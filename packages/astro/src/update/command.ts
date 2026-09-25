import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { readPlatformManifest } from '../platform.js';
import { AGENTS_BLOCK, artifactFile, PLATFORM_LOCK_PATH, readPlatformLock } from '../platform-lock.js';
import { applyUpdate, formatFailure, pendingTransaction, rollback, TRANSACTION_DIR } from './apply.js';
import { tail, type Exec } from './exec.js';
import { acceptConflicts, CONFLICT_TEXT, formatPlan, planUpdate, type Conflict, type UpdatePlan } from './plan.js';
import { directorySource, newestApproved, registrySource, type UpdateSource } from './source.js';
import { compareVersions, isStable, nodeSatisfies } from './versions.js';

export const CONFLICTS_DIR = '.yatris/update-conflicts';

export interface UpdateEnvironment {
  cwd: string;
  exec: Exec;
  log: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
  /** Where releases come from; defaults to npm (or YATRIS_UPDATE_SOURCE). */
  source?: UpdateSource;
  /** Runs the target release's own CLI; resolves to its exit code. */
  delegate?: (packageDir: string, args: string[]) => Promise<number>;
}

interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

const OPTIONS = {
  check: { type: 'boolean', default: false },
  'dry-run': { type: 'boolean', default: false },
  to: { type: 'string' },
  yes: { type: 'boolean', default: false },
  major: { type: 'boolean', default: false },
  'allow-dirty': { type: 'boolean', default: false },
  rollback: { type: 'boolean', default: false },
  // Set by the bootstrap when it hands over to the target release's CLI
  resolved: { type: 'string' },
  'install-spec': { type: 'string' },
  unreleased: { type: 'boolean', default: false },
} as const;

/**
 * `yatris update` (spec §5.4, decisions 11.1–11.4). The installed CLI is only
 * a bootstrap: it finds the target platform release on npm (stable only),
 * downloads it without installing anything, and hands over to that release's
 * own CLI, which plans, confirms, applies and verifies the update with its own
 * code, skills and templates.
 */
export async function runUpdate(argv: string[], env: UpdateEnvironment): Promise<Result> {
  let values;
  try {
    ({ values } = parse(argv));
  } catch (error) {
    return failure((error as Error).message);
  }

  const io = { exec: env.exec, log: env.log };

  if (values.rollback) {
    const restored = await rollback(env.cwd, io);
    return restored.length
      ? { code: 0, stdout: `Rolled back the unfinished update; restored ${restored.join(', ')}.`, stderr: '' }
      : { code: 0, stdout: 'There is no unfinished update to roll back.', stderr: '' };
  }

  let lock;
  try {
    lock = readPlatformLock(env.cwd);
  } catch (error) {
    return failure((error as Error).message);
  }
  if (lock === null) {
    return failure(`this repository has no ${PLATFORM_LOCK_PATH}, so the updater cannot tell which files it manages. Sites created by create-yatris have one.`);
  }

  try {
    return values.resolved ? await target(values, lock.platformVersion, env) : await bootstrap(argv, values, lock.platformVersion, env);
  } catch (error) {
    return failure((error as Error).message);
  }
}

function parse(args: string[]) {
  return parseArgs({ args, options: OPTIONS });
}
type Values = ReturnType<typeof parse>['values'];

