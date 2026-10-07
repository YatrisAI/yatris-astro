import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { doctor, formatReport } from './doctor/doctor.js';
import { STAGES, type Stage } from './doctor/findings.js';
import { FORMS_HELP, runForms } from './forms-command.js';
import { MAIL_HELP, runMail } from './mail-command.js';
import { RESERVATIONS_HELP, runReservations } from './reservations-command.js';
import { resolveRemote, type RemoteOptions } from './yatris-remote.js';
import { apiBaseFrom, exchangeSetupCode, pairProject } from './pairing.js';
import { readPlatformManifest } from './platform.js';
import { LOCK_PATH, projectWebsiteId, readLock, readManifest, syncInstructions, syncSchema, verifySchema } from './schema.js';
import { runUpdate, type UpdateEnvironment } from './update/command.js';
import { exec, type Exec } from './update/exec.js';

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliEnvironment {
  cwd: string;
  manifestUrl?: URL;
  /** Runs the site's production build; defaults to `npm run build` in `cwd`. */
  build?: () => Promise<{ code: number; output: string }>;
  /** Network access for `yatris connect`; defaults to the global fetch. */
  fetch?: typeof fetch;
  /** Overrides the Yatris origin (YATRIS_URL); defaults to the manifest's MCP origin. */
  yatrisUrl?: string;
  /** Asks a question on an interactive terminal; undefined when not interactive. */
  prompt?: (question: string) => Promise<string>;
  /** Runs npm and git for `yatris update`. */
  exec?: Exec;
  /** Progress lines while a long command runs; defaults to the console. */
  log?: (line: string) => void;
  /** Release source and hand-over for `yatris update` (tests). */
  update?: Pick<UpdateEnvironment, 'source' | 'delegate'>;
  /** Environment variables for Yatris MCP commands (YATRIS_MCP_TOKEN, SMTP); defaults to process.env. */
  environment?: Record<string, string | undefined>;
  /** Replaces the Yatris MCP HTTP transport (tests). */
  mcpTransport?: RemoteOptions['transport'];
  /** Delay between MCP transport retries (tests pass 0). */
  retryDelayMs?: number;
}

function remoteOptions(env: CliEnvironment): RemoteOptions {
  return { environment: env.environment, fetch: env.fetch, transport: env.mcpTransport, retryDelayMs: env.retryDelayMs };
}

const HELP = `Usage: yatris <command>

Commands:
  doctor --stage=scaffold [--json] [--no-build] [--dist=dist] [--offline]
             Check the site against the Yatris managed-site contract. Builds
             the site first unless --no-build, then audits the build output.
             Contact forms: declarations, <YatrisForm> mounts, thanks routes,
             renderer capabilities and, when paired with YATRIS_MCP_TOKEN set
             and not --offline, Yatris readiness (otherwise "unverified").
  schema status
             Show the schema revision this repository is locked to.
  schema sync --manifest=<file>
             Write the generated types and lock from a manifest read from the
             Yatris MCP (yatris://websites/{id}/schema).
  schema verify [--manifest=<file>]
             Check the lock and generated files, and that they match the
             manifest's revision when one is given. Writes nothing.
  connect [--force]
             Pair this repository with its Yatris Website. Asks for the
             single-use setup code from the dashboard (接続・診断), so it never
             appears in shell history. Writes the site identity and the MCP
             configuration; never a key or token. (\`connect <code>\` also
             works, for automation.)
  update [--check | --dry-run] [--to <version>] [--yes] [--major]
         [--allow-dirty] [--rollback]
             Move this site to a newer Yatris platform release (stable
             releases on npm). --check only reports what is available;
             --dry-run shows every package and managed-file change and any
             conflict, writing nothing. Without a terminal, pass --yes and
             --to <version> (and --major for a major Astro or platform
             change). Locally edited managed files stop the update. A failed
             update restores only the files it touched; it never commits.
             Run it as \`npm run yatris:update\`.
${FORMS_HELP}
${RESERVATIONS_HELP}
${MAIL_HELP}

Options:
  --version  Print the package and Yatris platform versions
  --help     Show this help`;

export async function run(argv: string[], env: CliEnvironment = { cwd: process.cwd() }): Promise<CliResult> {
  const [first, ...rest] = argv;

  if (first === '--version' || first === '-v') {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const platform = readPlatformManifest(env.manifestUrl);
    return { code: 0, stdout: `@yatris/astro ${version} (Yatris platform ${platform.platformVersion})`, stderr: '' };
  }

  if (first === undefined || first === '--help' || first === '-h') {
    return { code: 0, stdout: HELP, stderr: '' };
  }

  if (first === 'doctor') {
    return runDoctor(rest, env);
  }

  if (first === 'schema') {
    return runSchema(rest, env);
  }

  if (first === 'connect') {
    return runConnect(rest, env);
  }

  if (first === 'forms') {
    return runForms(rest, env.cwd, remoteOptions(env));
  }

  if (first === 'reservations') {
    return runReservations(rest, env.cwd, remoteOptions(env));
  }

  if (first === 'mail') {
    return runMail(rest, env.cwd, remoteOptions(env));
  }

  if (first === 'update') {
    return runUpdate(rest, {
      cwd: env.cwd,
      exec: env.exec ?? exec,
      log: env.log ?? ((line) => console.log(line)),
      prompt: env.prompt,
      ...env.update,
    });
  }

  return { code: 1, stdout: '', stderr: `yatris: unknown command "${first}"\n\n${HELP}` };
}

