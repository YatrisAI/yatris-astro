import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { FORMS_DIR } from './forms-config.js';
import { emptyFormsLock, FORMS_LOCK_PATH, readFormsLock, writeFormsLock, type FormLockEntry, type FormsLock, type Revision } from './forms-lock.js';
import { fileSha256, scanDeclarations, scanLines } from './forms-local.js';
import { validateDeclaration } from './forms/declaration.js';
import { FORM_KEY_PATTERN } from './forms/registry.js';
import { sha256 } from './schema.js';
import { describeFailure, EXIT, RemoteError, resolveRemote, type Remote, type RemoteOptions } from './yatris-remote.js';

/**
 * `yatris forms plan | apply | pull` (YatrisCMS#392, spec §4, §13, decisions
 * §4, §6): declarative synchronization of `src/forms/*.json` with Yatris
 * drafts through the Product MCP.
 *
 * - `plan` validates locally, then asks Yatris for a read-only comparison of
 *   local, baseline (`.yatris/forms.lock.json`) and current remote state. It
 *   writes only the plan file.
 * - `apply` sends the exact declarations a plan was made from, to drafts,
 *   atomically. It never publishes: a person reviews and publishes in Yatris.
 * - `pull` writes remote definitions into the repository, only where no
 *   unsynchronized local edit would be lost.
 *
 * Yatris computes every digest; the CLI only stores what Yatris returns.
 */

export const DEFAULT_PLAN_PATH = '.yatris/forms.plan.json';

export interface SyncResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Operation = 'create' | 'update_draft' | 'noop' | 'accept_remote' | 'remote_drift' | 'conflict' | 'adopt_required' | 'invalid';

/** Operations that block `apply` until a person reconciles them. */
export const BLOCKING: readonly Operation[] = ['remote_drift', 'conflict', 'adopt_required', 'invalid'];
/** Operations that write a Yatris draft. */
export const WRITING: readonly Operation[] = ['create', 'update_draft'];

interface RemoteState {
  draft_revision: Revision;
  published_version: Revision;
  digest: string | null;
}

export interface PlanOperation {
  key: string;
  operation: Operation;
  local_digest: string | null;
  changed_paths: string[];
  remote: RemoteState | null;
  issues: Array<{ path: string; code: string }>;
}

interface PlanAnswer {
  plan_token: string;
  expires_at: string;
  applicable: boolean;
  operations: PlanOperation[];
}

/** The reviewed plan `apply` executes. Holds paths and hashes, never declaration text or secrets. */
export interface PlanFile {
  planVersion: 1;
  websiteId: number;
  createdAt: string;
  plan_token: string;
  expires_at: string;
  applicable: boolean;
  declarations: Record<string, { path: string; sha256: string }>;
  operations: PlanOperation[];
}

interface FormSummary {
  key: string;
  name: string;
  status: string;
  published_version: Revision;
  draft_revision: Revision;
  draft_digest: string | null;
  published_digest: string | null;
  has_unpublished_changes: boolean;
}

interface RemoteDefinition {
  key: string;
  state: 'draft' | 'published';
  revision: Revision;
  version: Revision;
  digest: string;
  definition: unknown;
  review_url: string;
}

const OPERATIONS: readonly Operation[] = ['create', 'update_draft', 'noop', 'accept_remote', 'remote_drift', 'conflict', 'adopt_required', 'invalid'];

const EXPLAIN: Record<Operation, (key: string) => string> = {
  create: () => 'new in Yatris: apply creates a draft',
  update_draft: () => 'local changes: apply updates the Yatris draft',
  noop: () => 'no change',
  accept_remote: (key) => `the local file already matches Yatris; \`yatris forms pull ${key}\` records that as the baseline (nothing is written to Yatris)`,
  remote_drift: (key) => `changed in Yatris since the last sync (a draft or a publication); \`yatris forms pull ${key}\` brings it into the repository, then plan again`,
  conflict: () => 'changed both locally and in Yatris. Nothing merges automatically: move your local edit aside, pull, re-apply your change to the pulled file, and plan again',
  adopt_required: (key) => `a form "${key}" already exists in Yatris and this repository has no baseline for it. Adopt it with \`yatris forms pull ${key}\` (move a differing local file aside first); it is never replaced blindly`,
  invalid: () => 'Yatris rejected this declaration',
};

