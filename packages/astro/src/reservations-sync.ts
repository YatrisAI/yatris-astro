import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { Revision } from './forms-lock.js';
import { fileSha256 } from './forms-local.js';
import { RESERVATIONS_DIR } from './reservations-config.js';
import { canonical, definitionSha256, scanSetups, setupDefinition, setupScanLines } from './reservations-local.js';
import { emptyReservationsLock, readReservationsLock, RESERVATIONS_LOCK_PATH, writeReservationsLock, type ReservationsLock, type SetupLockEntry } from './reservations-lock.js';
import { SETUP_KEY_PATTERN } from './reservations/registry.js';
import { validateSetup } from './reservations/setup.js';
import { describeFailure, EXIT, RemoteError, resolveRemote, type Remote, type RemoteOptions } from './yatris-remote.js';

/**
 * `yatris reservations plan | apply | pull` (YatrisCMS#432, spec §13.2,
 * decisions §5): declarative synchronization of the setup definitions in
 * `src/reservations/*.json` with Yatris drafts through the Product MCP. It
 * mirrors `yatris forms plan | apply | pull` (forms-sync.ts): same plan and
 * lock files, exit codes and rules.
 *
 * - `plan` validates locally, then asks Yatris for a read-only comparison of
 *   local, baseline (`.yatris/reservations.lock.json`) and current remote
 *   state. It writes only the plan file.
 * - `apply` sends the exact declarations a plan was made from, to drafts,
 *   atomically. It never publishes: a person reviews and publishes in Yatris.
 * - `pull` writes remote setup definitions into the repository, only where no
 *   unsynchronized local edit would be lost.
 *
 * Setup definitions only. A declaration's `operations` section is a seed:
 * it is sent with the declaration, and Yatris uses it once, when apply
 * creates the setup. Afterwards daily operations (hours, closures, hosts,
 * capacity, policies) live only in Yatris: Yatris digests exclude the seed,
 * so operations edits are never drift or conflicts, and `pull` never writes
 * or removes an `operations` section. There is no delete: a setup whose file
 * is missing is never sent, so nothing is archived or deleted remotely.
 *
 * Yatris computes every digest; the CLI only stores what Yatris returns.
 */

export const DEFAULT_RESERVATIONS_PLAN_PATH = '.yatris/reservations.plan.json';

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
  /**
   * The live daily-operations revision in Yatris, or null. Informational
   * only: operations are not synchronized, so a change here is never drift
   * or a conflict.
   */
  live_operations_revision: number | null;
}

interface PlanAnswer {
  plan_token: string;
  expires_at: string;
  applicable: boolean;
  operations: PlanOperation[];
}

/** The reviewed plan `apply` executes. Holds paths and hashes, never declaration text, operations or secrets. */
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

interface SetupSummary {
  key: string;
  name: string;
  mode: string;
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
  definition: Record<string, unknown>;
  review_url: string;
}

const OPERATIONS: readonly Operation[] = ['create', 'update_draft', 'noop', 'accept_remote', 'remote_drift', 'conflict', 'adopt_required', 'invalid'];

const EXPLAIN: Record<Operation, (key: string) => string> = {
  create: () => 'new in Yatris: apply creates a draft',
  update_draft: () => 'local changes: apply updates the Yatris draft',
  noop: () => 'no change',
  accept_remote: (key) => `the local file already matches Yatris; \`yatris reservations pull ${key}\` records that as the baseline (nothing is written to Yatris)`,
  remote_drift: (key) => `changed in Yatris since the last sync (a builder draft or a publication); \`yatris reservations pull ${key}\` brings it into the repository, then plan again`,
  conflict: () => 'changed both locally and in Yatris. Nothing merges automatically: move your local edit aside, pull, re-apply your change to the pulled file, and plan again',
  adopt_required: (key) => `a reservation setup "${key}" already exists in Yatris and this repository has no baseline for it. Adopt it with \`yatris reservations pull ${key}\` (move a differing local file aside first); it is never replaced blindly`,
  invalid: () => 'Yatris rejected this declaration',
};

