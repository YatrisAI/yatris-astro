import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  contextFixtures,
  operationsFixtures,
  publicCases,
  publicMeta,
  setup as setupOf,
  setupFixtures,
  appointmentOps,
} from '../../test/reservations-fixtures.js';
import { canonicalJson, NODE_TYPE_NAMES, sha256Hex, validateQuestions } from '../forms/index.js';
import {
  OPERATIONS,
  RESERVATION_API_ERRORS,
  reservationContext,
  reservationDigest,
  reservationPublicContent,
  reservationPublicDefinition,
  SETUP,
  SETUP_SCHEMA_ID,
  setupJsonSchema,
  validateOperations,
  validateSetup,
  type ReservationOperations,
  type ReservationSetup,
} from './index.js';
import { rerootQuestionPath } from './setup.js';

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/reservations/v1');
const UPDATE = process.env.YATRIS_UPDATE_CONTRACT === '1';
const EXAMPLES = ['consultation.json', 'salon.json', 'restaurant.json'];
const example = (name: string) => JSON.parse(readFileSync(join(CONTRACT, 'examples', name), 'utf8')) as ReservationSetup;

/** Published contract files must equal what the sources produce; YATRIS_UPDATE_CONTRACT=1 rewrites them. */
function published(relative: string, value: unknown) {
  const path = join(CONTRACT, relative);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  expect(existsSync(path), `${relative} is missing; run YATRIS_UPDATE_CONTRACT=1 npx vitest run packages/astro/src/reservations`).toBe(true);
  expect(readFileSync(path, 'utf8'), `${relative} is stale; run YATRIS_UPDATE_CONTRACT=1 npx vitest run packages/astro/src/reservations`).toBe(contents);
}

/** Every semantic error and warning code the contract defines; each must appear in a fixture. */
const SEMANTIC_CODES = [
  'presentation_not_allowed',
  'identity_field_invalid',
  'invalid_timezone',
  'invalid_slot_interval',
  'duplicate_key',
  'invalid_interval',
  'overlapping_hours',
  'invalid_exception',
  'duplicate_date',
  'invalid_date',
  'location_field_not_allowed',
  'invalid_url',
  'resource_field_not_allowed',
  'min_exceeds_max',
  'section_not_allowed',
  'unknown_resource',
  'resource_kind_mismatch',
  'single_host_count',
  'host_choice_not_allowed',
  'count_exceeds_resources',
  'party_field_not_allowed',
  'combination_table_not_listed',
  'required_property',
];
const SHAPE_CODES = ['invalid_type', 'required_property', 'unknown_property', 'too_short', 'too_long', 'pattern_mismatch', 'invalid_enum', 'out_of_range', 'not_unique'];
const WARNING_CODES = ['confirmation_mode_missing'];

describe('setup fixtures', () => {
  it.each(setupFixtures.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    const result = validateSetup(fixture.setup);
    expect(result.errors).toEqual(fixture.errors);
    expect(result.warnings).toEqual(fixture.warnings);
    expect(result.valid).toBe(fixture.errors.length === 0);
  });
});

describe('operations fixtures', () => {
  it.each(operationsFixtures.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    const result = validateOperations(fixture.operations, { mode: fixture.mode, presentation: fixture.presentation });
    expect(result.errors).toEqual(fixture.errors);
    expect(result.warnings).toEqual(fixture.warnings);
    expect(result.valid).toBe(fixture.errors.length === 0);
  });

  it('prefixes every path with pathPrefix', () => {
    const fixture = operationsFixtures.find((f) => f.name === 'host references')!;
    const result = validateOperations(fixture.operations, { mode: fixture.mode, pathPrefix: '/operations' });
    expect(result.errors).toEqual(fixture.errors.map((i) => ({ ...i, path: `/operations${i.path}` })));
  });

  it('a seed reports exactly what the same live revision reports, under /operations', () => {
    for (const fixture of operationsFixtures.filter((f) => f.mode === 'time_slot')) {
      const result = validateSetup(setupOf('time_slot', { operations: fixture.operations }));
      expect(result.errors, fixture.name).toEqual(fixture.errors.map((i) => ({ ...i, path: `/operations${i.path}` })));
      expect(result.warnings, fixture.name).toEqual(fixture.warnings.map((i) => ({ ...i, path: `/operations${i.path}` })));
    }
  });

  it('rejects bad options as programming errors', () => {
    expect(() => validateOperations({}, { mode: 'walk_in' as never })).toThrow(TypeError);
    expect(() => validateOperations({}, { mode: 'business', presentation: 'table' as never })).toThrow(TypeError);
  });
});

