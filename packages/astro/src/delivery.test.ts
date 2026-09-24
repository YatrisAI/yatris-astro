import { describe, expect, it } from 'vitest';
import { createDeliveryClient, type DeliveryConfig } from './delivery.js';

const ENDPOINT = 'https://api.yatris.test/api/v1/delivery/7';
const KEY = `alk_${'k'.repeat(40)}`;

interface Raw {
  canonical_id: string;
  type: string;
  version: number;
  published_at: string;
  updated_at: string | null;
  payload: Record<string, unknown>;
}

function item(n: number, type = 'works', overrides: Partial<Raw> = {}): Raw {
  return {
    canonical_id: `w-${n}`,
    type,
    version: 1,
    published_at: `2026-09-${String(n).padStart(2, '0')}T10:00:00+09:00`,
    updated_at: `2026-09-${String(n).padStart(2, '0')}T12:00:00+09:00`,
    payload: { title: `実績 ${n}` },
    ...overrides,
  };
}

/** A fake Delivery API serving `items`, paginated the way Laravel does. */
function api(items: Raw[], { failFirst = 0, status }: { failFirst?: number; status?: number } = {}) {
  const requests: { url: string; auth: string | null }[] = [];
  let failures = failFirst;
  const fake: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ url: url.toString(), auth: new Headers(init?.headers).get('Authorization') });
    if (failures-- > 0) return new Response('boom', { status: 503 });
    if (status) return new Response('{}', { status });
    const match = /\/items\/(.+)$/.exec(url.pathname);
    if (match) {
      const found = items.find((i) => i.canonical_id === decodeURIComponent(match[1]));
      return found ? Response.json({ data: found }) : new Response('{}', { status: 404 });
    }
    const perPage = Number(url.searchParams.get('per_page'));
    const page = Number(url.searchParams.get('page'));
    const ofType = items.filter((i) => i.type === url.searchParams.get('type'));
    if (ofType.length === 0) return Response.json({ data: [], meta: { total: 0 } });
    return Response.json({
      data: ofType.slice((page - 1) * perPage, page * perPage),
      meta: { total: ofType.length, per_page: perPage, current_page: page, last_page: Math.ceil(ofType.length / perPage) },
    });
  };
  return { fake, requests };
}

const client = (fake: typeof fetch, extra: DeliveryConfig = {}) =>
  createDeliveryClient({ endpoint: ENDPOINT, apiKey: KEY, fetch: fake, retryDelayMs: 1, ...extra });

describe('Delivery client', () => {
  it('fetches every page, sending the key as a bearer token', async () => {
    const all = Array.from({ length: 230 }, (_, i) => item(i + 1));
    const { fake, requests } = api(all);

    const items = await client(fake).list('works');

    expect(items).toHaveLength(230);
    expect(requests).toHaveLength(3);
    expect(requests.every((r) => r.auth === `Bearer ${KEY}`)).toBe(true);
    expect(requests[0].url).toBe(`${ENDPOINT}/items?type=works&sort=id&per_page=100&page=1`);
  });

  it('maps items and orders them most recently updated first by default', async () => {
    const { fake } = api([item(1), item(3), item(2)]);

    const items = await client(fake).list('works');

    expect(items.map((i) => i.canonicalId)).toEqual(['w-3', 'w-2', 'w-1']);
    expect(items[0]).toEqual({
      canonicalId: 'w-3',
      type: 'works',
      version: 1,
      publishedAt: '2026-09-03T10:00:00+09:00',
      updatedAt: '2026-09-03T12:00:00+09:00',
      data: { title: '実績 3' },
    });
    expect((await client(fake).list('works', { sort: 'published_at' })).map((i) => i.canonicalId)).toEqual(['w-1', 'w-2', 'w-3']);
  });

  it('fails an empty list unless it is expected', async () => {
    const { fake } = api([item(1)]);

    await expect(client(fake).list('news')).rejects.toThrow('Content Type "news" has no published items, or does not exist');
    await expect(client(fake).list('news', { allowEmpty: true })).resolves.toEqual([]);
  });

  it('validates data against a declared schema and names the item', async () => {
    const { fake } = api([item(1), item(2, 'works', { payload: { title: 42 } })]);
    const schema = {
      parse(value: unknown) {
        const title = (value as { title: unknown }).title;
        if (typeof title !== 'string') throw new Error('title must be a string');
        return { title };
      },
    };

    await expect(client(fake).list('works', { schema })).rejects.toThrow(
      'Content Type "works", item w-2: content does not match the declared schema: title must be a string',
    );
  });

  it('fails a malformed envelope or item', async () => {
    const bad: typeof fetch = async () => Response.json({ items: [] });
    await expect(client(bad).list('works')).rejects.toThrow('malformed Delivery response');

    const { fake } = api([item(1, 'works', { version: 'one' as unknown as number })]);
    await expect(client(fake).list('works')).rejects.toThrow('Content Type "works", item w-1: malformed Delivery item');
  });

  it('fails when content changes mid-build instead of rendering a partial site', async () => {
    const lying: typeof fetch = async () =>
      Response.json({ data: [item(1)], meta: { total: 2, per_page: 100, current_page: 1, last_page: 1 } });

    await expect(client(lying).list('works')).rejects.toThrow('received 1 of 2 items');
  });

  it('retries transient failures, then gives up', async () => {
    await expect(client(api([item(1)], { failFirst: 2 }).fake).list('works')).resolves.toHaveLength(1);
    await expect(client(api([item(1)], { failFirst: 3 }).fake).list('works')).rejects.toThrow('HTTP 503');
  });

  it('explains a rejected key without revealing it', async () => {
    const error = await client(api([], { status: 401 }).fake).list('works').catch((e: Error) => e);

    expect(error.message).toContain('rejected the key (HTTP 401)');
    expect(error.message).not.toContain(KEY);
  });

  it('redacts a key that reaches an error message', async () => {
    const leaky: typeof fetch = async () => {
      throw new Error(`socket closed while sending ${KEY}`);
    };
    const error = await client(leaky, { retries: 0 }).list('works').catch((e: Error) => e);

    expect(error.message).toContain('alk_…');
    expect(error.message).not.toContain(KEY);
  });

  it('reads a Singleton and refuses more than one item', async () => {
    const { fake } = api([item(1, 'company')]);
    expect((await client(fake).singleton('company'))?.canonicalId).toBe('w-1');

    const two = api([item(1, 'company'), item(2, 'company')]).fake;
    await expect(client(two).singleton('company')).rejects.toThrow('is a Singleton but has 2 published items');
  });

  it('reads one item and returns null when it is not published', async () => {
    const { fake } = api([item(1)]);

    expect((await client(fake).item('w-1'))?.data).toEqual({ title: '実績 1' });
    expect(await client(fake).item('w-9')).toBeNull();
  });

  it('requires configuration and refuses to send the key over plain http', () => {
    expect(() => createDeliveryClient({ endpoint: '', apiKey: '' })).toThrow('YATRIS_DELIVERY_ENDPOINT and YATRIS_DELIVERY_API_KEY must be set');
    expect(() => createDeliveryClient({ endpoint: 'http://api.yatris.test/x', apiKey: KEY })).toThrow('must use https');
    expect(() => createDeliveryClient({ endpoint: 'http://127.0.0.1:4000/x', apiKey: KEY })).not.toThrow();
  });
});
