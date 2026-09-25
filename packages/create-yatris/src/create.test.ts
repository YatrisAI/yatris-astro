import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readPlatformManifest } from '@yatris/astro/platform';
import { createProject, packageName, SKILL_LOCATIONS } from './create.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const manifest = readPlatformManifest(new URL('../../../platform/manifest.json', import.meta.url));
const sources = { templateDir: join(root, 'template'), skillsDir: join(root, 'skills'), manifest };

function files(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(dir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'create-yatris-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('createProject', () => {
  it('lays out the managed-site repository contract', () => {
    const target = createProject({ targetDir: join(work, 'My Site') }, sources);

    expect(files(target)).toEqual(
      expect.arrayContaining([
        '.gitattributes',
        '.gitignore',
        '.codex/config.toml',
        '.mcp.json',
        '.yatris/mcp.json',
        '.yatris/schema.lock.json',
        '.yatris/project.json',
        'AGENTS.md',
        'CLAUDE.md',
        'astro.config.mjs',
        'package.json',
        'src/assets/images/.gitkeep',
        'src/components/.gitkeep',
        'src/layouts/BaseLayout.astro',
        'src/navigation.ts',
        'src/pages/index.astro',
        'src/scripts/alpine.ts',
        'src/styles/global.css',
        'tsconfig.json',
      ]),
    );
    expect(files(target)).not.toContain('_gitignore');
    expect(files(target).some((f) => /^tailwind\.config\./.test(f))).toBe(false);
  });

  it('pins every dependency to the platform release', () => {
    const target = createProject({ targetDir: join(work, 'My Site') }, sources);
    const pkg = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));

    expect(pkg.name).toBe('my-site');
    expect(pkg.dependencies).toEqual({ ...manifest.dependencies, '@yatris/astro': manifest.packages['@yatris/astro'] });
    expect(Object.keys(pkg.dependencies)).toEqual(Object.keys(pkg.dependencies).sort());
  });

  it('can point @yatris/astro at a local tarball', () => {
    const target = createProject({ targetDir: join(work, 'site'), yatrisAstroSpec: 'file:../yatris-astro-0.0.0.tgz' }, sources);

    expect(JSON.parse(readFileSync(join(target, 'package.json'), 'utf8')).dependencies['@yatris/astro']).toBe(
      'file:../yatris-astro-0.0.0.tgz',
    );
  });

  it('copies every skill byte-for-byte into both agent locations', () => {
    const target = createProject({ targetDir: join(work, 'site') }, sources);
    const canonical = files(sources.skillsDir).filter((f) => f.includes('/'));

    expect(canonical).toContain('tailwindcss-development/SKILL.md');
    expect(canonical).toContain('alpinejs-development/SKILL.md');
    for (const location of SKILL_LOCATIONS) {
      expect(files(join(target, location))).toEqual(canonical);
      for (const file of canonical) {
        expect(readFileSync(join(target, location, file))).toEqual(readFileSync(join(sources.skillsDir, file)));
      }
    }
  });

  it('writes an unpaired, credential-free project identity', () => {
    const target = createProject({ targetDir: join(work, 'site') }, sources);

    expect(JSON.parse(readFileSync(join(target, '.yatris/project.json'), 'utf8'))).toEqual({
      contractVersion: 1,
      websiteId: null,
      environment: 'production',
      templateVersion: manifest.template,
    });
  });

  it('contains no credentials', () => {
    const target = createProject({ targetDir: join(work, 'site') }, sources);
    const secretish = /alk_[A-Za-z0-9]{8,}|YATRIS_DELIVERY_API_KEY\s*=|Bearer\s+[A-Za-z0-9._-]{10,}|ghp_[A-Za-z0-9]{10,}/;

    for (const file of files(target)) {
      expect(readFileSync(join(target, file), 'utf8'), file).not.toMatch(secretish);
    }
  });

  it('refuses a directory that is not empty', () => {
    const target = join(work, 'taken');
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'x');

    expect(() => createProject({ targetDir: target }, sources)).toThrow('already exists and is not empty');
  });

  it('accepts an existing empty directory', () => {
    const target = join(work, 'empty');
    mkdirSync(target);

    expect(() => createProject({ targetDir: target }, sources)).not.toThrow();
  });
});

describe('packageName', () => {
  it.each([
    ['My Site', 'my-site'],
    ['site', 'site'],
    ['実績サイト', 'yatris-site'],
    ['.hidden', 'hidden'],
    ['a--b', 'a--b'],
  ])('%s → %s', (input, expected) => {
    expect(packageName(input)).toBe(expected);
  });
});
