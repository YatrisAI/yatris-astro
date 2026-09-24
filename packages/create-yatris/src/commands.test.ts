import { describe, expect, it } from 'vitest';
import { run } from './commands.js';

const manifestUrl = new URL('../../../platform/manifest.json', import.meta.url);

describe('create-yatris CLI', () => {
  it('prints the initializer and platform versions', () => {
    const result = run(['--version'], manifestUrl);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('create-yatris 0.0.0 (Yatris platform 0.0.0)');
  });

  it('prints help', () => {
    expect(run(['--help'], manifestUrl)).toMatchObject({ code: 0, stdout: expect.stringContaining('npm create yatris') });
  });

  it('refuses to create a project in this pre-release', () => {
    const result = run(['my-site'], manifestUrl);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('not available in this pre-release');
  });
});