// ---------------------------------------------------------------- plan

export interface PlanOptions extends RemoteOptions {
  json?: boolean;
  out?: string;
}

export async function planForms(root: string, options: PlanOptions): Promise<SyncResult> {
  const scan = scanDeclarations(root);
  if (scan.invalid.length) {
    return { code: EXIT.invalid, stdout: '', stderr: `${scanLines(scan).join('\n')}\nyatris forms plan: fix the invalid declarations first (\`yatris forms validate\`); nothing was sent.` };
  }
  if (scan.valid.length === 0) {
    return { code: EXIT.ok, stdout: `forms plan: no declarations in ${scan.shown}/, nothing to compare. \`yatris forms pull\` fetches forms that exist in Yatris.`, stderr: '' };
  }

  const outPath = options.out ?? DEFAULT_PLAN_PATH;
  const unsafe = unsafePlanPath(root, outPath);
  if (unsafe) return { code: EXIT.invalid, stdout: '', stderr: `yatris forms plan: ${unsafe}` };

  let remote: Remote;
  let lock: FormsLock | null;
  try {
    remote = resolveRemote(root, options);
    lock = lockFor(root, remote.websiteId);
  } catch (error) {
    return fail('plan', error, 'plan_contact_forms');
  }

  let answer: PlanAnswer;
  try {
    answer = parsePlan(
      await remote.call('plan_contact_forms', {
        website: remote.websiteId,
        forms: scan.valid.map((d) => ({ key: d.key, declaration: d.declaration, baseline: baselineOf(lock?.forms[d.key]) })),
      }),
    );
  } catch (error) {
    return fail('plan', error, 'plan_contact_forms');
  }

  const blocked = answer.operations.filter((op) => BLOCKING.includes(op.operation));
  const writes = answer.operations.filter((op) => WRITING.includes(op.operation));
  const applicable = answer.applicable && blocked.length === 0;
  const plan: PlanFile = {
    planVersion: 1,
    websiteId: remote.websiteId,
    createdAt: new Date().toISOString(),
    plan_token: answer.plan_token,
    expires_at: answer.expires_at,
    applicable,
    declarations: Object.fromEntries(scan.valid.map((d) => [d.key, { path: d.path, sha256: d.sha256 }])),
    operations: answer.operations,
  };

  let written: string | null = null;
  const notes: string[] = [];
  if (applicable && writes.length > 0) {
    const full = resolve(root, outPath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `${JSON.stringify(plan, null, 2)}\n`);
    written = shownPath(root, full);
    if (!planIgnored(root, full)) notes.push(`⚠ ${written} is not listed in .gitignore. Add \`${written}\` there: a plan can name private template changes and must never be committed or deployed.`);
  }

  const code = applicable ? EXIT.ok : EXIT.reconcile;
  if (options.json) {
    return { code, stdout: JSON.stringify({ website: remote.websiteId, applicable, expires_at: answer.expires_at, plan_file: written, operations: answer.operations }, null, 2), stderr: '' };
  }

  const lines = [`yatris forms plan: Website ${remote.websiteId} (read-only: nothing was saved in Yatris)`];
  for (const op of answer.operations) lines.push(...describeOperation(op));
  if (!applicable) {
    lines.push(`✖ Not applicable: ${blocked.map((op) => `${op.key} (${op.operation})`).join(', ') || 'Yatris refused the plan'}. Reconcile, then run \`yatris forms plan\` again. No plan file was written.`);
  } else if (written) {
    lines.push(`Plan written to ${written} (expires ${answer.expires_at}). Keep it out of public directories and Git.`);
    lines.push(`Next: \`yatris forms apply --plan ${written}\` saves ${writes.length === 1 ? 'a Yatris draft' : `${writes.length} Yatris drafts`}. Publication stays a person's review in Yatris.`);
  } else {
    lines.push('Nothing to apply: the repository and Yatris agree.');
  }
  lines.push(...notes);
  return applicable ? { code, stdout: lines.join('\n'), stderr: '' } : { code, stdout: '', stderr: lines.join('\n') };
}

