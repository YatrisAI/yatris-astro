import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INPUT_TYPES } from './forms/registry.js';
import { managedBlock } from './platform-lock.js';
import { validateSetup } from './reservations/setup.js';
import { schemaErrors, type Json } from '../test/json-schema-subset.js';

/**
 * The canonical `yatris-reservation` skill (YatrisCMS#422): its layout, the
 * mode-aware interview, the brief schema and its examples, the declarations
 * it teaches and the root guidance that points agents at it. create.test.ts,
 * update.test.ts, the smoke test and the scaffold e2e check delivery.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const skillDir = join(repo, 'skills/yatris-reservation');
const contractExamples = join(repo, 'contracts/reservations/v1/examples');
const read = (path: string) => readFileSync(join(skillDir, path), 'utf8').replace(/\r\n/g, '\n');
const jsonBlocks = (markdown: string): unknown[] => [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));

function skillFiles(): string[] {
  return readdirSync(skillDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(skillDir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}

type Decision = { topic: string; status: string; summary: string; value?: Json; source?: string; recommendation?: Json; proposedDefault?: boolean };
type Brief = { briefVersion: number; setup: string; stage: string; decisions: Record<string, Decision>; pending?: string[] };
type Node = { key: string; type: string; required?: boolean; sensitive?: boolean; fields?: Node[] };
type Setup = {
  key: string;
  name: string;
  mode: string;
  presentation?: string;
  identityFields: Record<string, string>;
  questions: Node[];
  copy?: { pendingMessage?: string; confirmedMessage?: string };
  success?: { redirectPath: string };
  operations?: Record<string, any>;
};

const briefSchema = JSON.parse(read('references/brief.schema.json')) as Record<string, Json>;
const briefErrors = (brief: unknown) => schemaErrors(briefSchema, brief as Json, briefSchema);
const isBrief = (block: unknown): block is Brief => typeof block === 'object' && block !== null && 'briefVersion' in block;
const exampleBrief = () => structuredClone(jsonBlocks(read('references/brief.md'))[0]) as Brief;
const exampleBriefs = () => jsonBlocks(read('references/examples.md')).filter(isBrief);
const skillDeclarations = () => jsonBlocks(read('references/examples.md')).filter((block) => !isBrief(block)) as Setup[];
const contractSetups = () =>
  readdirSync(contractExamples)
    .filter((file) => file.endsWith('.json'))
    .sort()
    .map((file) => JSON.parse(readFileSync(join(contractExamples, file), 'utf8')) as Setup);
const allBriefs = () => [exampleBrief(), ...exampleBriefs()];

/** Interview rows: id → modes, kind, needed-for. */
function interviewRows(): Map<string, { modes: string[]; kind: string; neededFor: string }> {
  const rows = new Map<string, { modes: string[]; kind: string; neededFor: string }>();
  for (const m of read('references/interview.md').matchAll(/^\| `([a-z][a-z0-9_.<>]*)` \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/gm)) {
    rows.set(m[1], { modes: m[2].split(',').map((s) => s.trim()), kind: m[3].trim(), neededFor: m[4].trim() });
  }
  return rows;
}
const generic = (id: string) => id.replace(/^questions\.[a-z0-9_]+\.required$/, 'questions.<key>.required').replace(/^locations\.[a-z0-9_]+\.details$/, 'locations.<key>.details');
const FLOW_MODES: Record<string, string[]> = { time_slot: ['all', 'time_slot'], business_service: ['all', 'business', 'service'], business_party: ['all', 'business', 'party'] };
const THEME_TOKENS = ['primary', 'onPrimary', 'background', 'surface', 'text', 'mutedText', 'border', 'error', 'focus', 'font', 'headingFont', 'fontFamily', 'headingFontFamily', 'spacing', 'radius'];
const TOPICS = ['Booking mode', 'Durations and resources', 'Hours and exceptions', 'Confirmation policy', 'Locations, Calendar and conferencing', 'Questions and recipients', 'Cutoffs and copy', 'Theme and embedding', 'Review and readiness'];
const EMAIL = /[^\s@"]+@[^\s@"]+\.[a-z]{2,}/i;

