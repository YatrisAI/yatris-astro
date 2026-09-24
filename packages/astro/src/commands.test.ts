import { describe, expect, it } from 'vitest';
import { run } from './commands.js';
import yatris from './index.js';

const manifestUrl = new URL('../../../platform/manifest.json', import.meta.url);

describe('yatris CLI', () => {
  it('prints the package and platform versions', () => {
    const result = run(['--version'], manifestUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('@yatris/astro 0.0.0 (Yatris platform 0.0.0)');
  });

  it('prints help with no arguments', () => {
    expect(run([], manifestUrl)).toMatchObject({ code: 0, stdout: expect.stringContaining('Usage: yatris') });
  });

  it('fails on an unknown command', () => {
    const result = run(['deploy'], manifestUrl);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown command "deploy"');
  });
});

describe('integration', () => {
  it('identifies itself to Astro', () => {
    expect(yatris().name).toBe('@yatris/astro');
  });
});