function describeOperation(op: PlanOperation): string[] {
  const mark = BLOCKING.includes(op.operation) ? '✖' : WRITING.includes(op.operation) ? '→' : '✔';
  const lines = [`  ${mark} ${op.key}: ${op.operation}, ${EXPLAIN[op.operation](op.key)}`];
  if (op.changed_paths.length) lines.push(`      changed: ${op.changed_paths.slice(0, 20).join(', ')}${op.changed_paths.length > 20 ? ` (+${op.changed_paths.length - 20} more)` : ''}`);
  if (op.remote) lines.push(`      Yatris: draft revision ${String(op.remote.draft_revision ?? 'none')}, published version ${String(op.remote.published_version ?? 'none')}`);
  for (const issue of op.issues) lines.push(`      ${issue.path || '/'} ${issue.code}`);
  return lines;
}

// ---------------------------------------------------------------- apply

export interface ApplyOptions extends RemoteOptions {
  plan: string;
  json?: boolean;
  now?: () => Date;
}

export async function applyForms(root: string, options: ApplyOptions): Promise<SyncResult> {
  let plan: PlanFile;
  try {
    plan = readPlanFile(resolve(root, options.plan));
  } catch (error) {
    return { code: EXIT.invalid, stdout: '', stderr: `yatris forms apply: ${(error as Error).message}` };
  }
  if (!plan.applicable) return { code: EXIT.reconcile, stdout: '', stderr: 'yatris forms apply: this plan is not applicable (drift, conflict, adoption or invalid forms). Reconcile and run `yatris forms plan` again; nothing was sent.' };
  if (Date.parse(plan.expires_at) <= (options.now?.() ?? new Date()).getTime()) {
    return { code: EXIT.stale, stdout: '', stderr: `yatris forms apply: the plan expired at ${plan.expires_at}. Run \`yatris forms plan\` again and review it; nothing was sent.` };
  }

  // The declarations must be exactly the ones the plan was made from
  const scan = scanDeclarations(root);
  const changed: string[] = [];
  const planned = new Map(Object.entries(plan.declarations));
  for (const [key, entry] of planned) if (fileSha256(root, entry.path) !== entry.sha256) changed.push(entry.path);
  for (const d of [...scan.valid, ...scan.invalid.map((i) => ({ key: i.expectedKey, path: i.path }))]) if (!planned.has(d.key)) changed.push(`${d.path} (not in the plan)`);
  if (changed.length) {
    return { code: EXIT.stale, stdout: '', stderr: `yatris forms apply: declarations changed since the plan: ${changed.join(', ')}. Run \`yatris forms plan\` again and review it; nothing was sent.` };
  }
  const declarations = scan.valid.filter((d) => planned.has(d.key));

  let remote: Remote;
  let lock: FormsLock | null;
  try {
    remote = resolveRemote(root, options);
    if (remote.websiteId !== plan.websiteId) {
      return { code: EXIT.stale, stdout: '', stderr: `yatris forms apply: the plan is for Website ${plan.websiteId}, but this repository is paired with Website ${remote.websiteId}; nothing was sent.` };
    }
    lock = lockFor(root, remote.websiteId);
  } catch (error) {
    return fail('apply', error, 'apply_contact_forms');
  }

  // One key per deliberate apply; callWithRetry resends these same arguments
  const args = {
    website: remote.websiteId,
    plan_token: plan.plan_token,
    forms: declarations.map((d) => ({ key: d.key, declaration: d.declaration })),
    idempotency_key: `forms-apply-${randomUUID()}`,
  };
  let answer: { forms: Array<{ key: string; operation: Operation; draft_revision: Revision; digest: string; published_version: Revision; review_url: string }> };
  try {
    answer = parseApply(await remote.call('apply_contact_forms', args));
  } catch (error) {
    return fail('apply', error, 'apply_contact_forms');
  }

  const next = lock ?? emptyFormsLock(remote.websiteId);
  const bySha = new Map(declarations.map((d) => [d.key, d.sha256]));
  for (const form of answer.forms) {
    const declarationSha = bySha.get(form.key);
    if (!declarationSha) continue;
    const previous = next.forms[form.key];
    next.forms[form.key] = {
      state: WRITING.includes(form.operation) ? 'draft' : (previous?.state ?? (form.published_version === null ? 'draft' : 'published')),
      digest: form.digest,
      draft_revision: form.draft_revision,
      published_version: form.published_version,
      declaration_sha256: declarationSha,
    };
  }
  writeFormsLock(root, next);

  if (options.json) {
    return { code: EXIT.ok, stdout: JSON.stringify({ status: 'draft_saved', publication: 'pending', website: remote.websiteId, forms: answer.forms, lock: FORMS_LOCK_PATH }, null, 2), stderr: '' };
  }
  const lines = [`yatris forms apply: Website ${remote.websiteId}: drafts saved in Yatris. Publication is pending: a person reviews and publishes each form in Yatris; the live site keeps rendering the published version until then.`];
  for (const form of answer.forms) {
    lines.push(`  ${form.key}: ${form.operation}${WRITING.includes(form.operation) ? `, draft revision ${String(form.draft_revision)}` : ''}${form.review_url ? `, review: ${form.review_url}` : ''}`);
  }
  lines.push(`Updated ${FORMS_LOCK_PATH}; commit it with the declarations.`);
  return { code: EXIT.ok, stdout: lines.join('\n'), stderr: '' };
}