const SEED_NOTE = {
  create: '      operations: seeded once from this declaration when Yatris creates the setup; afterwards they live only in Yatris',
  other: '      operations: the seed in this file is not compared or applied; the live operations stay as they are in Yatris',
};

/** What to do about the setup-specific issues Yatris reports for an `invalid` operation. */
const ISSUE_HINT: Record<string, string> = {
  mode_immutable: 'the mode or presentation of an existing setup cannot change; a different mode is a replacement setup under a new key, created in its own file',
  setup_archived: 'this setup is archived in Yatris; it is never revived or replaced by sync, so use a new key or ask staff',
  key_mismatch: 'the key inside the declaration must equal its file name',
};

// ---------------------------------------------------------------- plan

export interface PlanOptions extends RemoteOptions {
  json?: boolean;
  out?: string;
}

export async function planReservations(root: string, options: PlanOptions): Promise<SyncResult> {
  const scan = scanSetups(root);
  if (scan.invalid.length) {
    return { code: EXIT.invalid, stdout: '', stderr: `${setupScanLines(scan).join('\n')}\nyatris reservations plan: fix the invalid declarations first (\`yatris reservations validate\`); nothing was sent.` };
  }
  if (scan.valid.length === 0) {
    return { code: EXIT.ok, stdout: `reservations plan: no declarations in ${scan.shown}/, nothing to compare. \`yatris reservations pull\` fetches setups that exist in Yatris.`, stderr: '' };
  }

  const outPath = options.out ?? DEFAULT_RESERVATIONS_PLAN_PATH;
  const unsafe = unsafePlanPath(root, outPath);
  if (unsafe) return { code: EXIT.invalid, stdout: '', stderr: `yatris reservations plan: ${unsafe}` };

  let remote: Remote;
  let lock: ReservationsLock | null;
  try {
    remote = resolveRemote(root, options);
    lock = lockFor(root, remote.websiteId);
  } catch (error) {
    return fail('plan', error, 'plan_reservation_setups');
  }

  let answer: PlanAnswer;
  try {
    answer = parsePlan(
      await remote.call('plan_reservation_setups', {
        website: remote.websiteId,
        setups: scan.valid.map((d) => ({ key: d.key, declaration: d.declaration, baseline: baselineOf(lock?.setups[d.key]) })),
      }),
    );
  } catch (error) {
    return fail('plan', error, 'plan_reservation_setups');
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
    if (!planIgnored(root, full)) notes.push(`⚠ ${written} is not listed in .gitignore. Add \`${written}\` there: a plan names private setup changes and must never be committed or deployed.`);
  }

  const code = applicable ? EXIT.ok : EXIT.reconcile;
  if (options.json) {
    return { code, stdout: JSON.stringify({ website: remote.websiteId, applicable, expires_at: answer.expires_at, plan_file: written, operations: answer.operations }, null, 2), stderr: '' };
  }

  const seeded = new Set(scan.valid.filter((d) => d.declaration.operations !== undefined).map((d) => d.key));
  const lines = [`yatris reservations plan: Website ${remote.websiteId} (read-only: nothing was saved in Yatris; setup definitions only, daily operations live in Yatris)`];
  for (const op of answer.operations) lines.push(...describeOperation(op, seeded.has(op.key)));
  if (!applicable) {
    lines.push(`✖ Not applicable: ${blocked.map((op) => `${op.key} (${op.operation})`).join(', ') || 'Yatris refused the plan'}. Reconcile, then run \`yatris reservations plan\` again. No plan file was written.`);
  } else if (written) {
    lines.push(`Plan written to ${written} (expires ${answer.expires_at}). Keep it out of public directories and Git.`);
    lines.push(`Next: \`yatris reservations apply --plan ${written}\` saves ${writes.length === 1 ? 'a Yatris draft' : `${writes.length} Yatris drafts`}. Publication stays a person's review in Yatris.`);
  } else {
    lines.push('Nothing to apply: the repository and Yatris agree.');
  }
  lines.push(...notes);
  return applicable ? { code, stdout: lines.join('\n'), stderr: '' } : { code, stdout: '', stderr: lines.join('\n') };
}

