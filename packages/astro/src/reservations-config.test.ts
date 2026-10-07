import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { run } from './commands.js';
import yatris from './index.js';
import { assertReservationsMode, bookingOrigin, reservationsPreviewRequested, reservationsRuntime, syntheticHours } from './reservations-config.js';

const examples = new URL('../../../contracts/reservations/v1/examples/', import.meta.url);

function site({ paired = false, reservations = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'yatris-reservations-'));
  if (reservations) {
    mkdirSync(join(root, 'src/reservations'), { recursive: true });
    cpSync(new URL('consultation.json', examples), join(root, 'src/reservations/consultation.json'));
    writeFileSync(join(root, 'src/reservations/consultation.brief.json'), '{"notes":"agent brief, not a declaration"}');
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

type Plugin = { resolveId: (id: string) => string | undefined; load: (this: unknown, id: string) => string | undefined };

/** Runs the integration's setup and returns its reservations plugin. */
async function setup(root: URL, command: 'dev' | 'build', env: Record<string, string> = {}) {
  for (const [name, value] of Object.entries({ YATRIS_MEASUREMENT: 'off', YATRIS_FORMS_PREVIEW: '', YATRIS_RESERVATIONS_PREVIEW: '', YATRIS_BOOKING_ORIGIN: '', YATRIS_URL: '', ...env })) vi.stubEnv(name, value);
  if (!env.YATRIS_URL) delete process.env.YATRIS_URL;
  const network = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) =>
    String(url).endsWith('/schema') ? new Response(JSON.stringify({ contractVersion: 1, websiteId: 42, schemaMode: 'immediate' })) : new Response('{}', { status: 404 }),
  );
  let plugin: Plugin | undefined;
  await yatris().hooks['astro:config:setup']({
    config: { root },
    command,
    updateConfig: (config) => {
      plugin = (config as { vite: { plugins: Plugin[] } }).vite.plugins.find((p) => (p as { name?: string }).name === 'yatris:reservations');
    },
    logger: { info: () => {}, warn: () => {} },
  });
  const load = (id: string) => plugin!.load.call({ addWatchFile: () => {} }, plugin!.resolveId(id)!);
  return { load, network };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('reservations mode', () => {
  it('previews only under astro dev with YATRIS_RESERVATIONS_PREVIEW=1', () => {
    expect(assertReservationsMode('dev', { YATRIS_RESERVATIONS_PREVIEW: '1' })).toBe(true);
    expect(assertReservationsMode('dev', { YATRIS_RESERVATIONS_PREVIEW: 'true' })).toBe(true);
    expect(assertReservationsMode('dev', {})).toBe(false);
    expect(assertReservationsMode('dev', { YATRIS_RESERVATIONS_PREVIEW: '0' })).toBe(false);
    expect(assertReservationsMode('preview', { YATRIS_RESERVATIONS_PREVIEW: '1' })).toBe(false);
    expect(() => reservationsPreviewRequested({ YATRIS_RESERVATIONS_PREVIEW: 'yes' })).toThrow('is not understood');
  });

  it('a production build refuses preview, including from a .env file', async () => {
    const { url } = site();
    await expect(setup(url, 'build', { YATRIS_RESERVATIONS_PREVIEW: '1' })).rejects.toThrow('reservations preview only runs under `astro dev`');
    const fromFile = site();
    writeFileSync(join(fromFile.root, '.env'), 'YATRIS_RESERVATIONS_PREVIEW=1\n');
    vi.stubEnv('YATRIS_RESERVATIONS_PREVIEW', undefined as unknown as string);
    delete process.env.YATRIS_RESERVATIONS_PREVIEW;
    await expect(
      yatris().hooks['astro:config:setup']({ config: { root: fromFile.url }, command: 'build', updateConfig: (c) => c, logger: { info: () => {}, warn: () => {} } }),
    ).rejects.toThrow('YATRIS_RESERVATIONS_PREVIEW is set');
  });
});

describe('booking origin', () => {
  it('defaults to book.yatris.jp and accepts https or loopback http overrides', () => {
    expect(bookingOrigin({})).toBe('https://book.yatris.jp');
    expect(bookingOrigin({ YATRIS_BOOKING_ORIGIN: '' })).toBe('https://book.yatris.jp');
    expect(bookingOrigin({ YATRIS_BOOKING_ORIGIN: 'http://localhost:8000' })).toBe('http://localhost:8000');
    expect(bookingOrigin({ YATRIS_BOOKING_ORIGIN: 'https://book.staging.example/' })).toBe('https://book.staging.example');
  });

  it('fails the build on an unsafe override', async () => {
    expect(() => bookingOrigin({ YATRIS_BOOKING_ORIGIN: 'http://book.example.com' })).toThrow('YATRIS_BOOKING_ORIGIN');
    await expect(setup(site().url, 'build', { YATRIS_BOOKING_ORIGIN: 'http://192.168.0.5' })).rejects.toThrow('YATRIS_BOOKING_ORIGIN');
  });
});

