import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PlatformManifest } from '../platform.js';
import { AGENTS_BLOCK, artifactFile, managedBlock, PLATFORM_LOCK_PATH, platformLockText, replaceManagedBlock, type PlatformLock } from '../platform-lock.js';
import { verifySchema } from '../schema.js';
import { tail, type Exec } from './exec.js';
import type { UpdatePlan } from './plan.js';
import { PLATFORM_PACKAGE } from './source.js';

/**
 * An update transaction (spec §5.4): before changing anything, the updater
 * records every file it may touch and backs it up. If installation,
 * migration or verification fails, it restores exactly those files and
 * reinstalls `node_modules` from the restored lockfile. It never resets Git
 * and never touches a file it did not list.
 */
export const TRANSACTION_DIR = '.yatris/update-transaction';

/** Set for the verification commands, so the doctor knows the open transaction is this one. */
export const VERIFYING_ENV = 'YATRIS_UPDATE_VERIFYING';

interface Transaction {
  version: 1;
  from: string;
  to: string;
  startedAt: string;
  files: { path: string; existed: boolean }[];
  /** Whether `npm install` may have changed node_modules. */
  installed: boolean;
}

/** The scripts every managed site exposes (spec §5.4); added when missing. */
export const UPDATE_SCRIPTS: Record<string, string> = {
  'yatris:update': 'yatris update',
  'yatris:update:check': 'yatris update --check',
};

export interface Io {
  exec: Exec;
  log: (line: string) => void;
}

export interface Failure {
  step: string;
  command: string;
  output: string;
}

export type ApplyResult = { ok: true } | { ok: false; failure: Failure; restored: string[] };

export function pendingTransaction(root: string): Transaction | null {
  const path = join(root, TRANSACTION_DIR, 'transaction.json');
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as Transaction) : null;
}

/**
 * Applies a conflict-free plan inside a transaction, then verifies the
 * result; on failure restores what it touched. Never commits or pushes.
 */
export async function applyUpdate(root: string, plan: UpdatePlan, manifest: PlatformManifest, installSpec: string, io: Io): Promise<ApplyResult> {
  if (plan.conflicts.length > 0) throw new Error('an update with unresolved conflicts cannot be applied');

  const paths = [...new Set(['package.json', 'package-lock.json', PLATFORM_LOCK_PATH, ...plan.files.map((f) => artifactFile(f.key))])];
  begin(root, { version: 1, from: plan.from, to: plan.to, startedAt: new Date().toISOString(), files: paths.map((path) => ({ path, existed: existsSync(join(root, path)) })), installed: false });

  const fail = async (failure: Failure): Promise<ApplyResult> => ({ ok: false, failure, restored: await rollback(root, io) });

  try {
    // 1. The exact tested versions (never `latest`): the platform package and its matrix
    if (plan.packages.length > 0) {
      markInstalled(root);
      const specs = plan.packages.map((p) => (p.name === PLATFORM_PACKAGE ? installSpec : `${p.name}@${p.to}`));
      const command = ['npm', 'install', '--save-exact', '--no-audit', '--no-fund', ...specs];
      io.log(`Installing ${plan.packages.map((p) => `${p.name}@${p.to}`).join(', ')}…`);
      const result = await io.exec(command, { cwd: root });
      if (result.code !== 0) return fail({ step: 'install', command: command.join(' '), output: result.output });
    }

    // 2. Managed artifacts, both skill locations, the AGENTS.md block, MCP files
    for (const change of plan.files) writeArtifact(root, change.key, change.kind === 'remove' ? null : change.text);

    // 3. Versioned configuration: the update scripts
    addUpdateScripts(root);

    // 4. The platform lock advances only inside the transaction
    const lock: PlatformLock = {
      lockVersion: 1,
      platformVersion: manifest.platformVersion,
      template: manifest.template,
      skills: manifest.skills,
      packages: manifest.packages,
      dependencies: manifest.dependencies,
      managed: plan.managed,
    };
    writeFileSync(join(root, PLATFORM_LOCK_PATH), platformLockText(lock));

    // 5. Verification: schema contract, stage doctor (which builds), tests
    const schema = verifySchema(root);
    if (schema.length > 0) {
      return fail({ step: 'schema verify', command: 'yatris schema verify', output: schema.map((f) => `${f.code}${f.file ? ` ${f.file}` : ''}: ${f.message}`).join('\n') });
    }
    for (const script of verificationScripts(root)) {
      io.log(`Running npm run ${script}…`);
      const result = await io.exec(['npm', 'run', script], { cwd: root, env: { [VERIFYING_ENV]: '1' } });
      if (result.code !== 0) return fail({ step: script, command: `npm run ${script}`, output: result.output });
    }
  } catch (error) {
    return fail({ step: 'apply', command: 'yatris update', output: (error as Error).stack ?? String(error) });
  }

  rmSync(join(root, TRANSACTION_DIR), { recursive: true, force: true });
  return { ok: true };
}