// ---------------------------------------------------------------- pull

export interface PullOptions extends RemoteOptions {
  draft?: boolean;
  keys?: string[];
  json?: boolean;
}

interface PullOutcome {
  key: string;
  result: 'written' | 'baseline_advanced' | 'up_to_date' | 'refused' | 'skipped';
  state?: 'draft' | 'published';
  reason?: string;
}

export async function pullForms(root: string, options: PullOptions): Promise<SyncResult> {
  for (const key of options.keys ?? []) {
    if (!new RegExp(FORM_KEY_PATTERN, 'u').test(key)) return { code: EXIT.invalid, stdout: '', stderr: `yatris forms pull: "${key}" is not a form key.` };
  }

  let remote: Remote;
  let lock: FormsLock | null;
  try {
    remote = resolveRemote(root, options);
    lock = lockFor(root, remote.websiteId);
  } catch (error) {
    return fail('pull', error, 'list_contact_forms');
  }

  let summaries: FormSummary[];
  try {
    summaries = parseList(await remote.call('list_contact_forms', { website: remote.websiteId }));
  } catch (error) {
    return fail('pull', error, 'list_contact_forms');
  }

  const wanted = options.keys?.length ? new Set(options.keys) : null;
  if (summaries.length === 0) {
    return { code: wanted ? EXIT.invalid : EXIT.ok, stdout: wanted ? '' : `forms pull: Website ${remote.websiteId} has no contact forms in Yatris yet. Nothing was written.`, stderr: wanted ? `yatris forms pull: Website ${remote.websiteId} has no contact forms in Yatris.` : '' };
  }
  const missing = [...(wanted ?? [])].filter((key) => !summaries.some((s) => s.key === key));
  if (missing.length) return { code: EXIT.invalid, stdout: '', stderr: `yatris forms pull: no form ${missing.map((k) => `"${k}"`).join(', ')} in Yatris for Website ${remote.websiteId}; nothing was written.` };

  const next: FormsLock = lock ?? emptyFormsLock(remote.websiteId);
  const outcomes: PullOutcome[] = [];
  for (const summary of summaries) {
    if (wanted && !wanted.has(summary.key)) continue;
    if (!new RegExp(FORM_KEY_PATTERN, 'u').test(summary.key)) {
      outcomes.push({ key: summary.key, result: 'refused', reason: 'Yatris returned a key that is not a form key' });
      continue;
    }
    const state = options.draft ? 'draft' : 'published';
    if (state === 'published' && summary.published_version === null) {
      outcomes.push({ key: summary.key, result: 'skipped', reason: 'not published yet (staff can pull the draft with --draft)' });
      continue;
    }

    let got: RemoteDefinition;
    try {
      got = parseDefinition(await remote.call('get_contact_form', { website: remote.websiteId, key: summary.key, state }));
    } catch (error) {
      if (error instanceof RemoteError && error.kind === 'tool_error' && error.code === 'not_found') {
        outcomes.push({ key: summary.key, result: 'skipped', reason: `no ${state} definition in Yatris` });
        continue;
      }
      return fail('pull', error, 'get_contact_form', outcomes.length ? `${outcomes.length} form(s) were already handled; ${FORMS_LOCK_PATH} was not updated.` : undefined);
    }

    outcomes.push(pullOne(root, summary, got, next));
  }

  const changedLock = outcomes.some((o) => o.result === 'written' || o.result === 'baseline_advanced');
  if (changedLock) writeFormsLock(root, next);
  const refused = outcomes.filter((o) => o.result === 'refused');
  const code = refused.length ? EXIT.reconcile : EXIT.ok;

  if (options.json) return { code, stdout: JSON.stringify({ website: remote.websiteId, state: options.draft ? 'draft' : 'published', forms: outcomes, lock: changedLock ? FORMS_LOCK_PATH : null }, null, 2), stderr: '' };

  const lines = [`yatris forms pull: Website ${remote.websiteId}, ${options.draft ? 'unpublished drafts (staff operation: the live site still renders the published versions)' : 'published versions'}`];
  for (const o of outcomes) {
    const what = { written: `wrote ${FORMS_DIR}/${o.key}.json`, baseline_advanced: 'the local file already matches; recorded it as the baseline', up_to_date: 'up to date', refused: 'refused', skipped: 'skipped' }[o.result];
    lines.push(`  ${o.result === 'refused' ? '✖' : '✔'} ${o.key}: ${what}${o.reason ? `: ${o.reason}` : ''}`);
  }
  if (changedLock) lines.push(`Updated ${FORMS_LOCK_PATH}; commit it with the declarations.`);
  return refused.length ? { code, stdout: '', stderr: lines.join('\n') } : { code, stdout: lines.join('\n'), stderr: '' };
}

