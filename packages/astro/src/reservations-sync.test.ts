import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeReservations } from '../test/fake-reservations.js';
import { run } from './commands.js';
import { readReservationsLock, RESERVATIONS_LOCK_PATH } from './reservations-lock.js';
import { applyReservations, DEFAULT_RESERVATIONS_PLAN_PATH } from './reservations-sync.js';
import { RemoteError } from './yatris-remote.js';

/**
 * `yatris reservations plan | apply | pull | status` against a faked Product
 * MCP (YatrisCMS#432, RS-23, RS-24): the forms drift matrix for setup
 * definitions, plan staleness, idempotent retries, exit codes, that pull
 * never discards local work, that the operations seed is used once and never
 * written by pull, and that nothing is ever deleted remotely.
 */

const example = new URL('../../../contracts/reservations/v1/examples/consultation.json', import.meta.url);
const exampleJson = (): Json => JSON.parse(readFileSync(example, 'utf8'));
type Json = Record<string, any>;
const PATH = 'src/reservations/consultation.json';
const PLAN = DEFAULT_RESERVATIONS_PLAN_PATH;

let root: string;
let fake: FakeReservations;

function site({ paired = true } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'yatris-rsync-'));
  mkdirSync(join(dir, 'src/reservations'), { recursive: true });
  mkdirSync(join(dir, '.yatris'));
  cpSync(example, join(dir, PATH));
  writeFileSync(join(dir, '.yatris/project.json'), JSON.stringify({ contractVersion: 1, websiteId: paired ? 42 : null }));
  writeFileSync(join(dir, '.yatris/mcp.json'), JSON.stringify({ contractVersion: 1, server: { name: 'yatris', transport: 'streamable-http', url: 'https://app.yatris.jp/mcp/yatris' } }));
  writeFileSync(join(dir, '.gitignore'), `.yatris/forms.plan.json\n${PLAN}\n`);
  return dir;
}

const env = (extra: Json = {}) => ({ cwd: root, environment: { YATRIS_MCP_TOKEN: 'test-token' }, mcpTransport: () => fake, retryDelayMs: 0, ...extra });
const reservations = (...args: string[]) => run(['reservations', ...args], env());
const declaration = (key = 'consultation'): Json => JSON.parse(readFileSync(join(root, `src/reservations/${key}.json`), 'utf8'));
const writeDeclaration = (value: Json, key = 'consultation') => writeFileSync(join(root, `src/reservations/${key}.json`), `${JSON.stringify(value, null, 2)}\n`);
const editLocal = (change: (d: Json) => void, key = 'consultation') => {
  const d = declaration(key);
  change(d);
  writeDeclaration(d, key);
};
const operations = (result: { stdout: string }) => (JSON.parse(result.stdout) as { operations: Array<{ key: string; operation: string }> }).operations.map((o) => `${o.key}:${o.operation}`);
const remoteDefinition = (key = 'consultation') => fake.current(key)!.definition;

/** plan + apply, as an authorized agent or staff member would. */
async function sync() {
  const plan = await reservations('plan');
  expect(plan.code, plan.stderr).toBe(0);
  const apply = await reservations('apply', `--plan=${PLAN}`);
  expect(apply.code, apply.stderr).toBe(0);
  return apply;
}

