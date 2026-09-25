import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parsePlatformManifest, readPlatformManifest } from './platform.js';

const root = new URL('../../../', import.meta.url);
const manifestUrl = new URL('platform/manifest.json', root);
const packageVersion = (dir: string): string =>
  JSON.parse(readFileSync(new URL(`packages/${dir}/package.json`, root), 'utf8')).version;

describe('platform manifest', () => {
  it('parses the repository manifest', () => {
    const manifest = readPlatformManifest(manifestUrl);

    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.channel).toBe('stable');
  });

  it('declares the release approval where the registry shows it, identical to the manifest', () => {
    const manifest = readPlatformManifest(manifestUrl);
    const pkg = JSON.parse(readFileSync(new URL('packages/astro/package.json', root), 'utf8'));

    // The updater selects releases by this field; it must never disagree with the manifest
    expect(pkg.yatrisPlatform).toEqual({ status: manifest.status });
    expect(manifest.platformVersion).toBe(pkg.version);
  });

  it('pins the same versions the workspace packages declare', () => {
    const manifest = readPlatformManifest(manifestUrl);

    expect(manifest.packages['@yatris/astro']).toBe(packageVersion('astro'));
    expect(manifest.packages['create-yatris']).toBe(packageVersion('create-yatris'));
  });

  it('pins the house frontend stack to exact versions', () => {
    const { dependencies } = readPlatformManifest(manifestUrl);

    for (const name of ['astro', 'tailwindcss', '@tailwindcss/vite', 'alpinejs', '@astrojs/alpinejs', '@types/alpinejs']) {
      expect(dependencies[name], name).toMatch(/^\d+\.\d+\.\d+$/);
    }
  });

  it('rejects a version range where an exact version is required', () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    manifest.dependencies.astro = '^7.0.0';

    expect(() => parsePlatformManifest(manifest)).toThrow('dependencies.astro must be an exact version');
  });

  it('rejects an unknown manifest version', () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    manifest.manifestVersion = 2;

    expect(() => parsePlatformManifest(manifest)).toThrow('Unsupported platform manifestVersion: 2');
  });

  it('requires both Yatris packages', () => {
    const manifest = JSON.parse(readFileSync(manifestUrl, 'utf8'));
    delete manifest.packages['create-yatris'];

    expect(() => parsePlatformManifest(manifest)).toThrow('missing package create-yatris');
  });
});
