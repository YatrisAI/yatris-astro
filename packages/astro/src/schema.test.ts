import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run } from './commands.js';
import { verifyAgainstContract } from './schema-check.js';
import { emptyLock, generateZodModule, LOCK_PATH, parseManifest, readLock, sha256, syncSchema, verifySchema, ZOD_GENERATOR, ZOD_OUTDATED, ZOD_PATH, type SchemaLock, type SchemaManifest } from './schema.js';

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
    // The zod schemas derived from the canonical schema are pinned alongside (YatrisCMS#307)
    const zod = readFileSync(join(site, ZOD_PATH), 'utf8');
    expect(zod).toBe(generateZodModule(manifest().canonical, 'schema_01abc'));
    expect(lock).toEqual({
      contractVersion: 1,
      websiteId: 7,
      schemaRevision: 'schema_01abc',
      schemaDigest: manifest().schemaDigest,
      generatedFiles: { 'src/generated/yatris-schema.ts': sha256(TYPES), [ZOD_PATH]: sha256(zod) },
      // The zod generator it was written with, so a later release verifies it as written (YatrisCMS#329)
      zodGenerator: ZOD_GENERATOR,
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

  it('catches a hand-edited zod schema file', () => {
    syncSchema(site, manifest());
    writeFileSync(join(site, ZOD_PATH), readFileSync(join(site, ZOD_PATH), 'utf8').replace('z.string()', 'z.any()'));

    expect(codes(verifySchema(site))).toEqual(['schema-generated-drift']);
  });

  it('keeps a zod file Yatris sends itself instead of deriving one', () => {
    const own = '// from Yatris\n';
    const m = manifest();
    m.generatedFiles[ZOD_PATH] = { contents: own, sha256: sha256(own) };

    const lock = syncSchema(site, m);
    expect(lock.generatedFiles[ZOD_PATH]).toBe(sha256(own));
    expect(lock.zodGenerator).toBeUndefined();
    expect(readFileSync(join(site, ZOD_PATH), 'utf8')).toBe(own);
    expect(verifySchema(site, m)).toEqual([]);
  });

  it('catches a repository locked to a different revision than expected', () => {
    syncSchema(site, manifest());
    const newer = 'export const schemaRevision = "schema_02def" as const;\n';
    const expected = manifest({ schemaRevision: 'schema_02def', schemaDigest: sha256('{"v":2}'), canonical: '{"v":2}' }, newer);

    expect(codes(verifySchema(site, expected))).toEqual(['schema-revision-mismatch', 'schema-generated-mismatch', 'schema-generated-mismatch']);
  });

  it('requires a lock, and reports the empty lock of a new site as unsynced, not missing', () => {
    expect(codes(verifySchema(site))).toEqual(['schema-lock-missing']);

    writeFileSync(join(site, LOCK_PATH), JSON.stringify(emptyLock(7)));
    const findings = verifySchema(site);
    expect(codes(findings)).toEqual(['schema-lock-unsynced']);
    expect(findings[0].severity).toBe('warning');
    expect(findings[0].message).toContain('yatris://websites/7/schema');
  });

  it('reports an unsynced lock checked against a manifest as a revision mismatch', () => {
    writeFileSync(join(site, LOCK_PATH), JSON.stringify(emptyLock(7)));
    const findings = verifySchema(site, manifest());

    // One per synced file: Yatris's generated types and the derived zod module (#307)
    expect(codes(findings)).toEqual(['schema-revision-mismatch', 'schema-generated-mismatch', 'schema-generated-mismatch']);
    expect(findings[0].message).toContain('no revision has been synced yet, expected schema_01abc');
  });
});