function inputs(nodes: Node[]): Node[] {
  return nodes.flatMap((node) => [
    ...((INPUT_TYPES as string[]).includes(node.type) && !['hidden', 'quiz'].includes(node.type) ? [node] : []),
    ...(node.fields ? inputs(node.fields) : []),
  ]);
}
const schemaRefs = (def: string) =>
  Object.entries((briefSchema.properties as any).decisions.properties as Record<string, any>)
    .filter(([, schema]) => schema.$ref === `#/$defs/${def}` || schema.allOf?.[0]?.$ref === `#/$defs/${def}`)
    .map(([id]) => id)
    .sort();

describe('the yatris-reservation skill', () => {
  it('is one canonical skill: portable frontmatter, workflow in SKILL.md, every reference linked', () => {
    const skill = read('SKILL.md');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1];
    const fields = Object.fromEntries(frontmatter.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));

    expect(Object.keys(fields)).toEqual(['name', 'description']);
    expect(fields.name).toBe('yatris-reservation');
    expect(fields.description.length).toBeLessThanOrEqual(1024);
    for (const term of ['src/reservations/<key>.json', '<ReservationEmbed>', 'src/reservations/<key>.brief.json']) expect(fields.description).toContain(term);

    const references = skillFiles().filter((file) => file.startsWith('references/'));
    expect(references).toEqual(
      ['brief.md', 'brief.schema.json', 'connections.md', 'declaration.md', 'embedding.md', 'examples.md', 'interview.md', 'readiness.md', 'scenarios.md'].map((f) => `references/${f}`),
    );
    expect(skillFiles()).toEqual(['SKILL.md', ...references]);
    const linked = new Set([...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]));
    expect([...linked].sort()).toEqual(references);
    expect(skill.split('\n').length).toBeLessThan(260);
  });

  it('runs an adaptive interview over every spec §13.3 topic, at most three questions a round', () => {
    const skill = read('SKILL.md');
    const interview = read('references/interview.md');
    TOPICS.forEach((topic, i) => {
      expect(skill).toContain(`| ${i + 1} | ${topic} |`);
      expect(interview).toMatch(new RegExp(`^## ${i + 1}\\. ${topic}$`, 'm'));
    });
    expect(skill).toContain('**Short rounds: at most three questions.**');
    expect(interview).toContain('at most\nthree questions per round');
    expect(skill).toMatch(/a restaurant never gets host or meeting-link questions, a\s+consultant never gets table or party-size questions/);
    expect(skill).toContain('**Write the brief after every round.**');
  });

  it('adapts to the mode: host, service and party decisions never cross modes', () => {
    const rows = interviewRows();
    expect(rows.size).toBeGreaterThan(40);
    for (const [id, row] of rows) {
      for (const mode of row.modes) expect(['all', 'time_slot', 'business', 'service', 'party'], id).toContain(mode);
      expect(['fact', 'default', 'choice'], id).toContain(row.kind);
      expect(row.neededFor === '—' || /^(declaration|publication)\b/.test(row.neededFor), id).toBe(true);
      if (/^(hosts|appointment)\./.test(id)) expect(row.modes, id).toEqual(['time_slot']);
      if (/^(services|practitioners)\./.test(id)) expect(row.modes, id).toEqual(['service']);
      if (/^party\./.test(id)) expect(row.modes, id).toEqual(['party']);
      // A restaurant is never asked about meeting links or per-host hours
      if (['conferencing.wish', 'hours.resources'].includes(id)) expect(row.modes, id).not.toContain('party');
    }
    // Every mode has its own resource questions
    for (const [flow, prefix] of [['time_slot', 'hosts.'], ['business_service', 'services.'], ['business_party', 'party.']]) {
      expect([...rows].some(([id, row]) => id.startsWith(prefix) && row.modes.some((m) => FLOW_MODES[flow].includes(m)))).toBe(true);
    }
  });

  it('separates business facts from proposed defaults, in the interview and the brief schema', () => {
    const rows = interviewRows();
    const ids = (kind: string) => [...rows].filter(([id, row]) => row.kind === kind && !id.includes('<')).map(([id]) => id).sort();
    // Every fact is enforced by the schema (never delegated) and every default needs proposedDefault when delegated
    expect(schemaRefs('fact')).toEqual(ids('fact'));
    expect(schemaRefs('defaulted')).toEqual(ids('default'));
    for (const id of ['hosts.list', 'hours.weekly', 'party.capacity', 'party.tables', 'confirmation.mode', 'locations.list', 'appointment.duration', 'services.list']) {
      expect(rows.get(id)?.kind, id).toBe('fact');
    }
    // The decision-record §13 defaults, each labelled as a default
    const interview = read('references/interview.md');
    for (const text of ['`Asia/Tokyo` (default)', 'Every 15 minutes (default)', '90 days (default)', '2 hours (default)', '5 minutes (default)', '24 hours before the start (default)', '24 hours before (default)', '24 hours, ending early enough before the appointment (default)']) {
      expect(interview).toContain(text);
    }
    expect(interview).toContain('**Never inferred and never delegated**'); // decisions §8
    expect(read('SKILL.md')).toMatch(/Never present a proposed default[\s\S]*as a fact about the business/);
  });

  it('records Calendar and conferencing as wishes and never asks for credentials', () => {
    const interview = read('references/interview.md');
    expect(interview).toMatch(/`calendar.wish`[^\n]*\*\*A wish only\*\*/);
    expect(interview).toMatch(/`conferencing.wish`[^\n]*\*\*A wish only\*\*/);
    expect(interview).toMatch(/Offer only those\. Never add one the client did not name/);
    const connections = read('references/connections.md');
    for (const text of ['**later Yatris phases**', 'Never ask for SMTP credentials in chat', 'Never ask for a Google or Zoom password, token, client secret or API\n  key', 'Website Owner authorizes their own\n  Google or Zoom account on the Connections page']) {
      expect(connections).toContain(text);
    }
    expect(read('SKILL.md')).toMatch(/Never ask for, accept, print or store an SMTP password, an OAuth token/);
    for (const file of skillFiles()) {
      const text = read(file);
      expect(text, file).not.toMatch(/^YATRIS_SMTP_PASSWORD=\S/m);
      expect(text, file).not.toMatch(/alk_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{10,}|client_secret/);
    }
  });

  it('keeps recipients out of the repository and reuses the forms question contract', () => {
    const interview = read('references/interview.md');
    expect(interview).toMatch(/Business notification \*\*recipients\*\* are not interview decisions and never\s+appear in the repository/);
    const declaration = read('references/declaration.md');
    expect(declaration).toContain('| Recipients | Never. The Website Owner sets them in Yatris |');
    expect(declaration).toMatch(/explicit, unselected consent\*\*/); // decisions §12
    expect(declaration).toMatch(/\*\*purpose notice\*\*/);
    expect(declaration).toMatch(/\*\*staff review before publication\*\*/);
    expect(declaration).toMatch(/`sensitive: true`/);
    for (const key of ['booking.location_key', 'booking.starts_at', 'booking.host_key', 'booking.service_key', 'booking.party_size']) expect(declaration).toContain(`\`${key}\``);
    // No example puts an address anywhere: not in a brief, not in a declaration
    for (const block of jsonBlocks(read('references/brief.md') + read('references/examples.md'))) expect(JSON.stringify(block)).not.toMatch(EMAIL);
  });

  it('lists every readiness blocker and states that preview availability is synthetic', () => {
    const readiness = read('references/readiness.md');
    const pending = ((briefSchema.properties as any).pending.items.enum as string[]).sort();
    const listed = [...readiness.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]).sort();
    expect(listed).toEqual(pending);
    expect(readiness).toContain('## The synthetic-preview statement');
    expect(readiness).toContain('架空のデータ');
    expect(read('SKILL.md')).toContain('stating plainly that **preview availability is synthetic**');
    expect(read('references/embedding.md')).toMatch(/\*\*clearly labelled synthetic\*\* hosts and availability/);
    expect(read('references/declaration.md')).toMatch(/\*\*Never put a synthetic, placeholder or guessed host/);
  });

  it('documents the theme contract tokens by name', () => {
    const embedding = read('references/embedding.md');
    const tokens = [...embedding.matchAll(/^\| `([A-Za-z]+)` \|/gm)].map((m) => m[1]);
    expect(tokens).toEqual(THEME_TOKENS);
    expect(Object.keys((briefSchema.$defs as any).themeTokens.properties)).toEqual(THEME_TOKENS);
    expect(embedding).toContain('<ReservationEmbed setupKey="consultation" />');
    expect(embedding).toContain('`compact`, `comfortable` or `spacious`');
    expect(embedding).toContain('an integer from 0 to 24');
  });

  it('teaches only valid declarations: its own and the three contract examples', () => {
    const own = skillDeclarations();
    expect(own.length).toBeGreaterThanOrEqual(1);
    const contract = contractSetups();
    expect(contract.map((setup) => setup.key)).toEqual(['consultation', 'restaurant', 'salon']);
    for (const setup of [...own, ...contract]) {
      const result = validateSetup(setup);
      expect(result.errors, setup.key).toEqual([]);
      expect(result.warnings, setup.key).toEqual([]);
    }
    // examples.md points at exactly the contract examples, covering every mode
    const listed = [...read('references/examples.md').matchAll(/^\| `([a-z-]+\.json)` \| ([^|]+) \|/gm)].map((m) => [m[1], m[2].trim()]);
    expect(listed).toEqual([
      ['consultation.json', '`time_slot`'],
      ['salon.json', '`business` + `service`'],
      ['restaurant.json', '`business` + `party`'],
    ]);
    // The seed-less example: no operations, so no invented facts
    expect(own.some((setup) => setup.operations === undefined)).toBe(true);
  });
});