describe('fixture coverage', () => {
  const codes = (list: { errors: { code: string }[]; warnings: { code: string }[] }[], key: 'errors' | 'warnings') =>
    new Set(list.flatMap((f) => f[key].map((i) => i.code)));
  const errors = new Set([...codes(setupFixtures, 'errors'), ...codes(operationsFixtures, 'errors')]);
  const warnings = new Set([...codes(setupFixtures, 'warnings'), ...codes(operationsFixtures, 'warnings')]);

  it.each([...SEMANTIC_CODES, ...SHAPE_CODES])('error code %s appears in a fixture', (code) => expect(errors.has(code)).toBe(true));
  it.each(WARNING_CODES)('warning code %s appears in a fixture', (code) => expect(warnings.has(code)).toBe(true));

  it('never uses [] where an object is expected (PHP cannot tell [] from {})', () => {
    for (const f of setupFixtures) expect(Array.isArray(f.setup), f.name).toBe(false);
    for (const f of operationsFixtures) expect(Array.isArray(f.operations), f.name).toBe(false);
  });

  it('issue lists are deduplicated and sorted by path, then code', () => {
    for (const f of [...setupFixtures, ...operationsFixtures]) {
      for (const list of [f.errors, f.warnings]) {
        const keys = list.map((i) => `${i.path}\u0000${i.code}`);
        expect(keys, f.name).toEqual([...new Set(keys)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
      }
    }
  });
});

describe('question context', () => {
  it.each(contextFixtures.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    expect(reservationContext(fixture.setup, fixture.operations)).toEqual(fixture.expected);
  });

  it('setup question issues are validateQuestions issues re-rooted from /fields to /questions', () => {
    for (const fixture of setupFixtures.filter((f) => f.errors.some((i) => i.path.startsWith('/questions/')) && validateSetup(f.setup).errors.every((i) => i.path.startsWith('/questions')))) {
      const value = fixture.setup as ReservationSetup;
      const context = reservationContext(value, value.operations ?? null);
      const direct = validateQuestions(value.questions, { context }).errors.map((i) => ({ path: rerootQuestionPath(i.path), code: i.code }));
      expect(validateSetup(value).errors, fixture.name).toEqual(direct);
    }
    expect(rerootQuestionPath('/fields')).toBe('/questions');
    expect(rerootQuestionPath('/fields/2/visibleWhen/field')).toBe('/questions/2/visibleWhen/field');
    expect(rerootQuestionPath('/fieldset')).toBe('/fieldset');
  });
});

describe('examples', () => {
  it.each(EXAMPLES)('%s is valid with no warnings', (name) => {
    expect(validateSetup(example(name))).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('cover one mode each', () => {
    expect(EXAMPLES.map((name) => [example(name).mode, example(name).presentation ?? null])).toEqual([
      ['time_slot', null],
      ['business', 'service'],
      ['business', 'party'],
    ]);
  });

  it('salon marks the allergy question sensitive and asks for consent', () => {
    const health = example('salon.json').questions.find((q) => q.key === 'health')!;
    expect(health.fields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: 'allergy', sensitive: true }), expect.objectContaining({ type: 'acceptance', required: true })]),
    );
  });
});

