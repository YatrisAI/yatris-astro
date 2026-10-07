import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeYatris } from '../test/fake-yatris.js';
import { run } from './commands.js';
import { FORMS_LOCK_PATH, readFormsLock } from './forms-lock.js';
import { applyForms, DEFAULT_PLAN_PATH } from './forms-sync.js';
import { RemoteError } from './yatris-remote.js';

/**
 * `yatris forms plan | apply | pull` against a faked Product MCP
 * (YatrisCMS#392): every spec §4.1 drift case, plan staleness, idempotent
 * retries, exit codes, and that pull never discards local work.
 */

const example = new URL('../../../contracts/forms/v1/examples/contact.json', import.meta.url);
type Json = Record<string, any>;

let root: string;
let fake: FakeYatris;

function site({ paired = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-sync-'));
  mkdirSync(join(dir, 'src/forms'), { recursive: true });
  mkdirSync(join(dir, '.yatris'));
  cpSync(example, join(dir, 'src/forms/contact.json'));
  writeFileSync(join(dir, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: paired ? 42 : null }));
  writeFileSync(join(dir, '.yatris/mcp.json'), JSON.stringify({ contractVersion: 1, server: { name: 'yatris', transport: 'streamable-http', url: 'https://app.yatris.jp/mcp/yatris' } }));
  writeFileSync(join(dir, '.gitignore'), `${DEFAULT_PLAN_PATH}\n`);
  return dir;
}

const env = (extra: Json = {}) => ({ cwd: root, environment: { YATRIS_MCP_TOKEN: 'test-token' }, mcpTransport: () => fake, retryDelayMs: 0, ...extra });
const forms = (...args: string[]) => run(['forms', ...args], env());
const declaration = (key = 'contact'): Json => JSON.parse(readFileSync(join(root, `src/forms/${key}.json`), 'utf8'));
const writeDeclaration = (value: Json, key = 'contact') => writeFileSync(join(root, `src/forms/${key}.json`), `${JSON.stringify(value, null, 2)}\n`);
const editLocal = (change: (d: Json) => void, key = 'contact') => {
  const d = declaration(key);
  change(d);
  writeDeclaration(d, key);
};
const operations = (result: { stdout: string }) => (JSON.parse(result.stdout) as { operations: Array<{ key: string; operation: string }> }).operations.map((o) => `${o.key}:${o.operation}`);

/** plan + apply, as an authorized agent or staff member would. */
async function sync() {
  const plan = await forms('plan');
  expect(plan.code, plan.stderr).toBe(0);
  const apply = await forms('apply', `--plan=${DEFAULT_PLAN_PATH}`);
  expect(apply.code, apply.stderr).toBe(0);
  return apply;
}

