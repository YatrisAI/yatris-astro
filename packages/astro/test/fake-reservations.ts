import { createHash, randomUUID } from 'node:crypto';
import { RemoteError, type McpTransport } from '../src/yatris-remote.js';

/**
 * An in-memory stand-in for the Yatris Product MCP reservation setup tools
 * (YatrisCMS#432), shaped like the contact-form fake (fake-yatris.ts). It
 * computes the drift matrix the way the server is specified to: digests
 * cover the setup definition only (no `$schema`, no `operations`), the
 * operations seed is used once when apply creates a setup, and daily
 * operations live beside the definition with their own revision. Digests are
 * a test detail: the CLI never computes them.
 */

type Json = Record<string, any>;

interface RemoteSetup {
  mode: string;
  presentation: string | null;
  archived: boolean;
  draft: { definition: Json; revision: number } | null;
  published: { definition: Json; version: number } | null;
  /** Live daily operations, edited in Yatris only. */
  live: { operations: Json; revision: number; saved_at: string } | null;
}

interface StoredPlan {
  expiresAt: number;
  setups: Map<string, { local: string; remote: { draft_revision: number | null; published_version: number | null; digest: string | null } | null; operation: string }>;
}

export interface Call {
  name: string;
  args: Json;
}

export class FakeReservations implements McpTransport {
  readonly setups = new Map<string, RemoteSetup>();
  readonly calls: Call[] = [];
  readonly plans = new Map<string, StoredPlan>();
  readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  readonly failures: Array<{ tool: string; error: RemoteError }> = [];
  knownTools = new Set(['list_reservation_setups', 'get_reservation_setup', 'plan_reservation_setups', 'apply_reservation_setups', 'get_reservation_setup_readiness']);
  now = () => Date.now();

  constructor(readonly websiteId = 42) {}