describe('public definition', () => {
  const definitions = () =>
    Promise.all([
      ...EXAMPLES.map(async (name) => {
        const value = example(name);
        const operations = value.operations!;
        return { name, setup: value, operations, meta: publicMeta, expected: await reservationPublicDefinition(value, operations, publicMeta) };
      }),
      ...publicCases.map(async (c) => ({ ...c, expected: await reservationPublicDefinition(c.setup, c.operations, c.meta) })),
    ]);

  it('never exposes private operations, recipients or resource details', async () => {
    for (const { expected, operations } of await definitions()) {
      const json = JSON.stringify(expected);
      for (const secret of ['meetingUrl', 'address', 'instructions', 'reminderMinutesBefore', 'capacity', 'seats', 'weeklyHours', 'exceptions', 'venueHours', 'tableResourceKeys', 'combinations', 'hostResourceKeys', 'requirements', 'bufferAfterMinutes', '$schema', 'recipients']) {
        expect(json).not.toContain(`"${secret}"`);
      }
      for (const location of (operations as ReservationOperations).locations ?? []) {
        if (location.meetingUrl) expect(json).not.toContain(location.meetingUrl);
        if (location.address) expect(json).not.toContain(location.address);
      }
    }
  });

  it('applies policy defaults and shows the approval window only for manual confirmation', async () => {
    const [manual, , pool] = await Promise.all(publicCases.map((c) => reservationPublicDefinition(c.setup, c.operations, c.meta)));
    expect(manual!.policies).toEqual({
      timezone: 'Asia/Tokyo',
      slotIntervalMinutes: 15,
      bookingHorizonDays: 90,
      minimumLeadMinutes: 120,
      holdMinutes: 5,
      confirmationMode: 'manual',
      approvalWindowMinutes: 1440,
      cancelCutoffMinutes: 1440,
      rescheduleCutoffMinutes: 1440,
    });
    expect(manual!.appointment).toEqual({ durationMinutes: 30, visitorChoosesHost: true, hosts: [{ key: 'tanaka', label: '田中' }, { key: 'sato', label: '佐藤' }] });
    expect(manual!).toMatchObject({ locations: [], copy: {}, success: null, turnstile: null });
    expect(pool!.policies).not.toHaveProperty('approvalWindowMinutes');
    expect(pool!.party).toEqual({ minSize: 1, maxSize: 8, durationMinutes: 90 });
  });

  it('lists practitioners only when the visitor chooses one', async () => {
    const c = publicCases[1]!;
    const definition = await reservationPublicDefinition(c.setup, c.operations, c.meta);
    expect(definition.services!.map((s) => [s.key, s.practitioners])).toEqual([
      ['head_spa', [{ key: 'suzuki', label: '鈴木' }, { key: 'yamada', label: '山田' }]],
      ['color', []],
    ]);
    const consultation = await reservationPublicDefinition(example('consultation.json'), example('consultation.json').operations!, publicMeta);
    expect(consultation.appointment).toEqual({ durationMinutes: 60, visitorChoosesHost: false, hosts: [] });
  });

  it('projects questions exactly as the forms public definition projects fields', async () => {
    const restaurant = await reservationPublicDefinition(example('restaurant.json'), example('restaurant.json').operations!, publicMeta);
    expect(restaurant.questions.find((q) => q.key === 'children')).toMatchObject({ validation: { min: '0', max: '8', step: '1' } });
    expect(restaurant.questions.find((q) => q.key === 'allergies')).toMatchObject({ sensitive: true });
  });

  it('digests the content without version, revision, digest, turnstile and endpoints', async () => {
    const value = example('salon.json');
    const operations = value.operations!;
    const a = await reservationPublicDefinition(value, operations, publicMeta);
    const b = await reservationPublicDefinition(value, operations, { version: 9, operationsRevision: 99, turnstile: null, endpoints: {} });
    expect(a.setup.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(b.setup.digest).toBe(a.setup.digest);
    expect(await reservationDigest(value, operations)).toBe(a.setup.digest);
    const { version: _v, operationsRevision: _r, digest: _d, ...head } = a.setup;
    const { turnstile: _t, endpoints: _e, ...rest } = a;
    expect(`sha256:${await sha256Hex(canonicalJson({ ...rest, setup: head }))}`).toBe(a.setup.digest);
    expect(reservationPublicContent(value, operations)).toEqual({ ...rest, setup: head });
    const changed = await reservationDigest(value, { ...operations, holdMinutes: 6 });
    expect(changed).not.toBe(a.setup.digest);
  });

  it('refuses invalid input and a missing confirmationMode', async () => {
    const value = setupOf('time_slot');
    const { confirmationMode: _c, ...undecided } = appointmentOps();
    await expect(reservationPublicDefinition(value, undecided, publicMeta)).rejects.toThrow(/confirmationMode/);
    await expect(reservationPublicDefinition({ ...value, locale: 'en' } as never, appointmentOps(), publicMeta)).rejects.toThrow(/setup/);
    await expect(reservationPublicDefinition(value, appointmentOps({ timezone: 'JST' }), publicMeta)).rejects.toThrow(/operations/);
    const conditional = setupOf('time_slot', {}, [{ key: 'memo', type: 'text', label: 'memo', required: false, visibleWhen: { field: 'booking.host_key', operator: 'eq', value: 'kimura' } }]);
    expect(validateSetup(conditional).valid).toBe(true);
    await expect(reservationPublicDefinition(conditional, appointmentOps(), publicMeta)).rejects.toThrow(/live operations/);
  });

  it('publishes projection fixtures with stable digests', async () => {
    published('fixtures/public.json', await definitions());
  });
});

describe('published contract files', () => {
  it('setup.schema.json matches the registry', () => {
    const schema = setupJsonSchema() as { $id: string; properties: Record<string, unknown>; required: string[]; $defs: Record<string, { properties?: Record<string, unknown> }> };
    expect(schema.$id).toBe(SETUP_SCHEMA_ID);
    expect(Object.keys(schema.properties)).toEqual(Object.keys(SETUP.props));
    expect(schema.required).toEqual([...SETUP.required]);
    expect(schema.properties.operations).toEqual({ $ref: '#/$defs/operations' });
    expect(Object.keys(schema.$defs.operations!.properties!)).toEqual(Object.keys(OPERATIONS.props));
    expect(schema.properties.locale).toEqual({ type: 'string', enum: ['ja'] });
    for (const name of NODE_TYPE_NAMES) expect(schema.$defs).toHaveProperty(`node_${name}`);
    for (const name of EXAMPLES) expect(example(name).$schema).toBe(SETUP_SCHEMA_ID);
    published('setup.schema.json', schema);
  });

  it('messages.ja.json matches the API error messages', () => {
    published('messages.ja.json', { apiErrors: RESERVATION_API_ERRORS });
  });

  it('fixture files match their sources', () => {
    published('fixtures/setups.json', setupFixtures);
    published('fixtures/operations.json', operationsFixtures);
    published('fixtures/context.json', contextFixtures);
  });
});