function describeOperation(op: PlanOperation, seeded: boolean): string[] {
  const mark = BLOCKING.includes(op.operation) ? '✖' : WRITING.includes(op.operation) ? '→' : '✔';
  const lines = [`  ${mark} ${op.key}: ${op.operation}, ${EXPLAIN[op.operation](op.key)}`];
  if (op.changed_paths.length) lines.push(`      changed: ${op.changed_paths.slice(0, 20).join(', ')}${op.changed_paths.length > 20 ? ` (+${op.changed_paths.length - 20} more)` : ''}`);
  if (op.remote) lines.push(`      Yatris: draft revision ${String(op.remote.draft_revision ?? 'none')}, published version ${String(op.remote.published_version ?? 'none')}`);
  if (op.live_operations_revision !== null) lines.push(`      live operations: revision ${op.live_operations_revision} in Yatris (not synced; edit them in Yatris)`);
  if (seeded && op.operation !== 'invalid') lines.push(op.operation === 'create' ? SEED_NOTE.create : SEED_NOTE.other);
  for (const issue of op.issues) lines.push(`      ${issue.path || '/'} ${issue.code}${ISSUE_HINT[issue.code] ? `: ${ISSUE_HINT[issue.code]}` : ''}`);
  return lines;
}

// ---------------------------------------------------------------- apply

export interface ApplyOptions extends RemoteOptions {
  plan: string;
  json?: boolean;
  now?: () => Date;
}

export async function applyReservations(root: string, options: ApplyOptions): Promise<SyncResult> {
  let plan: PlanFile;
  try {
    plan = readPlanFile(resolve(root, options.plan));
  } catch (error) {
    return { code: EXIT.invalid, stdout: '', stderr: `yatris reservations apply: ${(error as Error).message}` };
  }
  if (!plan.applicable) return { code: EXIT.reconcile, stdout: '', stderr: 'yatris reservations apply: this plan is not applicable (drift, conflict, adoption or invalid setups). Reconcile and run `yatris reservations plan` again; nothing was sent.' };
  if (Date.parse(plan.expires_at) <= (options.now?.() ?? new Date()).getTime()) {
    return { code: EXIT.stale, stdout: '', stderr: `yatris reservations apply: the plan expired at ${plan.expires_at}. Run \`yatris reservations plan\` again and review it; nothing was sent.` };
  }

  // The declarations must be exactly the ones the plan was made from
  const scan = scanSetups(root);
  const changed: string[] = [];
  const planned = new Map(Object.entries(plan.declarations));
  for (const [, entry] of planned) if (fileSha256(root, entry.path) !== entry.sha256) changed.push(entry.path);
  for (const d of [...scan.valid, ...scan.invalid.map((i) => ({ key: i.expectedKey, path: i.path }))]) if (!planned.has(d.key)) changed.push(`${d.path} (not in the plan)`);
  if (changed.length) {
    return { code: EXIT.stale, stdout: '', stderr: `yatris reservations apply: declarations changed since the plan: ${changed.join(', ')}. Run \`yatris reservations plan\` again and review it; nothing was sent.` };
  }
  const declarations = scan.valid.filter((d) => planned.has(d.key));

  let remote: Remote;
  let lock: ReservationsLock | null;
  try {
    remote = resolveRemote(root, options);
    if (remote.websiteId !== plan.websiteId) {
      return { code: EXIT.stale, stdout: '', stderr: `yatris reservations apply: the plan is for Website ${plan.websiteId}, but this repository is paired with Website ${remote.websiteId}; nothing was sent.` };
    }
    lock = lockFor(root, remote.websiteId);
  } catch (error) {
    return fail('apply', error, 'apply_reservation_setups');
  }

  // One key per deliberate apply; callWithRetry resends these same arguments
  const args = {
    website: remote.websiteId,
    plan_token: plan.plan_token,
    setups: declarations.map((d) => ({ key: d.key, declaration: d.declaration })),
    idempotency_key: `reservations-apply-${randomUUID()}`,
  };
  let answer: ReturnType<typeof parseApply>;
  try {
    answer = parseApply(await remote.call('apply_reservation_setups', args));
  } catch (error) {
    return fail('apply', error, 'apply_reservation_setups');
  }

  const next = lock ?? emptyReservationsLock(remote.websiteId);
  const local = new Map(declarations.map((d) => [d.key, d]));
  for (const setup of answer.setups) {
    const declaration = local.get(setup.key);
    if (!declaration) continue;
    const previous = next.setups[setup.key];
    next.setups[setup.key] = {
      state: WRITING.includes(setup.operation) ? 'draft' : (previous?.state ?? (setup.published_version === null ? 'draft' : 'published')),
      digest: setup.digest,
      draft_revision: setup.draft_revision,
      published_version: setup.published_version,
      definition_sha256: declaration.definitionSha256,
    };
  }
  writeReservationsLock(root, next);

  if (options.json) {
    return { code: EXIT.ok, stdout: JSON.stringify({ status: 'draft_saved', publication: 'pending', website: remote.websiteId, setups: answer.setups, lock: RESERVATIONS_LOCK_PATH }, null, 2), stderr: '' };
  }
  const lines = [`yatris reservations apply: Website ${remote.websiteId}: drafts saved in Yatris. Publication is pending: a person reviews and publishes each setup in Yatris; booking pages keep using the published version until then.`];
  for (const setup of answer.setups) {
    const seeded = setup.operation === 'create' && local.get(setup.key)?.declaration.operations !== undefined;
    lines.push(`  ${setup.key}: ${setup.operation}${WRITING.includes(setup.operation) ? `, draft revision ${String(setup.draft_revision)}` : ''}${seeded ? ', operations seeded from the declaration' : ''}${setup.review_url ? `, review: ${setup.review_url}` : ''}`);
  }
  lines.push('Daily operations (hours, closures, hosts, capacity, policies) live in Yatris; sync never overwrites them.');
  lines.push(`Updated ${RESERVATIONS_LOCK_PATH}; commit it with the declarations.`);
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
  /** The local `operations` seed was kept as it was (never live values). */
  seed_kept?: boolean;
  reason?: string;
}

