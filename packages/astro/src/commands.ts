import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { doctor, formatReport } from './doctor/doctor.js';
import { STAGES, type Stage } from './doctor/findings.js';
import { readPlatformManifest } from './platform.js';

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
}

const HELP = `Usage: yatris <command>

Commands:
  doctor --stage=scaffold [--json] [--no-build] [--dist=dist]
             Check the site against the Yatris managed-site contract. Builds
             the site first unless --no-build, then audits the build output.

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

  return { code: 1, stdout: '', stderr: `yatris: unknown command "${first}"\n\n${HELP}` };
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