function pullOne(root: string, summary: FormSummary, got: RemoteDefinition, lock: FormsLock): PullOutcome {
  const key = summary.key;
  const path = `${FORMS_DIR}/${key}.json`;
  const state = got.state;
  if (got.key !== key) return { key, result: 'refused', reason: `Yatris returned the definition of "${got.key}"` };
  const check = validateDeclaration(got.definition);
  if (!check.valid || (got.definition as { key?: unknown }).key !== key) {
    return { key, result: 'refused', reason: `the ${state} definition does not pass this @yatris/astro's validator (${check.errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.code}`).join(', ') || 'key mismatch'}); update @yatris/astro with \`npm run yatris:update\`` };
  }

  const baseline = lock.forms[key];
  const current = fileSha256(root, path);
  const text = `${JSON.stringify(got.definition, null, 2)}\n`;
  const entry = (sha: string): FormLockEntry => ({
    state,
    digest: got.digest,
    published_version: got.version ?? summary.published_version,
    // A published baseline does not include an unpublished staff draft:
    // record no draft revision, so a later plan reports that draft as drift
    // instead of letting an update overwrite it (spec §4.1)
    draft_revision: state === 'draft' ? (got.revision ?? summary.draft_revision) : summary.has_unpublished_changes ? null : summary.draft_revision,
    declaration_sha256: sha,
  });

  if (current !== null && sameDefinition(readJson(join(root, path)), got.definition)) {
    const next = entry(current);
    const unchanged = baseline !== undefined && (Object.keys(next) as Array<keyof FormLockEntry>).every((field) => baseline[field] === next[field]);
    lock.forms[key] = next;
    return { key, state, result: unchanged ? 'up_to_date' : 'baseline_advanced' };
  }
  if (current !== null && (!baseline || baseline.declaration_sha256 !== current)) {
    return {
      key,
      state,
      result: 'refused',
      reason: baseline
        ? `${path} has local edits that were never applied. Nothing was overwritten. Run \`yatris forms plan\` to see them; to take the Yatris version, move your file aside and pull again`
        : `${path} exists but has no baseline in ${FORMS_LOCK_PATH}, so it may hold work Yatris does not have. Nothing was overwritten; move it aside to adopt the Yatris form, or keep it and resolve with staff`,
    };
  }
  mkdirSync(join(root, FORMS_DIR), { recursive: true });
  writeFileSync(join(root, path), text);
  lock.forms[key] = entry(sha256(Buffer.from(text)));
  return { key, state, result: 'written' };
}