export async function pullReservations(root: string, options: PullOptions): Promise<SyncResult> {
  for (const key of options.keys ?? []) {
    if (!new RegExp(SETUP_KEY_PATTERN, 'u').test(key)) return { code: EXIT.invalid, stdout: '', stderr: `yatris reservations pull: "${key}" is not a setup key.` };
  }

  let remote: Remote;
  let lock: ReservationsLock | null;
  try {
    remote = resolveRemote(root, options);
    lock = lockFor(root, remote.websiteId);
  } catch (error) {
    return fail('pull', error, 'list_reservation_setups');
  }

  let summaries: SetupSummary[];
  try {
    summaries = parseList(await remote.call('list_reservation_setups', { website: remote.websiteId }));
  } catch (error) {
    return fail('pull', error, 'list_reservation_setups');
  }

  const wanted = options.keys?.length ? new Set(options.keys) : null;
  if (summaries.length === 0) {
    return { code: wanted ? EXIT.invalid : EXIT.ok, stdout: wanted ? '' : `reservations pull: Website ${remote.websiteId} has no reservation setups in Yatris yet. Nothing was written.`, stderr: wanted ? `yatris reservations pull: Website ${remote.websiteId} has no reservation setups in Yatris.` : '' };
  }
  const missing = [...(wanted ?? [])].filter((key) => !summaries.some((s) => s.key === key));
  if (missing.length) return { code: EXIT.invalid, stdout: '', stderr: `yatris reservations pull: no setup ${missing.map((k) => `"${k}"`).join(', ')} in Yatris for Website ${remote.websiteId}; nothing was written.` };

  const next: ReservationsLock = lock ?? emptyReservationsLock(remote.websiteId);
  const outcomes: PullOutcome[] = [];
  for (const summary of summaries) {
    if (wanted && !wanted.has(summary.key)) continue;
    if (!new RegExp(SETUP_KEY_PATTERN, 'u').test(summary.key)) {
      outcomes.push({ key: summary.key, result: 'refused', reason: 'Yatris returned a key that is not a setup key' });
      continue;
    }
    const state = options.draft ? 'draft' : 'published';
    if (state === 'published' && summary.published_version === null) {
      outcomes.push({ key: summary.key, result: 'skipped', reason: 'not published yet (staff can pull the draft with --draft)' });
      continue;
    }

    let got: RemoteDefinition;
    try {
      got = parseDefinition(await remote.call('get_reservation_setup', { website: remote.websiteId, key: summary.key, state }));
    } catch (error) {
      if (error instanceof RemoteError && error.kind === 'tool_error' && error.code === 'not_found') {
        outcomes.push({ key: summary.key, result: 'skipped', reason: `no ${state} definition in Yatris` });
        continue;
      }
      return fail('pull', error, 'get_reservation_setup', outcomes.length ? `${outcomes.length} setup(s) were already handled; ${RESERVATIONS_LOCK_PATH} was not updated.` : undefined);
    }

    outcomes.push(pullOne(root, summary, got, next));
  }

  const changedLock = outcomes.some((o) => o.result === 'written' || o.result === 'baseline_advanced');
  if (changedLock) writeReservationsLock(root, next);
  const refused = outcomes.filter((o) => o.result === 'refused');
  const code = refused.length ? EXIT.reconcile : EXIT.ok;

  if (options.json) return { code, stdout: JSON.stringify({ website: remote.websiteId, state: options.draft ? 'draft' : 'published', setups: outcomes, lock: changedLock ? RESERVATIONS_LOCK_PATH : null }, null, 2), stderr: '' };

  const lines = [`yatris reservations pull: Website ${remote.websiteId}, ${options.draft ? 'unpublished drafts (staff operation: booking pages still use the published versions)' : 'published versions'} of the setup definitions (daily operations stay in Yatris)`];
  for (const o of outcomes) {
    const what = { written: `wrote ${RESERVATIONS_DIR}/${o.key}.json`, baseline_advanced: 'the local file already matches; recorded it as the baseline', up_to_date: 'up to date', refused: 'refused', skipped: 'skipped' }[o.result];
    const seed = o.result === 'written' && o.seed_kept ? ' (kept the local operations seed as it was; it is not the live operations)' : '';
    lines.push(`  ${o.result === 'refused' ? '✖' : '✔'} ${o.key}: ${what}${seed}${o.reason ? `: ${o.reason}` : ''}`);
  }
  if (changedLock) lines.push(`Updated ${RESERVATIONS_LOCK_PATH}; commit it with the declarations.`);
  return refused.length ? { code, stdout: '', stderr: lines.join('\n') } : { code, stdout: lines.join('\n'), stderr: '' };
}

