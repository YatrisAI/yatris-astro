import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import yatris from './index.js';
import { sha256, syncSchema, type SchemaManifest } from './schema.js';
import { checkSchemaContract } from './schema-check.js';

const WEBSITE = 42;

function manifest(revision: string, types: string): SchemaManifest {
  const canonical = `{"content_types":[],"contract":1,"revision":"${revision}","website_id":${WEBSITE}}`;
  return {
    contractVersion: 1,
    websiteId: WEBSITE,
    schemaRevision: revision,
    schemaDigest: sha256(canonical),
    state: 'active',
    canonical,
    generatedFiles: { 'src/generated/yatris-schema.ts': { contents: types, sha256: sha256(types) } },
  };
}

const active = manifest('schema_01active', 'export const schemaRevision = "schema_01active" as const;\n');
const pending = manifest('schema_02pending', 'export const schemaRevision = "schema_02pending" as const;\n');
const ref = (m: SchemaManifest) => ({ id: m.schemaRevision, digest: m.schemaDigest });

const revisioned = (withPending = false) => ({
  contractVersion: 1,
  websiteId: WEBSITE,
  schemaMode: 'revisioned',
  activeRevision: ref(active),
  pendingRevision: withPending ? ref(pending) : null,
});
const immediate = { contractVersion: 1, websiteId: WEBSITE, schemaMode: 'immediate', activeRevision: null, pendingRevision: null };

let root: string;
let requests: string[];

/** A fetch that answers `body` and records every URL it was asked for. */
function answering(body: unknown, status = 200): typeof fetch {
  return (async (url: string) => {
    requests.push(String(url));
    return new Response(JSON.stringify(body), { status });
  }) as typeof fetch;
}

const offline = (async (url: string) => {
  requests.push(String(url));
  throw new Error('no network');
}) as typeof fetch;

function pair(): void {
  mkdirSync(join(root, '.yatris'), { recursive: true });
  writeFileSync(join(root, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: WEBSITE, deliveryEndpoint: `https://app.yatris.jp/api/v1/delivery/${WEBSITE}` }));
}

const check = (command: 'dev' | 'build', fetch: typeof globalThis.fetch, env: Record<string, string> = {}) =>
  checkSchemaContract({ root: pathToFileURL(`${root}/`), command, fetch, env });

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'yatris-schema-check-'));
  requests = [];
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(root, { recursive: true, force: true });
});

describe('build-time schema check', () => {
  it('makes no request for an unpaired project', async () => {
    await expect(check('build', offline)).resolves.toBeNull();
    expect(requests).toEqual([]);
  });

  it('makes no request in dev', async () => {
    pair();
    await expect(check('dev', offline)).resolves.toBeNull();
    expect(requests).toEqual([]);
  });

  it('leaves an immediate-mode site alone, lock or no lock', async () => {
    pair();
    await expect(check('build', answering(immediate))).resolves.toEqual({ schemaMode: 'immediate' });
    expect(requests).toEqual([`https://app.yatris.jp/api/v1/sites/${WEBSITE}/schema`]);
  });

  it('passes a revisioned site locked to the active revision', async () => {
    pair();
    syncSchema(root, active);
    await expect(check('build', answering(revisioned()))).resolves.toEqual({ schemaMode: 'revisioned', revision: 'schema_01active', state: 'active' });
  });

  it('passes the pending revision, whose production deployment precedes its activation', async () => {
    pair();
    syncSchema(root, pending);
    await expect(check('build', answering(revisioned(true)))).resolves.toEqual({ schemaMode: 'revisioned', revision: 'schema_02pending', state: 'pending' });
  });

  it('fails a revisioned site whose lock does not match the active revision', async () => {
    pair();
    syncSchema(root, pending);
    await expect(check('build', answering(revisioned()))).rejects.toThrow(
      /schema check failed: \.yatris\/schema\.lock\.json is locked to schema_02pending \(sha256:[0-9a-f]{64}\), but Yatris expects schema_01active/,
    );
  });

  it('fails a lock that names the right revision with another digest', async () => {
    pair();
    syncSchema(root, active);
    const contract = { ...revisioned(), activeRevision: { id: active.schemaRevision, digest: pending.schemaDigest } };
    await expect(check('build', answering(contract))).rejects.toThrow('but Yatris expects schema_01active');
  });

  it('fails a revisioned site without a lock', async () => {
    pair();
    await expect(check('build', answering(revisioned()))).rejects.toThrow('.yatris/schema.lock.json is missing');
  });

  it('fails when the generated files do not verify against the lock', async () => {
    pair();
    syncSchema(root, active);
    writeFileSync(join(root, 'src/generated/yatris-schema.ts'), 'export const edited = true;\n');
    await expect(check('build', answering(revisioned()))).rejects.toThrow(/do not verify[\s\S]*schema-generated-drift src\/generated\/yatris-schema\.ts/);
  });

  it('fails rather than deploy unchecked when Yatris cannot be read', async () => {
    pair();
    syncSchema(root, active);
    await expect(check('build', offline)).rejects.toThrow('could not read the schema contract');
    await expect(check('build', answering({ error: 'x' }, 503))).rejects.toThrow('failed with HTTP 503');
    // The measurement escape hatch does not skip the schema
    await expect(check('build', offline, { YATRIS_MEASUREMENT: 'off' })).rejects.toThrow('could not read the schema contract');
  });

  it('refuses an answer for another Website or in an unknown shape', async () => {
    pair();
    syncSchema(root, active);
    await expect(check('build', answering({ ...revisioned(), websiteId: 7 }))).rejects.toThrow('answered for Website 7');
    await expect(check('build', answering({ ...revisioned(), contractVersion: 2 }))).rejects.toThrow('cannot read');
    await expect(check('build', answering({ ...revisioned(), activeRevision: { id: 'x', digest: 'md5:1' } }))).rejects.toThrow('malformed');
  });

  it('asks YATRIS_URL when it is set', async () => {
    pair();
    await check('build', answering(immediate), { YATRIS_URL: 'http://127.0.0.1:8000/' });
    expect(requests).toEqual([`http://127.0.0.1:8000/api/v1/sites/${WEBSITE}/schema`]);
  });
});

describe('the integration', () => {
  const setup = (command: 'dev' | 'build') =>
    yatris().hooks['astro:config:setup']({ config: { root: pathToFileURL(`${root}/`) }, command, updateConfig: (config) => config });

  /** Global fetch as a production build sees it: schema and measurement from Yatris. */
  function yatrisAnswers(contract: unknown): void {
    vi.stubGlobal('fetch', async (url: string) => {
      requests.push(String(url));
      const body = String(url).endsWith('/schema') ? contract : { contractVersion: 1, gtmContainerId: null, consentMode: null, searchConsoleVerification: null };
      return new Response(JSON.stringify(body));
    });
  }

  it('fails a paired production build on a mismatched lock', async () => {
    pair();
    syncSchema(root, pending);
    yatrisAnswers(revisioned());
    await expect(setup('build')).rejects.toThrow('but Yatris expects schema_01active');
  });

  it('builds a matching site', async () => {
    pair();
    syncSchema(root, active);
    yatrisAnswers(revisioned());
    await expect(setup('build')).resolves.toBeUndefined();
    expect(requests).toContain(`https://app.yatris.jp/api/v1/sites/${WEBSITE}/schema`);
  });

  it('asks nothing in dev', async () => {
    pair();
    yatrisAnswers(revisioned());
    await expect(setup('dev')).resolves.toBeUndefined();
    expect(requests).toEqual([]);
  });
});