async function runConnect(argv: string[], env: CliEnvironment): Promise<CliResult> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: { force: { type: 'boolean', default: false } } });
  } catch (error) {
    return { code: 1, stdout: '', stderr: `yatris connect: ${(error as Error).message}` };
  }

  const code = parsed.positionals[0] ?? (env.prompt ? (await env.prompt('Yatris setup code: ')).trim() : undefined);
  if (!code) return { code: 1, stdout: '', stderr: 'yatris connect: a setup code is required (issue one in the Yatris dashboard, 接続・診断, and run this in an interactive terminal).' };

  try {
    const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
    const manifest = readPlatformManifest(env.manifestUrl);
    const identity = await exchangeSetupCode(code, {
      apiBase: env.yatrisUrl ?? process.env.YATRIS_URL ?? apiBaseFrom(manifest.mcp.url),
      client: { name: '@yatris/astro', version },
      fetch: env.fetch,
    });
    const written = pairProject(env.cwd, identity, { force: parsed.values.force });

    return {
      code: 0,
      stdout: `Paired with Yatris Website ${identity.website.id} (${identity.website.name}).\nWrote ${written.join(', ')}.\nSign in to the Yatris MCP from your agent client: in Claude Code, open claude here, approve the yatris server, then run claude mcp login yatris; in Codex, trust this project, then run codex mcp login yatris.`,
      stderr: '',
    };
  } catch (error) {
    return { code: 1, stdout: '', stderr: `yatris connect: ${(error as Error).message}` };
  }
}

function runSchema(argv: string[], env: CliEnvironment): CliResult {
  const [action, ...rest] = argv;
  let manifestPath: string | undefined;
  try {
    ({
      values: { manifest: manifestPath },
    } = parseArgs({ args: rest, options: { manifest: { type: 'string' } } }));
  } catch (error) {
    return { code: 1, stdout: '', stderr: `yatris schema: ${(error as Error).message}` };
  }

  try {
    if (action === 'status') {
      const lock = readLock(env.cwd);
      if (lock === null) return { code: 1, stdout: '', stderr: `yatris schema: ${LOCK_PATH} does not exist. ${syncInstructions(projectWebsiteId(env.cwd))}` };
      const website = `Website ${lock.websiteId ?? '(unpaired)'}`;
      // The lock exists but nothing is synced into it yet (YatrisCMS#307)
      if (lock.schemaRevision === null) {
        return { code: 0, stdout: `${website}: no schema revision synced yet. ${syncInstructions(projectWebsiteId(env.cwd) ?? lock.websiteId)}`, stderr: '' };
      }
      return { code: 0, stdout: `${website}: ${lock.schemaRevision} (${lock.schemaDigest})`, stderr: '' };
    }

    if (action === 'sync') {
      if (!manifestPath) return { code: 1, stdout: '', stderr: 'yatris schema sync: --manifest=<file> is required' };
      const lock = syncSchema(env.cwd, readManifest(manifestPath));
      const files = [...Object.keys(lock.generatedFiles), '.yatris/schema.lock.json'].join(', ');
      return { code: 0, stdout: `Synced to ${lock.schemaRevision} (${lock.schemaDigest}): wrote ${files}`, stderr: '' };
    }

    if (action === 'verify') {
      const findings = verifySchema(env.cwd, manifestPath ? readManifest(manifestPath) : undefined);
      if (findings.length === 0) return { code: 0, stdout: 'schema: the repository matches its schema contract', stderr: '' };
      const lines = findings.map((f) => `${f.severity === 'error' ? '✖' : '⚠'} ${f.code}${f.file ? ` ${f.file}` : ''}: ${f.message}`).join('\n');
      // Warnings only (an unsynced lock): nothing contradicts the contract yet
      if (!findings.some((f) => f.severity === 'error')) return { code: 0, stdout: lines, stderr: '' };
      return { code: 1, stdout: '', stderr: lines };
    }
  } catch (error) {
    return { code: 1, stdout: '', stderr: `yatris schema: ${(error as Error).message}` };
  }

  return { code: 1, stdout: '', stderr: `yatris schema: unknown action "${action ?? ''}"\n\n${HELP}` };
}

async function runDoctor(argv: string[], env: CliEnvironment): Promise<CliResult> {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      allowNegative: true,
      options: {
        stage: { type: 'string' },
        json: { type: 'boolean', default: false },
        build: { type: 'boolean', default: true },
        dist: { type: 'string', default: 'dist' },
        offline: { type: 'boolean', default: false },
      },
    }));
  } catch (error) {
    return { code: 1, stdout: '', stderr: `yatris doctor: ${(error as Error).message}\n\n${HELP}` };
  }

  const stage = values.stage as Stage | undefined;
  if (!stage || !STAGES.includes(stage)) {
    return {
      code: 1,
      stdout: '',
      stderr: `yatris doctor: --stage must be one of: ${STAGES.join(', ')} (later stages arrive with later releases)`,
    };
  }

  const report = await doctor({
    root: env.cwd,
    stage,
    manifest: readPlatformManifest(env.manifestUrl),
    dist: values.dist,
    build: values.build ? (env.build ?? (() => npmBuild(env.cwd))) : undefined,
    forms: values.offline ? {} : { remote: () => resolveRemote(env.cwd, remoteOptions(env)) },
  });

  return {
    code: report.ok ? 0 : 1,
    stdout: values.json ? JSON.stringify(report, null, 2) : formatReport(report),
    stderr: '',
  };
}

function npmBuild(cwd: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    // npm is a .cmd shim on Windows, which only a shell can start.
    const child =
      process.platform === 'win32' ? spawn('npm run build', { cwd, shell: true }) : spawn('npm', ['run', 'build'], { cwd });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    child.on('close', (code) => resolve({ code: code ?? 1, output }));
    child.on('error', (error) => resolve({ code: 1, output: String(error) }));
  });
}