function pullOne(root: string, summary: SetupSummary, got: RemoteDefinition, lock: ReservationsLock): PullOutcome {
  const key = summary.key;
  const path = `${RESERVATIONS_DIR}/${key}.json`;
  const state = got.state;
  if (got.key !== key) return { key, result: 'refused', reason: `Yatris returned the definition of "${got.key}"` };

  // Setup definitions only: whatever Yatris sends, pull never writes `$schema` or `operations` from it
  const definition = setupDefinition(got.definition);
  const local = readJson(join(root, path));
  const current = local === undefined ? null : definitionSha256(local);
  const exists = existsSync(join(root, path));
  const baseline = lock.setups[key];

  const entry = (sha: string): SetupLockEntry => ({
    state,
    digest: got.digest,
    published_version: got.version ?? summary.published_version,
    // A published baseline does not include an unpublished builder draft:
    // record no draft revision, so a later plan reports that draft as drift
    // instead of letting an update overwrite it (spec §4.1, decisions §5)
    draft_revision: state === 'draft' ? (got.revision ?? summary.draft_revision) : summary.has_unpublished_changes ? null : summary.draft_revision,
    definition_sha256: sha,
  });

  if (local !== undefined && canonical(setupDefinition(local)) === canonical(definition)) {
    const check = validateSetup(local);
    if (!check.valid) return refusedInvalid(key, state, check.errors);
    const next = entry(current!);
    const unchanged = baseline !== undefined && (Object.keys(next) as Array<keyof SetupLockEntry>).every((field) => baseline[field] === next[field]);
    lock.setups[key] = next;
    return { key, state, result: unchanged ? 'up_to_date' : 'baseline_advanced' };
  }
  if (exists && (!baseline || baseline.definition_sha256 !== current)) {
    return {
      key,
      state,
      result: 'refused',
      reason: baseline
        ? `${path} has local edits that were never applied. Nothing was overwritten. Run \`yatris reservations plan\` to see them; to take the Yatris version, move your file aside and pull again`
        : `${path} exists but has no baseline in ${RESERVATIONS_LOCK_PATH}, so it may hold work Yatris does not have. Nothing was overwritten; move it aside to adopt the Yatris setup, or keep it and resolve with staff`,
    };
  }

  // The file is absent, or its definition is unchanged since the baseline:
  // replace the definition, keeping the file's own `$schema` and operations seed exactly as they are
  const own = local && typeof local === 'object' && !Array.isArray(local) ? (local as Record<string, unknown>) : {};
  const written: Record<string, unknown> = {
    ...('$schema' in own ? { $schema: own.$schema } : {}),
    ...definition,
    ...('operations' in own ? { operations: own.operations } : {}),
  };
  const check = validateSetup(written);
  if (!check.valid || written.key !== key) return refusedInvalid(key, state, check.errors, 'operations' in own);

  const text = `${JSON.stringify(written, null, 2)}\n`;
  mkdirSync(join(root, RESERVATIONS_DIR), { recursive: true });
  writeFileSync(join(root, path), text);
  lock.setups[key] = entry(definitionSha256(written));
  return { key, state, result: 'written', ...('operations' in own ? { seed_kept: true } : {}) };
}

