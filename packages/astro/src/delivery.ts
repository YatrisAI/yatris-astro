/**
 * Build-time client for the Yatris Content Delivery API. It serves published
 * content only, fetches every page, and fails the build loudly rather than
 * rendering a partial or malformed site. Never import it into browser code.
 */

/** One published content item. `data` is the item's field values. */
export interface DeliveryItem<T = Record<string, unknown>> {
  canonicalId: string;
  type: string;
  version: number;
  publishedAt: string;
  updatedAt: string | null;
  data: T;
}

/** Anything with a `parse` method, such as a zod schema from `astro/zod`. */
export interface Parser<T> {
  parse(value: unknown): T;
}

export type DeliverySort = 'updated_at' | '-updated_at' | 'published_at' | '-published_at';

export interface ListOptions<T> {
  /** Validates and types each item's data; a failure fails the build. */
  schema?: Parser<T>;
  /** Whether zero published items is expected. Otherwise an empty result fails the build. */
  allowEmpty?: boolean;
  /** Order of the returned items. Defaults to most recently updated first. */
  sort?: DeliverySort;
}

export interface DeliveryConfig {
  /** `…/api/v1/delivery/{websiteId}`; defaults to `YATRIS_DELIVERY_ENDPOINT`. */
  endpoint?: string;
  /** A `delivery:read` key; defaults to `YATRIS_DELIVERY_API_KEY`. */
  apiKey?: string;
  fetch?: typeof fetch;
  /** Retries after a network error or 5xx response. */
  retries?: number;
  retryDelayMs?: number;
}

export class YatrisDeliveryError extends Error {
  override name = 'YatrisDeliveryError';
  constructor(message: string) {
    super(redact(message));
  }
}

const PAGE_SIZE = 100;

export interface DeliveryClient {
  list<T = Record<string, unknown>>(type: string, options?: ListOptions<T>): Promise<DeliveryItem<T>[]>;
  singleton<T = Record<string, unknown>>(type: string, options?: Omit<ListOptions<T>, 'sort'>): Promise<DeliveryItem<T> | null>;
  item<T = Record<string, unknown>>(canonicalId: string, options?: { schema?: Parser<T> }): Promise<DeliveryItem<T> | null>;
}

export function createDeliveryClient(config: DeliveryConfig = {}): DeliveryClient {
  if (typeof window !== 'undefined') {
    throw new YatrisDeliveryError('the Yatris Delivery client runs at build time only; never import it into browser code');
  }
  const endpoint = (config.endpoint ?? process.env.YATRIS_DELIVERY_ENDPOINT ?? '').replace(/\/+$/, '');
  const apiKey = config.apiKey ?? process.env.YATRIS_DELIVERY_API_KEY ?? '';
  const doFetch = config.fetch ?? fetch;
  const retries = config.retries ?? 2;
  const retryDelayMs = config.retryDelayMs ?? 500;

  if (!endpoint || !apiKey) {
    throw new YatrisDeliveryError(
      'YATRIS_DELIVERY_ENDPOINT and YATRIS_DELIVERY_API_KEY must be set to read Yatris content (use an ignored .env file locally)',
    );
  }
  const base = parseEndpoint(endpoint);

  async function get(path: string, context: string): Promise<{ status: number; body: unknown }> {
    const url = `${base}${path}`;
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await doFetch(url, { headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' } });
      } catch (error) {
        if (attempt < retries) {
          await sleep(retryDelayMs * 2 ** attempt);
          continue;
        }
        throw new YatrisDeliveryError(`${context}: could not reach the Delivery API (${(error as Error).message})`);
      }
      if (response.status >= 500 && attempt < retries) {
        await sleep(retryDelayMs * 2 ** attempt);
        continue;
      }
      if (response.status === 404) return { status: 404, body: null };
      if (response.status === 401 || response.status === 403) {
        throw new YatrisDeliveryError(`${context}: the Delivery API rejected the key (HTTP ${response.status}); check YATRIS_DELIVERY_API_KEY`);
      }
      if (!response.ok) {
        throw new YatrisDeliveryError(`${context}: the Delivery API answered HTTP ${response.status}`);
      }
      try {
        return { status: response.status, body: await response.json() };
      } catch {
        throw new YatrisDeliveryError(`${context}: the Delivery API returned a body that is not JSON`);
      }
    }
  }

  async function list<T>(type: string, options: ListOptions<T> = {}): Promise<DeliveryItem<T>[]> {
    const context = `Content Type "${type}"`;
    const items: DeliveryItem<T>[] = [];
    const seen = new Set<string>();
    let lastPage = 1;
    let total = 0;

    for (let page = 1; page <= lastPage; page++) {
      const query = new URLSearchParams({ type, sort: 'id', per_page: String(PAGE_SIZE), page: String(page) });
      const { status, body } = await get(`/items?${query}`, context);
      if (status === 404) {
        throw new YatrisDeliveryError(`${context}: the Delivery endpoint was not found; check YATRIS_DELIVERY_ENDPOINT`);
      }
      const envelope = parseListEnvelope(body, `${context}, page ${page}`);
      total = envelope.total;
      lastPage = envelope.lastPage;
      for (const raw of envelope.data) {
        const item = parseItem(raw, context, options.schema);
        if (item.type !== type) {
          throw new YatrisDeliveryError(`${context}: item ${item.canonicalId} has type "${item.type}"`);
        }
        if (seen.has(item.canonicalId)) {
          throw new YatrisDeliveryError(`${context}: item ${item.canonicalId} was delivered twice; content changed during the build, so retry it`);
        }
        seen.add(item.canonicalId);
        items.push(item);
      }
    }

    if (items.length !== total) {
      throw new YatrisDeliveryError(`${context}: received ${items.length} of ${total} items; content changed during the build, so retry it`);
    }
    if (items.length === 0 && !options.allowEmpty) {
      throw new YatrisDeliveryError(
        `${context} has no published items, or does not exist. Pass { allowEmpty: true } where an empty list is expected and render an empty state.`,
      );
    }
    return sortItems(items, options.sort ?? '-updated_at');
  }

  return {
    list,
    async singleton<T>(type: string, options: Omit<ListOptions<T>, 'sort'> = {}) {
      const items = await list(type, { ...options, allowEmpty: true });
      if (items.length > 1) {
        throw new YatrisDeliveryError(`Content Type "${type}" is a Singleton but has ${items.length} published items`);
      }
      if (items.length === 0 && !options.allowEmpty) {
        throw new YatrisDeliveryError(`Content Type "${type}" has no published item. Pass { allowEmpty: true } if that is expected.`);
      }
      return items[0] ?? null;
    },
    async item<T>(canonicalId: string, options: { schema?: Parser<T> } = {}) {
      const context = `item ${canonicalId}`;
      const { status, body } = await get(`/items/${encodeURIComponent(canonicalId)}`, context);
      if (status === 404) return null;
      if (!isRecord(body) || !('data' in body)) {
        throw new YatrisDeliveryError(`${context}: the Delivery API response has no "data"`);
      }
      return parseItem(body.data, context, options.schema);
    },
  };
}

