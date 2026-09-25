import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { headTags } from './head.js';
import { trackEvent, updateConsent } from './measurement.js';
import { loadMeasurement, parseMeasurement, withMeasurement } from './measurement-config.js';

let root: string;
const answering = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
const settled = { contractVersion: 1, gtmContainerId: 'GTM-ABC1234', consentMode: 'required', searchConsoleVerification: 'abcDEF123_-xyz' };

function pair(): void {
  mkdirSync(join(root, '.yatris'), { recursive: true });
  writeFileSync(join(root, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: 42, deliveryEndpoint: 'https://app.yatris.jp/api/v1/delivery/42' }));
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yatris-measurement-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('measurement settings from Yatris', () => {
  const load = (command: 'dev' | 'build', fetch: typeof globalThis.fetch, env: Record<string, string> = {}) =>
    loadMeasurement({ root: pathToFileURL(`${root}/`), command, fetch, env });

  it('makes no request for an unpaired project, which still builds offline', async () => {
    const fetch = (async () => {
      throw new Error('no network');
    }) as typeof globalThis.fetch;
    await expect(load('build', fetch)).resolves.toBeNull();
  });

  it('makes no request in dev', async () => {
    pair();
    await expect(load('dev', answering(settled))).resolves.toBeNull();
  });

  it('reads the paired site settings on a production build', async () => {
    pair();
    let asked = '';
    const fetch = (async (url: string) => {
      asked = String(url);
      return new Response(JSON.stringify(settled));
    }) as typeof globalThis.fetch;

    await expect(load('build', fetch)).resolves.toEqual({ gtmContainerId: 'GTM-ABC1234', consentMode: 'required', searchConsoleVerification: 'abcDEF123_-xyz' });
    expect(asked).toBe('https://app.yatris.jp/api/v1/sites/42/measurement');
  });

  it('fails the build rather than guess when Yatris cannot be read', async () => {
    pair();
    await expect(load('build', answering({ error: 'x' }, 503))).rejects.toThrow('YATRIS_MEASUREMENT=off');
    await expect(load('build', answering({ error: 'x' }, 503), { YATRIS_MEASUREMENT: 'off' })).resolves.toEqual({ gtmContainerId: null, consentMode: null, searchConsoleVerification: null });
  });

  it('never renders a container that arrives without a consent policy', () => {
    expect(() => parseMeasurement({ ...settled, consentMode: null })).toThrow('consent policy');
    expect(() => parseMeasurement({ ...settled, gtmContainerId: 'UA-1' })).toThrow('GTM');
  });

  it('refuses GTM set in astro.config once the site is paired', () => {
    const settings = parseMeasurement(settled);
    expect(() => withMeasurement(resolveConfig({ gtmContainerId: 'GTM-OTHER1' }), settings, true)).toThrow('set in Yatris');
    expect(withMeasurement(resolveConfig(), settings, false).gtmContainerId).toBe('GTM-ABC1234');
  });
});

describe('consent in the head', () => {
  const ctx = (config: Parameters<typeof withMeasurement>[1]) => ({ site: new URL('https://client.example.jp'), pathname: '/', config: withMeasurement(resolveConfig(), config, false) });

  it('starts Consent Mode denied before GTM when consent is required', () => {
    const tags = headTags({ title: 'Home', description: 'd' }, ctx(parseMeasurement(settled)));
    const scripts = tags.filter((t) => t.tag === 'script').map((t) => (t as { html: string }).html);

    const consent = scripts.findIndex((html) => html.includes("'consent','default'"));
    const gtm = scripts.findIndex((html) => html.includes('gtm.js'));
    expect(consent).toBeGreaterThanOrEqual(0);
    expect(consent).toBeLessThan(gtm);
    expect(scripts[consent]).toContain("analytics_storage:'denied'");
  });

  it('adds no consent default when the policy does not require one', () => {
    const tags = headTags({ title: 'Home', description: 'd' }, ctx(parseMeasurement({ ...settled, consentMode: 'not_required' })));
    expect(tags.some((t) => t.tag === 'script' && t.html.includes("'consent'"))).toBe(false);
  });
});

describe('site-code helpers', () => {
  it('pushes semantic events and consent updates to the dataLayer', () => {
    const heatmap: boolean[] = [];
    const w = { dataLayer: [] as unknown[], AutoLogicriHM: { consent: (granted: boolean) => heatmap.push(granted) } };
    (globalThis as { window?: unknown }).window = w;
    try {
      trackEvent('contact_submit', { form: 'inquiry' });
      updateConsent({ analytics: true, ads: false });
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }

    expect(w.dataLayer[0]).toEqual({ event: 'contact_submit', form: 'inquiry' });
    expect(Array.from(w.dataLayer[1] as ArrayLike<unknown>)).toEqual(['consent', 'update', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }]);
    expect(heatmap).toEqual([true]);
    expect(() => trackEvent('Contact Submit')).toThrow('snake_case');
  });
});