function refusedInvalid(key: string, state: 'draft' | 'published', errors: Array<{ path: string; code: string }>, withSeed = false): PullOutcome {
  const issues = errors.slice(0, 3).map((e) => `${e.path || '/'} ${e.code}`).join(', ') || 'key mismatch';
  const seedOnly = withSeed && errors.length > 0 && errors.every((e) => e.path.startsWith('/operations'));
  return {
    key,
    state,
    result: 'refused',
    reason: seedOnly
      ? `the ${state} definition does not validate together with the operations seed kept in ${RESERVATIONS_DIR}/${key}.json (${issues}). The seed is used only when a setup is created; remove or correct it, then pull again`
      : `the ${state} definition does not pass this @yatris/astro's validator (${issues}); update @yatris/astro with \`npm run yatris:update\``,
  };
}

// ---------------------------------------------------------------- status

export interface StatusOptions extends RemoteOptions {
  key: string;
  json?: boolean;
}

/**
 * `yatris reservations status <key>`: readiness and the current, redacted
 * live operations, read from Yatris. Read-only. The live operations are the
 * values bookings use now; the `operations` seed in the repository is stale
 * after creation and is never shown as live.
 */
export async function statusReservation(root: string, options: StatusOptions): Promise<SyncResult> {
  if (!new RegExp(SETUP_KEY_PATTERN, 'u').test(options.key)) return { code: EXIT.invalid, stdout: '', stderr: `yatris reservations status: "${options.key}" is not a setup key.` };
  let remote: Remote;
  try {
    remote = resolveRemote(root, options);
  } catch (error) {
    return fail('status', error, 'get_reservation_setup_readiness');
  }
  let answer: Record<string, unknown>;
  try {
    const value = await remote.call('get_reservation_setup_readiness', { website: remote.websiteId, key: options.key });
    if (!value || typeof value !== 'object' || !Array.isArray((value as { readiness?: unknown }).readiness)) protocol('get_reservation_setup_readiness: unexpected answer');
    answer = value as Record<string, unknown>;
  } catch (error) {
    return fail('status', error, 'get_reservation_setup_readiness');
  }

  const live = answer.live_operations && typeof answer.live_operations === 'object' ? (answer.live_operations as Record<string, unknown>) : null;
  const seedPath = `${RESERVATIONS_DIR}/${options.key}.json`;
  if (options.json) {
    return {
      code: EXIT.ok,
      stdout: JSON.stringify({ website: remote.websiteId, ...answer, live_operations: live ? { ...live, source: 'live', note: `live values from Yatris (redacted); not the operations seed in ${seedPath}` } : null }, null, 2),
      stderr: '',
    };
  }

  const items = (answer.readiness as Array<Record<string, unknown>>).filter((i) => i && typeof i === 'object');
  const lines = [`yatris reservations status ${options.key}: Website ${remote.websiteId} (read-only)`];
  lines.push(`  status: ${String(answer.status ?? 'unknown')}, published version ${String(answer.published_version ?? 'none')}${answer.has_unpublished_changes === true ? ', unpublished changes waiting for review' : ''}`);
  lines.push('  readiness:');
  for (const item of items) lines.push(`    ${item.ok === true ? '✔' : item.blocking === true ? '✖' : '⚠'} ${String(item.label ?? item.code)}${item.ok !== true && item.detail ? `: ${String(item.detail)}` : ''}`);
  if (live) {
    lines.push(`  live operations (current values in Yatris, redacted): revision ${String(live.revision ?? answer.live_operations_revision ?? 'unknown')}${live.saved_at ? `, saved ${String(live.saved_at)}` : ''}. These are what bookings use; the operations seed in ${seedPath} is not. Read them with --json; edit them in Yatris.`);
  } else {
    lines.push(`  live operations: none in Yatris yet. Any operations seed in ${seedPath} is not live; Yatris uses it once, when apply creates the setup.`);
  }
  if (typeof answer.review_url === 'string' && answer.review_url) lines.push(`  review: ${answer.review_url}`);
  return { code: EXIT.ok, stdout: lines.join('\n'), stderr: '' };
}

