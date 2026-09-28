import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Finding } from './doctor/findings.js';
import { generateZodModule, ZOD_PATH } from './schema-zod.js';

export { generateZodModule, ZOD_PATH } from './schema-zod.js';

/**
 * The site's schema contract (#265 / ADR-0008): `.yatris/schema.lock.json`
 * names the exact Yatris schema revision the repository was built against,
 * and the hashes of the files generated from it. Yatris generates those
 * files; `sync` writes what a pinned manifest carries, after checking its
 * integrity, plus the zod schemas derived from the manifest's canonical
 * schema (`src/generated/yatris-zod.ts`, YatrisCMS#307). `verify` never
 * writes anything.
 */

export const LOCK_PATH = '.yatris/schema.lock.json';

export interface SchemaLock {
  contractVersion: 1;
  websiteId: number | null;
  schemaRevision: string | null;
  schemaDigest: string | null;
  generatedFiles: Record<string, string>;
}

export interface SchemaManifest {
  contractVersion: 1;
  websiteId: number;
  schemaRevision: string;
  schemaDigest: string;
  state: string;
  canonical: string;
  generatedFiles: Record<string, { contents: string; sha256: string }>;
}

/** The lock of a site that has no schema yet (scaffold stage). */
export function emptyLock(websiteId: number | null = null): SchemaLock {
  return { contractVersion: 1, websiteId, schemaRevision: null, schemaDigest: null, generatedFiles: {} };
}

export function sha256(contents: string | Buffer): string {
  return `sha256:${createHash('sha256').update(contents).digest('hex')}`;
}

/** Parses a manifest and checks that it is internally consistent. */
export function parseManifest(value: unknown): SchemaManifest {
  const m = value as Partial<SchemaManifest> | null;
  if (!m || m.contractVersion !== 1 || typeof m.canonical !== 'string' || typeof m.schemaRevision !== 'string' || typeof m.websiteId !== 'number') {
    throw new Error('Not a Yatris schema manifest (contractVersion 1).');
  }
  if (sha256(m.canonical) !== m.schemaDigest) {
    throw new Error(`Manifest digest mismatch: the canonical schema hashes to ${sha256(m.canonical)}, not ${m.schemaDigest}.`);
  }
  for (const [path, file] of Object.entries(m.generatedFiles ?? {})) {
    if (!isGeneratedPath(path)) throw new Error(`Manifest names a file outside src/generated/: ${path}`);
    if (sha256(file.contents) !== file.sha256) throw new Error(`Manifest file ${path} does not match its hash.`);
  }
  return m as SchemaManifest;
}

export function readManifest(path: string): SchemaManifest {
  return parseManifest(JSON.parse(readFileSync(path, 'utf8')));
}

export function readLock(root: string): SchemaLock | null {
  const path = join(root, LOCK_PATH);
  return existsSync(path) ? (JSON.parse(readFileSync(path, 'utf8')) as SchemaLock) : null;
}

/** Writes the manifest's generated files and the matching lock. */
export function syncSchema(root: string, manifest: SchemaManifest): SchemaLock {
  const projectWebsite = projectWebsiteId(root);
  if (projectWebsite !== null && projectWebsite !== manifest.websiteId) {
    throw new Error(`This manifest is for Website ${manifest.websiteId}, but .yatris/project.json names Website ${projectWebsite}.`);
  }

  const generatedFiles: Record<string, string> = {};
  for (const [path, file] of Object.entries(derivedFiles(manifest))) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), file.contents);
    generatedFiles[path] = file.sha256;
  }

  const lock: SchemaLock = {
    contractVersion: 1,
    websiteId: manifest.websiteId,
    schemaRevision: manifest.schemaRevision,
    schemaDigest: manifest.schemaDigest,
    generatedFiles,
  };
  mkdirSync(join(root, '.yatris'), { recursive: true });
  writeFileSync(join(root, LOCK_PATH), `${JSON.stringify(lock, null, 2)}\n`);
  return lock;
}

/**
 * Read-only check of the repository against its lock and, when given, an
 * expected manifest (the revision a Work Order or PR is pinned to). Every
 * finding is an error except `schema-lock-unsynced`, a warning.
 */