  failNext(tool: string, error: RemoteError, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ tool, error });
  }

  /** A staff edit in the setup builder: saves a new draft revision of the definition. */
  staffEdit(key: string, change: (definition: Json) => void): void {
    const setup = this.setups.get(key)!;
    const base = structuredClone(setup.draft?.definition ?? setup.published!.definition);
    change(base);
    setup.draft = { definition: base, revision: (setup.draft?.revision ?? setup.published?.version ?? 0) + 1 };
  }

  /** A client's daily operations edit in Yatris (hours, closures, capacity …): never part of the definition. */
  operationsEdit(key: string, change: (operations: Json) => void): void {
    const setup = this.setups.get(key)!;
    const operations = structuredClone(setup.live?.operations ?? {});
    change(operations);
    setup.live = { operations, revision: (setup.live?.revision ?? 0) + 1, saved_at: new Date(this.now()).toISOString() };
  }

  publish(key: string): void {
    const setup = this.setups.get(key)!;
    if (!setup.draft) return;
    setup.published = { definition: setup.draft.definition, version: (setup.published?.version ?? 0) + 1 };
    setup.draft = null;
  }

  archive(key: string): void {
    this.setups.get(key)!.archived = true;
  }

  /** Seeds a setup that exists only in Yatris (built in the setup builder), with live operations. */
  seed(key: string, declaration: Json, published = true): void {
    const definition = definitionOf(declaration);
    this.setups.set(key, {
      mode: String(declaration.mode),
      presentation: (declaration.presentation as string | undefined) ?? null,
      archived: false,
      draft: published ? null : { definition, revision: 1 },
      published: published ? { definition, version: 1 } : null,
      live: declaration.operations ? { operations: structuredClone(declaration.operations), revision: 1, saved_at: new Date(this.now()).toISOString() } : null,
    });
  }

  async callTool(name: string, args: Json): Promise<unknown> {
    this.calls.push({ name, args: structuredClone(args) });
    const failure = this.failures.findIndex((f) => f.tool === name);
    if (failure !== -1) throw this.failures.splice(failure, 1)[0].error;
    if (!this.knownTools.has(name)) throw new RemoteError('unknown_tool', `Tool [${name}] not found.`);
    if (args.website !== this.websiteId) throw new RemoteError('tool_error', 'Website not found.', 'not_found');
    switch (name) {
      case 'list_reservation_setups':
        return { setups: [...this.setups.entries()].map(([key, s]) => this.summary(key, s)) };
      case 'get_reservation_setup':
        return this.get(String(args.key), args.state as 'draft' | 'published');
      case 'plan_reservation_setups':
        return this.plan(args.setups);
      case 'apply_reservation_setups':
        return this.apply(args);
      case 'get_reservation_setup_readiness':
        return this.readinessOf(String(args.key));
    }
    throw new Error(`unhandled ${name}`);
  }

  calledTools(): string[] {
    return this.calls.map((c) => c.name);
  }

  current(key: string): { definition: Json; digest: string; draft_revision: number | null; published_version: number | null } | null {
    const setup = this.setups.get(key);
    if (!setup) return null;
    const definition = setup.draft?.definition ?? setup.published!.definition;
    return { definition, digest: digest(definition), draft_revision: setup.draft?.revision ?? null, published_version: setup.published?.version ?? null };
  }

  private summary(key: string, s: RemoteSetup) {
    const current = this.current(key)!;
    return {
      key,
      name: String(current.definition.name),
      mode: s.mode,
      presentation: s.presentation,
      status: s.archived ? 'archived' : 'active',
      draft_revision: s.draft?.revision ?? null,
      published_version: s.published?.version ?? null,
      digest: current.digest,
      draft_digest: s.draft ? digest(s.draft.definition) : null,
      published_digest: s.published ? digest(s.published.definition) : null,
      has_unpublished_changes: s.draft !== null && s.published !== null,
      review_url: `https://app.yatris.jp/sites/${this.websiteId}/reservations/${key}`,
    };
  }

  private get(key: string, state: 'draft' | 'published') {
    const setup = this.setups.get(key);
    if (!setup) throw new RemoteError('tool_error', `Setup "${key}" does not exist.`, 'not_found');
    const chosen = state === 'draft' ? (setup.draft ?? (setup.published ? { definition: setup.published.definition, revision: null } : null)) : setup.published;
    if (!chosen) throw new RemoteError('tool_error', `Setup "${key}" has no ${state} definition.`, 'not_found');
    return {
      key,
      state,
      revision: state === 'draft' ? (setup.draft?.revision ?? null) : null,
      version: setup.published?.version ?? null,
      digest: digest(chosen.definition),
      definition: structuredClone(chosen.definition),
      review_url: `https://app.yatris.jp/sites/${this.websiteId}/reservations/${key}`,
    };
  }

  private plan(setups: Array<{ key: string; declaration: Json; baseline: { digest: string; draft_revision: number | null; published_version: number | null } | null }>) {
    const stored: StoredPlan = { expiresAt: this.now() + 15 * 60_000, setups: new Map() };
    const operations = setups.map(({ key, declaration, baseline }) => {
      const local = digest(declaration);
      const existing = this.setups.get(key);
      const remote = this.current(key);
      const remoteState = remote ? { draft_revision: remote.draft_revision, published_version: remote.published_version, digest: remote.digest } : null;
      let operation: string;
      const issues: Array<{ path: string; code: string }> = [];
      if (declaration.name === 'SERVER-INVALID') {
        operation = 'invalid';
        issues.push({ path: '/name', code: 'server_rule' });
      } else if (existing?.archived) {
        operation = 'invalid';
        issues.push({ path: '', code: 'setup_archived' });
      } else if (existing && (existing.mode !== declaration.mode || existing.presentation !== (declaration.presentation ?? null))) {
        operation = 'invalid';
        issues.push({ path: '/mode', code: 'mode_immutable' });
      } else if (!remote) operation = 'create';
      else if (!baseline) operation = local === remote.digest ? 'accept_remote' : 'adopt_required';
      else {
        const localChanged = local !== baseline.digest;
        const remoteChanged = remote.digest !== baseline.digest || remote.draft_revision !== baseline.draft_revision || remote.published_version !== baseline.published_version;
        if (!localChanged && !remoteChanged) operation = 'noop';
        else if (localChanged && !remoteChanged) operation = 'update_draft';
        else if (!localChanged) operation = 'remote_drift';
        else operation = local === remote.digest ? 'accept_remote' : 'conflict';
      }
      stored.setups.set(key, { local, remote: remoteState, operation });
      const mine = definitionOf(declaration);
      const against = remote?.definition ?? {};
      const changed = remote ? Object.keys({ ...against, ...mine }).filter((k) => JSON.stringify(against[k]) !== JSON.stringify(mine[k])).map((k) => `/${k}`) : [];
      return { key, operation, local_digest: local, changed_paths: changed, remote: remoteState, issues, live_operations_revision: existing?.live?.revision ?? null };
    });
    const token = `plan_${randomUUID()}`;
    this.plans.set(token, stored);
    const blocking = ['remote_drift', 'conflict', 'adopt_required', 'invalid'];
    return { plan_token: token, expires_at: new Date(stored.expiresAt).toISOString(), applicable: !operations.some((o) => blocking.includes(o.operation)), operations };
  }

  private apply(args: Json) {
    const key = String(args.idempotency_key);
    const fingerprint = JSON.stringify({ plan: args.plan_token, setups: args.setups });
    const replay = this.idempotency.get(key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new RemoteError('tool_error', 'This idempotency key was used for a different request.', 'conflict');
      return { ...(replay.result as Json), replayed: true };
    }
    const plan = this.plans.get(String(args.plan_token));
    if (!plan) throw new RemoteError('tool_error', 'Unknown plan.', 'plan_mismatch');
    if (plan.expiresAt <= this.now()) throw new RemoteError('tool_error', 'The plan expired.', 'plan_expired');
    const setups = args.setups as Array<{ key: string; declaration: Json }>;
    for (const { key: setupKey, declaration } of setups) {
      const planned = plan.setups.get(setupKey);
      if (!planned || planned.local !== digest(declaration)) throw new RemoteError('tool_error', `The declaration of "${setupKey}" differs from the plan.`, 'plan_mismatch');
      const now = this.current(setupKey);
      const nowState = now ? { draft_revision: now.draft_revision, published_version: now.published_version, digest: now.digest } : null;
      if (JSON.stringify(nowState) !== JSON.stringify(planned.remote)) throw new RemoteError('tool_error', `"${setupKey}" changed in Yatris since the plan.`, 'revision_conflict');
      if (['remote_drift', 'conflict', 'adopt_required', 'invalid'].includes(planned.operation)) throw new RemoteError('tool_error', 'The plan is not applicable.', 'conflict');
    }
    const results = setups.map(({ key: setupKey, declaration }) => {
      const planned = plan.setups.get(setupKey)!;
      if (planned.operation === 'create') {
        this.setups.set(setupKey, {
          mode: String(declaration.mode),
          presentation: (declaration.presentation as string | undefined) ?? null,
          archived: false,
          draft: { definition: definitionOf(declaration), revision: 1 },
          published: null,
          // The seed, used once
          live: declaration.operations ? { operations: structuredClone(declaration.operations), revision: 1, saved_at: new Date(this.now()).toISOString() } : null,
        });
      } else if (planned.operation === 'update_draft') {
        const setup = this.setups.get(setupKey)!;
        setup.draft = { definition: definitionOf(declaration), revision: (setup.draft?.revision ?? setup.published?.version ?? 0) + 1 };
      }
      const s = this.setups.get(setupKey)!;
      const now = this.current(setupKey)!;
      return {
        key: setupKey,
        operation: planned.operation,
        draft_revision: now.draft_revision,
        published_version: now.published_version,
        digest: now.digest,
        draft_digest: s.draft ? digest(s.draft.definition) : null,
        published_digest: s.published ? digest(s.published.definition) : null,
        review_url: `https://app.yatris.jp/sites/${this.websiteId}/reservations/${setupKey}`,
      };
    });
    const result = { status: 'draft_saved', publication: 'pending', setups: results, replayed: false };
    this.idempotency.set(key, { fingerprint, result });
    return result;
  }

  private readinessOf(key: string) {
    const setup = this.setups.get(key);
    if (!setup) throw new RemoteError('tool_error', `Setup "${key}" does not exist.`, 'not_found');
    const live = setup.live ? redact(setup.live.operations) : null;
    return {
      key,
      status: setup.archived ? 'archived' : 'active',
      readiness: [
        { code: 'published', label: '公開済み', ok: setup.published !== null, blocking: true, detail: null },
        { code: 'operations', label: '営業時間・担当者', ok: setup.live !== null, blocking: true, detail: setup.live ? null : 'Yatris で入力してください' },
      ],
      published_version: setup.published?.version ?? null,
      has_unpublished_changes: setup.draft !== null && setup.published !== null,
      recipients_count: 0,
      live_operations: setup.live ? { source: 'live', revision: setup.live.revision, saved_at: setup.live.saved_at, operations: live } : null,
      live_operations_revision: setup.live?.revision ?? null,
      review_url: `https://app.yatris.jp/sites/${this.websiteId}/reservations/${key}`,
    };
  }

  /** The live operations as stored (tests). */
  liveOperations(key: string): Json | null {
    return this.setups.get(key)?.live?.operations ?? null;
  }
}

/** The setup definition: no `$schema`, no `operations`. */
export function definitionOf(declaration: Json): Json {
  const { $schema: _schema, operations: _operations, ...definition } = structuredClone(declaration);
  return definition;
}

function redact(operations: Json): Json {
  const copy = structuredClone(operations);
  for (const location of (copy.locations as Json[] | undefined) ?? []) {
    if ('meetingUrl' in location) {
      delete location.meetingUrl;
      location.meetingUrlSet = true;
    }
  }
  return copy;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Json)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(declaration: Json): string {
  return `sha256:${createHash('sha256').update(canonical(definitionOf(declaration))).digest('hex')}`;
}