// ---------------------------------------------------------------- helpers

function fail(action: string, error: unknown, tool: string, extra?: string): SyncResult {
  const { code, message } = describeFailure(error, tool);
  return { code, stdout: '', stderr: `yatris reservations ${action}: ${message}${extra ? ` ${extra}` : ''}` };
}

/** The lock, checked against the paired Website. */
function lockFor(root: string, websiteId: number): ReservationsLock | null {
  const lock = readReservationsLock(root);
  if (lock && lock.websiteId !== websiteId) throw new Error(`${RESERVATIONS_LOCK_PATH} is for Website ${lock.websiteId}, but this repository is paired with Website ${websiteId}. Restore the right lock from Git; nothing was sent.`);
  return lock;
}

function baselineOf(entry: SetupLockEntry | undefined): { digest: string; draft_revision: Revision; published_version: Revision } | null {
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
  if (['public', 'src', 'dist', '.astro'].includes(top)) return `refusing to write a plan under ${top}/: a plan names private setup changes and must never be published or built. Use the default ${DEFAULT_RESERVATIONS_PLAN_PATH}.`;
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
  if (!existsSync(path)) throw new Error(`no plan file at ${path}; run \`yatris reservations plan\` first.`);
  let plan: Partial<PlanFile>;
  try {
    plan = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new Error(`${path} is not a plan file (invalid JSON).`);
  }
  if (plan?.planVersion !== 1 || typeof plan.websiteId !== 'number' || typeof plan.plan_token !== 'string' || typeof plan.expires_at !== 'string' || typeof plan.applicable !== 'boolean' || !plan.declarations || typeof plan.declarations !== 'object') {
    throw new Error(`${path} is not a plan written by \`yatris reservations plan\`.`);
  }
  for (const entry of Object.values(plan.declarations)) {
    if (typeof entry?.path !== 'string' || typeof entry.sha256 !== 'string' || !entry.path.startsWith(`${RESERVATIONS_DIR}/`)) throw new Error(`${path} is not a plan written by \`yatris reservations plan\`.`);
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
  if (!v || typeof v.plan_token !== 'string' || typeof v.expires_at !== 'string' || typeof v.applicable !== 'boolean' || !Array.isArray(v.operations)) protocol('plan_reservation_setups: unexpected answer');
  for (const op of v.operations) {
    if (!op || typeof op.key !== 'string' || !OPERATIONS.includes(op.operation)) protocol(`plan_reservation_setups: unknown operation ${String(op?.operation)}`);
    op.changed_paths = Array.isArray(op.changed_paths) ? op.changed_paths.filter((p): p is string => typeof p === 'string') : [];
    op.issues = Array.isArray(op.issues) ? op.issues.filter((i) => i && typeof i.code === 'string').map((i) => ({ path: String(i.path ?? ''), code: i.code })) : [];
    op.remote = op.remote && typeof op.remote === 'object' ? { draft_revision: op.remote.draft_revision ?? null, published_version: op.remote.published_version ?? null, digest: op.remote.digest ?? null } : null;
    op.local_digest = typeof op.local_digest === 'string' ? op.local_digest : null;
    op.live_operations_revision = typeof op.live_operations_revision === 'number' && Number.isFinite(op.live_operations_revision) ? op.live_operations_revision : null;
  }
  return v as PlanAnswer;
}

function parseApply(value: unknown) {
  const v = value as { status?: unknown; setups?: unknown } | null;
  if (!v || v.status !== 'draft_saved' || !Array.isArray(v.setups)) protocol(`apply_reservation_setups: expected status draft_saved, got ${String(v?.status)}`);
  const setups = (v.setups as Array<Record<string, unknown>>).map((s) => {
    if (typeof s?.key !== 'string' || typeof s.digest !== 'string' || !isRevision(s.draft_revision ?? null) || !isRevision(s.published_version ?? null)) protocol('apply_reservation_setups: incomplete setup result');
    return { key: s.key, operation: (OPERATIONS as string[]).includes(String(s.operation)) ? (s.operation as Operation) : 'update_draft', draft_revision: (s.draft_revision ?? null) as Revision, digest: s.digest, published_version: (s.published_version ?? null) as Revision, review_url: typeof s.review_url === 'string' ? s.review_url : '' };
  });
  return { setups };
}

function parseList(value: unknown): SetupSummary[] {
  const setups = (value as { setups?: unknown } | null)?.setups;
  if (!Array.isArray(setups)) protocol('list_reservation_setups: unexpected answer');
  return setups.map((s: Record<string, unknown>) => {
    if (typeof s?.key !== 'string') protocol('list_reservation_setups: a setup without a key');
    const draftDigest = typeof s.draft_digest === 'string' ? s.draft_digest : null;
    const publishedDigest = typeof s.published_digest === 'string' ? s.published_digest : null;
    return {
      key: s.key,
      name: String(s.name ?? s.key),
      mode: String(s.mode ?? ''),
      status: String(s.status ?? ''),
      published_version: isRevision(s.published_version) ? s.published_version : null,
      draft_revision: isRevision(s.draft_revision) ? s.draft_revision : null,
      draft_digest: draftDigest,
      published_digest: publishedDigest,
      // Unpublished builder changes: an explicit flag when Yatris sends one, else a draft that differs from the publication
      has_unpublished_changes: typeof s.has_unpublished_changes === 'boolean' ? s.has_unpublished_changes : draftDigest !== null && publishedDigest !== null && draftDigest !== publishedDigest,
    };
  });
}

function parseDefinition(value: unknown): RemoteDefinition {
  const v = value as Partial<RemoteDefinition> | null;
  if (!v || typeof v.key !== 'string' || (v.state !== 'draft' && v.state !== 'published') || typeof v.digest !== 'string' || !v.definition || typeof v.definition !== 'object' || Array.isArray(v.definition)) protocol('get_reservation_setup: unexpected answer');
  return { key: v.key, state: v.state, revision: isRevision(v.revision) ? v.revision : null, version: isRevision(v.version) ? v.version : null, digest: v.digest, definition: v.definition, review_url: typeof v.review_url === 'string' ? v.review_url : '' };
}
