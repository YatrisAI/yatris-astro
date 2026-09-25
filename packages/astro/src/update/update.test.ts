import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mcpDescriptor, mcpFiles } from '../mcp.js';
import { pairProject } from '../pairing.js';
import { readPlatformManifest, type PlatformManifest } from '../platform.js';
import { AGENTS_BLOCK, digest, lockFor, managedArtifacts, PLATFORM_LOCK_PATH, readPlatformLock, writePlatformLock } from '../platform-lock.js';
import { emptyLock, LOCK_PATH } from '../schema.js';
import { applyUpdate, TRANSACTION_DIR } from './apply.js';
import { CONFLICTS_DIR, runUpdate, type UpdateEnvironment } from './command.js';
import type { Exec } from './exec.js';
import { planUpdate } from './plan.js';
import { newestStable, type UpdateSource } from './source.js';
import { isMajorChange, isStable, nodeSatisfies } from './versions.js';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const current = readPlatformManifest(new URL('platform/manifest.json', `file:///${repo.replaceAll('\\', '/')}`));
const CUSTOM_PAGE = '---\n---\n<h1>お客様のページ</h1>\n';
const CUSTOM_SKILL = '# our own skill\n';

let site: string;
let release: string;
let next: PlatformManifest;

/** A site on the current platform, with its own page and its own skill. */
function scaffold(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-update-site-'));
  const artifacts = managedArtifacts({ skillsDir: join(repo, 'skills'), agentsTemplate: join(repo, 'template/AGENTS.md') }, current.mcp.url);
  for (const [key, text] of Object.entries(artifacts)) {
    const path = key === AGENTS_BLOCK ? 'AGENTS.md' : key;
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), key === AGENTS_BLOCK ? `${text}\n\n## Site notes\n\nお客様固有のメモ\n` : text);
  }
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ name: 'site', scripts: { build: 'astro build', doctor: 'yatris doctor --stage=scaffold' }, dependencies: { ...current.dependencies, '@yatris/astro': '0.0.0' } }, null, 2)}\n`);
  writeFileSync(join(dir, 'package-lock.json'), '{"lockfileVersion":3}\n');
  mkdirSync(join(dir, 'src/pages'), { recursive: true });
  writeFileSync(join(dir, 'src/pages/about.astro'), CUSTOM_PAGE);
  mkdirSync(join(dir, '.agents/skills/our-skill'), { recursive: true });
  writeFileSync(join(dir, '.agents/skills/our-skill/SKILL.md'), CUSTOM_SKILL);
  writeFileSync(join(dir, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: null }));
  writeFileSync(join(dir, LOCK_PATH), JSON.stringify(emptyLock()));
  writePlatformLock(dir, lockFor(current, artifacts));
  return dir;
}

/** The next release as its package would ship it: manifest, skills and template. */
function nextRelease(changes: { astro?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-update-release-'));
  cpSync(join(repo, 'skills'), join(dir, 'skills'), { recursive: true });
  mkdirSync(join(dir, 'template'));
  writeFileSync(join(dir, 'skills/alpinejs-development/SKILL.md'), `${readFileSync(join(dir, 'skills/alpinejs-development/SKILL.md'), 'utf8')}\n## New in 0.1.0\n`);
  mkdirSync(join(dir, 'skills/yatris-content'));
  writeFileSync(join(dir, 'skills/yatris-content/SKILL.md'), '# yatris-content\n');
  writeFileSync(join(dir, 'template/AGENTS.md'), readFileSync(join(repo, 'template/AGENTS.md'), 'utf8').replace('## Conventions', '## Conventions (0.1.0)'));
  next = {
    ...current,
    platformVersion: '0.1.0',
    status: 'released',
    packages: { ...current.packages, '@yatris/astro': '0.1.0' },
    dependencies: { ...current.dependencies, ...(changes.astro ? { astro: changes.astro } : {}) },
  };
  writeFileSync(join(dir, 'platform.json'), JSON.stringify(next));
  return dir;
}

const sources = () => ({ skillsDir: join(release, 'skills'), agentsTemplate: join(release, 'template/AGENTS.md') });
const read = (path: string) => readFileSync(join(site, path), 'utf8');

