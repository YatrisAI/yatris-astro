import { describe, expect, it } from 'vitest';
import { run } from './commands.js';
import yatris from './index.js';

const manifestUrl = new URL('../../../platform/manifest.json', import.meta.url);
const env = { cwd: process.cwd(), manifestUrl };

describe('yatris CLI', () => {
  it('prints the package and platform versions', async () => {
    const result = await run(['--version'], env);

    expect(result.code).toBe(0);
    expect(result.stdout).toBe('@yatris/astro 0.0.0 (Yatris platform 0.0.0)');
  });

  it('prints help with no arguments', async () => {
    expect(await run([], env)).toMatchObject({ code: 0, stdout: expect.stringContaining('Usage: yatris') });
  });

  it('fails on an unknown command', async () => {
    const result = await run(['deploy'], env);

    expect(result.code).toBe(1);
    expect(result.stderr).toContain('unknown command "deploy"');
  });

  it('requires a known doctor stage', async () => {
    expect((await run(['doctor'], env)).stderr).toContain('--stage must be one of: scaffold');
    expect((await run(['doctor', '--stage=active'], env)).code).toBe(1);
  });
});

describe('integration', () => {
  it('identifies itself to Astro', () => {
    expect(yatris().name).toBe('@yatris/astro');
  });

  it('rejects a malformed GTM container ID', () => {
    expect(() => yatris({ gtmContainerId: 'UA-12345' })).toThrow('GTM-XXXXXXX');
  });

  it('serves its settings to the components through a virtual module', async () => {
    let plugin: { resolveId: (id: string) => unknown; load: (id: string) => unknown } | undefined;
    await yatris({ gtmContainerId: 'GTM-ABC1234' }).hooks['astro:config:setup']({
      updateConfig: (config) => {
        plugin = (config as { vite: { plugins: (typeof plugin)[] } }).vite.plugins[0];
        return config;
      },
    });

    const id = plugin!.resolveId('virtual:yatris/config') as string;
    expect(plugin!.load(id)).toBe(
      'export default {"gtmContainerId":"GTM-ABC1234","searchConsoleVerification":null,"consentMode":null};',
    );
  });
});