describe('a lock written by an older zod generator (YatrisCMS#329)', () => {
  /** The repository as @yatris/astro 0.3.0's sync left it: zod generator 1, and no version in the lock. */
  function syncedBy030(): SchemaLock {
    const m = manifest();
    const zod = generateZodModule(m.canonical, m.schemaRevision, 1);
    mkdirSync(join(site, 'src/generated'), { recursive: true });
    writeFileSync(join(site, 'src/generated/yatris-schema.ts'), TYPES);
    writeFileSync(join(site, ZOD_PATH), zod);
    const lock: SchemaLock = {
      contractVersion: 1,
      websiteId: 7,
      schemaRevision: m.schemaRevision,
      schemaDigest: m.schemaDigest,
      generatedFiles: { 'src/generated/yatris-schema.ts': sha256(TYPES), [ZOD_PATH]: sha256(zod) },
    };
    writeFileSync(join(site, LOCK_PATH), `${JSON.stringify(lock, null, 2)}\n`);
    return lock;
  }

  it('still verifies, with or without the manifest, and only warns that a sync would add variants', () => {
    syncedBy030();

    for (const findings of [verifySchema(site), verifySchema(site, manifest())]) {
      expect(codes(findings)).toEqual([ZOD_OUTDATED]);
      expect(findings[0]).toMatchObject({ severity: 'warning', file: ZOD_PATH });
      expect(findings[0].message).toContain('yatris schema sync --manifest <file>');
      expect(findings[0].message).toContain('schema_01abc');
    }
  });

  it('exits 0 from `yatris schema verify`, printing the warning', async () => {
    syncedBy030();
    const file = join(site, '..', `manifest-old-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(manifest()));

    for (const args of [['schema', 'verify'], ['schema', 'verify', `--manifest=${file}`]]) {
      const result = await run(args, { cwd: site });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`⚠ ${ZOD_OUTDATED} ${ZOD_PATH}`);
    }
    rmSync(file);
  });

  it('passes the build-time schema check unchanged', () => {
    syncedBy030();
    const revision = { id: 'schema_01abc', digest: manifest().schemaDigest };

    expect(verifyAgainstContract(site, { schemaMode: 'revisioned', activeRevision: revision, pendingRevision: null })).toEqual({
      schemaMode: 'revisioned',
      revision: 'schema_01abc',
      state: 'active',
    });
  });

  it('is regenerated with variants, and the version recorded, by the next sync of the same revision', () => {
    const before = syncedBy030();
    const lock = syncSchema(site, manifest());

    expect(lock.generatedFiles['src/generated/yatris-schema.ts']).toBe(before.generatedFiles['src/generated/yatris-schema.ts']);
    expect(lock.generatedFiles[ZOD_PATH]).not.toBe(before.generatedFiles[ZOD_PATH]);
    expect(readFileSync(join(site, ZOD_PATH), 'utf8')).toContain('variants: z.array(yatrisImageVariant).optional()');
    expect(readLock(site)?.zodGenerator).toBe(ZOD_GENERATOR);
    expect(verifySchema(site)).toEqual([]);
    expect(verifySchema(site, manifest())).toEqual([]);
  });

  it('still catches a hand edit of the old file', () => {
    syncedBy030();
    writeFileSync(join(site, ZOD_PATH), readFileSync(join(site, ZOD_PATH), 'utf8').replace('mime: z.string() }', 'mime: z.string(), variants: z.any() }'));

    expect(codes(verifySchema(site))).toEqual(['schema-generated-drift', ZOD_OUTDATED]);
    expect(codes(verifySchema(site, manifest()))).toEqual(['schema-generated-drift', ZOD_OUTDATED]);
  });

  it('refuses a lock from a zod generator newer than this release', () => {
    syncSchema(site, manifest());
    const lock = readLock(site)!;
    writeFileSync(join(site, LOCK_PATH), JSON.stringify({ ...lock, zodGenerator: ZOD_GENERATOR + 1 }));

    const findings = verifySchema(site, manifest());
    expect(codes(findings)).toEqual(['schema-lock-invalid']);
    expect(findings[0].message).toContain(`zod generator version ${ZOD_GENERATOR + 1}`);
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

  it('tells an unsynced lock apart from a missing one in verify and status (YatrisCMS#307)', async () => {
    const missingVerify = await run(['schema', 'verify'], { cwd: site });
    expect(missingVerify.code).toBe(1);
    expect(missingVerify.stderr).toContain('✖ schema-lock-missing .yatris/schema.lock.json: the file does not exist.');
    const missingStatus = await run(['schema', 'status'], { cwd: site });
    expect(missingStatus.code).toBe(1);
    expect(missingStatus.stderr).toContain('does not exist');

    writeFileSync(join(site, LOCK_PATH), JSON.stringify(emptyLock(7)));

    const verify = await run(['schema', 'verify'], { cwd: site });
    expect(verify.code).toBe(0);
    expect(verify.stdout).toContain('⚠ schema-lock-unsynced .yatris/schema.lock.json: the lock exists, but no schema revision has been synced yet.');
    expect(verify.stdout).toContain('read yatris://websites/7/schema');
    expect(verify.stdout).toContain('yatris schema sync --manifest <file>');
    expect(`${verify.stdout}${verify.stderr}`).not.toContain('schema-lock-missing');

    const status = await run(['schema', 'status'], { cwd: site });
    expect(status.code).toBe(0);
    expect(status.stdout).toContain('Website 7: no schema revision synced yet. To sync: read yatris://websites/7/schema');
  });

  it('explains a missing manifest argument', async () => {
    expect((await run(['schema', 'sync'], { cwd: site })).stderr).toContain('--manifest=<file> is required');
  });
});
