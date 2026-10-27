import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDeliveryClient } from './delivery.js';
import yatris from './index.js';
import { mergeRedirects, redirectLines, slugPath } from './slug-redirects.js';

const ENDPOINT = 'https://api.yatris.test/api/v1/delivery/7';
const KEY = `alk_${'k'.repeat(40)}`;

const items = [
  { canonical_id: 'w-1', slug: 'kitchen-reform', number: 1, type: 'works', version: 2, published_at: '2026-10-01T10:00:00+09:00', updated_at: null, payload: { title: 'キッチン' } },
  { canonical_id: 'w-2', slug: '浴室', number: 2, type: 'works', version: 1, published_at: '2026-10-02T10:00:00+09:00', updated_at: null, payload: { title: '浴室' } },
];
const redirects = [
  { type: 'news', from: 'old-news', to: 'new-news' },
  { type: 'works', from: 'kitchen', to: 'kitchen-reform' },
  { type: 'works', from: '旧浴室', to: '浴室' },
];

/** A Delivery API with item slugs: `?type=&slug=` and `/redirects`. */
function api() {
  const requests: string[] = [];
  const fake: typeof fetch = async (input) => {
    const url = new URL(String(input));
    requests.push(url.pathname + url.search);
    if (url.pathname.endsWith('/redirects')) {
      const type = url.searchParams.get('type');
      return Response.json({ data: redirects.filter((r) => type === null || r.type === type) });
    }
    const slug = url.searchParams.get('slug');
    const found = items.filter((i) => i.type === url.searchParams.get('type') && (slug === null || i.slug === slug));
    return Response.json({ data: found, meta: { total: found.length, per_page: 100, current_page: 1, last_page: 1 } });
  };
  return { fake, requests };
}

const client = (fake: typeof fetch) => createDeliveryClient({ endpoint: ENDPOINT, apiKey: KEY, fetch: fake, retryDelayMs: 1 });

describe('item slugs from Delivery', () => {
  it('serves each item with its slug and number, and finds one by slug', async () => {
    const { fake, requests } = api();

    const [first] = await client(fake).list('works');
    expect(first).toMatchObject({ slug: 'kitchen-reform', number: 1 });

    const bath = await client(fake).bySlug('works', '浴室');
    expect(bath?.canonicalId).toBe('w-2');
    expect(requests.at(-1)).toBe(`/api/v1/delivery/7/items?type=works&slug=${encodeURIComponent('浴室')}`);
    expect(await client(fake).bySlug('works', 'missing')).toBeNull();
  });

  it('reads an item from a server that predates slugs as having none', async () => {
    const legacy: typeof fetch = async () => {
      const { slug: _slug, number: _number, ...rest } = items[0];
      return Response.json({ data: [rest], meta: { total: 1, last_page: 1 } });
    };
    const [item] = await client(legacy).list('works');
    expect(item).toMatchObject({ slug: null, number: null });
  });

  it('lists redirects, all or of one type, and none from a server without them', async () => {
    const { fake } = api();
    expect(await client(fake).redirects()).toHaveLength(3);
    expect(await client(fake).redirects('works')).toEqual(redirects.slice(1));
    expect(await client(async () => new Response('{}', { status: 404 })).redirects()).toEqual([]);
  });
});

describe('_redirects', () => {
  it('writes a 301 per old slug of a routed type, with and without the trailing slash, percent-encoding the slug', () => {
    expect(slugPath('/works/[slug]/', '浴室')).toBe(`/works/${encodeURIComponent('浴室')}/`);
    const [old, current] = [encodeURIComponent('旧浴室'), encodeURIComponent('浴室')];
    expect(redirectLines(redirects, { works: '/works/[slug]/' })).toEqual({
      lines: [
        '/works/kitchen/ /works/kitchen-reform/ 301',
        '/works/kitchen /works/kitchen-reform/ 301',
        `/works/${old}/ /works/${current}/ 301`,
        `/works/${old} /works/${current}/ 301`,
      ],
      unrouted: ['news'],
    });
    expect(redirectLines(redirects.slice(1, 2), { works: '/works/[slug].html' }).lines).toEqual(['/works/kitchen.html /works/kitchen-reform.html 301']);
  });

  it('keeps the site’s own rules first and lets them win, and replaces an earlier generated block', () => {
    const own = '/old-page /new-page 301\n/works/kitchen/ /works/special/ 302\n';
    const merged = mergeRedirects(own, ['/works/kitchen/ /works/kitchen-reform/ 301', '/works/a/ /works/b/ 301']);

    expect(merged.startsWith(own)).toBe(true);
    expect(merged).not.toContain('/works/kitchen/ /works/kitchen-reform/ 301');
    expect(merged).toContain('/works/a/ /works/b/ 301');
    expect(mergeRedirects(merged, ['/works/c/ /works/d/ 301'])).toBe(`${own}\n# Yatris: old item URLs, written at build time (YatrisCMS#519)\n/works/c/ /works/d/ 301\n`);
    expect(mergeRedirects('', [])).toBe('');
  });
});

describe('the integration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('rejects a slug route without [slug]', () => {
    expect(() => yatris({ slugRoutes: { works: '/works/' } })).toThrow('slugRoutes.works must be a path with one [slug]');
  });

  it('writes the routed types’ redirects into the built _redirects after the site’s own', async () => {
    vi.stubEnv('YATRIS_DELIVERY_ENDPOINT', ENDPOINT);
    vi.stubEnv('YATRIS_DELIVERY_API_KEY', KEY);
    vi.stubEnv('YATRIS_PREVIEW_URL', '');
    vi.stubGlobal('fetch', api().fake);
    const root = mkdtempSync(join(tmpdir(), 'yatris-slugs-'));
    const out = join(root, 'dist');
    mkdirSync(out);
    writeFileSync(join(out, '_redirects'), '/old-page /new-page 301\n');
    const logger = { info: vi.fn(), warn: vi.fn() };
    const integration = yatris({ slugRoutes: { works: '/works/[slug]/' } });

    await integration.hooks['astro:config:setup']({ config: { root: pathToFileURL(`${root}/`) }, command: 'build', updateConfig: () => undefined, logger });
    await integration.hooks['astro:build:done']({ pages: [], dir: pathToFileURL(`${out}/`), logger });

    const written = readFileSync(join(out, '_redirects'), 'utf8');
    expect(written.startsWith('/old-page /new-page 301\n')).toBe(true);
    expect(written).toContain('/works/kitchen/ /works/kitchen-reform/ 301\n/works/kitchen /works/kitchen-reform/ 301\n');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('old slugs of news'));
    expect(logger.info).toHaveBeenCalledWith('slug redirects: 2 old item URLs redirect to the current page');
  });
});
