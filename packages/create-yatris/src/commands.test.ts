import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Environment, run } from './commands.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

let work: string;
let out: string[];
let err: string[];
let execs: { command: string; args: string[]; cwd: string }[];

function env(overrides: Partial<Environment> = {}): Environment {
  return {
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    exec: async (command, args, cwd) => {
      execs.push({ command, args, cwd });
      return 0;
    },
    manifestUrl: new URL('../../../platform/manifest.json', import.meta.url),
    templateDir: join(root, 'template'),
    skillsDir: join(root, 'skills'),
    ...overrides,
  };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'create-yatris-cli-'));
  out = [];
  err = [];
  execs = [];
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('create-yatris CLI', () => {
  it('prints the initializer and platform versions', async () => {
    expect(await run(['--version'], env())).toBe(0);
    expect(out).toEqual(['create-yatris 0.0.0 (Yatris platform 0.0.0)']);
  });

  it('prints help', async () => {
    expect(await run(['--help'], env())).toBe(0);
    expect(out[0]).toContain('npm create yatris');
  });

  it('creates the project, initialises Git, installs dependencies and runs the first build', async () => {
    const target = join(work, 'site');

    expect(await run([target], env())).toBe(0);
    expect(existsSync(join(target, 'astro.config.mjs'))).toBe(true);
    expect(execs.map((e) => [e.command, ...e.args].join(' '))).toEqual([
      'git init --quiet',
      'npm install --no-audit --no-fund',
      'npm run build',
    ]);
    expect(execs.every((e) => e.cwd === target)).toBe(true);
  });

  it('skips install and build with --no-install', async () => {
    expect(await run([join(work, 'site'), '--no-install'], env())).toBe(0);
    expect(execs.map((e) => e.command)).toEqual(['git']);
    expect(out.at(-1)).toContain('npm install');
  });

  it('skips Git with --no-git', async () => {
    expect(await run([join(work, 'site'), '--no-git', '--no-install'], env())).toBe(0);
    expect(execs).toEqual([]);
  });

  it('warns but continues when git init fails', async () => {
    const code = await run(
      [join(work, 'site')],
      env({
        exec: async (command, args, cwd) => {
          execs.push({ command, args, cwd });
          return command === 'git' ? 1 : 0;
        },
      }),
    );

    expect(code).toBe(0);
    expect(err[0]).toContain('`git init` failed');
    expect(execs.map((e) => e.command)).toEqual(['git', 'npm', 'npm']);
  });

  it('stops when a step fails', async () => {
    const code = await run([join(work, 'site'), '--no-git'], env({ exec: async () => 3 }));

    expect(code).toBe(1);
    expect(err[0]).toContain('`npm install --no-audit --no-fund` failed with exit code 3');
  });

  it('asks for the directory on an interactive terminal', async () => {
    const target = join(work, 'asked');

    expect(await run(['--no-install'], env({ prompt: async () => ` ${target} ` }))).toBe(0);
    expect(existsSync(join(target, 'package.json'))).toBe(true);
  });

  it('requires a directory when it cannot prompt', async () => {
    expect(await run([], env())).toBe(1);
    expect(err[0]).toContain('a project directory is required');
  });

  it('does not prompt with --yes', async () => {
    expect(await run(['--yes'], env({ prompt: async () => join(work, 'nope') }))).toBe(1);
    expect(existsSync(join(work, 'nope'))).toBe(false);
  });

  it('refuses pairing until it exists', async () => {
    expect(await run([join(work, 'site'), '--connect', 'ABCD-EFGH'], env())).toBe(1);
    expect(err[0]).toContain('--connect');
    expect(existsSync(join(work, 'site'))).toBe(false);
  });

  it('rejects unknown options', async () => {
    expect(await run(['--bogus'], env())).toBe(1);
    expect(err[0]).toContain('bogus');
  });
});