/** Equal authoring definitions; recipients are dashboard-managed and never part of a remote definition. */
function sameDefinition(local: unknown, remote: unknown): boolean {
  if (!local || typeof local !== 'object') return false;
  const copy = structuredClone(local) as { mail?: { notification?: { to?: unknown } } };
  if (copy.mail?.notification) delete copy.mail.notification.to;
  return canonical(copy) === canonical(remote);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

// ---------------------------------------------------------------- helpers

function fail(action: string, error: unknown, tool: string, extra?: string): SyncResult {
  const { code, message } = describeFailure(error, tool);
  return { code, stdout: '', stderr: `yatris forms ${action}: ${message}${extra ? ` ${extra}` : ''}` };
}

/** The lock, checked against the paired Website. */
function lockFor(root: string, websiteId: number): FormsLock | null {
  const lock = readFormsLock(root);
  if (lock && lock.websiteId !== websiteId) throw new Error(`${FORMS_LOCK_PATH} is for Website ${lock.websiteId}, but this repository is paired with Website ${websiteId}. Restore the right lock from Git; nothing was sent.`);
  return lock;
}

function baselineOf(entry: FormLockEntry | undefined): { digest: string; draft_revision: Revision; published_version: Revision } | null {
  return entry ? { digest: entry.digest, draft_revision: entry.draft_revision, published_version: entry.published_version } : null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Why a plan file location is unsafe, or null. Plans never go where a build or the site could publish them. */
function unsafePlanPath(root: string, out: string): string | null {
  const full = resolve(root, out);
  const rel = relative(root, full).replaceAll('\\', '/');
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  const top = rel.split('/')[0];
  if (['public', 'src', 'dist', '.astro'].includes(top)) return `refusing to write a plan under ${top}/: a plan can name private template changes and must never be published or built. Use the default ${DEFAULT_PLAN_PATH}.`;
  return null;
}

function planIgnored(root: string, full: string): boolean {
  const rel = relative(root, full).replaceAll('\\', '/');
  if (rel.startsWith('..')) return true;
  const gitignore = join(root, '.gitignore');
  if (!existsSync(gitignore)) return false;
  const lines = readFileSync(gitignore, 'utf8').split(/\r?\n/).map((l) => l.trim());
  const name = rel.split('/').pop()!;
  return lines.some((l) => l === rel || l === `/${rel}` || l === name || l === '.yatris/*.plan.json' || l === '*.plan.json');
}

function shownPath(root: string, full: string): string {
  const rel = relative(root, full).replaceAll('\\', '/');
  return rel.startsWith('..') ? full : rel;
}

function readPlanFile(path: string): PlanFile {
  if (!existsSync(path)) throw new Error(`no plan file at ${path}; run \`yatris forms plan\` first.`);
  let plan: Partial<PlanFile>;
  try {
    plan = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not a plan file (invalid JSON).`);
  }
  if (plan?.planVersion !== 1 || typeof plan.websiteId !== 'number' || typeof plan.plan_token !== 'string' || typeof plan.expires_at !== 'string' || typeof plan.applicable !== 'boolean' || !plan.declarations || typeof plan.declarations !== 'object') {
    throw new Error(`${path} is not a plan written by \`yatris forms plan\`.`);
  }
  for (const entry of Object.values(plan.declarations)) {
    if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string') throw new Error(`${path} is not a plan written by \`yatris forms plan\`.`);
  }
  return plan as PlanFile;
}

// ---------------------------------------------------------------- answers

function protocol(message: string): never {
  throw new RemoteError('protocol', message);
}

function isRevision(value: unknown): value is Revision {
  return value === null || typeof value === 'string' || typeof value === 'number';
}

function parsePlan(value: unknown): PlanAnswer {
  const v = value as Partial<PlanAnswer> | null;
  if (!v || typeof v.plan_token !== 'string' || typeof v.expires_at !== 'string' || typeof v.applicable !== 'boolean' || !Array.isArray(v.operations)) protocol('plan_contact_forms: unexpected answer');
  for (const op of v.operations) {
    if (!op || typeof op.key !== 'string' || !OPERATIONS.includes(op.operation)) protocol(`plan_contact_forms: unknown operation ${String(op?.operation)}`);
    op.changed_paths = Array.isArray(op.changed_paths) ? op.changed_paths.filter((p): p is string => typeof p === 'string') : [];
    op.issues = Array.isArray(op.issues) ? op.issues.filter((i) => i && typeof i.code === 'string').map((i) => ({ path: String(i.path ?? ''), code: i.code })) : [];
    op.remote = op.remote && typeof op.remote === 'object' ? { draft_revision: op.remote.draft_revision ?? null, published_version: op.remote.published_version ?? null, digest: op.remote.digest ?? null } : null;
    op.local_digest = typeof op.local_digest === 'string' ? op.local_digest : null;
  }
  return v as PlanAnswer;
}

function parseApply(value: unknown) {
  const v = value as { status?: unknown; forms?: unknown } | null;
  if (!v || v.status !== 'draft_saved' || !Array.isArray(v.forms)) protocol(`apply_contact_forms: expected status draft_saved, got ${String(v?.status)}`);
  const forms = (v.forms as Array<Record<string, unknown>>).map((f) => {
    if (typeof f?.key !== 'string' || typeof f.digest !== 'string' || !isRevision(f.draft_revision ?? null) || !isRevision(f.published_version ?? null)) protocol('apply_contact_forms: incomplete form result');
    return { key: f.key, operation: (OPERATIONS as string[]).includes(String(f.operation)) ? (f.operation as Operation) : 'update_draft', draft_revision: (f.draft_revision ?? null) as Revision, digest: f.digest, published_version: (f.published_version ?? null) as Revision, review_url: typeof f.review_url === 'string' ? f.review_url : '' };
  });
  return { forms };
}

function parseList(value: unknown): FormSummary[] {
  const forms = (value as { forms?: unknown } | null)?.forms;
  if (!Array.isArray(forms)) protocol('list_contact_forms: unexpected answer');
  return forms.map((f: Record<string, unknown>) => {
    if (typeof f?.key !== 'string') protocol('list_contact_forms: a form without a key');
    return {
      key: f.key,
      name: String(f.name ?? f.key),
      status: String(f.status ?? ''),
      published_version: isRevision(f.published_version) ? f.published_version : null,
      draft_revision: isRevision(f.draft_revision) ? f.draft_revision : null,
      draft_digest: typeof f.draft_digest === 'string' ? f.draft_digest : null,
      published_digest: typeof f.published_digest === 'string' ? f.published_digest : null,
      has_unpublished_changes: f.has_unpublished_changes === true,
    };
  });
}

function parseDefinition(value: unknown): RemoteDefinition {
  const v = value as Partial<RemoteDefinition> | null;
  if (!v || typeof v.key !== 'string' || (v.state !== 'draft' && v.state !== 'published') || typeof v.digest !== 'string' || !v.definition || typeof v.definition !== 'object') protocol('get_contact_form: unexpected answer');
  return { key: v.key, state: v.state, revision: isRevision(v.revision) ? v.revision : null, version: isRevision(v.version) ? v.version : null, digest: v.digest, definition: v.definition, review_url: typeof v.review_url === 'string' ? v.review_url : '' };
}
