import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksLikeCredential } from '@yatris/astro/mcp';
import { type Environment, run } from './commands.js';

const identity = {
  contractVersion: 1,
  website: { id: 42, name: 'client.example.jp', url: 'https://client.example.jp', timezone: 'Asia/Tokyo', status: 'preparing' },
  mcp: { contractVersion: 1, server: { name: 'yatris', transport: 'streamable-http', url: 'https://app.yatris.jp/mcp/yatris' } },
  delivery: { endpoint: 'https://app.yatris.jp/api/v1/delivery/42', credentials: 'deferred' },
  schema: { mode: 'immediate', revision: null },
};

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

  it('pairs the new site with --connect, writing no secret', async () => {
    const target = join(work, 'site');
    const requests: { url: string; body: unknown }[] = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify(identity), { status: 200 });
    }) as typeof globalThis.fetch;

    expect(await run([target, '--connect', 'ABCD-EFGH', '--no-install'], env({ fetch }))).toBe(0);

    expect(requests[0].url).toBe('https://app.yatris.jp/api/v1/setup/exchange');
    expect(requests[0].body).toMatchObject({ code: 'ABCD-EFGH', client: { name: 'create-yatris' } });
    const project = JSON.parse(readFileSync(join(target, '.yatris/project.json'), 'utf8'));
    expect(project.websiteId).toBe(42);
    expect(readFileSync(join(target, '.mcp.json'), 'utf8')).toContain('https://app.yatris.jp/mcp/yatris');
    for (const path of ['.yatris/project.json', '.yatris/mcp.json', '.mcp.json', '.codex/config.toml', '.yatris/schema.lock.json']) {
      expect(looksLikeCredential(readFileSync(join(target, path), 'utf8'))).toBe(false);
    }
    expect(out.join('\n')).toContain('Paired with Yatris Website 42');
  });

  it('asks for the setup code with --pair, so it never enters shell history', async () => {
    const target = join(work, 'site');
    const asked: string[] = [];
    const sent: unknown[] = [];
    const fetch = (async (_url: string, init?: RequestInit) => {
      sent.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(identity), { status: 200 });
    }) as typeof globalThis.fetch;
    const prompt = async (question: string) => {
      asked.push(question);
      return '  WXYZ-2345 ';
    };

    const argv = [target, '--pair', '--no-install'];
    expect(await run(argv, env({ fetch, prompt }))).toBe(0);

    expect(argv.join(' ')).not.toContain('WXYZ');
    expect(asked).toEqual(['Yatris setup code: ']);
    expect(sent[0]).toMatchObject({ code: 'WXYZ-2345' });
    expect(JSON.parse(readFileSync(join(target, '.yatris/project.json'), 'utf8')).websiteId).toBe(42);
  });

  it('refuses --pair without an interactive terminal', async () => {
    expect(await run([join(work, 'site'), '--pair', '--no-install'], env({ prompt: undefined }))).toBe(1);
    expect(err[0]).toContain('interactive terminal');
  });

  it('reports a refused setup code and leaves an unpaired project', async () => {
    const target = join(work, 'site');
    const fetch = (async () => new Response(JSON.stringify({ error: 'invalid_code', message: 'expired' }), { status: 422 })) as typeof globalThis.fetch;

    expect(await run([target, '--connect', 'ABCD-EFGH', '--no-install'], env({ fetch }))).toBe(1);
    expect(err[0]).toContain('expired');
    expect(JSON.parse(readFileSync(join(target, '.yatris/project.json'), 'utf8')).websiteId).toBeNull();
  });

  it('rejects unknown options', async () => {
    expect(await run(['--bogus'], env())).toBe(1);
    expect(err[0]).toContain('bogus');
  });
});
