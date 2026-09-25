import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { looksLikeCredential, mcpFiles, type McpDescriptor } from './mcp.js';
import { emptyLock, LOCK_PATH, readLock } from './schema.js';

/**
 * Pairing a repository with its Yatris Website (spec §8 / YatrisCMS#270).
 *
 * Staff issue a single-use setup code in the Yatris dashboard (15 minutes).
 * `npm create yatris … --connect CODE` or `yatris connect CODE` trades it for
 * the Website's non-secret identity and the canonical MCP descriptor, and
 * writes only that. Nothing secret is ever written: agent clients sign in to
 * the MCP server themselves, and the Delivery key waits for content design.
 */

export const PROJECT_PATH = '.yatris/project.json';

export interface SiteIdentity {
  contractVersion: 1;
  website: { id: number; name: string; url: string | null; timezone: string | null; status: string };
  mcp: McpDescriptor;
  delivery: { endpoint: string; credentials: 'deferred' };
  schema: { mode: string; revision: string | null };
}

export interface ExchangeOptions {
  /** The Yatris origin, for example https://app.yatris.jp */
  apiBase: string;
  client: { name: string; version: string };
  fetch?: typeof fetch;
}

/** The Yatris origin that serves the MCP server named in the platform manifest. */
export function apiBaseFrom(mcpUrl: string): string {
  return new URL(mcpUrl).origin;
}

export async function exchangeSetupCode(code: string, options: ExchangeOptions): Promise<SiteIdentity> {
  const doFetch = options.fetch ?? fetch;
  const url = `${options.apiBase.replace(/\/$/, '')}/api/v1/setup/exchange`;

  let response: Response;
  try {
    response = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ code, client: options.client }),
    });
  } catch (error) {
    throw new Error(`could not reach Yatris at ${options.apiBase} (${(error as Error).message}).`);
  }

  const text = await response.text();
  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      message = (JSON.parse(text) as { message?: string }).message ?? message;
    } catch {
      // not JSON: keep the status
    }
    throw new Error(`the setup code was not accepted: ${message}`);
  }

  return parseIdentity(JSON.parse(text));
}

/**
 * Validates the exchange answer, and refuses one that carries anything
 * credential-like: the contract is that nothing secret crosses.
 */
export function parseIdentity(value: unknown): SiteIdentity {
  const identity = value as Partial<SiteIdentity> | null;
  const id = identity?.website?.id;
  const url = identity?.mcp?.server?.url;

  if (identity?.contractVersion !== 1 || typeof id !== 'number' || typeof url !== 'string' || !url.startsWith('https://') && !url.startsWith('http://localhost')) {
    throw new Error('Yatris returned an identity this version cannot read.');
  }

  if (looksLikeCredential(JSON.stringify({ ...identity, delivery: { ...identity.delivery, credentials: undefined } }))) {
    throw new Error('Yatris returned something that looks like a credential; refusing to write it.');
  }

  return identity as SiteIdentity;
}

/**
 * Writes the pairing into the project: the site identity in
 * `.yatris/project.json`, the MCP descriptor and adapters, and the Website
 * on an still-empty schema lock. Refuses a project already paired to a
 * different Website unless `force` is set. Returns the files written.
 */
export function pairProject(root: string, identity: SiteIdentity, options: { force?: boolean } = {}): string[] {
  const projectPath = join(root, PROJECT_PATH);
  const project = existsSync(projectPath) ? (JSON.parse(readFileSync(projectPath, 'utf8')) as Record<string, unknown>) : { contractVersion: 1, environment: 'production' };

  if (typeof project.websiteId === 'number' && project.websiteId !== identity.website.id && !options.force) {
    throw new Error(`this project is already paired with Website ${project.websiteId}; pass --force to pair it with Website ${identity.website.id}.`);
  }

  const files: Record<string, string> = {
    [PROJECT_PATH]: `${JSON.stringify({
      ...project,
      contractVersion: 1,
      websiteId: identity.website.id,
      site: { name: identity.website.name, url: identity.website.url, timezone: identity.website.timezone },
      deliveryEndpoint: identity.delivery.endpoint,
    }, null, 2)}\n`,
    ...mcpFiles(identity.mcp),
  };

  const lock = readLock(root);
  if (lock === null || (lock.schemaRevision === null && lock.websiteId !== identity.website.id)) {
    files[LOCK_PATH] = `${JSON.stringify(emptyLock(identity.website.id), null, 2)}\n`;
  }

  for (const [path, contents] of Object.entries(files)) {
    if (looksLikeCredential(contents)) {
      throw new Error(`refusing to write ${path}: it would contain something credential-like.`);
    }
  }

  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }

  return Object.keys(files);
}