describe('reservations runtime', () => {
  it('a paired project embeds the hosted page by Website id', async () => {
    const { url } = site({ paired: true });
    const { load } = await setup(url, 'build', { YATRIS_BOOKING_ORIGIN: 'http://book.localhost:8000' });
    expect(load('virtual:yatris/reservations')).toBe(`export default ${JSON.stringify({ mode: 'live', bookingOrigin: 'http://book.localhost:8000', websiteId: 42 })};`);
  });

  it('an unpaired project is unconfigured, never a preview', async () => {
    const { load } = await setup(site().url, 'build');
    expect(JSON.parse(load('virtual:yatris/reservations')!.replace(/^export default |;$/g, ''))).toMatchObject({ mode: 'unconfigured' });
  });

  it('a production build never reads src/reservations and bundles no preview code', async () => {
    const { load } = await setup(site({ paired: true }).url, 'build');
    const runtime = load('virtual:yatris/reservations')!;
    expect(runtime).not.toContain('previews');
    expect(runtime).not.toContain('無料相談');
    expect(load('virtual:yatris/reservations-preview')).toBe('export default null;');
  });

  it('dev preview loads the declaration with synthetic hosts and the booking UI', async () => {
    const { load } = await setup(site({ paired: true }).url, 'dev', { YATRIS_RESERVATIONS_PREVIEW: '1' });
    const runtime = JSON.parse(load('virtual:yatris/reservations')!.replace(/^export default |;$/g, ''));
    expect(runtime.mode).toBe('preview');
    expect(runtime.previews.consultation.definition.setup.key).toBe('consultation');
    expect(Object.keys(runtime.previews)).toEqual(['consultation']);
    expect(JSON.stringify(runtime)).not.toContain('meet.google.com');
    expect(load('virtual:yatris/reservations-preview')).toContain("from '@yatris/astro/booking/preview'");
    expect(load('virtual:yatris/reservations-preview')).toContain("import '@yatris/astro/YatrisBooking.css'");
  });

  it('synthetic hours narrow the venue hours by the first host', () => {
    expect(
      syntheticHours({
        appointment: { durationMinutes: 30, hostStrategy: 'single', hostResourceKeys: ['a'] },
        resources: [{ key: 'a', kind: 'host', label: 'A', weeklyHours: [{ day: 'monday', start: '11:00', end: '18:00' }] }],
        venueHours: { weekly: [{ day: 'monday', start: '10:00', end: '12:00' }, { day: 'monday', start: '13:00', end: '17:00' }, { day: 'tuesday', start: '10:00', end: '17:00' }] },
      }).weeklyHours,
    ).toEqual([
      { day: 'monday', start: '11:00', end: '12:00' },
      { day: 'monday', start: '13:00', end: '17:00' },
    ]);
    expect(syntheticHours({ venueHours: { weekly: [{ day: 'friday', start: '09:00', end: '10:00' }] } }).weeklyHours).toEqual([{ day: 'friday', start: '09:00', end: '10:00' }]);
    expect(syntheticHours({}).weeklyHours).toEqual([]);
  });

  it('dev without the flag uses the live or unconfigured runtime', () => {
    const { url } = site();
    expect(reservationsRuntime({ root: url, command: 'dev', env: {} }).mode).toBe('unconfigured');
  });
});

describe('yatris reservations', () => {
  it('validate passes valid declarations and skips agent briefs', async () => {
    const { root } = site();
    const result = await run(['reservations', 'validate'], { cwd: root });
    expect(result.code).toBe(0);
    expect(result.stdout).not.toContain('brief');
    expect(await run(['reservations', 'validate', 'src/reservations/consultation.brief.json'], { cwd: root })).toMatchObject({ code: 0, stdout: expect.stringContaining('no declarations') });
    expect(result.stdout).toContain('✔ src/reservations/consultation.json: valid (consultation)');
    expect(result.stdout).toContain('1 declaration, 0 invalid');
  });

  it('validate takes files and directories and exits 1 with the path and code of every error', async () => {
    const { root } = site();
    mkdirSync(join(root, 'more'));
    writeFileSync(join(root, 'more/broken.json'), JSON.stringify({ contractVersion: 2, key: 'broken', name: 'x', locale: 'ja', mode: 'time_slot', identityFields: { name: 'name', email: 'email' }, questions: [] }));
    cpSync(join(root, 'src/reservations/consultation.json'), join(root, 'more/renamed.json'));
    writeFileSync(join(root, 'more/bad.json'), '{');
    const result = await run(['reservations', 'validate', 'src/reservations/consultation.json', 'more'], { cwd: root });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('✖ more/broken.json: 2 errors');
    expect(result.stderr).toContain('    /contractVersion out_of_range');
    expect(result.stderr).toContain('    /questions too_short');
    expect(result.stderr).toContain('✖ more/renamed.json: 1 error\n    /key filename_mismatch (key must be "renamed")');
    expect(result.stderr).toMatch(/✖ more\/bad\.json: invalid_json/);
    expect(result.stderr).toContain('✔ src/reservations/consultation.json: valid (consultation)');
    expect(result.stderr).toContain('4 declarations, 3 invalid');
  });

  it('validate handles missing paths and never touches the network', async () => {
    const network = vi.spyOn(globalThis, 'fetch');
    const { root } = site({ reservations: false });
    expect(await run(['reservations', 'validate'], { cwd: root })).toMatchObject({ code: 0, stdout: expect.stringContaining('no declarations') });
    expect(await run(['reservations', 'validate', 'nowhere'], { cwd: root })).toMatchObject({ code: 1, stderr: expect.stringContaining('nowhere does not exist') });
    expect(network).not.toHaveBeenCalled();
  });

  it('an unknown action fails and the help lists the reservations command', async () => {
    expect((await run(['reservations', 'plan'], { cwd: process.cwd() })).code).toBe(1);
    expect((await run(['--help'], { cwd: process.cwd() })).stdout).toContain('reservations validate [<path>…]');
  });
});
