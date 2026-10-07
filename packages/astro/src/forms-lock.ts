import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { looksLikeCredential } from './mcp.js';

/**
 * `.yatris/forms.lock.json` (YatrisCMS#392, spec §4.1): the last-synchronized
 * baseline of every contact form, so `yatris forms plan` can tell local edits,
 * remote edits (drafts as well as publications) and conflicts apart.
 *
 * Per form it records what Yatris returned at the last apply or pull: the
 * authoring-definition digest (computed only by Yatris: PHP and JavaScript
 * format numbers differently, so the CLI never computes it), the draft
 * revision, the published version, and which state that baseline is (`draft`
 * after an apply or `pull --draft`, `published` after a plain pull). It also
 * records the SHA-256 of the local declaration file as it stood then, which
 * is how `pull` knows a file has no unsynchronized local edits.
 *
 * Written only by `yatris forms apply` and `yatris forms pull`. It is not
 * secret and never holds recipients, template text or SMTP values. It is
 * outside the ordinary `src/` write boundary of hosted agents: a work order
 * that runs apply or pull must name this exact path.
 */

export const FORMS_LOCK_PATH = '.yatris/forms.lock.json';

/** A remote revision or version identifier, opaque to the CLI. */
export type Revision = number | string | null;

export interface FormLockEntry {
  /** Which Yatris state the baseline is. */
  state: 'draft' | 'published';
  /** Yatris's digest of that authoring definition. */
  digest: string;
  draft_revision: Revision;
  published_version: Revision;
  /** `sha256:<hex>` of `src/forms/<key>.json` when the baseline was recorded. */
  declaration_sha256: string;
}

export interface FormsLock {
  contractVersion: 1;
  websiteId: number;
  forms: Record<string, FormLockEntry>;
}

export function emptyFormsLock(websiteId: number): FormsLock {
  return { contractVersion: 1, websiteId, forms: {} };
}

/** The lock, or null when there is none. Throws on a lock this version cannot read. */
export function readFormsLock(root: string): FormsLock | null {
  const path = join(root, FORMS_LOCK_PATH);
  if (!existsSync(path)) return null;
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${FORMS_LOCK_PATH} is not valid JSON; it is written by \`yatris forms apply\` and \`pull\` only. Restore it from Git.`);
  }
  const problem = lockProblem(value);
  if (problem) throw new Error(`${FORMS_LOCK_PATH}: ${problem}. Restore it from Git; never edit it by hand.`);
  return value as FormsLock;
}

/** Why a value is not a forms lock, or null when it is one. */
export function lockProblem(value: unknown): string | null {
  const lock = value as Partial<FormsLock> | null;
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) return 'not an object';
  if (lock.contractVersion !== 1) return `unsupported contractVersion ${String(lock.contractVersion)}`;
  if (typeof lock.websiteId !== 'number') return 'websiteId is missing';
  if (!lock.forms || typeof lock.forms !== 'object' || Array.isArray(lock.forms)) return 'forms is missing';
  for (const [key, entry] of Object.entries(lock.forms)) {
    const e = entry as Partial<FormLockEntry> | null;
    if (!e || (e.state !== 'draft' && e.state !== 'published') || typeof e.digest !== 'string' || typeof e.declaration_sha256 !== 'string' || !isRevision(e.draft_revision) || !isRevision(e.published_version)) {
      return `the entry for "${key}" is incomplete`;
    }
  }
  return null;
}

export function writeFormsLock(root: string, lock: FormsLock): void {
  const sorted: FormsLock = {
    contractVersion: 1,
    websiteId: lock.websiteId,
    forms: Object.fromEntries(
      Object.keys(lock.forms)
        .sort()
        .map((key) => {
          const e = lock.forms[key];
          return [key, { state: e.state, digest: e.digest, draft_revision: e.draft_revision, published_version: e.published_version, declaration_sha256: e.declaration_sha256 }];
        }),
    ),
  };
  const text = `${JSON.stringify(sorted, null, 2)}\n`;
  if (looksLikeCredential(text)) throw new Error(`refusing to write ${FORMS_LOCK_PATH}: it would contain something credential-like.`);
  mkdirSync(dirname(join(root, FORMS_LOCK_PATH)), { recursive: true });
  writeFileSync(join(root, FORMS_LOCK_PATH), text);
}

function isRevision(value: unknown): value is Revision {
  return value === null || typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}
