import { createHash, randomUUID } from 'node:crypto';
import { RemoteError, type McpTransport } from '../src/yatris-remote.js';

/**
 * An in-memory stand-in for the Yatris Product MCP contact-form tools, with
 * the frozen contract of YatrisCMS#392 / #390. It computes the spec §4.1
 * drift matrix the way the server is specified to, so CLI tests exercise
 * real baselines rather than canned answers. Digests here are a test detail:
 * the CLI never computes them, it only stores what this fake returns.
 */

type Json = Record<string, unknown>;

interface RemoteForm {
  name: string;
  draft: { definition: Json; revision: number } | null;
  published: { definition: Json; version: number } | null;
  /** Dashboard-managed recipients; never part of a returned definition. */
  recipients: string[];
}

interface StoredPlan {
  expiresAt: number;
  forms: Map<string, { local: string; remote: { draft_revision: number | null; published_version: number | null; digest: string | null } | null; operation: string }>;
}

export interface Call {
  name: string;
  args: Json;
}

export class FakeYatris implements McpTransport {
  readonly forms = new Map<string, RemoteForm>();
  readonly calls: Call[] = [];
  readonly plans = new Map<string, StoredPlan>();
  readonly idempotency = new Map<string, { fingerprint: string; result: unknown }>();
  readonly failures: Array<{ tool: string; error: RemoteError }> = [];
  readiness: Record<string, unknown> | null = null;
  knownTools = new Set(['list_contact_forms', 'get_contact_form', 'plan_contact_forms', 'apply_contact_forms', 'get_contact_form_readiness', 'import_mail_profile']);
  now = () => Date.now();

  constructor(readonly websiteId = 42) {}

  /** Makes the next `times` calls of `tool` fail with `error`. */
  failNext(tool: string, error: RemoteError, times = 1): void {
    for (let i = 0; i < times; i++) this.failures.push({ tool, error });
  }

  /** A staff edit in the builder: saves a new draft revision. */
  staffEdit(key: string, change: (definition: Json) => void): void {
    const form = this.forms.get(key)!;
    const base = structuredClone(form.draft?.definition ?? form.published!.definition);
    change(base);
    form.draft = { definition: base, revision: (form.draft?.revision ?? form.published?.version ?? 0) + 1 };
  }

  /** A person publishes the current draft. */
  publish(key: string): void {
    const form = this.forms.get(key)!;
    if (!form.draft) return;
    form.published = { definition: form.draft.definition, version: (form.published?.version ?? 0) + 1 };
    form.draft = null;
  }

  /** Seeds a form that exists only in Yatris (created in the builder). */
  seed(key: string, definition: Json, published = true): void {
    const authoring = stripRecipients(definition);
    this.forms.set(key, { name: String(definition.name), draft: published ? null : { definition: authoring, revision: 1 }, published: published ? { definition: authoring, version: 1 } : null, recipients: [] });
  }

  async callTool(name: string, args: Json): Promise<unknown> {
    this.calls.push({ name, args: structuredClone(args) });
    const failure = this.failures.findIndex((f) => f.tool === name);
    if (failure !== -1) throw this.failures.splice(failure, 1)[0].error;
    if (!this.knownTools.has(name)) throw new RemoteError('unknown_tool', `Tool [${name}] not found.`);
    if (args.website !== this.websiteId) throw new RemoteError('tool_error', 'Website not found.', 'not_found');
    switch (name) {
      case 'list_contact_forms':
        return { forms: [...this.forms.entries()].map(([key, f]) => this.summary(key, f)) };
      case 'get_contact_form':
        return this.get(String(args.key), args.state as 'draft' | 'published');
      case 'plan_contact_forms':
        return this.plan(args.forms as Array<{ key: string; declaration: Json; baseline: { digest: string; draft_revision: number | null; published_version: number | null } | null }>);
      case 'apply_contact_forms':
        return this.apply(args);
      case 'get_contact_form_readiness':
        return this.readinessOf(String(args.key));
      case 'import_mail_profile': {
        const s = args.settings as Json;
        const { password: _password, ...shown } = s;
        return { status: 'pending_test', revision: 3, settings: { ...shown, password_set: true }, next: 'Yatris の「メールの連携」でテスト送信し、有効化してください。' };
      }
    }
    throw new Error(`unhandled ${name}`);
  }

  calledTools(): string[] {
    return this.calls.map((c) => c.name);
  }

  current(key: string): { definition: Json; digest: string; draft_revision: number | null; published_version: number | null } | null {
    const form = this.forms.get(key);
    if (!form) return null;
    const definition = form.draft?.definition ?? form.published!.definition;
    return { definition, digest: digest(definition), draft_revision: form.draft?.revision ?? null, published_version: form.published?.version ?? null };
  }

  private summary(key: string, f: RemoteForm) {
    return {
      key,
      name: f.name,
      status: 'active',
      published_version: f.published?.version ?? null,
      draft_revision: f.draft?.revision ?? null,
      draft_digest: f.draft ? digest(f.draft.definition) : null,
      published_digest: f.published ? digest(f.published.definition) : null,
      has_unpublished_changes: f.draft !== null && f.published !== null,
    };
  }

  private get(key: string, state: 'draft' | 'published') {
    const form = this.forms.get(key);
    if (!form) throw new RemoteError('tool_error', `Form "${key}" does not exist.`, 'not_found');
    const chosen = state === 'draft' ? (form.draft ?? (form.published ? { definition: form.published.definition, revision: null } : null)) : form.published;
    if (!chosen) throw new RemoteError('tool_error', `Form "${key}" has no ${state} definition.`, 'not_found');
    return {
      key,
      state,
      revision: state === 'draft' ? (form.draft?.revision ?? null) : null,
      version: form.published?.version ?? null,
      digest: digest(chosen.definition),
      definition: structuredClone(chosen.definition),
      review_url: `https://app.yatris.jp/sites/${this.websiteId}/forms/${key}`,
    };
  }