describe('the interview brief (src/reservations/<key>.brief.json)', () => {
  it('every documented brief matches brief.schema.json, one per mode', () => {
    const briefs = allBriefs();
    for (const brief of briefs) expect(briefErrors(brief), brief.setup).toEqual([]);
    expect(briefs.map((b) => b.decisions['mode.flow'].value).sort()).toEqual(['business_party', 'business_service', 'time_slot', 'time_slot']);
  });

  it('documents every decision id the briefs use, and uses only ids of the brief\'s mode', () => {
    const rows = interviewRows();
    for (const brief of allBriefs()) {
      const flow = brief.decisions['mode.flow'].value as string;
      for (const id of Object.keys(brief.decisions)) {
        const row = rows.get(generic(id));
        expect(row, `${brief.setup}: ${id}`).toBeDefined();
        expect(row!.modes.some((mode) => FLOW_MODES[flow].includes(mode)), `${brief.setup}: ${id} in ${flow}`).toBe(true);
      }
    }
  });

  it('matches the declaration it produced', () => {
    const declarations = new Map([...skillDeclarations(), ...contractSetups()].map((setup) => [setup.key, setup]));
    for (const brief of allBriefs()) {
      const setup = declarations.get(brief.setup)!;
      const d = brief.decisions;
      const value = (id: string) => d[id]?.value;
      expect(setup, brief.setup).toBeDefined();
      expect(brief.stage).toBe('implemented');
      expect(value('setup.name')).toBe(setup.name);
      expect(value('mode.flow')).toBe(setup.mode === 'time_slot' ? 'time_slot' : `business_${setup.presentation}`);
      expect(value('questions.identity')).toEqual(setup.identityFields);

      // Explicit requiredness for every input; sensitive questions as recorded
      const questions = inputs(setup.questions);
      for (const question of questions) {
        const decision = d[`questions.${question.key}.required`];
        expect(decision, `${brief.setup}: ${question.key}`).toBeDefined();
        expect(['confirmed', 'delegated']).toContain(decision.status);
        expect(decision.value).toBe(question.required);
      }
      const sensitive = questions.filter((q) => q.sensitive === true).map((q) => q.key);
      expect(value('questions.sensitive')).toEqual(sensitive);
      if (sensitive.length > 0) expect(brief.pending).toContain('staff_review');

      // Copy and outcome
      expect(value('copy.confirmed')).toBe(setup.copy?.confirmedMessage);
      if (setup.copy?.pendingMessage) expect(value('copy.pending')).toBe(setup.copy.pendingMessage);
      expect(value('success.redirect')).toBe(setup.success?.redirectPath ?? 'message');
      expect(value('placement.route')).toMatch(/^\/[a-z0-9/-]*\/$/);
      expect(Object.keys(value('theme.tokens') as object).every((token) => THEME_TOKENS.includes(token))).toBe(true);

      // Recipients are always the Owner's step in Yatris
      expect(brief.pending).toContain('recipient_setup');
      expect(Object.keys(d).some((id) => id.startsWith('recipients'))).toBe(false);

      const facts = Object.entries(d).filter(([id]) => schemaRefs('fact').includes(id));
      if (setup.operations === undefined) {
        // Seed-less: unresolved facts wait for Yatris
        expect(value('operations.seed')).toBe('omitted');
        expect(brief.pending).toContain('operating_facts');
        expect(facts.some(([, decision]) => decision.status === 'unresolved')).toBe(true);
        continue;
      }
      // Seeded: every operating fact was confirmed by the user, and the seed says the same
      const ops = setup.operations;
      expect(value('operations.seed')).toBe('included');
      expect(brief.pending).not.toContain('operating_facts');
      for (const [id, decision] of facts) expect(decision.status, `${brief.setup}: ${id}`).toBe('confirmed');
      expect(value('confirmation.mode')).toBe(ops.confirmationMode);
      expect(value('locations.list')).toEqual(ops.locations.map((l: { key: string }) => l.key));
      for (const location of ops.locations) expect(d[`locations.${location.key}.details`]?.status, location.key).toBe('confirmed');
      const kind = (k: string) => ops.resources.filter((r: { kind: string }) => r.kind === k).map((r: { key: string }) => r.key);
      if (setup.mode === 'time_slot') {
        expect(value('appointment.duration')).toBe(ops.appointment.durationMinutes);
        expect(value('hosts.list')).toEqual(ops.appointment.hostResourceKeys);
        expect(value('hosts.strategy')).toBe(ops.appointment.hostStrategy);
      } else if (setup.presentation === 'service') {
        expect(value('services.list')).toEqual(ops.services.map((s: { key: string }) => s.key));
        expect(value('practitioners.list')).toEqual(kind('practitioner'));
      } else {
        expect(value('party.size_limits')).toEqual({ min: ops.party.minSize, max: ops.party.maxSize });
        expect(value('party.duration')).toBe(ops.party.durationMinutes);
        expect(value('party.strategy')).toBe(ops.party.strategy);
        expect(value('party.tables')).toEqual(ops.party.tableResourceKeys);
        if (ops.confirmationMode === 'manual') expect(value('confirmation.approval_window')).toBe(ops.approvalWindowMinutes);
      }
      // Delegated values are the defaults they claim to be
      const defaults: Record<string, [string, number | string]> = {
        'hours.timezone': ['timezone', 'Asia/Tokyo'],
        'policy.slot_interval': ['slotIntervalMinutes', 15],
        'policy.horizon': ['bookingHorizonDays', 90],
        'policy.lead_time': ['minimumLeadMinutes', 120],
        'policy.hold': ['holdMinutes', 5],
        'cutoffs.cancel': ['cancelCutoffMinutes', 1440],
        'cutoffs.reschedule': ['rescheduleCutoffMinutes', 1440],
        'reminder.timing': ['reminderMinutesBefore', 1440],
      };
      for (const [id, [property, fallback]] of Object.entries(defaults)) {
        const decision = d[id];
        expect(decision?.value, `${brief.setup}: ${id}`).toBe(ops[property]);
        if (decision.status === 'delegated') expect(decision.value, `${brief.setup}: ${id} is the default`).toBe(fallback);
      }
    }
  });

  it('accepts a brief in progress with unresolved facts', () => {
    expect(
      briefErrors({
        briefVersion: 1,
        setup: 'reservation',
        stage: 'interviewing',
        decisions: {
          'mode.flow': { topic: 'booking_mode', status: 'confirmed', summary: 'A restaurant.', value: 'business_party', source: 'user' },
          'party.tables': { topic: 'durations_resources', status: 'unresolved', summary: 'Which tables, with how many seats?' },
          'confirmation.mode': { topic: 'confirmation_policy', status: 'unresolved', summary: 'Automatic or staff approval?' },
          'policy.horizon': { topic: 'hours_exceptions', status: 'unresolved', summary: 'How far ahead?', recommendation: 90, proposedDefault: true },
        },
      }),
    ).toEqual([]);
  });

  const mutations: Array<[string, (brief: Brief) => void, string]> = [
    ['a delegated host list (a fact)', (b) => ((b.decisions['hosts.list'] = { topic: 'durations_resources', status: 'delegated', summary: 'x', value: ['a'], source: 'user' })), '/decisions/hosts.list/status: enum'],
    ['delegated opening hours (a fact)', (b) => ((b.decisions['hours.weekly'] = { topic: 'hours_exceptions', status: 'delegated', summary: 'x', value: 'mon 10:00-18:00', source: 'user' })), '/decisions/hours.weekly/status: enum'],
    ['a delegated confirmation choice', (b) => ((b.decisions['confirmation.mode'].status = 'delegated')), '/decisions/confirmation.mode/status: enum'],
    ['an unknown confirmation choice', (b) => ((b.decisions['confirmation.mode'].value = 'auto')), '/decisions/confirmation.mode/value: enum'],
    ['a fact labelled as a default', (b) => ((b.decisions['appointment.duration'].proposedDefault = true)), '/decisions/appointment.duration/proposedDefault: const'],
    ['a delegated default without its label', (b) => delete b.decisions['cutoffs.cancel'].proposedDefault, '/decisions/cutoffs.cancel/proposedDefault: required'],
    ['a recipient address as a value', (b) => ((b.decisions['mail.source'].value = 'owner@example.jp')), '/decisions/mail.source/value: not'],
    ['recipient addresses in a list', (b) => ((b.decisions['questions.list'].value = ['name', 'owner@example.jp'])), '/decisions/questions.list/value: not'],
    ['a recipient address in a summary', (b) => ((b.decisions['mail.source'].summary = 'Send to owner@example.jp')), '/decisions/mail.source/summary: not'],
    ['an unresolved decision with a value', (b) => ((b.decisions['hosts.list'].value = ['sato'])), '/decisions/hosts.list: not'],
    ['a confirmed decision without a value', (b) => delete b.decisions['appointment.duration'].value, '/decisions/appointment.duration/value: required'],
    ['an unknown mode', (b) => ((b.decisions['mode.flow'].value = 'business')), '/decisions/mode.flow/value: enum'],
    ['an unknown topic', (b) => ((b.decisions['setup.name'].topic = 'design')), '/decisions/setup.name/topic: enum'],
    ['an unknown status', (b) => ((b.decisions['setup.name'].status = 'assumed')), '/decisions/setup.name/status: enum'],
    ['an extra decision property', (b) => (((b.decisions['setup.name'] as Record<string, Json>).password = 'x')), '/decisions/setup.name/password: false'],
    ['an unknown theme token', (b) => (((b.decisions['theme.tokens'].value as Record<string, Json>).shadow = '0 0 4px')), '/decisions/theme.tokens/value/shadow: false'],
    ['a radius outside 0..24', (b) => (((b.decisions['theme.tokens'].value as Record<string, Json>).radius = 30)), '/decisions/theme.tokens/value/radius: maximum'],
    ['an unknown spacing', (b) => (((b.decisions['theme.tokens'].value as Record<string, Json>).spacing = 'wide')), '/decisions/theme.tokens/value/spacing: enum'],
    ['a decision id that is not dotted lowercase', (b) => ((b.decisions['Hosts.List'] = b.decisions['setup.name'])), '/decisions/Hosts.List#name: pattern'],
    ['an extra top-level property', (b) => (((b as unknown as Record<string, Json>).recipients = ['owner'])), '/recipients: false'],
    ['a setup key that is not a setup key', (b) => ((b.setup = 'Free Consultation')), '/setup: pattern'],
    ['another brief version', (b) => ((b.briefVersion = 2)), '/briefVersion: const'],
    ['an unknown stage', (b) => ((b.stage = 'published')), '/stage: enum'],
    ['an unknown pending item', (b) => ((b.pending = ['go_live'])), '/pending/0: enum'],
    ['a missing decisions map', (b) => delete (b as Partial<Brief>).decisions, '/decisions: required'],
  ];
  it.each(mutations)('rejects %s', (_name, mutate, expected) => {
    const brief = exampleBrief();
    mutate(brief);
    expect(briefErrors(brief)).toContain(expected);
  });
});

describe('root agent guidance', () => {
  it('the managed AGENTS.md block sends reservations to Yatris and forbids other booking paths', () => {
    const block = managedBlock(readFileSync(join(repo, 'template/AGENTS.md'), 'utf8'))!;
    expect(block).toContain('**Reservations always use Yatris**');
    expect(block).toContain('`src/reservations/<key>.json`');
    expect(block).toContain('<ReservationEmbed setupKey="<key>" />');
    expect(block).toContain('`yatris-reservation`');
    for (const text of ['third-party booking widget', 'custom booking backend', 'Not even as a stopgap', 'never ask for SMTP, OAuth or provider credentials', 'never write recipient addresses into the\n  repository']) {
      expect(block).toContain(text);
    }
  });
});
