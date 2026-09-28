import { fileURLToPath } from 'node:url';
import { readPairedProject, siteApiUrl } from './paired-build.js';
import { LOCK_PATH, readLock, verifySchema } from './schema.js';

/**
 * The build-time schema check (YatrisCMS#304). A paired site's production
 * build reads `GET {yatris}/api/v1/sites/{id}/schema` and, when the Website
 * is in `revisioned` schema mode, fails unless:
 *
 * - `.yatris/schema.lock.json` names the active revision and its digest, or
 *   the pending one whose code is being deployed so staff can activate it
 *   afterwards; and
 * - the generated files verify against the lock (`yatris schema verify`).
 *
 * The failed build never deploys, so a mismatched site cannot reach
 * production however its pull request was merged. `immediate` Websites carry
 * no contract and are not checked. An unpaired project and `astro dev` make
 * no request. There is deliberately no switch to skip the check: a paired
 * build that cannot read the contract fails.
 */

export interface SchemaContract {
  schemaMode: 'immediate' | 'revisioned';
  activeRevision: RevisionRef | null;
  pendingRevision: RevisionRef | null;
}

export interface RevisionRef {
  id: string;
  digest: string;
}

export interface SchemaCheckSource {
  root: URL;
  command: 'dev' | 'build' | 'preview' | 'sync' | undefined;
  fetch?: typeof fetch;
  env?: Record<string, string | undefined>;
}

/** What the check found; null when this build is not checked at all. */
export type SchemaCheckResult = { schemaMode: 'immediate' } | { schemaMode: 'revisioned'; revision: string; state: 'active' | 'pending' };

const PREFIX = '@yatris/astro: schema check failed:';

/** Null when this build does not check the schema; throws when the check fails. */
export async function checkSchemaContract(source: SchemaCheckSource): Promise<SchemaCheckResult | null> {
  const env = source.env ?? process.env;
  const project = readPairedProject(source.root);

  if (project === null || source.command !== 'build') return null;

  const url = siteApiUrl(project, 'schema', env);
  let response: Response;
  try {
    response = await (source.fetch ?? fetch)(url, { headers: { accept: 'application/json' } });
  } catch (error) {
    throw new Error(`${PREFIX} could not read the schema contract from ${url} (${(error as Error).message}). A paired production build must confirm its schema before it can deploy.`);
  }
  if (!response.ok) {
    throw new Error(`${PREFIX} reading the schema contract from ${url} failed with HTTP ${response.status}. A paired production build must confirm its schema before it can deploy.`);
  }

  const contract = parseSchemaContract(await response.json(), project.websiteId);
  if (contract.schemaMode === 'immediate') return { schemaMode: 'immediate' };

  return verifyAgainstContract(fileURLToPath(source.root), contract);
}

export function parseSchemaContract(value: unknown, websiteId: number): SchemaContract {
  const data = (value ?? {}) as Record<string, unknown>;
  if (data.contractVersion !== 1) throw new Error(`${PREFIX} Yatris returned a schema contract this version cannot read.`);
  if (data.websiteId !== websiteId) throw new Error(`${PREFIX} Yatris answered for Website ${String(data.websiteId)}, but .yatris/project.json names Website ${websiteId}.`);
  if (data.schemaMode !== 'immediate' && data.schemaMode !== 'revisioned') throw new Error(`${PREFIX} Yatris returned an unknown schema mode ${JSON.stringify(data.schemaMode)}.`);

  return {
    schemaMode: data.schemaMode,
    activeRevision: revisionRef(data.activeRevision),
    pendingRevision: revisionRef(data.pendingRevision),
  };
}

/** The revisioned-mode verdict for the repository at `root`. */
export function verifyAgainstContract(root: string, contract: SchemaContract): SchemaCheckResult {
  const active = contract.activeRevision;
  if (active === null) throw new Error(`${PREFIX} Yatris has no active schema revision for this revisioned Website.`);

  const lock = readLock(root);
  if (lock === null) throw new Error(`${PREFIX} ${LOCK_PATH} is missing. Run \`yatris schema sync\` with the manifest of ${active.id}.`);

  const pending = contract.pendingRevision;
  const matches = (revision: RevisionRef | null) => revision !== null && lock.schemaRevision === revision.id && lock.schemaDigest === revision.digest;
  const state = matches(active) ? 'active' : matches(pending) ? 'pending' : null;

  if (state === null) {
    const expected = pending === null ? `${active.id} (${active.digest})` : `${active.id} (${active.digest}) or the pending ${pending.id} (${pending.digest})`;
    const locked = lock.schemaRevision === null ? 'exists, but no schema revision has been synced into it yet' : `is locked to ${lock.schemaRevision} (${lock.schemaDigest ?? 'no digest'})`;
    throw new Error(
      `${PREFIX} ${LOCK_PATH} ${locked}, but Yatris expects ${expected}. ` +
        'Run `yatris schema sync` with the manifest from the Yatris MCP (yatris://websites/{id}/schema) and commit the result.',
    );
  }

  const errors = verifySchema(root).filter((finding) => finding.severity === 'error');
  if (errors.length > 0) {
    const list = errors.map((finding) => `  - ${finding.code}${finding.file ? ` ${finding.file}` : ''}: ${finding.message}`).join('\n');
    throw new Error(`${PREFIX} the generated schema files do not verify against ${LOCK_PATH}:\n${list}`);
  }

  return { schemaMode: 'revisioned', revision: lock.schemaRevision as string, state };
}

function revisionRef(value: unknown): RevisionRef | null {
  if (value === null || value === undefined) return null;
  const ref = value as Record<string, unknown>;
  if (typeof ref.id !== 'string' || typeof ref.digest !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(ref.digest)) {
    throw new Error(`${PREFIX} Yatris returned a malformed schema revision.`);
  }
  return { id: ref.id, digest: ref.digest };
}
