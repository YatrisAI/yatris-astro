import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isStable } from './versions.js';

const bootstrap = fileURLToPath(new URL('../../../../bootstrap/', import.meta.url));
const pkg = (name: string) => JSON.parse(readFileSync(`${bootstrap}${name}/package.json`, 'utf8'));

// The one-time npm placeholders (bootstrap/README.md, YatrisCMS#258) must stay
// nonfunctional, and impossible for the updater to select
describe('npm bootstrap placeholders', () => {
  for (const dir of ['yatris-astro', 'create-yatris']) {
    it(`${dir} is a bootstrap-tagged prerelease the updater can never select`, () => {
      const p = pkg(dir);
      expect(p.version).toBe('0.0.0-bootstrap.0');
      expect(isStable(p.version)).toBe(false);
      // npm ignores publishConfig.tag here, so the tag is always passed explicitly
      expect(p.publishConfig).toEqual({ access: 'public' });
      expect(p.yatrisPlatform).toBeUndefined();
      expect(p.scripts).toBeUndefined();
      expect(p.dependencies).toBeUndefined();
      expect(p.description).toMatch(/^NONFUNCTIONAL PLACEHOLDER/);
    });
  }

  it('reserves exactly the published names', () => {
    expect([pkg('yatris-astro').name, pkg('create-yatris').name]).toEqual(['@yatris/astro', 'create-yatris']);
  });

  it('fails loudly when used', async () => {
    await expect(import(pathToFileURL(`${bootstrap}yatris-astro/index.js`).href)).rejects.toThrow('nonfunctional placeholder');

    const cli = spawnSync(process.execPath, [`${bootstrap}create-yatris/cli.js`], { encoding: 'utf8' });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain('nonfunctional placeholder');
  });
});
