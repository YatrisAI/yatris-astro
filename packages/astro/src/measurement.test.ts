import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig } from './config.js';
import { GTM_CONSENT_LOADER, headTags } from './head.js';
import { storedConsent, trackEvent, updateConsent } from './measurement.js';
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
  const scripts = (config: Parameters<typeof withMeasurement>[1]) =>
    headTags({ title: 'Home', description: 'd' }, ctx(config))
      .filter((t) => t.tag === 'script')
      .map((t) => (t as { html: string }).html);

  /** Runs the page's head scripts against a fake browser that records requests. */
  function browse(html: string[], stored: string | null = null) {
    const requested: string[] = [];
    const script = { parentNode: { insertBefore: (el: { src: string }) => requested.push(el.src) } };
    const document = { getElementsByTagName: () => [script], createElement: () => ({ src: '' }) };
    const window: Record<string, unknown> = { localStorage: { getItem: () => stored } };
    for (const code of html) new Function('window', 'document', code)(window, document);
    return { requested, window, dataLayer: () => (window.dataLayer as unknown[]).map((e) => (typeof e === 'object' && e !== null && 'length' in e ? Array.from(e as ArrayLike<unknown>) : e)) };
  }

  it('does not request GTM before consent when consent is required (basic mode)', () => {
    const page = browse(scripts(parseMeasurement(settled)));

    expect(page.requested).toEqual([]);
    expect(page.dataLayer()).toEqual([]);
  });

  it('loads GTM on the grant, with the visitor’s choice as the Consent Mode default', () => {
    const page = browse(scripts(parseMeasurement(settled)));
    const load = page.window[GTM_CONSENT_LOADER] as (c: { analytics: boolean; ads: boolean }) => void;

    load({ analytics: false, ads: true });
    expect(page.requested).toEqual([]);

    load({ analytics: true, ads: false });
    load({ analytics: true, ads: false });
    expect(page.requested).toEqual(['https://www.googletagmanager.com/gtm.js?id=GTM-ABC1234']);
    const [consent, start] = page.dataLayer();
    expect(consent).toEqual(['consent', 'default', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }]);
    expect(start).toMatchObject({ event: 'gtm.js' });
  });

  it('loads GTM straight away when an earlier visit granted consent, and not after a refusal', () => {
    const html = scripts(parseMeasurement(settled));

    expect(browse(html, JSON.stringify({ analytics: true, ads: true })).requested).toHaveLength(1);
    expect(browse(html, JSON.stringify({ analytics: false, ads: false })).requested).toEqual([]);
    expect(browse(html, '{not json').requested).toEqual([]);
  });

  it('loads GTM at once, with no consent default, when the policy does not require consent', () => {
    const page = browse(scripts(parseMeasurement({ ...settled, consentMode: 'not_required' })));

    expect(page.requested).toHaveLength(1);
    expect(page.dataLayer().some((e) => Array.isArray(e) && e[0] === 'consent')).toBe(false);
  });
});

describe('site-code helpers', () => {
  it('pushes semantic events and consent updates, stores the decision and loads a waiting GTM', () => {
    const heatmap: boolean[] = [];
    const loaded: unknown[] = [];
    const storage = new Map<string, string>();
    const w = {
      dataLayer: [] as unknown[],
      localStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
      AutoLogicriHM: { consent: (granted: boolean) => heatmap.push(granted) },
      [GTM_CONSENT_LOADER]: (choice: unknown) => loaded.push(choice),
    };
    (globalThis as { window?: unknown }).window = w;
    let before: unknown;
    let after: unknown;
    try {
      before = storedConsent();
      trackEvent('contact_submit', { form: 'inquiry' });
      updateConsent({ analytics: true, ads: false });
      after = storedConsent();
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }

    expect(before).toBeNull();
    expect(after).toEqual({ analytics: true, ads: false });
    expect(loaded).toEqual([{ analytics: true, ads: false }]);
    expect(w.dataLayer[0]).toEqual({ event: 'contact_submit', form: 'inquiry' });
    expect(Array.from(w.dataLayer[1] as ArrayLike<unknown>)).toEqual(['consent', 'update', { analytics_storage: 'granted', ad_storage: 'denied', ad_user_data: 'denied', ad_personalization: 'denied' }]);
    expect(heatmap).toEqual([true]);
    expect(() => trackEvent('Contact Submit')).toThrow('snake_case');
  });
});
