import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Revision } from './forms-lock.js';
import { looksLikeCredential } from './mcp.js';

/**
 * `.yatris/reservations.lock.json` (YatrisCMS#432, spec §13.2, decisions §5):
 * the last-synchronized baseline of every reservation setup definition, so
 * `yatris reservations plan` can tell local edits, remote edits (builder
 * drafts as well as publications) and conflicts apart. It mirrors
 * `.yatris/forms.lock.json`.
 *
 * Per setup it records what Yatris returned at the last apply or pull: the
 * setup-definition digest (computed only by Yatris, over the declaration
 * without `$schema` and without the `operations` seed), the draft revision,
 * the published version, and which state that baseline is (`draft` after an
 * apply or `pull --draft`, `published` after a plain pull).
 *
 * It also records `definition_sha256`: a local hash of the declaration's
 * setup definition as it stood then (canonical JSON, without `$schema` and
 * `operations`). That is how `pull` knows a file has no unsynchronized
 * definition edits. The operations seed is left out because it is used once,
 * when Yatris creates the setup, and `pull` keeps it as it is: removing or
 * editing a seed after creation is never "unsynchronized work".
 *
 * Written only by `yatris reservations apply` and `pull`. It is not secret and
 * never holds operations, recipients or provider values. It is outside the
 * ordinary `src/` write boundary of hosted agents: a work order that runs
 * apply or pull must name this exact path.
 */

export const RESERVATIONS_LOCK_PATH = '.yatris/reservations.lock.json';

export interface SetupLockEntry {
  /** Which Yatris state the baseline is. */
  state: 'draft' | 'published';
  /** Yatris's digest of that setup definition. */
  digest: string;
  draft_revision: Revision;
  published_version: Revision;
  /** `sha256:<hex>` of the canonical setup definition of `src/reservations/<key>.json` when the baseline was recorded. */
  definition_sha256: string;
}

export interface ReservationsLock {
  contractVersion: 1;
  websiteId: number;
  setups: Record<string, SetupLockEntry>;
}

export function emptyReservationsLock(websiteId: number): ReservationsLock {
  return { contractVersion: 1, websiteId, setups: {} };
}

/** The lock, or null when there is none. Throws on a lock this version cannot read. */
export function readReservationsLock(root: string): ReservationsLock | null {
  const path = join(root, RESERVATIONS_LOCK_PATH);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${RESERVATIONS_LOCK_PATH} is not valid JSON; it is written by \`yatris reservations apply\` and \`pull\` only. Restore it from Git.`);
  }
  const problem = reservationsLockProblem(value);
  if (problem) throw new Error(`${RESERVATIONS_LOCK_PATH}: ${problem}. Restore it from Git; never edit it by hand.`);
  return value as ReservationsLock;
}

/** Why a value is not a reservations lock, or null when it is one. */
export function reservationsLockProblem(value: unknown): string | null {
  const lock = value as Partial<ReservationsLock> | null;
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return 'not an object';
  if (lock.contractVersion !== 1) return `unsupported contractVersion ${String(lock.contractVersion)}`;
  if (typeof lock.websiteId !== 'number') return 'websiteId is missing';
  if (!lock.setups || typeof lock.setups !== 'object' || Array.isArray(lock.setups)) return 'setups is missing';
  for (const [key, entry] of Object.entries(lock.setups)) {
    const e = entry as Partial<SetupLockEntry> | null;
    if (!e || (e.state !== 'draft' && e.state !== 'published') || typeof e.digest !== 'string' || typeof e.definition_sha256 !== 'string' || !isRevision(e.draft_revision) || !isRevision(e.published_version)) {
      return `the entry for "${key}" is incomplete`;
    }
  }
  return null;
}

export function writeReservationsLock(root: string, lock: ReservationsLock): void {
  const sorted: ReservationsLock = {
    contractVersion: 1,
    websiteId: lock.websiteId,
    setups: Object.fromEntries(
      Object.keys(lock.setups)
        .sort()
        .map((key) => {
          const e = lock.setups[key];
          return [key, { state: e.state, digest: e.digest, draft_revision: e.draft_revision, published_version: e.published_version, definition_sha256: e.definition_sha256 }];
        }),
    ),
  };
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (looksLikeCredential(text)) throw new Error(`refusing to write ${RESERVATIONS_LOCK_PATH}: it would contain something credential-like.`);
  mkdirSync(dirname(join(root, RESERVATIONS_LOCK_PATH)), { recursive: true });
  writeFileSync(join(root, RESERVATIONS_LOCK_PATH), text);
}

function isRevision(value: unknown): value is Revision {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