  private plan(forms: Array<{ key: string; declaration: Json; baseline: { digest: string; draft_revision: number | null; published_version: number | null } | null }>) {
    const stored: StoredPlan = { expiresAt: this.now() + 15 * 60_000, forms: new Map() };
    const operations = forms.map(({ key, declaration, baseline }) => {
      const local = digest(stripRecipients(declaration));
      const remote = this.current(key);
      const remoteState = remote ? { draft_revision: remote.draft_revision, published_version: remote.published_version, digest: remote.digest } : null;
      let operation: string;
      const issues: Array<{ path: string; code: string }> = [];
      if (declaration.name === 'SERVER-INVALID') {
        operation = 'invalid';
        issues.push({ path: '/name', code: 'server_rule' });
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
      stored.forms.set(key, { local, remote: remoteState, operation });
      const against = stripRecipients(remote?.definition ?? {});
      const changed = remote ? Object.keys({ ...against, ...stripRecipients(declaration) }).filter((k) => JSON.stringify(against[k]) !== JSON.stringify(stripRecipients(declaration)[k])).map((k) => `/${k}`) : [];
      return { key, operation, local_digest: local, changed_paths: changed, remote: remoteState, issues };
    });
    const token = `plan_${randomUUID()}`;
    this.plans.set(token, stored);
    const blocking = ['remote_drift', 'conflict', 'adopt_required', 'invalid'];
    return { plan_token: token, expires_at: new Date(stored.expiresAt).toISOString(), applicable: !operations.some((o) => blocking.includes(o.operation)), operations };
  }

  private apply(args: Json) {
    const key = String(args.idempotency_key);
    const fingerprint = JSON.stringify({ plan: args.plan_token, forms: args.forms });
    const replay = this.idempotency.get(key);
    if (replay) {
      if (replay.fingerprint !== fingerprint) throw new RemoteError('tool_error', 'This idempotency key was used for a different request.', 'conflict');
      return replay.result;
    }
    const plan = this.plans.get(String(args.plan_token));
    if (!plan) throw new RemoteError('tool_error', 'Unknown plan.', 'plan_mismatch');
    if (plan.expiresAt <= this.now()) throw new RemoteError('tool_error', 'The plan expired.', 'plan_expired');
    const forms = args.forms as Array<{ key: string; declaration: Json }>;
    // Validate everything first; all or nothing
    for (const { key: formKey, declaration } of forms) {
      const planned = plan.forms.get(formKey);
      if (!planned || planned.local !== digest(stripRecipients(declaration))) throw new RemoteError('tool_error', `The declaration of "${formKey}" differs from the plan.`, 'plan_mismatch');
      const now = this.current(formKey);
      const nowState = now ? { draft_revision: now.draft_revision, published_version: now.published_version, digest: now.digest } : null;
      if (JSON.stringify(nowState) !== JSON.stringify(planned.remote)) throw new RemoteError('tool_error', `"${formKey}" changed in Yatris since the plan.`, 'revision_conflict');
      if (['remote_drift', 'conflict', 'adopt_required', 'invalid'].includes(planned.operation)) throw new RemoteError('tool_error', 'The plan is not applicable.', 'conflict');
    }
    const results = forms.map(({ key: formKey, declaration }) => {
      const planned = plan.forms.get(formKey)!;
      if (planned.operation === 'create') {
        const to = ((declaration.mail as Json)?.notification as Json)?.to;
        this.forms.set(formKey, { name: String(declaration.name), draft: { definition: stripRecipients(declaration), revision: 1 }, published: null, recipients: Array.isArray(to) ? (to as string[]) : [] });
      } else if (planned.operation === 'update_draft') {
        const form = this.forms.get(formKey)!;
        form.draft = { definition: stripRecipients(declaration), revision: (form.draft?.revision ?? form.published?.version ?? 0) + 1 };
      }
      const now = this.current(formKey)!;
      return { key: formKey, operation: planned.operation, draft_revision: now.draft_revision, digest: now.digest, published_version: now.published_version, review_url: `https://app.yatris.jp/sites/${this.websiteId}/forms/${formKey}` };
    });
    const result = { status: 'draft_saved', publication: 'pending', forms: results };
    this.idempotency.set(key, { fingerprint, result });
    return result;
  }

  private readinessOf(key: string) {
    const form = this.forms.get(key);
    if (!form) throw new RemoteError('tool_error', `Form "${key}" does not exist.`, 'not_found');
    return (
      this.readiness ?? {
        key,
        readiness: [
          { code: 'published', label: '公開済み', ok: form.published !== null, blocking: true, detail: null },
          { code: 'recipients', label: '通知先', ok: form.recipients.length > 0, blocking: true, detail: null },
        ],
        published_version: form.published?.version ?? null,
        has_unpublished_changes: form.draft !== null && form.published !== null,
        review_url: `https://app.yatris.jp/sites/${this.websiteId}/forms/${key}`,
      }
    );
  }
}

/** The authoring definition without dashboard-managed recipients. */
export function stripRecipients(definition: Json): Json {
  const copy = structuredClone(definition);
  const notification = (copy.mail as Json | undefined)?.notification as Json | undefined;
  if (notification) delete notification.to;
  return copy;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Json)[k])}`).join(',')}}`;
  return JSON.stringify(value);
}

function digest(definition: Json): string {
  return `sha256:${createHash('sha256').update(canonical(stripRecipients(definition))).digest('hex')}`;
}