/** Fakes npm and git: records commands, lets `npm install` pin versions, fails what it is told to. */
function fakeExec(fail: RegExp | null = null) {
  const commands: string[] = [];
  const fn: Exec = async (command) => {
    const line = command.join(' ');
    commands.push(line);
    if (fail?.test(line)) return { code: 1, output: `${line} failed\nError: doctor found 1 error` };
    if (command[0] === 'npm' && command[1] === 'install') {
      const pkg = JSON.parse(read('package.json'));
      for (const spec of command.slice(2).filter((a) => !a.startsWith('--'))) {
        const at = spec.lastIndexOf('@');
        pkg.dependencies[spec.slice(0, at)] = spec.slice(at + 1);
      }
      writeFileSync(join(site, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);
      writeFileSync(join(site, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}\n');
    }
    return { code: 0, output: '' };
  };
  return { fn, commands };
}

beforeEach(() => {
  site = scaffold();
  release = nextRelease();
});
afterEach(() => {
  rmSync(site, { recursive: true, force: true });
  rmSync(release, { recursive: true, force: true });
});

describe('planning an update', () => {
  it('refreshes changed managed files in both skill locations and adds new ones, leaving the site’s files alone', () => {
    const plan = planUpdate(site, readPlatformLock(site)!, next, sources());
    const changed = plan.files.filter((f) => f.kind !== 'adopt').map((f) => `${f.kind} ${f.key}`);

    expect(changed).toEqual([
      'update .agents/skills/alpinejs-development/SKILL.md',
      'add .agents/skills/yatris-content/SKILL.md',
      'update .claude/skills/alpinejs-development/SKILL.md',
      'add .claude/skills/yatris-content/SKILL.md',
      `update ${AGENTS_BLOCK}`,
    ]);
    expect(plan.conflicts).toEqual([]);
    expect(plan.packages).toEqual([{ name: '@yatris/astro', from: '0.0.0', to: '0.1.0' }]);
    expect(plan.major).toEqual(['Yatris platform 0.0.0 → 0.1.0']);
  });

  it('stops on a customised managed file the release changes, and keeps one it does not', () => {
    writeFileSync(join(site, '.claude/skills/alpinejs-development/SKILL.md'), 'our edit\n');
    writeFileSync(join(site, '.claude/skills/tailwindcss-development/SKILL.md'), 'our edit\n');
    mkdirSync(join(site, '.agents/skills/yatris-content'));
    writeFileSync(join(site, '.agents/skills/yatris-content/SKILL.md'), 'already ours\n');

    const plan = planUpdate(site, readPlatformLock(site)!, next, sources());

    expect(plan.conflicts.map((c) => `${c.reason} ${c.key}`)).toEqual([
      'unmanaged .agents/skills/yatris-content/SKILL.md',
      'modified .claude/skills/alpinejs-development/SKILL.md',
    ]);
    expect(plan.kept).toEqual(['.claude/skills/tailwindcss-development/SKILL.md']);
  });

  it('treats Astro and platform majors as needing confirmation', () => {
    release = nextRelease({ astro: '8.0.0' });
    const plan = planUpdate(site, readPlatformLock(site)!, next, sources());
    expect(plan.major.some((m) => m.startsWith('Astro 7.3.5 → 8.0.0'))).toBe(true);
    expect(isMajorChange('1.2.0', '1.3.0')).toBe(false);
    expect(isMajorChange('0.1.0', '0.2.0')).toBe(true);
  });
});

describe('applying an update', () => {
  it('installs the exact versions, refreshes managed files, advances the lock and verifies', async () => {
    const exec = fakeExec();
    const plan = planUpdate(site, readPlatformLock(site)!, next, sources());

    const result = await applyUpdate(site, plan, next, '@yatris/astro@0.1.0', { exec: exec.fn, log: () => {} });

    expect(result).toEqual({ ok: true });
    expect(exec.commands).toEqual(['npm install --save-exact --no-audit --no-fund @yatris/astro@0.1.0', 'npm run doctor']);
    expect(read('.claude/skills/alpinejs-development/SKILL.md')).toContain('New in 0.1.0');
    expect(read('.agents/skills/yatris-content/SKILL.md')).toBe('# yatris-content\n');
    expect(read('AGENTS.md')).toContain('## Conventions (0.1.0)');
    expect(read('AGENTS.md')).toContain('お客様固有のメモ');
    expect(read('src/pages/about.astro')).toBe(CUSTOM_PAGE);
    expect(read('.agents/skills/our-skill/SKILL.md')).toBe(CUSTOM_SKILL);
    expect(JSON.parse(read('package.json')).scripts['yatris:update']).toBe('yatris update');

    const lock = readPlatformLock(site)!;
    expect(lock.platformVersion).toBe('0.1.0');
    expect(lock.managed['.claude/skills/yatris-content/SKILL.md']).toBe(digest('# yatris-content\n'));
    expect(existsSync(join(site, TRANSACTION_DIR))).toBe(false);
  });

  it('restores exactly the files it touched when verification fails', async () => {
    const before = new Map(['package.json', 'package-lock.json', PLATFORM_LOCK_PATH, 'AGENTS.md', '.claude/skills/alpinejs-development/SKILL.md'].map((p) => [p, read(p)]));
    const exec = fakeExec(/npm run doctor/);
    const plan = planUpdate(site, readPlatformLock(site)!, next, sources());
    writeFileSync(join(site, 'src/pages/draft.astro'), 'work in progress');

    const result = await applyUpdate(site, plan, next, '@yatris/astro@0.1.0', { exec: exec.fn, log: () => {} });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.failure).toMatchObject({ step: 'doctor', command: 'npm run doctor' });
    for (const [path, text] of before) expect(read(path)).toBe(text);
    expect(existsSync(join(site, '.claude/skills/yatris-content'))).toBe(true); // the directory, now empty
    expect(existsSync(join(site, '.claude/skills/yatris-content/SKILL.md'))).toBe(false);
    expect(read('src/pages/draft.astro')).toBe('work in progress');
    expect(exec.commands.at(-1)).toBe('npm ci --no-audit --no-fund');
    expect(existsSync(join(site, TRANSACTION_DIR))).toBe(false);
  });
});

describe('yatris update', () => {
  const env = (exec: Exec, extra: Partial<UpdateEnvironment> = {}): UpdateEnvironment => ({ cwd: site, exec, log: () => {}, ...extra });
  const resolved = ['--resolved', '', '--install-spec', '@yatris/astro@0.1.0'];
  const args = (...more: string[]) => [...more, ...resolved.map((a) => (a === '' ? release : a))];

  it('needs --yes, --to and, for a major change, --major without a terminal', async () => {
    const exec = fakeExec();
    expect((await runUpdate(args(), env(exec.fn))).stderr).toContain('--yes and --to');
    expect((await runUpdate(args('--yes', '--to', '0.1.0'), env(exec.fn))).stderr).toContain('--major');
    expect(readPlatformLock(site)!.platformVersion).toBe('0.0.0');

    const done = await runUpdate(args('--yes', '--to', '0.1.0', '--major'), env(exec.fn));
    expect(done.code).toBe(0);
    expect(readPlatformLock(site)!.platformVersion).toBe('0.1.0');
  });

  it('refuses a dirty working tree', async () => {
    const dirty: Exec = async (command) => ({ code: 0, output: command[0] === 'git' ? ' M src/pages/index.astro\n' : '' });
    const result = await runUpdate(args('--yes', '--to', '0.1.0', '--major'), env(dirty));
    expect(result.stderr).toContain('uncommitted changes');
  });

  it('stops on a locally edited managed skill, with no flag to force it, and writes the proposal for review', async () => {
    writeFileSync(join(site, '.agents/skills/alpinejs-development/SKILL.md'), 'our edit\n');
    const exec = fakeExec();

    const result = await runUpdate(args('--yes', '--to', '0.1.0', '--major'), env(exec.fn));

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('customised');
    expect(read('.agents/skills/alpinejs-development/SKILL.md')).toBe('our edit\n');
    expect(readFileSync(join(site, CONFLICTS_DIR, '.agents/skills/alpinejs-development/SKILL.md'), 'utf8')).toContain('New in 0.1.0');
    expect(readPlatformLock(site)!.platformVersion).toBe('0.0.0');
    expect(exec.commands.some((c) => c.startsWith('npm install'))).toBe(false);
  });

  it('lets a person at the terminal accept the Yatris version of a conflict', async () => {
    writeFileSync(join(site, '.agents/skills/alpinejs-development/SKILL.md'), 'our edit\n');
    const exec = fakeExec();
    const prompt = async () => 'y';

    const result = await runUpdate(args(), env(exec.fn, { prompt }));

    expect(result.code).toBe(0);
    expect(read('.agents/skills/alpinejs-development/SKILL.md')).toContain('New in 0.1.0');
  });

  it('--rollback recovers an update that was interrupted (a crash, a killed terminal)', async () => {
    const original = read('package.json');
    mkdirSync(join(site, TRANSACTION_DIR, 'files'), { recursive: true });
    writeFileSync(join(site, TRANSACTION_DIR, 'files/package.json'), original);
    writeFileSync(join(site, TRANSACTION_DIR, 'files/package-lock.json'), read('package-lock.json'));
    writeFileSync(
      join(site, TRANSACTION_DIR, 'transaction.json'),
      JSON.stringify({ version: 1, from: '0.0.0', to: '0.1.0', startedAt: '', installed: true, files: [{ path: 'package.json', existed: true }, { path: 'package-lock.json', existed: true }, { path: '.agents/skills/yatris-content/SKILL.md', existed: false }] }),
    );
    writeFileSync(join(site, 'package.json'), '{"half":"written"}');
    mkdirSync(join(site, '.agents/skills/yatris-content'));
    writeFileSync(join(site, '.agents/skills/yatris-content/SKILL.md'), 'new');
    const exec = fakeExec();

    expect((await runUpdate(args('--yes', '--to', '0.1.0', '--major'), env(exec.fn))).stderr).toContain('--rollback');
    const result = await runUpdate(['--rollback'], env(exec.fn));

    expect(result.stdout).toContain('restored package.json');
    expect(read('package.json')).toBe(original);
    expect(existsSync(join(site, '.agents/skills/yatris-content/SKILL.md'))).toBe(false);
    expect(exec.commands).toContain('npm ci --no-audit --no-fund');
    expect(existsSync(join(site, TRANSACTION_DIR))).toBe(false);
  });

  it('dry-run and check write nothing', async () => {
    const exec = fakeExec();
    const lock = read(PLATFORM_LOCK_PATH);

    expect((await runUpdate(args('--check'), env(exec.fn))).stdout).toContain('Update available: Yatris platform 0.0.0 → 0.1.0');
    expect((await runUpdate(args('--dry-run'), env(exec.fn))).stdout).toContain('nothing was written');
    expect(read(PLATFORM_LOCK_PATH)).toBe(lock);
    expect(exec.commands.filter((c) => !c.startsWith('git'))).toEqual([]);
  });

  it('bootstraps: finds the newest stable release and hands over to its own CLI', async () => {
    const handed: string[][] = [];
    const source: UpdateSource = {
      allowUnreleased: false,
      versions: async () => ['0.0.0', '0.1.0', '0.2.0-beta.1'],
      fetch: async (version) => ({ packageDir: `/tmp/${version}/package`, installSpec: `@yatris/astro@${version}` }),
    };
    const delegate = async (_dir: string, argv: string[]) => (handed.push(argv), 0);

    await runUpdate(['--dry-run'], env(fakeExec().fn, { source, delegate }));
    expect(handed).toEqual([['--dry-run', '--resolved', '/tmp/0.1.0/package', '--install-spec', '@yatris/astro@0.1.0']]);

    expect((await runUpdate(['--to', '0.2.0'], env(fakeExec().fn, { source, delegate }))).stderr).toContain('not published');
    expect((await runUpdate(['--to', '0.2.0-beta.1'], env(fakeExec().fn, { source, delegate }))).stderr).toContain('stable Yatris platform releases only');
    writePlatformLock(site, { ...readPlatformLock(site)!, platformVersion: '0.1.0' });
    expect((await runUpdate([], env(fakeExec().fn, { source, delegate }))).stdout).toContain('newest stable');
    expect((await runUpdate(['--to', '0.0.0'], env(fakeExec().fn, { source, delegate }))).stderr).toContain('does not downgrade');
    expect(newestStable(['1.0.0', '1.1.0-rc.1'])).toBe('1.0.0');
    expect(isStable('1.1.0-rc.1')).toBe(false);
    expect(nodeSatisfies('>=22.12.0', '22.11.0')).toBe(false);
  });
});

describe('pairing and the platform lock', () => {
  it('records the MCP files pairing rewrites, so they are not mistaken for customisations', () => {
    const descriptor = mcpDescriptor('https://app.yatris.jp/mcp/yatris?site=42');
    pairProject(site, {
      contractVersion: 1,
      website: { id: 42, name: 'Client', url: 'https://client.example.jp', timezone: 'Asia/Tokyo' },
      delivery: { endpoint: 'https://app.yatris.jp/api/v1/delivery/42' },
      mcp: descriptor,
    } as Parameters<typeof pairProject>[1]);

    const lock = readPlatformLock(site)!;
    expect(lock.managed['.mcp.json']).toBe(digest(mcpFiles(descriptor)['.mcp.json']));

    const plan = planUpdate(site, lock, next, sources());
    expect(plan.conflicts).toEqual([]);
    expect(plan.files.some((f) => f.key === '.mcp.json' && f.kind !== 'adopt')).toBe(false);
  });
});
