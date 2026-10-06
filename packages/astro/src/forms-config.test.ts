import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from './commands.js';
import { assertFormsMode, formsRuntime, previewRequested } from './forms-config.js';
import { EXIT_UNAVAILABLE } from './forms-command.js';
import { formMountConfig, serializeMountConfig } from './forms-mount.js';
import yatris from './index.js';

const examples = new URL('../../../contracts/forms/v1/examples/', import.meta.url);
const contactExample = () => JSON.parse(readFileSync(new URL('contact.json', examples), 'utf8'));

function site({ paired = false, forms = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yatris-forms-'));
  if (forms) {
    mkdirSync(join(root, 'src/forms'), { recursive: true });
    cpSync(new URL('full-coverage.json', examples), join(root, 'src/forms/full-coverage.json'));
    cpSync(new URL('contact.json', examples), join(root, 'src/forms/contact.json'));
    writeFileSync(join(root, 'src/forms/contact.brief.json'), '{"notes":"agent brief, not a declaration"}');
  }
  if (paired) {
    mkdirSync(join(root, '.yatris'));
    writeFileSync(
      join(root, '.yatris/project.json'),
      JSON.stringify({ contractVersion: 1, websiteId: 42, site: { name: 'テスト', url: null, timezone: 'Asia/Tokyo' }, deliveryEndpoint: 'https://app.yatris.jp/api/v1/delivery/42' }),
    );
  }
  return { root, url: pathToFileURL(`${root}/`) };
}

/** Runs the integration's setup and returns its forms plugin. */
async function setup(root: URL, command: 'dev' | 'build', env: Record<string, string> = {}) {
  for (const [name, value] of Object.entries({ YATRIS_MEASUREMENT: 'off', YATRIS_FORMS_PREVIEW: '', YATRIS_URL: '', ...env })) vi.stubEnv(name, value);
  if (!env.YATRIS_URL) delete process.env.YATRIS_URL;
  // A paired build confirms its schema with Yatris; answer that, and nothing else.
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    String(url).endsWith('/schema') ? new Response(JSON.stringify({ contractVersion: 1, websiteId: 42, schemaMode: 'immediate' })) : new Response('{}', { status: 404 }),
  );
  let plugin: { resolveId: (id: string) => string | undefined; load: (this: unknown, id: string) => Promise<string | undefined> } | undefined;
  await yatris().hooks['astro:config:setup']({
    config: { root },
    command,
    updateConfig: (config) => {
      plugin = (config as { vite: { plugins: (typeof plugin)[] } }).vite.plugins.find((p) => (p as { name?: string }).name === 'yatris:forms');
    },
    logger: { info: () => {}, warn: () => {} },
  });
  const load = async (id: string) => plugin!.load.call({ addWatchFile: () => {} }, plugin!.resolveId(id)!);
  return { load, network };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('forms mode', () => {
  it('previews only under astro dev with YATRIS_FORMS_PREVIEW=1', () => {
    expect(assertFormsMode('dev', { YATRIS_FORMS_PREVIEW: '1' })).toBe(true);
    expect(assertFormsMode('dev', {})).toBe(false);
    expect(assertFormsMode('preview', { YATRIS_FORMS_PREVIEW: 'true' })).toBe(false);
    expect(() => assertFormsMode('build', { YATRIS_FORMS_PREVIEW: '1' })).toThrow('forms preview only runs under `astro dev`');
    expect(assertFormsMode('build', { YATRIS_FORMS_PREVIEW: '0' })).toBe(false);
  });

  it('refuses a value it does not understand instead of guessing', () => {
    expect(() => previewRequested({ YATRIS_FORMS_PREVIEW: 'yes' })).toThrow('is not understood');
  });

  it('a production build refuses preview, including from a .env file', async () => {
    const { url } = site();
    await expect(setup(url, 'build', { YATRIS_FORMS_PREVIEW: '1' })).rejects.toThrow('forms preview only runs under `astro dev`');
    const fromFile = site();
    writeFileSync(join(fromFile.root, '.env'), 'YATRIS_FORMS_PREVIEW=1\n');
    vi.stubEnv('YATRIS_FORMS_PREVIEW', undefined as unknown as string);
    delete process.env.YATRIS_FORMS_PREVIEW;
    await expect(
      yatris().hooks['astro:config:setup']({ config: { root: fromFile.url }, command: 'build', updateConfig: (c) => c, logger: { info: () => {}, warn: () => {} } }),
    ).rejects.toThrow('YATRIS_FORMS_PREVIEW is set');
  });
});

describe('forms runtime', () => {
  it('a paired project loads live definitions from the Yatris origin', async () => {
    const { url } = site({ paired: true });
    const runtime = await formsRuntime({ root: url, command: 'build', env: {} });
    expect(runtime).toEqual({ mode: 'live', origin: 'https://app.yatris.jp', websiteId: 42, timeZone: 'Asia/Tokyo' });
    expect(formMountConfig(runtime, { form: 'contact' })).toEqual({
      mode: 'live',
      form: 'contact',
      timeZone: 'Asia/Tokyo',
      publicKey: '42.contact',
      definitionUrl: 'https://app.yatris.jp/api/v1/forms/42.contact',
    });
    expect(await formsRuntime({ root: url, command: 'build', env: { YATRIS_URL: 'http://localhost:8000/' } })).toMatchObject({ origin: 'http://localhost:8000' });
  });

  it('an unpaired project is unconfigured, never a preview', async () => {
    const { url } = site();
    const runtime = await formsRuntime({ root: url, command: 'dev', env: {} });
    expect(runtime.mode).toBe('unconfigured');
    expect(formMountConfig(runtime, { form: 'contact' }).mode).toBe('unconfigured');
  });

  it('a production build never reads src/forms and bundles no preview code', async () => {
    for (const paired of [false, true]) {
      const { url } = site({ paired });
      const { load, network } = await setup(url, 'build');
      const forms = (await load('virtual:yatris/forms'))!;
      expect(network.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/forms'))).toEqual([]);
      expect(JSON.parse(forms.replace(/^export default |;$/g, '')).mode).toBe(paired ? 'live' : 'unconfigured');
      expect(forms).not.toContain('お問い合わせ');
      expect(forms).not.toContain('contact@example.jp');
      expect(forms).not.toContain('fujisan');
      expect(await load('virtual:yatris/forms-preview')).toBe('export default null;');
    }
  });

  it('dev preview carries public projections only: no mail, recipients or quiz answers', async () => {
    const { url } = site({ paired: true });
    const { load } = await setup(url, 'dev', { YATRIS_FORMS_PREVIEW: '1' });
    expect(await load('virtual:yatris/forms-preview')).toContain('@yatris/astro/forms/preview');
    const runtime = JSON.parse((await load('virtual:yatris/forms'))!.replace(/^export default |;$/g, ''));
    expect(runtime.mode).toBe('preview');
    expect(Object.keys(runtime.previews).sort()).toEqual(['contact', 'full-coverage']);
    const text = JSON.stringify(runtime);
    for (const secret of ['contact@example.jp', 'fujisan', 'ふじさん', 'submission.answers', 'thankYou', 'replyToField']) expect(text).not.toContain(secret);
    const mount = formMountConfig(runtime, { form: 'full-coverage' });
    expect(mount).toMatchObject({ mode: 'preview', source: 'src/forms/full-coverage.json' });
    expect(formMountConfig(runtime, { form: 'missing' })).toMatchObject({ mode: 'preview', problem: { message: expect.stringContaining('src/forms/missing.json がありません') } });
  });

  it('reports an invalid declaration in preview instead of rendering it', async () => {
    const { root, url } = site();
    writeFileSync(join(root, 'src/forms/broken.json'), JSON.stringify({ contractVersion: 1, key: 'broken' }));
    const runtime = await formsRuntime({ root: url, command: 'dev', env: { YATRIS_FORMS_PREVIEW: '1' } });
    expect(formMountConfig(runtime, { form: 'broken' })).toMatchObject({ problem: { issues: expect.arrayContaining([{ path: '/fields', code: 'required_property' }]) } });
  });
});

describe('<YatrisForm> props', () => {
  const runtime = { mode: 'live' as const, origin: 'https://app.yatris.jp', websiteId: 7, timeZone: 'Asia/Tokyo' };

  it('validates the form key, hidden values and class slots', () => {
    expect(() => formMountConfig(runtime, { form: 'Contact Form' })).toThrow('form must be a form key');
    expect(() => formMountConfig(runtime, { form: 'contact', hidden: { 'Bad Key': 'x' } })).toThrow('is not a field key');
    expect(() => formMountConfig(runtime, { form: 'contact', hidden: { source: 3 as unknown as string } })).toThrow('must be a string');
    expect(() => formMountConfig(runtime, { form: 'contact', classes: { button: 'x' } as never })).toThrow('is not one of');
    expect(formMountConfig(runtime, { form: 'contact', hidden: { source: 'lp-a' }, classes: { submit: 'btn' } })).toMatchObject({ hidden: { source: 'lp-a' }, classes: { submit: 'btn' } });
  });

  it('serializes configuration safely inside a script element', () => {
    const text = serializeMountConfig(formMountConfig(runtime, { form: 'contact', hidden: { source: '</script><script>alert(1)</script>' } }));
    expect(text).not.toContain('<');
    expect(JSON.parse(text).hidden.source).toBe('</script><script>alert(1)</script>');
  });
});

describe('yatris forms', () => {
  it('validate passes valid declarations and skips agent briefs', async () => {
    const { root } = site();
    const result = await run(['forms', 'validate'], { cwd: root });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('✔ src/forms/contact.json: valid (contact)');
    expect(result.stdout).toContain('✔ src/forms/full-coverage.json: valid (full-coverage)');
    expect(result.stdout).not.toContain('brief');
    expect(result.stdout).toContain('2 declarations, 0 invalid');
  });

  it('validate exits 1 with the path and code of every error', async () => {
    const { root } = site();
    writeFileSync(join(root, 'src/forms/broken.json'), JSON.stringify({ contractVersion: 1, key: 'broken', name: 'x', locale: 'ja', fields: [{ key: 'a', type: 'signature' }], submit: { label: 'x' }, success: { mode: 'message', message: 'x' }, mail: {} }));
    writeFileSync(join(root, 'src/forms/renamed.json'), JSON.stringify({ ...contactExample(), key: 'other' }));
    writeFileSync(join(root, 'src/forms/garbage.json'), '{ not json');
    const result = await run(['forms', 'validate'], { cwd: root });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('✖ src/forms/broken.json');
    expect(result.stderr).toContain('/fields/0/type unknown_node_type');
    expect(result.stderr).toContain('/mail/notification required_property');
    expect(result.stderr).toContain('/key filename_mismatch (key must be "renamed")');
    expect(result.stderr).toContain('✖ src/forms/garbage.json: invalid_json');
    expect(result.stderr).toContain('5 declarations, 3 invalid');
  });

  it('validate reports a warning without failing', async () => {
    const { root } = site({ forms: false });
    mkdirSync(join(root, 'forms'));
    const contact = contactExample();
    contact.mail.notification.to = [];
    writeFileSync(join(root, 'forms/contact.json'), JSON.stringify(contact));
    const result = await run(['forms', 'validate', '--dir=forms'], { cwd: root });
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('⚠ forms/contact.json: /mail/notification/to recipients_missing');
  });

  it('validate handles a missing directory', async () => {
    const { root } = site({ forms: false });
    expect(await run(['forms', 'validate'], { cwd: root })).toMatchObject({ code: 0, stdout: expect.stringContaining('no declarations') });
    expect(await run(['forms', 'validate', '--dir=nowhere'], { cwd: root })).toMatchObject({ code: 1, stderr: expect.stringContaining('nowhere does not exist') });
  });

  it('validate never touches the network', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    await run(['forms', 'validate'], { cwd: site().root });
    expect(network).not.toHaveBeenCalled();
  });

  for (const action of ['plan', 'apply', 'pull']) {
    it(`${action} says synchronization is unavailable and exits ${EXIT_UNAVAILABLE}`, async () => {
      const network = vi.spyOn(globalThis, 'fetch');
      const result = await run(['forms', action], { cwd: site().root });
      expect(result.code).toBe(EXIT_UNAVAILABLE);
      expect(result.stdout).toBe('');
      expect(result.stderr).toContain('synchronization with Yatris is not available yet');
      expect(network).not.toHaveBeenCalled();
    });
  }

  it('an unknown action fails and the help lists the forms commands', async () => {
    expect((await run(['forms', 'sync'], { cwd: process.cwd() })).code).toBe(1);
    expect((await run(['--help'], { cwd: process.cwd() })).stdout).toContain('forms validate [--dir=src/forms]');
  });
});