/**
 * Restores every file the pending transaction listed, reinstalls
 * node_modules if the update had started installing, and closes the
 * transaction. Returns the restored paths.
 */
export async function rollback(root: string, io: Io): Promise<string[]> {
  const transaction = pendingTransaction(root);
  if (transaction === null) return [];

  const backup = join(root, TRANSACTION_DIR, 'files');
  for (const { path, existed } of transaction.files) {
    const target = join(root, path);
    if (existed) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, readFileSync(join(backup, path)));
    } else if (existsSync(target)) {
      unlinkSync(target);
    }
  }

  if (transaction.installed) {
    const lockfile = transaction.files.some((f) => f.path === 'package-lock.json' && f.existed);
    io.log('Reinstalling the previous dependencies…');
    const result = await io.exec(lockfile ? ['npm', 'ci', '--no-audit', '--no-fund'] : ['npm', 'install', '--no-audit', '--no-fund'], { cwd: root });
    if (result.code !== 0) io.log(`Reinstalling failed; run npm ci yourself:\n${tail(result.output)}`);
  }

  rmSync(join(root, TRANSACTION_DIR), { recursive: true, force: true });
  return transaction.files.map((f) => f.path);
}

/** The recovery report printed after a failed update. */
export function formatFailure(result: Extract<ApplyResult, { ok: false }>): string {
  return [
    `✖ The update failed at "${result.failure.step}" and was rolled back.`,
    `  Failing command: ${result.failure.command}`,
    tail(result.failure.output)
      .split('\n')
      .map((line) => `    ${line}`)
      .join('\n'),
    `  Restored (only files the updater listed before changing anything): ${result.restored.join(', ')}`,
    '  Nothing else in the repository was touched, and nothing was committed.',
  ].join('\n');
}

function begin(root: string, transaction: Transaction): void {
  const dir = join(root, TRANSACTION_DIR);
  if (existsSync(dir)) throw new Error(`an earlier update did not finish (${TRANSACTION_DIR}); run \`yatris update --rollback\` first`);
  for (const { path, existed } of transaction.files) {
    if (!existed) continue;
    mkdirSync(dirname(join(dir, 'files', path)), { recursive: true });
    writeFileSync(join(dir, 'files', path), readFileSync(join(root, path)));
  }
  writeFileSync(join(dir, 'transaction.json'), `${JSON.stringify(transaction, null, 2)}\n`);
}

function markInstalled(root: string): void {
  const path = join(root, TRANSACTION_DIR, 'transaction.json');
  const transaction = JSON.parse(readFileSync(path, 'utf8')) as Transaction;
  writeFileSync(path, `${JSON.stringify({ ...transaction, installed: true }, null, 2)}\n`);
}

function writeArtifact(root: string, key: string, text: string | null): void {
  const path = join(root, artifactFile(key));

  if (key === AGENTS_BLOCK) {
    if (text === null) return;
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    // Markers removed by the site and the new block accepted: put it first
    const next = managedBlock(current) === null ? `${text}\n\n${current}`.trimEnd() + '\n' : replaceManagedBlock(current, text);
    writeFileSync(path, next);
    return;
  }

  if (text === null) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

function addUpdateScripts(root: string): void {
  const path = join(root, 'package.json');
  const pkg = JSON.parse(readFileSync(path, 'utf8')) as { scripts?: Record<string, string> };
  const missing = Object.entries(UPDATE_SCRIPTS).filter(([name]) => !(name in (pkg.scripts ?? {})));
  if (missing.length === 0) return;
  pkg.scripts = { ...pkg.scripts, ...Object.fromEntries(missing) };
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
}

/** The site's own checks: its doctor (which builds), else the build; then its tests. */
function verificationScripts(root: string): string[] {
  const scripts = (JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> }).scripts ?? {};
  const run = [scripts.doctor ? 'doctor' : 'build'];
  if (scripts.test && !/no test specified/.test(scripts.test)) run.push('test');
  return run;
}