export function verifySchema(root: string, manifest?: SchemaManifest): Finding[] {
  const findings: Finding[] = [];
  const error = (code: string, message: string, file?: string) => findings.push({ severity: 'error', code, message, file });
  const lock = readLock(root);

  const projectWebsite = projectWebsiteId(root);

  if (lock === null) {
    error('schema-lock-missing', `the file does not exist. ${syncInstructions(projectWebsite)}`, LOCK_PATH);
    return findings;
  }
  if (lock.contractVersion !== 1) error('schema-lock-invalid', `unsupported contractVersion ${lock.contractVersion}`, LOCK_PATH);

  // A lock that exists but names no revision is the scaffold state, not a
  // missing lock (YatrisCMS#307): nothing to verify yet, so it is a warning
  if (lock.schemaRevision === null && !manifest) {
    findings.push({ severity: 'warning', code: UNSYNCED, message: `the lock exists, but no schema revision has been synced yet. ${syncInstructions(projectWebsite ?? lock.websiteId)}`, file: LOCK_PATH });
  }

  if (projectWebsite !== null && lock.websiteId !== null && lock.websiteId !== projectWebsite) {
    error('schema-website-mismatch', `the lock is for Website ${lock.websiteId}, but .yatris/project.json names Website ${projectWebsite}`, LOCK_PATH);
  }

  for (const [path, expected] of Object.entries(lock.generatedFiles ?? {})) {
    const full = join(root, path);
    if (!existsSync(full)) {
      error('schema-generated-missing', 'a generated schema file named in the lock is missing', path);
    } else if (sha256(readFileSync(full)) !== expected) {
      error('schema-generated-drift', 'differs from what Yatris generated; never edit it by hand — re-run `yatris schema sync`', path);
    }
  }

  if (manifest) {
    if (lock.websiteId !== manifest.websiteId) error('schema-website-mismatch', `the lock is for Website ${lock.websiteId}, expected ${manifest.websiteId}`, LOCK_PATH);
    if (lock.schemaRevision !== manifest.schemaRevision || lock.schemaDigest !== manifest.schemaDigest) {
      const locked = lock.schemaRevision === null ? 'no revision has been synced yet' : `the lock names ${lock.schemaRevision}`;
      error('schema-revision-mismatch', `${locked}, expected ${manifest.schemaRevision}; run \`yatris schema sync --manifest <file>\` with that manifest`, LOCK_PATH);
    }
    for (const [path, file] of Object.entries(derivedFiles(manifest))) {
      if (lock.generatedFiles?.[path] !== file.sha256) error('schema-generated-mismatch', `does not match revision ${manifest.schemaRevision}`, path);
    }
  }

  return findings;
}

/**
 * The files a sync writes: Yatris's own, plus the zod schemas derived from
 * the canonical schema (YatrisCMS#307) unless Yatris already sent them.
 */
export function derivedFiles(manifest: SchemaManifest): Record<string, { contents: string; sha256: string }> {
  const files = { ...manifest.generatedFiles };
  if (!(ZOD_PATH in files)) {
    const contents = generateZodModule(manifest.canonical, manifest.schemaRevision);
    files[ZOD_PATH] = { contents, sha256: sha256(contents) };
  }
  return files;
}

/** The finding code of a lock that exists but has no revision synced yet. */
export const UNSYNCED = 'schema-lock-unsynced';

/** The next step towards a synced lock, for a person or an agent. */
export function syncInstructions(websiteId: number | null): string {
  const id = websiteId === null ? '{id}' : String(websiteId);
  return `To sync: read yatris://websites/${id}/schema from the Yatris MCP, save the JSON to a file outside the repository, and run \`yatris schema sync --manifest <file>\`.`;
}

function isGeneratedPath(path: string): boolean {
  return /^src\/generated\/[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/.test(path) && !path.includes('..');
}

export function projectWebsiteId(root: string): number | null {
  const path = join(root, '.yatris/project.json');
  if (!existsSync(path)) return null;
  const id = (JSON.parse(readFileSync(path, 'utf8')) as { websiteId?: unknown }).websiteId;
  return typeof id === 'number' ? id : null;
}