beforeEach(() => {
  root = site();
  fake = new FakeReservations();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('yatris reservations plan', () => {
  it('no baseline, remote absent: plans a creation, read-only, and writes a plan with no declaration text', async () => {
    const result = await reservations('plan');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('consultation: create');
    expect(result.stdout).toContain('nothing was saved in Yatris');
    expect(result.stdout).toContain('operations: seeded once from this declaration');
    expect(fake.calledTools()).toEqual(['plan_reservation_setups']);
    expect(fake.calls[0].args).toMatchObject({ website: 42, setups: [{ key: 'consultation', baseline: null }] });
    expect(fake.setups.size).toBe(0);
    expect(existsSync(join(root, RESERVATIONS_LOCK_PATH))).toBe(false);

    const plan = readFileSync(join(root, PLAN), 'utf8');
    const parsed = JSON.parse(plan);
    expect(parsed).toMatchObject({ planVersion: 1, websiteId: 42, applicable: true, declarations: { consultation: { path: PATH } } });
    expect(parsed.declarations.consultation.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
    // Paths and hashes only: no questions, no seed (meeting URL, address)
    expect(plan).not.toContain('meet.google.com');
    expect(plan).not.toContain('梅田');
    expect(plan).not.toContain('ご相談内容');
  });

  it('sends the operations seed with the declaration (Yatris uses it only for a creation)', async () => {
    await reservations('plan');
    const sent = (fake.calls[0].args.setups as Json[])[0].declaration;
    expect(sent.operations).toEqual(exampleJson().operations);
    expect(sent).toEqual(exampleJson());
  });

  it('exits 1 on an invalid declaration without contacting Yatris', async () => {
    writeFileSync(join(root, 'src/reservations/broken.json'), '{ nope');
    const result = await reservations('plan');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('invalid_json');
    expect(fake.calls).toEqual([]);
  });

  it('exits 1 on a declaration whose key does not match its file name', async () => {
    writeDeclaration({ ...exampleJson(), key: 'other' }, 'renamed');
    const result = await reservations('plan');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('filename_mismatch');
    expect(fake.calls).toEqual([]);
  });

  it('has nothing to compare without declarations, and never reads briefs', async () => {
    renameSync(join(root, PATH), join(root, 'src/reservations/consultation.brief.json'));
    expect(await reservations('plan')).toMatchObject({ code: 0, stdout: expect.stringContaining('no declarations') });
    expect(fake.calls).toEqual([]);
  });

  it('refuses to write a plan where a build could publish it', async () => {
    const result = await reservations('plan', '--out=public/plan.json');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('refusing to write a plan under public/');
    expect(fake.calls).toEqual([]);
  });

  it('warns when the plan file is not gitignored', async () => {
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    const result = await reservations('plan');
    expect(result.stdout).toContain(`${PLAN} is not listed in .gitignore`);
  });

  it('prints JSON for agents', async () => {
    const result = await reservations('plan', '--json');
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ website: 42, applicable: true, plan_file: PLAN, operations: [{ key: 'consultation', operation: 'create', live_operations_revision: null }] });
  });
});

describe('yatris reservations apply', () => {
  it('saves a draft, never publishes, seeds operations once and records the baseline Yatris returned', async () => {
    const apply = await sync();
    expect(apply.stdout).toContain('drafts saved in Yatris');
    expect(apply.stdout).toContain('Publication is pending');
    expect(apply.stdout).toContain('consultation: create, draft revision 1, operations seeded from the declaration');
    expect(apply.stdout).toContain('review: https://app.yatris.jp/sites/42/reservations/consultation');
    expect(apply.stdout).not.toMatch(/\bwas published\b|\bis live\b/);
    expect(fake.setups.get('consultation')!.published).toBeNull();
    expect(fake.liveOperations('consultation')).toEqual(exampleJson().operations);

    const lock = readReservationsLock(root)!;
    expect(lock).toMatchObject({ contractVersion: 1, websiteId: 42 });
    expect(lock.setups.consultation).toEqual({ state: 'draft', digest: fake.current('consultation')!.digest, draft_revision: 1, published_version: null, definition_sha256: expect.stringMatching(/^sha256:[0-9a-f]{64}$/) });
    // The lock holds no seed values, questions or credential
    const text = readFileSync(join(root, RESERVATIONS_LOCK_PATH), 'utf8');
    expect(text).not.toContain('meet.google.com');
    expect(text).not.toMatch(/token|password/i);
  });

  it('refuses a plan whose declarations changed since it was made, without sending anything', async () => {
    expect((await reservations('plan')).code).toBe(0);
    editLocal((d) => (d.name = 'changed after review'));
    const result = await reservations('apply', `--plan=${PLAN}`);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain(`declarations changed since the plan: ${PATH}`);
    expect(fake.calledTools()).toEqual(['plan_reservation_setups']);
  });

  it('refuses a plan whose operations seed changed since it was made (the seed is sent too)', async () => {
    expect((await reservations('plan')).code).toBe(0);
    editLocal((d) => (d.operations.holdMinutes = 15));
    expect((await reservations('apply', `--plan=${PLAN}`)).code).toBe(3);
    expect(fake.calledTools()).toEqual(['plan_reservation_setups']);
  });

  it('refuses when a declaration was added after the plan', async () => {
    expect((await reservations('plan')).code).toBe(0);
    writeDeclaration({ ...declaration(), key: 'second' }, 'second');
    const result = await reservations('apply', `--plan=${PLAN}`);
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('src/reservations/second.json (not in the plan)');
  });

  it('refuses a plan written by forms plan', async () => {
    mkdirSync(join(root, '.yatris'), { recursive: true });
    writeFileSync(join(root, '.yatris/forms.plan.json'), JSON.stringify({ planVersion: 1, websiteId: 42, plan_token: 'p', expires_at: new Date(Date.now() + 60_000).toISOString(), applicable: true, declarations: { contact: { path: 'src/forms/contact.json', sha256: 'sha256:x' } }, operations: [] }));
    const result = await reservations('apply', '--plan=.yatris/forms.plan.json');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is not a plan written by `yatris reservations plan`');
    expect(fake.calls).toEqual([]);
  });

  it('refuses an expired plan locally', async () => {
    expect((await reservations('plan')).code).toBe(0);
    const later = () => new Date(Date.now() + 16 * 60_000);
    const result = await applyReservations(root, { plan: PLAN, environment: { YATRIS_MCP_TOKEN: 'x' }, transport: () => fake, now: later });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('the plan expired');
    expect(fake.calledTools()).toEqual(['plan_reservation_setups']);
  });

  it('reports a server-side plan expiry or revision race as stale (exit 3) and leaves the lock alone', async () => {
    expect((await reservations('plan')).code).toBe(0);
    fake.now = () => Date.now() + 16 * 60_000;
    const result = await applyReservations(root, { plan: PLAN, environment: { YATRIS_MCP_TOKEN: 'x' }, transport: () => fake, retryDelayMs: 0, now: () => new Date() });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain('plan_expired');
    expect(existsSync(join(root, RESERVATIONS_LOCK_PATH))).toBe(false);
  });

  it('reuses the same idempotency key on a transport retry and applies once', async () => {
    expect((await reservations('plan')).code).toBe(0);
    fake.failNext('apply_reservation_setups', new RemoteError('backend_unavailable', 'HTTP 503'), 2);
    const result = await reservations('apply', `--plan=${PLAN}`);
    expect(result.code, result.stderr).toBe(0);
    const applies = fake.calls.filter((c) => c.name === 'apply_reservation_setups');
    expect(applies).toHaveLength(3);
    expect(new Set(applies.map((c) => c.args.idempotency_key)).size).toBe(1);
    expect(String(applies[0].args.idempotency_key)).toMatch(/^reservations-apply-[0-9a-f-]{36}$/);
    expect(applies[0].args).toMatchObject({ website: 42, plan_token: expect.stringMatching(/^plan_/), setups: [{ key: 'consultation' }] });
    expect(fake.setups.get('consultation')!.draft!.revision).toBe(1);
  });

  it('a replayed apply (same key) returns the stored result instead of applying twice', async () => {
    expect((await reservations('plan')).code).toBe(0);
    const original = fake.callTool.bind(fake);
    let lost = false;
    vi.spyOn(fake, 'callTool').mockImplementation(async (name, args) => {
      const answer = await original(name, args);
      if (name === 'apply_reservation_setups' && !lost) {
        lost = true;
        throw new RemoteError('backend_unavailable', 'network error: request failed');
      }
      return answer;
    });
    const result = await reservations('apply', `--plan=${PLAN}`);
    expect(result.code, result.stderr).toBe(0);
    expect(fake.setups.get('consultation')!.draft!.revision).toBe(1);
    expect(readReservationsLock(root)!.setups.consultation.draft_revision).toBe(1);
  });

  it('a new apply uses a new idempotency key', async () => {
    await sync();
    editLocal((d) => (d.name = 'second edit'));
    await sync();
    const keys = fake.calls.filter((c) => c.name === 'apply_reservation_setups').map((c) => c.args.idempotency_key);
    expect(new Set(keys).size).toBe(2);
  });

  it('exits 75 when Yatris stays unreachable and records nothing', async () => {
    expect((await reservations('plan')).code).toBe(0);
    fake.failNext('apply_reservation_setups', new RemoteError('backend_unavailable', 'HTTP 502'), 3);
    const result = await reservations('apply', `--plan=${PLAN}`);
    expect(result.code).toBe(75);
    expect(result.stderr).toContain('backend_unavailable');
    expect(existsSync(join(root, RESERVATIONS_LOCK_PATH))).toBe(false);
  });

  it('needs --plan', async () => {
    expect(await reservations('apply')).toMatchObject({ code: 1, stderr: expect.stringContaining('--plan=<file> is required') });
  });
});

describe('the drift matrix for setup definitions', () => {
  it('local same, remote same: no change', async () => {
    await sync();
    const result = await reservations('plan', '--json');
    expect(result.code).toBe(0);
    expect(operations(result)).toEqual(['consultation:noop']);
  });

  it('local changed, remote same: plans an update to the remote draft', async () => {
    await sync();
    editLocal((d) => (d.copy.pendingMessage = '確認後にご連絡します。'));
    const plan = await reservations('plan');
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain('consultation: update_draft');
    expect(plan.stdout).toContain('changed: /copy');
    await reservations('apply', `--plan=${PLAN}`);
    expect(fake.setups.get('consultation')!.draft!.revision).toBe(2);
    expect(readReservationsLock(root)!.setups.consultation.draft_revision).toBe(2);
  });

  it('local same, remote changed in the builder: reports drift, refuses apply, and pull reconciles it', async () => {
    await sync();
    fake.staffEdit('consultation', (d) => (d.name = 'Staff edit in the builder'));
    const plan = await reservations('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('consultation: remote_drift');
    expect(plan.stderr).toContain('Not applicable');
    expect(plan.stderr).toContain('No plan file was written');

    // Applying the older plan cannot erase the staff draft
    const stale = await reservations('apply', `--plan=${PLAN}`);
    expect(stale.code).toBe(3);
    expect(remoteDefinition().name).toBe('Staff edit in the builder');

    const pull = await reservations('pull', '--draft');
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.stdout).toContain('staff operation');
    expect(declaration().name).toBe('Staff edit in the builder');
    expect(readReservationsLock(root)!.setups.consultation).toMatchObject({ state: 'draft', draft_revision: 2 });
    expect(operations(await reservations('plan', '--json'))).toEqual(['consultation:noop']);
  });

  it('changed on both sides: conflict with changed paths; nothing merges and pull keeps the local file', async () => {
    await sync();
    fake.staffEdit('consultation', (d) => (d.name = 'Staff'));
    editLocal((d) => (d.copy.pendingMessage = 'Agent'));
    const before = readFileSync(join(root, PATH), 'utf8');

    const plan = await reservations('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('consultation: conflict');
    expect(plan.stderr).toMatch(/changed: .*\/name/);

    const pull = await reservations('pull', '--draft');
    expect(pull.code).toBe(2);
    expect(pull.stderr).toContain('has local edits that were never applied. Nothing was overwritten');
    expect(readFileSync(join(root, PATH), 'utf8')).toBe(before);
    expect(remoteDefinition().name).toBe('Staff');
  });

  it('local matches the current remote, remote changed: accept_remote, and pull advances the baseline without any write', async () => {
    await sync();
    fake.staffEdit('consultation', (d) => (d.name = 'Same change'));
    editLocal((d) => (d.name = 'Same change'));
    const before = readFileSync(join(root, PATH), 'utf8');

    const plan = await reservations('plan');
    expect(plan.code).toBe(0);
    expect(plan.stdout).toContain('consultation: accept_remote');
    expect(plan.stdout).toContain('Nothing to apply');

    const applies = fake.calledTools().filter((t) => t === 'apply_reservation_setups').length;
    const pull = await reservations('pull', '--draft', 'consultation');
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.stdout).toContain('recorded it as the baseline');
    expect(readFileSync(join(root, PATH), 'utf8')).toBe(before); // seed and $schema kept
    expect(fake.calledTools().filter((t) => t === 'apply_reservation_setups').length).toBe(applies);
    expect(operations(await reservations('plan', '--json'))).toEqual(['consultation:noop']);
  });

  it('no baseline, remote exists: requires explicit adoption and never replaces the setup blindly', async () => {
    fake.seed('consultation', { ...exampleJson(), name: 'Built by staff' });
    const plan = await reservations('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('consultation: adopt_required');

    const refused = await reservations('pull', 'consultation');
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('has no baseline');
    expect(declaration().name).not.toBe('Built by staff');

    renameSync(join(root, PATH), join(root, 'consultation.local.json'));
    const adopted = await reservations('pull', 'consultation');
    expect(adopted.code, adopted.stderr).toBe(0);
    expect(declaration().name).toBe('Built by staff');
    expect(readReservationsLock(root)!.setups.consultation).toMatchObject({ state: 'published', published_version: 1 });
    expect(operations(await reservations('plan', '--json'))).toEqual(['consultation:noop']);
  });

  it('a declaration Yatris rejects is reported with its issues', async () => {
    editLocal((d) => (d.name = 'SERVER-INVALID'));
    const plan = await reservations('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('consultation: invalid');
    expect(plan.stderr).toContain('/name server_rule');
  });

  it('a mode change of an existing setup is invalid and explains the replacement setup', async () => {
    fake.seed('consultation', { ...exampleJson(), mode: 'business', presentation: 'service' });
    const plan = await reservations('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('consultation: invalid');
    expect(plan.stderr).toContain('/mode mode_immutable: the mode or presentation of an existing setup cannot change');
  });

  it('an archived setup is invalid and never revived', async () => {
    await sync();
    fake.archive('consultation');
    editLocal((d) => (d.name = 'try again'));
    const plan = await reservations('plan');
    expect(plan.code).toBe(2);
    expect(plan.stderr).toContain('/ setup_archived: this setup is archived in Yatris');
  });

  it('a multi-setup apply is one request (atomic on the server)', async () => {
    writeDeclaration({ ...declaration(), key: 'estimate', name: '見積もり相談' }, 'estimate');
    await sync();
    const applies = fake.calls.filter((c) => c.name === 'apply_reservation_setups');
    expect(applies).toHaveLength(1);
    expect((applies[0].args.setups as Json[]).map((s) => s.key)).toEqual(['consultation', 'estimate']);
    expect(Object.keys(readReservationsLock(root)!.setups)).toEqual(['consultation', 'estimate']);
  });
});

describe('the operations seed (decisions §5)', () => {
  it('daily operations edits in Yatris are neither drift nor conflicts, and the plan shows them as live, not synced', async () => {
    await sync();
    fake.operationsEdit('consultation', (o) => {
      o.holdMinutes = 20;
      o.venueHours.exceptions.push({ date: '2027-02-11', closed: true });
    });
    const plan = await reservations('plan');
    expect(plan.code, plan.stderr).toBe(0);
    expect(plan.stdout).toContain('consultation: noop');
    expect(plan.stdout).toContain('live operations: revision 2 in Yatris (not synced; edit them in Yatris)');
    expect(plan.stdout).toContain('the seed in this file is not compared or applied');
    expect(JSON.parse((await reservations('plan', '--json')).stdout).operations[0]).toMatchObject({ operation: 'noop', live_operations_revision: 2 });
  });

  it('editing or removing the seed after creation changes nothing in Yatris', async () => {
    await sync();
    editLocal((d) => (d.operations.holdMinutes = 30));
    expect(operations(await reservations('plan', '--json'))).toEqual(['consultation:noop']);
    editLocal((d) => delete d.operations);
    expect(operations(await reservations('plan', '--json'))).toEqual(['consultation:noop']);
    expect(fake.liveOperations('consultation')).toEqual(exampleJson().operations);
  });

  it('routine sync never overwrites live operations, even when the seed changed with the definition', async () => {
    await sync();
    fake.operationsEdit('consultation', (o) => (o.holdMinutes = 20));
    const live = structuredClone(fake.liveOperations('consultation'));
    editLocal((d) => {
      d.name = '新しい名前';
      d.operations.holdMinutes = 5;
      d.operations.minimumLeadMinutes = 60;
    });
    const plan = await reservations('plan');
    expect(plan.stdout).toContain('consultation: update_draft');
    expect((await reservations('apply', `--plan=${PLAN}`)).code).toBe(0);
    expect(remoteDefinition().name).toBe('新しい名前');
    expect(fake.liveOperations('consultation')).toEqual(live);
    expect(fake.setups.get('consultation')!.live!.revision).toBe(2);
  });

  it('pull never writes an operations section: a new file gets none, even when Yatris has live operations', async () => {
    rmSync(join(root, PATH));
    fake.seed('consultation', exampleJson());
    expect(fake.liveOperations('consultation')).not.toBeNull();
    const pull = await reservations('pull');
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.stdout).toContain(`consultation: wrote ${PATH}`);
    expect(declaration()).not.toHaveProperty('operations');
    expect(declaration()).not.toHaveProperty('$schema');
    expect(readFileSync(join(root, PATH), 'utf8')).not.toContain('meet.google.com');
  });

  it('pull keeps the local seed exactly as it is when it takes a newer definition', async () => {
    await sync();
    editLocal((d) => (d.operations.holdMinutes = 12)); // a seed edit after creation is not unsynchronized work
    const seed = declaration().operations;
    fake.publish('consultation');
    fake.staffEdit('consultation', (d) => (d.name = 'v2'));
    fake.publish('consultation');
    fake.operationsEdit('consultation', (o) => (o.holdMinutes = 45));

    const pull = await reservations('pull');
    expect(pull.code, pull.stderr).toBe(0);
    expect(pull.stdout).toContain('kept the local operations seed as it was; it is not the live operations');
    const pulled = declaration();
    expect(pulled.name).toBe('v2');
    expect(pulled.operations).toEqual(seed);
    expect(pulled.$schema).toBe(exampleJson().$schema);
    expect(Object.keys(pulled)[0]).toBe('$schema');
    expect(Object.keys(pulled).at(-1)).toBe('operations');
    expect(operations(await reservations('plan', '--json'))).toEqual(['consultation:noop']);
  });

  it('pull keeps a removed seed removed', async () => {
    await sync();
    editLocal((d) => delete d.operations);
    fake.publish('consultation');
    fake.staffEdit('consultation', (d) => (d.name = 'v2'));
    fake.publish('consultation');
    expect((await reservations('pull')).code).toBe(0);
    expect(declaration().name).toBe('v2');
    expect(declaration()).not.toHaveProperty('operations');
  });

  it('pull ignores operations in a remote definition, should Yatris ever send them', async () => {
    rmSync(join(root, PATH));
    fake.seed('consultation', exampleJson());
    const original = fake.callTool.bind(fake);
    vi.spyOn(fake, 'callTool').mockImplementation(async (name, args) => {
      const answer = (await original(name, args)) as Json;
      if (name === 'get_reservation_setup') answer.definition = { ...answer.definition, operations: { holdMinutes: 99 }, $schema: 'https://example.com/x.json' };
      return answer;
    });
    expect((await reservations('pull')).code).toBe(0);
    expect(declaration()).not.toHaveProperty('operations');
    expect(declaration()).not.toHaveProperty('$schema');
  });
});

describe('no deletion', () => {
  it('a setup with no local file is never sent by plan or apply, and stays in Yatris', async () => {
    fake.seed('other', { ...exampleJson(), key: 'other', name: 'Only in Yatris' });
    const before = structuredClone(fake.setups.get('other'));
    await sync();
    for (const call of fake.calls.filter((c) => c.name === 'plan_reservation_setups' || c.name === 'apply_reservation_setups')) {
      expect((call.args.setups as Json[]).map((s) => s.key)).toEqual(['consultation']);
    }
    expect(fake.setups.get('other')).toEqual(before);
  });

  it('removing a declaration after sync never deletes or archives the setup', async () => {
    writeDeclaration({ ...declaration(), key: 'estimate', name: '見積もり相談' }, 'estimate');
    await sync();
    rmSync(join(root, 'src/reservations/estimate.json'));
    const plan = await reservations('plan', '--json');
    expect(operations(plan)).toEqual(['consultation:noop']);
    expect(fake.setups.get('estimate')!.archived).toBe(false);
    expect(fake.current('estimate')).not.toBeNull();

    rmSync(join(root, PATH));
    const calls = fake.calls.length;
    expect((await reservations('plan')).stdout).toContain('no declarations');
    expect(fake.calls.length).toBe(calls);
    expect(fake.setups.size).toBe(2);
  });

  it('every tool the CLI calls is read-only or the draft apply; there is no delete', async () => {
    fake.seed('other', { ...exampleJson(), key: 'other' });
    await sync();
    await reservations('pull', '--draft');
    await reservations('status', 'consultation');
    expect(new Set(fake.calledTools())).toEqual(new Set(['plan_reservation_setups', 'apply_reservation_setups', 'list_reservation_setups', 'get_reservation_setup', 'get_reservation_setup_readiness']));
  });
});

describe('yatris reservations pull', () => {
  it('pulls published definitions by default and skips setups not published yet', async () => {
    rmSync(join(root, PATH));
    fake.seed('consultation', exampleJson());
    fake.seed('estimate', { ...exampleJson(), key: 'estimate' }, false);
    const result = await reservations('pull');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`consultation: wrote ${PATH}`);
    expect(result.stdout).toContain('estimate: skipped: not published yet');
    expect(existsSync(join(root, 'src/reservations/estimate.json'))).toBe(false);
    expect(fake.calls.find((c) => c.name === 'get_reservation_setup')!.args).toEqual({ website: 42, key: 'consultation', state: 'published' });
    expect(fake.calls.find((c) => c.name === 'list_reservation_setups')!.args).toEqual({ website: 42 });
    expect(readReservationsLock(root)!.setups.consultation.state).toBe('published');
  });

  it('a published baseline leaves out an unpublished builder draft, so it still shows as drift', async () => {
    rmSync(join(root, PATH));
    fake.seed('consultation', exampleJson());
    fake.staffEdit('consultation', (d) => (d.name = 'Unpublished staff work'));
    expect((await reservations('pull')).code).toBe(0);
    expect(readReservationsLock(root)!.setups.consultation).toMatchObject({ state: 'published', published_version: 1, draft_revision: null });
    expect(operations(await reservations('plan', '--json'))).toEqual(['consultation:remote_drift']);
  });

  it('overwrites a file whose definition is unchanged since its baseline', async () => {
    await sync();
    fake.publish('consultation');
    fake.staffEdit('consultation', (d) => (d.name = 'v2'));
    fake.publish('consultation');
    const result = await reservations('pull');
    expect(result.code, result.stderr).toBe(0);
    expect(declaration().name).toBe('v2');
    expect(readReservationsLock(root)!.setups.consultation).toMatchObject({ state: 'published', published_version: 2 });
  });

  it('distinguishes "no setups in Yatris" (exit 0) from backend_unavailable (exit 75)', async () => {
    expect(await reservations('pull')).toMatchObject({ code: 0, stdout: expect.stringContaining('has no reservation setups in Yatris yet') });
    fake.failNext('list_reservation_setups', new RemoteError('backend_unavailable', 'HTTP 503'), 3);
    const down = await reservations('pull');
    expect(down.code).toBe(75);
    expect(down.stderr).toContain('backend_unavailable');
    expect(down.stderr).toContain('Nothing is known about remote state');
  });

  it('names a requested setup Yatris does not have, and rejects a malformed key', async () => {
    fake.seed('other', { ...exampleJson(), key: 'other' });
    expect(await reservations('pull', 'missing')).toMatchObject({ code: 1 });
    expect(await reservations('pull', '../etc')).toMatchObject({ code: 1, stderr: expect.stringContaining('is not a setup key') });
  });
});

describe('yatris reservations status', () => {
  it('labels the redacted live operations as live values from Yatris, never as the seed', async () => {
    await sync();
    fake.operationsEdit('consultation', (o) => (o.holdMinutes = 20));
    const result = await reservations('status', 'consultation');
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain('live operations (current values in Yatris, redacted): revision 2');
    expect(result.stdout).toContain(`the operations seed in ${PATH} is not`);
    expect(result.stdout).toContain('✖ 公開済み');
    expect(fake.calls.at(-1)).toEqual({ name: 'get_reservation_setup_readiness', args: { website: 42, key: 'consultation' } });

    const json = JSON.parse((await reservations('status', 'consultation', '--json')).stdout);
    expect(json.live_operations).toMatchObject({ source: 'live', revision: 2, operations: { holdMinutes: 20 } });
    expect(JSON.stringify(json)).not.toContain('meet.google.com');
  });

  it('says when Yatris has no live operations yet', async () => {
    rmSync(join(root, PATH));
    fake.seed('bare', { ...exampleJson(), key: 'bare', operations: undefined });
    const result = await reservations('status', 'bare');
    expect(result.stdout).toContain('live operations: none in Yatris yet');
  });

  it('needs exactly one key', async () => {
    expect((await reservations('status')).code).toBe(1);
    expect(fake.calls).toEqual([]);
  });
});

describe('exit codes', () => {
  it('4 when the repository is not paired', async () => {
    rmSync(root, { recursive: true, force: true });
    root = site({ paired: false });
    expect((await reservations('plan')).code).toBe(4);
    expect(fake.calls).toEqual([]);
  });

  it('5 when no credential is set, without sending anything', async () => {
    const result = await run(['reservations', 'plan'], { ...env(), environment: {} });
    expect(result.code).toBe(5);
    expect(result.stderr).toContain('YATRIS_MCP_TOKEN');
    expect(fake.calls).toEqual([]);
  });

  it('5 when Yatris refuses the credential', async () => {
    fake.failNext('plan_reservation_setups', new RemoteError('unauthorized', 'HTTP 401'));
    expect((await reservations('plan')).code).toBe(5);
  });

  it('69 when Yatris does not offer the reservation tools', async () => {
    fake.knownTools.delete('plan_reservation_setups');
    const result = await reservations('plan');
    expect(result.code).toBe(69);
    expect(result.stderr).toContain('does not offer `plan_reservation_setups` yet');
  });

  it('69 when Yatris reports the capability unavailable', async () => {
    fake.failNext('list_reservation_setups', new RemoteError('tool_error', 'Reservations are not enabled.', 'unavailable'));
    expect((await reservations('pull')).code).toBe(69);
  });

  it('1 when Yatris rejects the request as invalid', async () => {
    fake.failNext('plan_reservation_setups', new RemoteError('tool_error', 'The request is invalid.', 'validation'));
    expect((await reservations('plan')).code).toBe(1);
  });

  it('1 when the lock belongs to another Website', async () => {
    writeFileSync(join(root, RESERVATIONS_LOCK_PATH), JSON.stringify({ contractVersion: 1, websiteId: 7, setups: {} }));
    const result = await reservations('plan');
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('is for Website 7');
    expect(fake.calls).toEqual([]);
  });

  it('1 on an unknown action', async () => {
    expect((await reservations('delete', 'consultation')).code).toBe(1);
    expect(fake.calls).toEqual([]);
  });
});
