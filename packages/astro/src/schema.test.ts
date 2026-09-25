import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './commands.js';
import { emptyLock, LOCK_PATH, parseManifest, sha256, syncSchema, verifySchema, type SchemaManifest } from './schema.js';

const TYPES = 'export const schemaRevision = "schema_01abc" as const;\n';

function manifest(overrides: Partial<SchemaManifest> = {}, contents = TYPES): SchemaManifest {
  const canonical = '{"content_types":[],"contract":1,"website_id":7}';
  return {
    contractVersion: 1,
    websiteId: 7,
    schemaRevision: 'schema_01abc',
    schemaDigest: sha256(canonical),
    state: 'active',
    canonical,
    generatedFiles: { 'src/generated/yatris-schema.ts': { contents, sha256: sha256(contents) } },
    ...overrides,
  };
}

let site: string;
const codes = (findings: { code: string }[]) => findings.map((f) => f.code);

beforeEach(() => {
  site = mkdtempSync(join(tmpdir(), 'yatris-schema-'));
  mkdirSync(join(site, '.yatris'));
  writeFileSync(join(site, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: 7 }));
});
afterEach(() => {
  rmSync(site, { recursive: true, force: true });
});

describe('schema manifest', () => {
  it('accepts a consistent manifest', () => {
    expect(parseManifest(manifest()).schemaRevision).toBe('schema_01abc');
  });

  it('rejects a canonical schema that does not match its digest', () => {
    expect(() => parseManifest(manifest({ schemaDigest: 'sha256:0000' }))).toThrow('digest mismatch');
  });

  it('rejects generated contents that do not match their hash', () => {
    const m = manifest();
    m.generatedFiles['src/generated/yatris-schema.ts'].contents += '// edited';
    expect(() => parseManifest(m)).toThrow('does not match its hash');
  });

  it('refuses to write outside src/generated/', () => {
    const m = manifest();
    m.generatedFiles = { 'astro.config.mjs': { contents: 'x', sha256: sha256('x') } };
    expect(() => parseManifest(m)).toThrow('outside src/generated/');
  });
});

describe('schema sync and verify', () => {
  it('writes the generated file and a lock that verifies', () => {
    const lock = syncSchema(site, manifest());

    expect(readFileSync(join(site, 'src/generated/yatris-schema.ts'), 'utf8')).toBe(TYPES);
    expect(lock).toEqual({
      contractVersion: 1,
      websiteId: 7,
      schemaRevision: 'schema_01abc',
      schemaDigest: manifest().schemaDigest,
      generatedFiles: { 'src/generated/yatris-schema.ts': sha256(TYPES) },
    });
    expect(verifySchema(site)).toEqual([]);
    expect(verifySchema(site, manifest())).toEqual([]);
  });

  it('refuses a manifest for another Website', () => {
    expect(() => syncSchema(site, manifest({ websiteId: 8 }))).toThrow('Website 8');
  });

  it('catches a hand-edited generated file', () => {
    syncSchema(site, manifest());
    writeFileSync(join(site, 'src/generated/yatris-schema.ts'), TYPES + 'export type Hack = 1;\n');

    expect(codes(verifySchema(site))).toEqual(['schema-generated-drift']);
  });

  it('catches a repository locked to a different revision than expected', () => {
    syncSchema(site, manifest());
    const newer = 'export const schemaRevision = "schema_02def" as const;\n';
    const expected = manifest({ schemaRevision: 'schema_02def', schemaDigest: sha256('{"v":2}'), canonical: '{"v":2}' }, newer);

    expect(codes(verifySchema(site, expected))).toEqual(['schema-revision-mismatch', 'schema-generated-mismatch']);
  });

  it('requires a lock, and accepts the explicit empty lock of a new site', () => {
    expect(codes(verifySchema(site))).toEqual(['schema-lock-missing']);

    writeFileSync(join(site, LOCK_PATH), JSON.stringify(emptyLock()));
    expect(verifySchema(site)).toEqual([]);
  });
});

describe('yatris schema CLI', () => {
  it('syncs, reports status and verifies', async () => {
    const file = join(site, '..', `manifest-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(manifest()));

    expect((await run(['schema', 'sync', `--manifest=${file}`], { cwd: site })).stdout).toContain('Synced to schema_01abc');
    expect((await run(['schema', 'status'], { cwd: site })).stdout).toBe(`Website 7: schema_01abc (${manifest().schemaDigest})`);
    expect((await run(['schema', 'verify', `--manifest=${file}`], { cwd: site })).code).toBe(0);

    writeFileSync(join(site, 'src/generated/yatris-schema.ts'), 'tampered');
    const failed = await run(['schema', 'verify'], { cwd: site });
    expect(failed.code).toBe(1);
    expect(failed.stderr).toContain('schema-generated-drift');
    rmSync(file);
  });

  it('explains a missing manifest argument', async () => {
    expect((await run(['schema', 'sync'], { cwd: site })).stderr).toContain('--manifest=<file> is required');
  });
});