beforeEach(() => {
  root = site();
  fake = new FakeYatris();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('yatris forms plan', () => {
  it('no baseline, remote absent: plans a creation, read-only, and writes a plan with no declaration text', async () => {
    const result = await forms('plan');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('contact: create');
    expect(result.stdout).toContain('nothing was saved in Yatris');
    expect(fake.calledTools()).toEqual(['plan_contact_forms']);
    expect(fake.calls[0].args).toMatchObject({ website: 42, forms: [{ key: 'contact', baseline: null }] });
    expect(fake.forms.size).toBe(0);
    expect(existsSync(join(root, FORMS_LOCK_PATH))).toBe(false);

    const plan = readFileSync(join(root, DEFAULT_PLAN_PATH), 'utf8');
    const parsed = JSON.parse(plan);
    expect(parsed).toMatchObject({ planVersion: 1, websiteId: 42, applicable: true, declarations: { contact: { path: 'src/forms/contact.json' } } });
    expect(parsed.declarations.contact.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Paths and hashes only: no template text, no recipients
    const body = (declaration().mail.notification.body as string).split('\n')[0];
    expect(plan).not.toContain(body);
    expect(plan).not.toContain('@');
  });

  it('exits 1 on an invalid declaration without contacting Yatris', async () => {
    writeFileSync(join(root, 'src/forms/broken.json'), '{ nope');
    const result = await forms('plan');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('invalid_json');
    expect(fake.calls).toEqual([]);
  });

  it('has nothing to compare without declarations', async () => {
    rmSync(join(root, 'src/forms/contact.json'));
    expect(await forms('plan')).toMatchObject({ code: 0, stdout: expect.stringContaining('no declarations') });
    expect(fake.calls).toEqual([]);
  });

  it('refuses to write a plan where a build could publish it', async () => {
    const result = await forms('plan', '--out=public/plan.json');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refusing to write a plan under public/');
    expect(fake.calls).toEqual([]);
  });

  it('warns when the plan file is not gitignored', async () => {
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    const result = await forms('plan');
    expect(result.stdout).toContain(`${DEFAULT_PLAN_PATH} is not listed in .gitignore`);
  });

  it('prints JSON for agents', async () => {
    const result = await forms('plan', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ website: 42, applicable: true, plan_file: DEFAULT_PLAN_PATH, operations: [{ key: 'contact', operation: 'create' }] });
  });
});

describe('yatris forms apply', () => {
  it('saves a draft, never publishes, and records the baseline Yatris returned', async () => {
    const apply = await sync();
    expect(apply.stdout).toContain('drafts saved in Yatris');
    expect(apply.stdout).toContain('Publication is pending');
    expect(apply.stdout).toContain('review: https://app.yatris.jp/sites/42/forms/contact');
    expect(apply.stdout).not.toMatch(/\bwas published\b|\bis live\b/);
    expect(fake.forms.get('contact')!.published).toBeNull();

    const lock = readFormsLock(root)!;
    expect(lock).toMatchObject({ contractVersion: 1, websiteId: 42 });
    expect(lock.forms.contact).toEqual({ state: 'draft', digest: fake.current('contact')!.digest, draft_revision: 1, published_version: null, declaration_sha256: expect.stringMatching(/^sha256:/) });
    // The lock holds no recipients, template text or credential
    const text = readFileSync(join(root, FORMS_LOCK_PATH), 'utf8');
    expect(text).not.toContain('@');
    expect(text).not.toMatch(/token|password/i);
    // Recipients seeded the new form only
    expect(fake.forms.get('contact')!.recipients).toEqual(declaration().mail.notification.to);
  });

  it('refuses a plan whose declarations changed since it was made, without sending anything', async () => {
    expect((await forms('plan')).code).toBe(0);
    editLocal((d) => (d.name = 'changed after review'));
    const result = await forms('apply', `--plan=${DEFAULT_PLAN_PATH}`);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('declarations changed since the plan: src/forms/contact.json');
    expect(fake.calledTools()).toEqual(['plan_contact_forms']);
  });

  it('refuses when a declaration was added after the plan', async () => {
    expect((await forms('plan')).code).toBe(0);
    writeDeclaration({ ...declaration(), key: 'second' }, 'second');
    const result = await forms('apply', `--plan=${DEFAULT_PLAN_PATH}`);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('src/forms/second.json (not in the plan)');
  });

  it('refuses an expired plan locally', async () => {
    expect((await forms('plan')).code).toBe(0);
    const later = () => new Date(Date.now() + 16 * 60_000);
    const result = await applyForms(root, { plan: DEFAULT_PLAN_PATH, environment: { YATRIS_MCP_TOKEN: 'x' }, transport: () => fake, now: later });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('the plan expired');
    expect(fake.calledTools()).toEqual(['plan_contact_forms']);
  });

  it('reports a server-side plan expiry or revision race as stale (exit 3) and leaves the lock alone', async () => {
    expect((await forms('plan')).code).toBe(0);
    fake.now = () => Date.now() + 16 * 60_000;
    const result = await applyForms(root, { plan: DEFAULT_PLAN_PATH, environment: { YATRIS_MCP_TOKEN: 'x' }, transport: () => fake, retryDelayMs: 0, now: () => new Date() });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('plan_expired');
    expect(existsSync(join(root, FORMS_LOCK_PATH))).toBe(false);
  });

  it('reuses the same idempotency key on a transport retry and applies once', async () => {
    expect((await forms('plan')).code).toBe(0);
    fake.failNext('apply_contact_forms', new RemoteError('backend_unavailable', 'HTTP 503'), 2);
    const result = await forms('apply', `--plan=${DEFAULT_PLAN_PATH}`);
    expect(result.code, result.stderr).toBe(0);
    const applies = fake.calls.filter((c) => c.name === 'apply_contact_forms');
    expect(applies).toHaveLength(3);
    expect(new Set(applies.map((c) => c.args.idempotency_key)).size).toBe(1);
    expect(String(applies[0].args.idempotency_key)).toMatch(/^forms-apply-[0-9a-f-]{36}$/);
    expect(fake.forms.get('contact')!.draft!.revision).toBe(1);
  });

  it('a replayed apply (same key) returns the stored result instead of applying twice', async () => {
    expect((await forms('plan')).code).toBe(0);
    // The first attempt reaches Yatris but its answer is lost on the way back
    const original = fake.callTool.bind(fake);
    let lost = false;
    vi.spyOn(fake, 'callTool').mockImplementation(async (name, args) => {
      const answer = await original(name, args);
      if (name === 'apply_contact_forms' && !lost) {
        lost = true;
        throw new RemoteError('backend_unavailable', 'network error: request failed');
      }
      return answer;
    });
    const result = await forms('apply', `--plan=${DEFAULT_PLAN_PATH}`);
    expect(result.code, result.stderr).toBe(0);
    expect(fake.forms.get('contact')!.draft!.revision).toBe(1);
    expect(readFormsLock(root)!.forms.contact.draft_revision).toBe(1);
  });

  it('a new apply uses a new idempotency key', async () => {
    await sync();
    editLocal((d) => (d.name = 'second edit'));
    await sync();
    const keys = fake.calls.filter((c) => c.name === 'apply_contact_forms').map((c) => c.args.idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });

  it('exits 75 when Yatris stays unreachable and records nothing', async () => {
    expect((await forms('plan')).code).toBe(0);
    fake.failNext('apply_contact_forms', new RemoteError('backend_unavailable', 'HTTP 502'), 3);
    const result = await forms('apply', `--plan=${DEFAULT_PLAN_PATH}`);
    expect(result.code).toBe(75);
    expect(result.stderr).toContain('backend_unavailable');
    expect(existsSync(join(root, FORMS_LOCK_PATH))).toBe(false);
  });

  it('needs --plan', async () => {
    expect(await forms('apply')).toMatchObject({ code: 1, stderr: expect.stringContaining('--plan=<file> is required') });
  });
});

describe('the spec §4.1 drift matrix', () => {
  it('local same, remote same: no change', async () => {
    await sync();
    const result = await forms('plan', '--json');
    expect(result.code).toBe(0);
    expect(operations(result)).toEqual(['contact:noop']);
  });

  it('local changed, remote same: plans an update to the remote draft', async () => {
    await sync();
    editLocal((d) => (d.submit.label = '内容を送る'));
    const plan = await forms('plan');
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain('contact: update_draft');
    expect(plan.stdout).toContain('changed: /submit');
    await forms('apply', `--plan=${DEFAULT_PLAN_PATH}`);
    expect(fake.forms.get('contact')!.draft!.revision).toBe(2);
    expect(readFormsLock(root)!.forms.contact.draft_revision).toBe(2);
  });

  it('local same, remote changed: reports drift, refuses apply, and pull reconciles it', async () => {
    await sync();
    fake.staffEdit('contact', (d) => (d.name = 'Staff edit in the builder'));
    const plan = await forms('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('contact: remote_drift');
    expect(plan.stderr).toContain('Not applicable');
    expect(plan.stderr).toContain('No plan file was written');
    expect(existsSync(join(root, DEFAULT_PLAN_PATH))).toBe(true); // the earlier, applied plan

    // Applying an older plan cannot erase the staff draft
    const stale = await forms('apply', `--plan=${DEFAULT_PLAN_PATH}`);
    expect(stale.code).toBe(3);
    expect(fake.current('contact')!.definition.name).toBe('Staff edit in the builder');

    const pull = await forms('pull', '--draft');
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.stdout).toContain('staff operation');
    expect(declaration().name).toBe('Staff edit in the builder');
    expect(readFormsLock(root)!.forms.contact).toMatchObject({ state: 'draft', draft_revision: 2 });
    expect(operations(await forms('plan', '--json'))).toEqual(['contact:noop']);
  });

  it('changed on both sides: conflict with changed paths; nothing merges and pull keeps the local file', async () => {
    await sync();
    fake.staffEdit('contact', (d) => (d.name = 'Staff'));
    editLocal((d) => (d.submit.label = 'Agent'));
    const before = readFileSync(join(root, 'src/forms/contact.json'), 'utf8');

    const plan = await forms('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('contact: conflict');
    expect(plan.stderr).toMatch(/changed: .*\/name/);

    const pull = await forms('pull', '--draft');
    expect(pull.code).toBe(2);
    expect(pull.stderr).toContain('has local edits that were never applied. Nothing was overwritten');
    expect(readFileSync(join(root, 'src/forms/contact.json'), 'utf8')).toBe(before);
    expect(fake.current('contact')!.definition.name).toBe('Staff');
  });

  it('local matches the current remote, remote changed: accept_remote, and pull advances the baseline without any write', async () => {
    await sync();
    fake.staffEdit('contact', (d) => (d.submit.label = 'Same change'));
    editLocal((d) => (d.submit.label = 'Same change'));
    const before = readFileSync(join(root, 'src/forms/contact.json'), 'utf8');

    const plan = await forms('plan');
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain('contact: accept_remote');
    expect(plan.stdout).toContain('Nothing to apply');

    const applies = fake.calledTools().filter((t) => t === 'apply_contact_forms').length;
    const pull = await forms('pull', '--draft', 'contact');
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.stdout).toContain('recorded it as the baseline');
    expect(readFileSync(join(root, 'src/forms/contact.json'), 'utf8')).toBe(before); // recipients kept
    expect(fake.calledTools().filter((t) => t === 'apply_contact_forms').length).toBe(applies);
    expect(operations(await forms('plan', '--json'))).toEqual(['contact:noop']);
  });

  it('no baseline, remote absent: plans creation', async () => {
    expect(operations(await forms('plan', '--json'))).toEqual(['contact:create']);
  });

  it('no baseline, remote exists: requires explicit adoption and never replaces the form blindly', async () => {
    fake.seed('contact', { ...declaration(), name: 'Built by staff' });
    const plan = await forms('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('contact: adopt_required');

    // The local file has no baseline: pull refuses to overwrite it
    const refused = await forms('pull', 'contact');
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('has no baseline');
    expect(declaration().name).not.toBe('Built by staff');

    // Explicit adoption: move the local file aside, then pull
    renameSync(join(root, 'src/forms/contact.json'), join(root, 'contact.local.json'));
    const adopted = await forms('pull', 'contact');
    expect(adopted.code, adopted.stderr).toBe(0);
    expect(declaration().name).toBe('Built by staff');
    expect(readFormsLock(root)!.forms.contact).toMatchObject({ state: 'published', published_version: 1 });
    expect(operations(await forms('plan', '--json'))).toEqual(['contact:noop']);
  });

  it('a declaration Yatris rejects is reported with its issues', async () => {
    editLocal((d) => (d.name = 'SERVER-INVALID'));
    const plan = await forms('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('contact: invalid');
    expect(plan.stderr).toContain('/name server_rule');
  });

  it('a multi-form apply is one request (atomic on the server)', async () => {
    writeDeclaration({ ...declaration(), key: 'estimate', name: '見積もり' }, 'estimate');
    await sync();
    const applies = fake.calls.filter((c) => c.name === 'apply_contact_forms');
    expect(applies).toHaveLength(1);
    expect((applies[0].args.forms as Json[]).map((f) => f.key)).toEqual(['contact', 'estimate']);
    expect(Object.keys(readFormsLock(root)!.forms)).toEqual(['contact', 'estimate']);
  });
});

describe('yatris forms pull', () => {
  it('pulls published definitions by default and skips forms not published yet', async () => {
    rmSync(join(root, 'src/forms/contact.json'));
    fake.seed('contact', JSON.parse(readFileSync(example, 'utf8')));
    fake.seed('estimate', { ...JSON.parse(readFileSync(example, 'utf8')), key: 'estimate' }, false);
    const result = await forms('pull');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('contact: wrote src/forms/contact.json');
    expect(result.stdout).toContain('estimate: skipped: not published yet');
    expect(existsSync(join(root, 'src/forms/estimate.json'))).toBe(false);
    // Recipients are dashboard-managed and never come back
    expect(declaration().mail.notification.to).toBeUndefined();
    expect(fake.calls.find((c) => c.name === 'get_contact_form')!.args).toMatchObject({ state: 'published' });
    expect(readFormsLock(root)!.forms.contact.state).toBe('published');
  });

  it('a published baseline leaves out an unpublished staff draft, so it still shows as drift', async () => {
    rmSync(join(root, 'src/forms/contact.json'));
    fake.seed('contact', JSON.parse(readFileSync(example, 'utf8')));
    fake.staffEdit('contact', (d) => (d.name = 'Unpublished staff work'));
    expect((await forms('pull')).code).toBe(0);
    expect(readFormsLock(root)!.forms.contact).toMatchObject({ state: 'published', published_version: 1, draft_revision: null });
    expect(operations(await forms('plan', '--json'))).toEqual(['contact:remote_drift']);
  });

  it('overwrites a file that is unchanged since its baseline', async () => {
    await sync();
    fake.publish('contact');
    fake.staffEdit('contact', (d) => (d.name = 'v2'));
    fake.publish('contact');
    const result = await forms('pull');
    expect(result.code, result.stderr).toBe(0);
    expect(declaration().name).toBe('v2');
    expect(readFormsLock(root)!.forms.contact).toMatchObject({ state: 'published', published_version: 2 });
  });

  it('distinguishes "no forms in Yatris" (exit 0) from backend_unavailable (exit 75)', async () => {
    expect(await forms('pull')).toMatchObject({ code: 0, stdout: expect.stringContaining('has no contact forms in Yatris yet') });
    fake.failNext('list_contact_forms', new RemoteError('backend_unavailable', 'HTTP 503'), 3);
    const down = await forms('pull');
    expect(down.code).toBe(75);
    expect(down.stderr).toContain('backend_unavailable');
    expect(down.stderr).toContain('Nothing is known about remote state');
  });

  it('names a requested form Yatris does not have', async () => {
    expect(await forms('pull', 'missing')).toMatchObject({ code: 1 });
  });
});

describe('exit codes', () => {
  it('4 when the repository is not paired', async () => {
    rmSync(root, { recursive: true, force: true });
    root = site({ paired: false });
    expect((await forms('plan')).code).toBe(4);
    expect(fake.calls).toEqual([]);
  });

  it('5 when no credential is set, without sending anything', async () => {
    const result = await run(['forms', 'plan'], { ...env(), environment: {} });
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('YATRIS_MCP_TOKEN');
    expect(fake.calls).toEqual([]);
  });

  it('5 when Yatris refuses the credential', async () => {
    fake.failNext('plan_contact_forms', new RemoteError('unauthorized', 'HTTP 401'));
    expect((await forms('plan')).code).toBe(5);
  });

  it('69 when Yatris does not offer the form tools', async () => {
    fake.knownTools.delete('plan_contact_forms');
    const result = await forms('plan');
    expect(result.code).toBe(69);
    expect(result.stderr).toContain('does not offer `plan_contact_forms` yet');
  });

  it('69 when Yatris reports the capability unavailable', async () => {
    fake.failNext('list_contact_forms', new RemoteError('tool_error', 'Contact forms are not enabled.', 'unavailable'));
    expect((await forms('pull')).code).toBe(69);
  });

  it('1 when Yatris rejects the request as invalid', async () => {
    fake.failNext('plan_contact_forms', new RemoteError('tool_error', 'The request is invalid.', 'validation'));
    expect((await forms('plan')).code).toBe(1);
  });

  it('1 when the lock belongs to another Website', async () => {
    writeFileSync(join(root, FORMS_LOCK_PATH), JSON.stringify({ contractVersion: 1, websiteId: 7, forms: {} }));
    const result = await forms('plan');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is for Website 7');
    expect(fake.calls).toEqual([]);
  });
});