async function bootstrap(argv: string[], values: Values, current: string, env: UpdateEnvironment): Promise<Result> {
  const source = env.source ?? (process.env.YATRIS_UPDATE_SOURCE ? directorySource(process.env.YATRIS_UPDATE_SOURCE) : registrySource(env.exec, env.cwd));
  const versions = await source.versions();

  // Decisions 11.1–11.2: the newest *approved* stable release, never npm's `latest` tag
  const newest = values.to ? null : await newestApproved(source, versions, current);
  for (const skipped of newest?.skipped ?? []) env.log(`Skipping ${skipped}: published, but not an approved Yatris platform release.`);
  const version = values.to ?? newest?.version ?? null;
  if (version === null) return { code: 0, stdout: `This site is on ${current}; there is no newer approved Yatris platform release.`, stderr: '' };
  if (!versions.includes(version)) return failure(`Yatris platform ${version} is not published.`);
  // Decision 11.2: the stable channel only (a local mirror may test others)
  if (!isStable(version) && !source.allowUnreleased) return failure(`${version} is a prerelease; managed sites take stable Yatris platform releases only.`);
  if (values.to && compareVersions(version, current) > 0) {
    const rejection = await source.rejection(version);
    if (rejection !== null) return failure(`${version} is published but is not an approved Yatris platform release: ${rejection}.`);
  }
  if (compareVersions(version, current) < 0) return failure(`this site is on ${current}; the updater does not downgrade to ${version}.`);
  if (compareVersions(version, current) === 0) return { code: 0, stdout: `This site is already on Yatris platform ${current}.`, stderr: '' };

  const dir = mkdtempSync(join(tmpdir(), 'yatris-update-'));
  try {
    env.log(`Fetching Yatris platform ${version}…`);
    const fetched = await source.fetch(version, dir);
    const args = [...argv, '--resolved', fetched.packageDir, '--install-spec', fetched.installSpec, ...(source.allowUnreleased ? ['--unreleased'] : [])];
    const code = await (env.delegate ?? delegate(env.cwd))(fetched.packageDir, args);
    return { code, stdout: '', stderr: '' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function delegate(cwd: string) {
  return (packageDir: string, args: string[]) =>
    new Promise<number>((resolve) => {
      const child = spawn(process.execPath, [join(packageDir, 'dist/cli.js'), 'update', ...args], { cwd, stdio: 'inherit' });
      child.on('close', (code) => resolve(code ?? 1));
      child.on('error', () => resolve(1));
    });
}

/** The target release's side: everything that reads or writes the project. */
async function target(values: Values, current: string, env: UpdateEnvironment): Promise<Result> {
  const packageDir = values.resolved as string;
  const manifest = readPlatformManifest(pathToFileURL(join(packageDir, 'platform.json')));
  if (manifest.status !== 'released' && !values.unreleased) return failure(`Yatris platform ${manifest.platformVersion} is not an approved release (its manifest is not marked released).`);
  if (!nodeSatisfies(manifest.node)) return failure(`Yatris platform ${manifest.platformVersion} needs Node ${manifest.node}; this is ${process.versions.node}.`);

  const lock = readPlatformLock(env.cwd)!;
  const sources = { skillsDir: join(packageDir, 'skills'), agentsTemplate: join(packageDir, 'template/AGENTS.md') };
  let plan = planUpdate(env.cwd, lock, manifest, sources);

  if (values.check) {
    const lines = [`Update available: Yatris platform ${current} → ${manifest.platformVersion}`];
    for (const p of plan.packages) lines.push(`  ${p.name} ${p.from ?? '(not installed)'} → ${p.to}`);
    for (const m of plan.major) lines.push(`  ! major: ${m}`);
    lines.push('Run `npm run yatris:update -- --dry-run` to see which files it would change.');
    return { code: 0, stdout: lines.join('\n'), stderr: '' };
  }

  if (values['dry-run']) {
    env.log(formatPlan(plan));
    for (const conflict of plan.conflicts) env.log(await difference(conflict, env));
    return plan.conflicts.length
      ? failure(`${plan.conflicts.length} conflict(s): the update would stop before changing anything. Nothing was written.`)
      : { code: 0, stdout: 'Dry run: nothing was written or installed.', stderr: '' };
  }

  rmSync(join(env.cwd, CONFLICTS_DIR), { recursive: true, force: true });
  if (pendingTransaction(env.cwd)) return failure(`an earlier update did not finish (${TRANSACTION_DIR}); run \`npm run yatris:update -- --rollback\` first.`);
  if (!values['allow-dirty']) {
    const dirty = await uncommitted(env);
    if (dirty) return failure(dirty);
  }

  env.log(formatPlan(plan));

  if (plan.conflicts.length > 0) {
    const accepted: Conflict[] = [];
    for (const conflict of plan.conflicts) {
      env.log(await difference(conflict, env));
      // Only a person at a terminal may accept a managed version over local
      // changes; there is no flag for it, so an agent run always stops here
      if (env.prompt && /^y(es)?$/i.test((await env.prompt(`Replace ${conflict.key} with the Yatris version? Your version stays in Git history. [y/N] `)).trim())) {
        accepted.push(conflict);
      }
    }
    if (accepted.length < plan.conflicts.length) {
      const left = plan.conflicts.filter((c) => !accepted.includes(c));
      writeProposals(env.cwd, left);
      return failure(
        [
          `Stopped before changing anything: ${left.length} managed file(s) were customised in this repository.`,
          `The Yatris versions are in ${CONFLICTS_DIR}/ for review. Move site-specific instructions below the AGENTS.md end marker or into a skill of your own, restore the managed file, then run the update again.`,
        ].join('\n'),
      );
    }
    plan = acceptConflicts(plan, accepted);
  }

  const confirmed = await confirm(plan, values, env);
  if (confirmed !== true) return failure(confirmed);

  const result = await applyUpdate(env.cwd, plan, manifest, values['install-spec'] ?? `@yatris/astro@${manifest.platformVersion}`, { exec: env.exec, log: env.log });
  if (!result.ok) return { code: 1, stdout: '', stderr: formatFailure(result) };

  return {
    code: 0,
    stdout: [
      `✔ Updated to Yatris platform ${manifest.platformVersion}; verification passed.`,
      ...plan.major.map((m) => `  Follow-up: ${m}`),
      'Review the changes with `git diff` and commit them. The updater never commits or pushes.',
    ].join('\n'),
    stderr: '',
  };
}

/** True, or why the update may not go ahead (decision 11.3, spec §5.4 step 2). */
async function confirm(plan: UpdatePlan, values: Values, env: UpdateEnvironment): Promise<true | string> {
  if (env.prompt) {
    const question = plan.major.length ? `This update includes major changes:\n${plan.major.map((m) => `  ${m}`).join('\n')}\nApply it? [y/N] ` : 'Apply this update? [y/N] ';
    return /^y(es)?$/i.test((await env.prompt(question)).trim()) ? true : 'Cancelled; nothing was changed.';
  }
  if (!values.yes || !values.to) return 'not an interactive terminal: pass --yes and --to <version> to update without prompts.';
  if (plan.major.length && !values.major) return `this update includes major changes (${plan.major.join('; ')}); confirm them with --major, or run it at a terminal.`;
  return true;
}

async function uncommitted(env: UpdateEnvironment): Promise<string | null> {
  const status = await env.exec(['git', 'status', '--porcelain'], { cwd: env.cwd });
  if (status.code !== 0) return 'this is not a Git repository (or Git is unavailable). The updater leaves its changes as a diff to review; pass --allow-dirty to update anyway.';
  const lines = status.output.split('\n').filter((line) => line.trim() !== '');
  if (lines.length === 0) return null;
  return `the working tree has uncommitted changes, which would mix with the update's:\n${lines.slice(0, 10).map((l) => `  ${l}`).join('\n')}\nCommit or stash them first, or pass --allow-dirty.`;
}

/** The difference between the site's version and the release's, for a conflict. */
async function difference(conflict: Conflict, env: UpdateEnvironment): Promise<string> {
  const header = `✖ ${conflict.key}: ${CONFLICT_TEXT[conflict.reason]}`;
  const dir = mkdtempSync(join(tmpdir(), 'yatris-diff-'));
  try {
    const name = conflict.key.replace(/[^\w.-]+/g, '_');
    const ours = join(dir, 'this-repository', name);
    const theirs = join(dir, 'yatris', name);
    mkdirSync(dirname(ours), { recursive: true });
    mkdirSync(dirname(theirs), { recursive: true });
    writeFileSync(ours, conflict.current ?? '');
    writeFileSync(theirs, conflict.proposed ?? '');
    const diff = await env.exec(['git', 'diff', '--no-index', '--no-color', '--', ours, theirs], { cwd: dir });
    return `${header}\n${tail(diff.output.replaceAll(dir.replaceAll('\\', '/'), ''), 80)}`;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function writeProposals(root: string, conflicts: Conflict[]): void {
  for (const conflict of conflicts) {
    const file = conflict.key === AGENTS_BLOCK ? 'AGENTS.managed-block.md' : artifactFile(conflict.key);
    const path = join(root, CONFLICTS_DIR, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, conflict.proposed ?? `This Yatris release removes ${conflict.key}.\n`);
  }
}

function failure(message: string): Result {
  return { code: 1, stdout: '', stderr: `yatris update: ${message}` };
}