let defaultClient: DeliveryClient | undefined;
const client = () => (defaultClient ??= createDeliveryClient());

/** Every published item of a List (or Taxonomy) Content Type. */
export function getYatrisList<T = Record<string, unknown>>(type: string, options?: ListOptions<T>) {
  return client().list<T>(type, options);
}

/** The published item of a Singleton Content Type. */
export function getYatrisSingleton<T = Record<string, unknown>>(type: string, options?: Omit<ListOptions<T>, 'sort'>) {
  return client().singleton<T>(type, options);
}

/** One published item by canonical ID, or null. */
export function getYatrisItem<T = Record<string, unknown>>(canonicalId: string, options?: { schema?: Parser<T> }) {
  return client().item<T>(canonicalId, options);
}

function parseEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new YatrisDeliveryError(`YATRIS_DELIVERY_ENDPOINT is not a URL: ${endpoint}`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new YatrisDeliveryError('YATRIS_DELIVERY_ENDPOINT must use https so the key is never sent in clear text');
  }
  return endpoint;
}

function parseListEnvelope(body: unknown, context: string): { data: unknown[]; total: number; lastPage: number } {
  if (!isRecord(body) || !Array.isArray(body.data) || !isRecord(body.meta)) {
    throw new YatrisDeliveryError(`${context}: malformed Delivery response (expected { data: [], meta: {} })`);
  }
  const { total, last_page: lastPage } = body.meta;
  if (typeof total !== 'number') {
    throw new YatrisDeliveryError(`${context}: malformed Delivery response (meta.total is missing)`);
  }
  // An unknown Content Type is answered with { data: [], meta: { total: 0 } }.
  if (lastPage === undefined && total === 0 && body.data.length === 0) {
    return { data: [], total: 0, lastPage: 1 };
  }
  if (typeof lastPage !== 'number') {
    throw new YatrisDeliveryError(`${context}: malformed Delivery response (meta.last_page is missing)`);
  }
  return { data: body.data, total, lastPage: Math.max(lastPage, 1) };
}

function parseItem<T>(raw: unknown, context: string, schema?: Parser<T>): DeliveryItem<T> {
  const id = isRecord(raw) && typeof raw.canonical_id === 'string' ? raw.canonical_id : undefined;
  const where = `${context}, item ${id ?? '(no canonical_id)'}`;
  if (
    !isRecord(raw) ||
    id === undefined ||
    typeof raw.type !== 'string' ||
    typeof raw.version !== 'number' ||
    typeof raw.published_at !== 'string' ||
    !(raw.updated_at === null || typeof raw.updated_at === 'string') ||
    !isRecord(raw.payload)
  ) {
    throw new YatrisDeliveryError(`${where}: malformed Delivery item`);
  }
  let data: T;
  try {
    data = schema ? schema.parse(raw.payload) : (raw.payload as T);
  } catch (error) {
    throw new YatrisDeliveryError(`${where}: content does not match the declared schema: ${(error as Error).message}`);
  }
  return { canonicalId: id, type: raw.type, version: raw.version, publishedAt: raw.published_at, updatedAt: raw.updated_at, data };
}

function sortItems<T>(items: DeliveryItem<T>[], sort: DeliverySort): DeliveryItem<T>[] {
  const descending = sort.startsWith('-');
  const key = (sort.replace(/^-/, '') === 'published_at' ? 'publishedAt' : 'updatedAt') as 'publishedAt' | 'updatedAt';
  const time = (value: string | null) => (value ? Date.parse(value) : 0);
  return [...items].sort((a, b) => {
    const order = time(a[key]) - time(b[key]);
    return descending ? -order : order;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redact(message: string): string {
  return message.replace(/alk_[A-Za-z0-9]+/g, 'alk_…');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
