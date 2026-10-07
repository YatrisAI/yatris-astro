/**
 * Source of the shared reservation contract fixtures in
 * contracts/reservations/v1/fixtures/. Expectations are written by hand
 * here; reservations/contract.test.ts checks the JavaScript implementation
 * against them and keeps the published JSON in step (YATRIS_UPDATE_CONTRACT=1
 * rewrites it). The PHP twin in YatrisCMS must pass the same JSON.
 *
 * Issue lists are in their exact expected order: deduplicated, sorted by
 * path, then code (UTF-16 code unit order), as forms `tidy`.
 */

type Json = any;
type IssueJson = { path: string; code: string };

const issue = (path: string, code: string): IssueJson => ({ path, code });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
const omit = (value: Json, ...keys: string[]): Json => {
  const out = clone(value);
  for (const key of keys) delete out[key];
  return out;
};

// Questions ---------------------------------------------------------------

const NAME = { key: 'name', type: 'text', label: 'お名前', required: true };
const EMAIL = { key: 'email', type: 'email', label: 'メールアドレス', required: true };
const PHONE = { key: 'phone', type: 'tel', label: '電話番号', required: false };
const text = (key: string, extra: Json = {}) => ({ key, type: 'text', label: key, required: false, ...extra });
const eq = (field: string, value: Json) => ({ field, operator: 'eq', value });

type Kind = 'time_slot' | 'service' | 'party';

/** A setup of the given kind with questions [name, email, ...more]. */
export function setup(kind: Kind, extra: Json = {}, more: Json[] = []): Json {
  return {
    contractVersion: 1,
    key: kind === 'time_slot' ? 'consultation' : kind === 'service' ? 'salon' : 'restaurant',
    name: kind === 'time_slot' ? '無料相談のご予約' : kind === 'service' ? 'サロンのご予約' : 'お席のご予約',
    locale: 'ja',
    mode: kind === 'time_slot' ? 'time_slot' : 'business',
    ...(kind === 'time_slot' ? {} : { presentation: kind }),
    identityFields: { name: 'name', email: 'email' },
    questions: [NAME, EMAIL, ...more],
    ...extra,
  };
}

// Operations --------------------------------------------------------------

const host = (key: string, label = key) => ({ key, kind: 'host', label });
const practitioner = (key: string, label = key) => ({ key, kind: 'practitioner', label });
const table = (key: string, min: number, max: number) => ({ key, kind: 'table', label: key, seats: { min, max } });
const pool = (key: string, capacity: number) => ({ key, kind: 'pool', label: key, capacity });

export function appointmentOps(extra: Json = {}): Json {
  return {
    confirmationMode: 'automatic',
    locations: [
      { key: 'online', type: 'online', label: 'オンライン' },
      { key: 'office', type: 'in_person', label: '本社' },
    ],
    resources: [host('sato', '佐藤'), host('tanaka', '田中')],
    appointment: { durationMinutes: 60, hostStrategy: 'one_available', hostResourceKeys: ['sato', 'tanaka'] },
    ...extra,
  };
}

export function serviceOps(extra: Json = {}): Json {
  return {
    confirmationMode: 'automatic',
    locations: [{ key: 'salon', type: 'in_person', label: '本店' }],
    resources: [practitioner('yamada', '山田'), practitioner('suzuki', '鈴木'), { key: 'spa_room', kind: 'room', label: 'スパルーム' }],
    services: [
      {
        key: 'cut',
        label: 'カット',
        durationMinutes: 60,
        variants: [
          { key: 'short', label: 'ショート', durationMinutes: 45 },
          { key: 'long', label: 'ロング', durationMinutes: 75 },
        ],
        requirements: [{ resourceKeys: ['yamada', 'suzuki'], count: 1 }],
      },
      { key: 'color', label: 'カラー', durationMinutes: 90, requirements: [{ resourceKeys: ['yamada', 'suzuki'], count: 1 }] },
    ],
    ...extra,
  };
}

export function partyOps(extra: Json = {}): Json {
  return {
    confirmationMode: 'manual',
    locations: [{ key: 'restaurant', type: 'in_person', label: '本店' }],
    resources: [table('t1', 1, 2), table('t2', 1, 2), table('t3', 2, 4)],
    party: {
      minSize: 1,
      maxSize: 6,
      durationMinutes: 120,
      strategy: 'tables',
      tableResourceKeys: ['t1', 't2', 't3'],
      combinations: [{ key: 't1_t2', resourceKeys: ['t1', 't2'], seats: { min: 3, max: 4 } }],
    },
    ...extra,
  };
}

function poolOps(extra: Json = {}): Json {
  return {
    confirmationMode: 'automatic',
    resources: [pool('seats', 30)],
    party: { minSize: 1, maxSize: 8, durationMinutes: 90, strategy: 'pool', poolResourceKey: 'seats' },
    ...extra,
  };
}

// Setup fixtures ----------------------------------------------------------

export interface SetupFixture {
  name: string;
  setup: Json;
  errors: IssueJson[];
  warnings: IssueJson[];
}

const S = (name: string, value: Json, errors: IssueJson[] = [], warnings: IssueJson[] = []): SetupFixture => ({ name, setup: value, errors, warnings });

const serviceQuestions = [
  text('perm_notes', { visibleWhen: eq('booking.service_key', 'perm') }),
  text('long_notes', { visibleWhen: eq('booking.variant_key', 'long') }),
  text('extra_notes', { visibleWhen: eq('booking.variant_key', 'extra_long') }),
];

export const setupFixtures: SetupFixture[] = [
  // Valid
  S('minimal time_slot setup', setup('time_slot')),
  S('minimal business service setup', setup('service')),
  S('minimal business party setup', setup('party')),
  S('time_slot setup with an operations seed', setup('time_slot', { operations: appointmentOps() })),
  S('service setup with an operations seed', setup('service', { operations: serviceOps() })),
  S('party setup with an operations seed', setup('party', { operations: partyOps() })),
  S('copy and success', setup('time_slot', { copy: { pendingMessage: '受け付けました。\n確認後にご連絡します。', confirmedMessage: '確定しました。' }, success: { redirectPath: '/thanks/' } })),
  S(
    'a seed without confirmationMode is a warning',
    setup('time_slot', { operations: omit(appointmentOps(), 'confirmationMode') }),
    [],
    [issue('/operations/confirmationMode', 'confirmation_mode_missing')],
  ),

  // Shape
  S('not an object', 'consultation', [issue('', 'invalid_type')]),
  S('missing required properties', omit(setup('time_slot'), 'identityFields', 'mode', 'questions'), [
    issue('/identityFields', 'required_property'),
    issue('/mode', 'required_property'),
    issue('/questions', 'required_property'),
  ]),
  S('recipients are never declared', setup('time_slot', { recipients: ['owner@example.jp'] }), [issue('/recipients', 'unknown_property')]),
  S('unsupported contract version', setup('time_slot', { contractVersion: 2 }), [issue('/contractVersion', 'out_of_range')]),
  S('setup key grammar', setup('time_slot', { key: 'Consultation_1' }), [issue('/key', 'pattern_mismatch')]),
  S('name length and line rules', setup('time_slot', { name: 'あ'.repeat(201) }), [issue('/name', 'too_long')]),
  S('a multi-line name', setup('time_slot', { name: '無料相談\nのご予約' }), [issue('/name', 'pattern_mismatch')]),
  S('only Japanese is supported', setup('time_slot', { locale: 'en' }), [issue('/locale', 'invalid_enum')]),
  S('unknown mode', setup('time_slot', { mode: 'walk_in' }), [issue('/mode', 'invalid_enum')]),
  S('unknown presentation', setup('service', { presentation: 'table' }), [issue('/presentation', 'invalid_enum')]),
  S('wrong property types', setup('time_slot', { name: 42, identityFields: 'name' }), [issue('/identityFields', 'invalid_type'), issue('/name', 'invalid_type')]),
  S('identity fields shape', setup('time_slot', { identityFields: { name: 'name', mail: 'email' } }), [
    issue('/identityFields/email', 'required_property'),
    issue('/identityFields/mail', 'unknown_property'),
  ]),
  S('identity field key grammar', setup('time_slot', { identityFields: { name: 'Name', email: 'email' } }), [issue('/identityFields/name', 'pattern_mismatch')]),
  S('empty question list', setup('time_slot', { questions: [] }), [issue('/questions', 'too_short')]),
  S(
    'question shape issues use /questions paths',
    setup('time_slot', {}, [{ key: 'colour', type: 'color', label: 'c', required: false }, { key: 'memo', type: 'textarea', label: 'm' }]),
    [issue('/questions/2/type', 'unknown_node_type'), issue('/questions/3/required', 'required_property')],
  ),
  S('copy and success shapes', setup('time_slot', { copy: { pendingMessage: 'あ'.repeat(2001), note: 'x' }, success: {} }), [
    issue('/copy/note', 'unknown_property'),
    issue('/copy/pendingMessage', 'too_long'),
    issue('/success/redirectPath', 'required_property'),
  ]),
  S('success redirect path grammar', setup('time_slot', { success: { redirectPath: 'thanks' } }), [issue('/success/redirectPath', 'pattern_mismatch')]),
  S(
    'seed shape issues use /operations paths and skip every semantic rule',
    setup('time_slot', { presentation: 'party', operations: { slotIntervalMinutes: 7, holdMinutes: 60, recipients: [] } }),
    [issue('/operations/holdMinutes', 'out_of_range'), issue('/operations/recipients', 'unknown_property')],
  ),

  // Presentation
  S('business mode needs a presentation', omit(setup('service'), 'presentation'), [issue('/presentation', 'required_property')]),
  S('time_slot takes no presentation', setup('time_slot', { presentation: 'service' }), [issue('/presentation', 'presentation_not_allowed')]),
  S(
    'a business seed without presentation skips the mode-section rules',
    omit(setup('service', { operations: serviceOps({ appointment: { durationMinutes: 30, hostStrategy: 'single', hostResourceKeys: ['yamada'] } }) }), 'presentation'),
    [issue('/operations/appointment/hostResourceKeys/0', 'resource_kind_mismatch'), issue('/presentation', 'required_property')],
  ),

  // Identity fields
  S(
    'identity fields must name inputs of the right type',
    setup('time_slot', {
      identityFields: { name: 'name', email: 'email', phone: 'phone' },
      questions: [
        { ...NAME, required: false },
        { key: 'email', type: 'text', label: 'メール', required: true },
        { key: 'phone', type: 'email', label: '電話', required: false },
      ],
    }),
    [issue('/identityFields/email', 'identity_field_invalid'), issue('/identityFields/name', 'identity_field_invalid'), issue('/identityFields/phone', 'identity_field_invalid')],
  ),
  S(
    'name and email must be unconditional, through every ancestor group',
    setup('time_slot', {
      questions: [
        { ...NAME, requiredWhen: { field: 'booking.starts_at', operator: 'isNotEmpty' } },
        {
          key: 'outer',
          type: 'group',
          label: '連絡先',
          visibleWhen: eq('booking.location_key', 'office'),
          fields: [{ key: 'inner', type: 'group', fields: [EMAIL] }],
        },
      ],
    }),
    [issue('/identityFields/email', 'identity_field_invalid'), issue('/identityFields/name', 'identity_field_invalid')],
  ),
  S(
    'a conditionally visible name or an optional email',
    setup('time_slot', { questions: [{ ...NAME, visibleWhen: eq('booking.location_key', 'online') }, { ...EMAIL, required: false }] }),
    [issue('/identityFields/email', 'identity_field_invalid'), issue('/identityFields/name', 'identity_field_invalid')],
  ),
  S('identity fields inside an unconditional group', setup('time_slot', { questions: [{ key: 'contact', type: 'group', label: '連絡先', fields: [NAME, EMAIL] }] })),
  S('unknown identity keys', setup('time_slot', { identityFields: { name: 'full_name', email: 'mail', phone: 'tel' } }), [
    issue('/identityFields/email', 'identity_field_invalid'),
    issue('/identityFields/name', 'identity_field_invalid'),
    issue('/identityFields/phone', 'identity_field_invalid'),
  ]),
  S(
    'sensitive identity fields are invalid',
    setup('time_slot', {
      identityFields: { name: 'name', email: 'email', phone: 'phone' },
      questions: [NAME, { ...EMAIL, sensitive: true }, { ...PHONE, sensitive: true }],
    }),
    [issue('/identityFields/email', 'identity_field_invalid'), issue('/identityFields/phone', 'identity_field_invalid')],
  ),
  S(
    'phone may be optional and conditional',
    setup('party', {
      identityFields: { name: 'name', email: 'email', phone: 'phone' },
      questions: [NAME, EMAIL, { ...PHONE, requiredWhen: { field: 'booking.party_size', operator: 'gte', value: '6' } }],
    }),
  ),

  // Questions and the question context
  S('a context key outside the mode is an unknown reference', setup('time_slot', {}, [text('menu', { visibleWhen: eq('booking.service_key', 'cut') })]), [
    issue('/questions/2/visibleWhen/field', 'unknown_reference'),
  ]),
  S('party size only exists for party presentation', setup('service', {}, [text('kids', { visibleWhen: { field: 'booking.party_size', operator: 'gte', value: '3' } })]), [
    issue('/questions/2/visibleWhen/field', 'unknown_reference'),
  ]),
  S('service and variant keys are checked against the seed', setup('service', { operations: serviceOps() }, serviceQuestions), [
    issue('/questions/2/visibleWhen/value', 'invalid_condition_value'),
    issue('/questions/4/visibleWhen/value', 'invalid_condition_value'),
  ]),
  S('without a seed any service or variant key is accepted', setup('service', {}, serviceQuestions)),
  S(
    'host and location keys are checked against the seed',
    setup('time_slot', { operations: appointmentOps() }, [
      text('a', { visibleWhen: eq('booking.host_key', 'sato') }),
      text('b', { visibleWhen: { field: 'booking.host_key', operator: 'in', value: ['tanaka', 'kimura'] } }),
      text('c', { visibleWhen: eq('booking.location_key', 'office') }),
      text('d', { visibleWhen: eq('booking.location_key', 'home') }),
    ]),
    [issue('/questions/3/visibleWhen/value', 'invalid_condition_value'), issue('/questions/5/visibleWhen/value', 'invalid_condition_value')],
  ),
  S(
    'booking context operators and values',
    setup('party', {}, [
      text('a', { visibleWhen: { field: 'booking.party_size', operator: 'contains', value: '6' } }),
      text('b', { visibleWhen: { field: 'booking.starts_at', operator: 'gte', value: 'tomorrow' } }),
      { key: 'g', type: 'group', label: 'g', fields: [text('c', { visibleWhen: eq('booking.host_key', 'sato') })] },
      text('d', { requiredWhen: { field: 'booking.starts_at', operator: 'gte', value: '2026-12-01T18:00' } }),
    ]),
    [
      issue('/questions/2/visibleWhen/operator', 'invalid_operator'),
      issue('/questions/3/visibleWhen/value', 'invalid_condition_value'),
      issue('/questions/4/fields/0/visibleWhen/field', 'unknown_reference'),
    ],
  ),
  S('duplicate question keys use /questions paths', setup('time_slot', {}, [text('memo'), text('memo')]), [issue('/questions/3/key', 'duplicate_key')]),
  S(
    'sensitive questions may carry conditions',
    setup('service', {}, [
      { key: 'allergy', type: 'textarea', label: 'アレルギー', required: false, sensitive: true, visibleWhen: eq('booking.service_key', 'color') },
    ]),
  ),

  // Operations seed semantics
  S(
    'seed semantics use /operations paths',
    setup('time_slot', {
      operations: appointmentOps({
        timezone: 'Asia/Nowhere',
        slotIntervalMinutes: 25,
        party: { minSize: 1, maxSize: 2, durationMinutes: 60, strategy: 'pool', poolResourceKey: 'sato' },
      }),
    }),
    [
      issue('/operations/party', 'section_not_allowed'),
      issue('/operations/party/poolResourceKey', 'resource_kind_mismatch'),
      issue('/operations/slotIntervalMinutes', 'invalid_slot_interval'),
      issue('/operations/timezone', 'invalid_timezone'),
    ],
  ),
  S('a time_slot seed needs an appointment', setup('time_slot', { operations: { confirmationMode: 'automatic' } }), [issue('/operations/appointment', 'required_property')]),
  S('a party seed needs a party section', setup('party', { operations: { confirmationMode: 'manual' } }), [issue('/operations/party', 'required_property')]),
];

// Operations fixtures (live revision: prefix "") ---------------------------

export interface OperationsFixture {
  name: string;
  mode: 'time_slot' | 'business';
  presentation: 'party' | 'service' | null;
  operations: Json;
  errors: IssueJson[];
  warnings: IssueJson[];
}

const O = (name: string, kind: Kind | 'business', operations: Json, errors: IssueJson[] = [], warnings: IssueJson[] = []): OperationsFixture => ({
  name,
  mode: kind === 'time_slot' ? 'time_slot' : 'business',
  presentation: kind === 'service' || kind === 'party' ? kind : null,
  operations,
  errors,
  warnings,
});

const location = (key: string, type: string, extra: Json = {}) => ({ key, type, label: key, ...extra });
const online = (url: string, i: number) => location(`online_${i}`, 'online', { meetingUrl: url });

export const operationsFixtures: OperationsFixture[] = [
  // Valid
  O('valid time_slot operations', 'time_slot', appointmentOps()),
  O('valid business service operations', 'service', serviceOps()),
  O('valid party operations with tables and a combination', 'party', partyOps()),
  O('valid party operations with a capacity pool', 'party', poolOps()),
  O('confirmationMode missing is a warning', 'time_slot', omit(appointmentOps(), 'confirmationMode'), [], [issue('/confirmationMode', 'confirmation_mode_missing')]),
  O('an empty revision lacks its mode section', 'time_slot', {}, [issue('/appointment', 'required_property')], [issue('/confirmationMode', 'confirmation_mode_missing')]),
  O('business without a presentation skips mode sections', 'business', {
    confirmationMode: 'automatic',
    resources: [host('sato')],
    appointment: { durationMinutes: 30, hostStrategy: 'single', hostResourceKeys: ['sato'] },
  }),

  // Shape
  O('not an object', 'time_slot', 'not an object', [issue('', 'invalid_type')]),
  O('no recipients, calendars or secrets', 'time_slot', appointmentOps({ recipients: ['owner@example.jp'], calendarId: 'primary' }), [
    issue('/calendarId', 'unknown_property'),
    issue('/recipients', 'unknown_property'),
  ]),
  O(
    'policy ranges and types',
    'time_slot',
    appointmentOps({
      timezone: '',
      slotIntervalMinutes: 3,
      holdMinutes: 31,
      approvalWindowMinutes: 10,
      confirmationMode: 'auto',
      minimumLeadMinutes: '120',
      bookingHorizonDays: 366,
      cancelCutoffMinutes: -1,
      reminderMinutesBefore: 59,
    }),
    [
      issue('/approvalWindowMinutes', 'out_of_range'),
      issue('/bookingHorizonDays', 'out_of_range'),
      issue('/cancelCutoffMinutes', 'out_of_range'),
      issue('/confirmationMode', 'invalid_enum'),
      issue('/holdMinutes', 'out_of_range'),
      issue('/minimumLeadMinutes', 'invalid_type'),
      issue('/reminderMinutesBefore', 'out_of_range'),
      issue('/slotIntervalMinutes', 'out_of_range'),
      issue('/timezone', 'too_short'),
    ],
  ),
  O(
    'nested shapes',
    'time_slot',
    {
      confirmationMode: 'automatic',
      locations: [],
      resources: [
        { key: 'sato', kind: 'staff', label: '佐藤' },
        { key: 'tanaka', kind: 'host' },
        { key: 't1', kind: 'table', label: 'T1', seats: { min: 2 } },
        { key: 'Room', kind: 'room', label: 'R' },
      ],
      venueHours: {
        weekly: [{ day: 'mon', start: '9:00', end: '18:00' }],
        exceptions: [{ date: '2026/12/31', closed: true }],
      },
      appointment: { durationMinutes: 60, hostStrategy: 'one_available', hostResourceKeys: ['sato', 'sato'] },
    },
    [
      issue('/appointment/hostResourceKeys', 'not_unique'),
      issue('/locations', 'too_short'),
      issue('/resources/0/kind', 'invalid_enum'),
      issue('/resources/1/label', 'required_property'),
      issue('/resources/2/seats/max', 'required_property'),
      issue('/resources/3/key', 'pattern_mismatch'),
      issue('/venueHours/exceptions/0/date', 'pattern_mismatch'),
      issue('/venueHours/weekly/0/day', 'invalid_enum'),
      issue('/venueHours/weekly/0/start', 'pattern_mismatch'),
    ],
  ),
  O(
    'mode section shapes',
    'service',
    {
      confirmationMode: 'automatic',
      services: [{ key: 'cut', label: 'カット', durationMinutes: 600, variants: [], requirements: [] }],
      party: { minSize: 0, maxSize: 2, durationMinutes: 60 },
    },
    [
      issue('/party/minSize', 'out_of_range'),
      issue('/party/strategy', 'required_property'),
      issue('/services/0/durationMinutes', 'out_of_range'),
      issue('/services/0/requirements', 'too_short'),
      issue('/services/0/variants', 'too_short'),
    ],
  ),

  // 1. Timezone and slot grid
  ...['Asia/Tokyo', 'UTC', 'Etc/GMT-9', 'America/Argentina/Buenos_Aires', 'Europe/London'].map((tz) => O(`timezone ${tz} is valid`, 'time_slot', appointmentOps({ timezone: tz }))),
  ...['Asia/Nowhere', 'JST', '+09:00', 'asia/tokyo', 'Japan', 'Asia/Tokyo '].map((tz) =>
    O(`timezone "${tz}" is invalid`, 'time_slot', appointmentOps({ timezone: tz }), [issue('/timezone', 'invalid_timezone')]),
  ),
  ...[5, 45, 90, 120].map((n) => O(`a ${n}-minute slot interval divides a day`, 'time_slot', appointmentOps({ slotIntervalMinutes: n }))),
  ...[7, 25, 100].map((n) =>
    O(`a ${n}-minute slot interval does not divide a day`, 'time_slot', appointmentOps({ slotIntervalMinutes: n }), [issue('/slotIntervalMinutes', 'invalid_slot_interval')]),
  ),

  // 2. Duplicate keys
  O(
    'duplicate location and resource keys',
    'time_slot',
    appointmentOps({
      locations: [location('online', 'online'), location('online', 'phone')],
      resources: [host('sato'), host('tanaka'), host('sato', '佐藤（別）')],
    }),
    [issue('/locations/1/key', 'duplicate_key'), issue('/resources/2/key', 'duplicate_key')],
  ),
  O(
    'duplicate service and variant keys',
    'service',
    serviceOps({
      services: [
        {
          key: 'cut',
          label: 'カット',
          durationMinutes: 60,
          variants: [
            { key: 'short', label: 'ショート', durationMinutes: 45 },
            { key: 'short', label: 'ショート2', durationMinutes: 50 },
          ],
          requirements: [{ resourceKeys: ['yamada'], count: 1 }],
        },
        { key: 'color', label: 'カラー', durationMinutes: 90, requirements: [{ resourceKeys: ['yamada'], count: 1 }] },
        { key: 'cut', label: 'カット2', durationMinutes: 30, requirements: [{ resourceKeys: ['suzuki'], count: 1 }] },
      ],
    }),
    [issue('/services/0/variants/1/key', 'duplicate_key'), issue('/services/2/key', 'duplicate_key')],
  ),
  O(
    'variant keys may repeat across services',
    'service',
    serviceOps({
      services: [
        { key: 'cut', label: 'カット', durationMinutes: 60, variants: [{ key: 'short', label: 'ショート', durationMinutes: 45 }], requirements: [{ resourceKeys: ['yamada'], count: 1 }] },
        { key: 'color', label: 'カラー', durationMinutes: 90, variants: [{ key: 'short', label: 'ショート', durationMinutes: 60 }], requirements: [{ resourceKeys: ['yamada'], count: 1 }] },
      ],
    }),
  ),
  O(
    'duplicate combination keys',
    'party',
    partyOps({
      party: {
        ...partyOps().party,
        combinations: [
          { key: 't1_t2', resourceKeys: ['t1', 't2'], seats: { min: 3, max: 4 } },
          { key: 't1_t2', resourceKeys: ['t2', 't3'], seats: { min: 3, max: 6 } },
        ],
      },
    }),
    [issue('/party/combinations/1/key', 'duplicate_key')],
  ),

  // 3. Hours
  O(
    'weekly hours intervals and overlaps',
    'time_slot',
    appointmentOps({
      resources: [
        { ...host('sato'), weeklyHours: [{ day: 'friday', start: '09:00', end: '12:00' }, { day: 'friday', start: '11:59', end: '13:00' }] },
        host('tanaka'),
      ],
      venueHours: {
        weekly: [
          { day: 'monday', start: '10:00', end: '12:00' },
          { day: 'monday', start: '12:00', end: '18:00' },
          { day: 'monday', start: '11:00', end: '13:00' },
          { day: 'tuesday', start: '11:00', end: '13:00' },
          { day: 'tuesday', start: '18:00', end: '18:00' },
          { day: 'tuesday', start: '19:00', end: '09:00' },
          { day: 'wednesday', start: '09:00', end: '17:00' },
          { day: 'wednesday', start: '09:00', end: '17:00' },
          { day: 'tuesday', start: '17:00', end: '19:00' },
        ],
      },
    }),
    [
      issue('/resources/0/weeklyHours/1', 'overlapping_hours'),
      issue('/venueHours/weekly/2', 'overlapping_hours'),
      issue('/venueHours/weekly/4', 'invalid_interval'),
      issue('/venueHours/weekly/5', 'invalid_interval'),
      issue('/venueHours/weekly/7', 'overlapping_hours'),
    ],
  ),

  // 4. Exceptions
  O(
    'dated exceptions',
    'time_slot',
    appointmentOps({
      resources: [{ ...host('sato'), exceptions: [{ date: '2026-12-31', closed: true }, { date: '2026-12-31', closed: true }] }, host('tanaka')],
      venueHours: {
        exceptions: [
          { date: '2026-12-29' },
          { date: '2026-12-30', closed: true, hours: [{ start: '10:00', end: '12:00' }] },
          { date: '2026-12-31', closed: false },
          { date: '2027-01-04', closed: false, hours: [{ start: '10:00', end: '12:00' }, { start: '11:00', end: '15:00' }] },
          { date: '2027-01-04', closed: true },
          { date: '2027-02-30', closed: true },
          { date: '2027-01-05', hours: [{ start: '15:00', end: '13:00' }] },
        ],
      },
    }),
    [
      issue('/resources/0/exceptions/1', 'duplicate_date'),
      issue('/venueHours/exceptions/0', 'invalid_exception'),
      issue('/venueHours/exceptions/1', 'invalid_exception'),
      issue('/venueHours/exceptions/2', 'invalid_exception'),
      issue('/venueHours/exceptions/3/hours/1', 'overlapping_hours'),
      issue('/venueHours/exceptions/4', 'duplicate_date'),
      issue('/venueHours/exceptions/5/date', 'invalid_date'),
      issue('/venueHours/exceptions/6/hours/0', 'invalid_interval'),
    ],
  ),

  // 5. Locations
  O(
    'location fields by type',
    'time_slot',
    appointmentOps({
      locations: [
        location('online', 'online', { meetingUrl: 'https://meet.google.com/abc-defg-hij', instructions: 'リンクからご参加ください。' }),
        location('zoom', 'online', { meetingUrl: 'http://zoom.us/j/1' }),
        location('office', 'in_person', { address: '大阪府大阪市北区梅田1-1-1', meetingUrl: 'https://meet.google.com/x' }),
        location('phone', 'phone', { address: '東京都', instructions: 'お電話します。' }),
        location('web', 'online', { address: '大阪府' }),
      ],
    }),
    [
      issue('/locations/1/meetingUrl', 'invalid_url'),
      issue('/locations/2/meetingUrl', 'location_field_not_allowed'),
      issue('/locations/3/address', 'location_field_not_allowed'),
      issue('/locations/4/address', 'location_field_not_allowed'),
    ],
  ),
  O(
    'meeting URLs must be absolute https URLs with a host',
    'time_slot',
    appointmentOps({
      locations: [
        'https://',
        'HTTPS://meet.example.com',
        'https://meet example.com',
        'https://user@meet.example.com/x',
        'https://-bad.example.com',
        'https://meet.example.com/会議',
        'meet.example.com',
        'https://meet.example.com:123456',
        'https://meet.example.com/a b',
        'https:///path',
      ].map(online),
    }),
    Array.from({ length: 10 }, (_, i) => issue(`/locations/${i}/meetingUrl`, 'invalid_url')).sort((a, b) => (a.path < b.path ? -1 : 1)),
  ),
  O(
    'valid meeting URLs',
    'time_slot',
    appointmentOps({
      locations: ['https://zoom.us/j/123456789?pwd=abc', 'https://meet.example.com:8443/room#top', 'https://localhost', 'https://teams.microsoft.com/l/meetup-join/19%3Ameeting'].map(online),
    }),
  ),

  // 6. Resources
  O(
    'resource fields by kind',
    'time_slot',
    appointmentOps({
      resources: [
        host('sato'),
        host('tanaka'),
        { key: 'seats', kind: 'pool', label: '客席' },
        { key: 'room_a', kind: 'room', label: '会議室', capacity: 4 },
        { key: 't1', kind: 'table', label: 'T1' },
        { key: 'kit', kind: 'equipment', label: '機材', seats: { min: 1, max: 2 } },
        table('t2', 4, 2),
      ],
    }),
    [
      issue('/resources/2/capacity', 'required_property'),
      issue('/resources/3/capacity', 'resource_field_not_allowed'),
      issue('/resources/4/seats', 'required_property'),
      issue('/resources/5/seats', 'resource_field_not_allowed'),
      issue('/resources/6/seats', 'min_exceeds_max'),
    ],
  ),

  // 7. Mode sections
  O(
    'time_slot allows only appointment',
    'time_slot',
    {
      confirmationMode: 'automatic',
      resources: [practitioner('yamada'), table('t1', 1, 4)],
      services: [{ key: 'cut', label: 'カット', durationMinutes: 60, requirements: [{ resourceKeys: ['yamada'], count: 1 }] }],
      party: { minSize: 1, maxSize: 4, durationMinutes: 90, strategy: 'tables', tableResourceKeys: ['t1'] },
    },
    [issue('/appointment', 'required_property'), issue('/party', 'section_not_allowed'), issue('/services', 'section_not_allowed')],
  ),
  O(
    'service presentation allows only services; references in other sections are still checked',
    'service',
    serviceOps({ appointment: { durationMinutes: 30, hostStrategy: 'single', hostResourceKeys: ['yamada'] }, party: { minSize: 1, maxSize: 2, durationMinutes: 60, strategy: 'pool', poolResourceKey: 'spa_room' } }),
    [
      issue('/appointment', 'section_not_allowed'),
      issue('/appointment/hostResourceKeys/0', 'resource_kind_mismatch'),
      issue('/party', 'section_not_allowed'),
      issue('/party/poolResourceKey', 'resource_kind_mismatch'),
    ],
  ),
  O(
    'party presentation needs party and allows no services',
    'party',
    { confirmationMode: 'manual', resources: [practitioner('yamada')], services: [{ key: 'cut', label: 'カット', durationMinutes: 60, requirements: [{ resourceKeys: ['yamada'], count: 1 }] }] },
    [issue('/party', 'required_property'), issue('/services', 'section_not_allowed')],
  ),

  // 8. Resource references
  O(
    'host references',
    'time_slot',
    appointmentOps({ resources: [host('sato'), { key: 'room_a', kind: 'room', label: '会議室' }], appointment: { durationMinutes: 60, hostStrategy: 'one_available', hostResourceKeys: ['sato', 'room_a', 'kimura'] } }),
    [issue('/appointment/hostResourceKeys/1', 'resource_kind_mismatch'), issue('/appointment/hostResourceKeys/2', 'unknown_resource')],
  ),
  O(
    'service requirement references',
    'service',
    serviceOps({
      resources: [practitioner('yamada'), host('sato'), table('t1', 1, 2), { key: 'kit', kind: 'equipment', label: '機材' }, { key: 'spa_room', kind: 'room', label: 'スパルーム' }],
      services: [
        {
          key: 'cut',
          label: 'カット',
          durationMinutes: 60,
          requirements: [
            { resourceKeys: ['yamada', 'sato', 'kit'], count: 1 },
            { resourceKeys: ['t1', 'nobody', 'spa_room'], count: 1 },
          ],
        },
      ],
    }),
    [
      issue('/services/0/requirements/0/resourceKeys/1', 'resource_kind_mismatch'),
      issue('/services/0/requirements/1/resourceKeys/0', 'resource_kind_mismatch'),
      issue('/services/0/requirements/1/resourceKeys/1', 'unknown_resource'),
    ],
  ),
  O('a pool reference must name a pool', 'party', poolOps({ resources: [table('t1', 1, 2), pool('seats', 30)], party: { ...poolOps().party, poolResourceKey: 't1' } }), [
    issue('/party/poolResourceKey', 'resource_kind_mismatch'),
  ]),
  O(
    'table and combination references',
    'party',
    partyOps({
      resources: [table('t1', 1, 2), table('t2', 1, 2), table('t3', 2, 4), pool('seats', 30)],
      party: {
        minSize: 1,
        maxSize: 6,
        durationMinutes: 120,
        strategy: 'tables',
        tableResourceKeys: ['t1', 'seats', 'ghost'],
        combinations: [
          { key: 'c1', resourceKeys: ['t1', 't2'], seats: { min: 3, max: 4 } },
          { key: 'c2', resourceKeys: ['t1', 'ghost2'], seats: { min: 5, max: 4 } },
          { key: 'c3', resourceKeys: ['t1', 'seats'], seats: { min: 2, max: 6 } },
        ],
      },
    }),
    [
      issue('/party/combinations/0/resourceKeys/1', 'combination_table_not_listed'),
      issue('/party/combinations/1/resourceKeys/1', 'combination_table_not_listed'),
      issue('/party/combinations/1/resourceKeys/1', 'unknown_resource'),
      issue('/party/combinations/1/seats', 'min_exceeds_max'),
      issue('/party/combinations/2/resourceKeys/1', 'resource_kind_mismatch'),
      issue('/party/tableResourceKeys/1', 'resource_kind_mismatch'),
      issue('/party/tableResourceKeys/2', 'unknown_resource'),
    ],
  ),
  O(
    'references resolve to the first resource with a key',
    'time_slot',
    appointmentOps({ resources: [host('sato'), { key: 'sato', kind: 'room', label: '会議室' }, host('tanaka')] }),
    [issue('/resources/1/key', 'duplicate_key')],
  ),

  // 9. Appointment
  O(
    'a single host strategy takes one host and no visitor choice',
    'time_slot',
    appointmentOps({ appointment: { durationMinutes: 60, hostStrategy: 'single', hostResourceKeys: ['sato', 'tanaka'], visitorChoosesHost: true } }),
    [issue('/appointment/hostResourceKeys', 'single_host_count'), issue('/appointment/visitorChoosesHost', 'host_choice_not_allowed')],
  ),
  O('a single host', 'time_slot', appointmentOps({ appointment: { durationMinutes: 60, hostStrategy: 'single', hostResourceKeys: ['sato'], visitorChoosesHost: false } })),
  O('visitors may choose among available hosts', 'time_slot', appointmentOps({ appointment: { durationMinutes: 60, hostStrategy: 'one_available', hostResourceKeys: ['sato', 'tanaka'], visitorChoosesHost: true } })),

  // 10. Services
  O(
    'a requirement count cannot exceed its resources',
    'service',
    serviceOps({
      services: [
        {
          key: 'cut',
          label: 'カット',
          durationMinutes: 60,
          requirements: [
            { resourceKeys: ['yamada'], count: 2 },
            { resourceKeys: ['yamada', 'suzuki'], count: 2 },
          ],
        },
      ],
    }),
    [issue('/services/0/requirements/0/count', 'count_exceeds_resources')],
  ),

  // 11. Party
  O(
    'pool strategy fields',
    'party',
    {
      confirmationMode: 'automatic',
      resources: [pool('seats', 30), table('t1', 1, 2), table('t2', 1, 2)],
      party: {
        minSize: 8,
        maxSize: 2,
        durationMinutes: 90,
        strategy: 'pool',
        tableResourceKeys: ['t1', 't2'],
        combinations: [{ key: 'c', resourceKeys: ['t1', 't2'], seats: { min: 3, max: 4 } }],
      },
    },
    [
      issue('/party', 'min_exceeds_max'),
      issue('/party/combinations', 'party_field_not_allowed'),
      issue('/party/poolResourceKey', 'required_property'),
      issue('/party/tableResourceKeys', 'party_field_not_allowed'),
    ],
  ),
  O(
    'tables strategy fields',
    'party',
    { confirmationMode: 'manual', resources: [pool('seats', 30), table('t1', 1, 4)], party: { minSize: 1, maxSize: 4, durationMinutes: 90, strategy: 'tables', poolResourceKey: 'seats' } },
    [issue('/party/poolResourceKey', 'party_field_not_allowed'), issue('/party/tableResourceKeys', 'required_property')],
  ),
  O(
    'combinations need tableResourceKeys to be checked for listing',
    'party',
    {
      confirmationMode: 'manual',
      resources: [table('t1', 1, 2), table('t2', 1, 2)],
      party: { minSize: 1, maxSize: 4, durationMinutes: 90, strategy: 'tables', combinations: [{ key: 'c', resourceKeys: ['t1', 't2'], seats: { min: 3, max: 4 } }] },
    },
    [issue('/party/tableResourceKeys', 'required_property')],
  ),
];

// Question context fixtures -----------------------------------------------

export interface ContextFixture {
  name: string;
  setup: Json;
  operations: Json | null;
  expected: Json;
}

const LOCATION = { kind: 'choice' };
const STARTS_AT = { kind: 'datetime' };

export const contextFixtures: ContextFixture[] = [
  {
    name: 'time_slot without operations',
    setup: setup('time_slot'),
    operations: null,
    expected: { 'booking.location_key': LOCATION, 'booking.starts_at': STARTS_AT, 'booking.host_key': { kind: 'choice' } },
  },
  {
    name: 'time_slot with operations',
    setup: setup('time_slot'),
    operations: appointmentOps(),
    expected: {
      'booking.location_key': { kind: 'choice', options: ['online', 'office'] },
      'booking.starts_at': STARTS_AT,
      'booking.host_key': { kind: 'choice', options: ['sato', 'tanaka'] },
    },
  },
  {
    name: 'service without operations',
    setup: setup('service'),
    operations: null,
    expected: { 'booking.location_key': LOCATION, 'booking.starts_at': STARTS_AT, 'booking.service_key': { kind: 'choice' }, 'booking.variant_key': { kind: 'choice' } },
  },
  {
    name: 'service with operations: variant keys across services, deduplicated',
    setup: setup('service'),
    operations: serviceOps({
      services: [
        ...serviceOps().services,
        { key: 'perm', label: 'パーマ', durationMinutes: 120, variants: [{ key: 'long', label: 'ロング', durationMinutes: 150 }, { key: 'root', label: '根元', durationMinutes: 90 }], requirements: [{ resourceKeys: ['yamada'], count: 1 }] },
      ],
    }),
    expected: {
      'booking.location_key': { kind: 'choice', options: ['salon'] },
      'booking.starts_at': STARTS_AT,
      'booking.service_key': { kind: 'choice', options: ['cut', 'color', 'perm'] },
      'booking.variant_key': { kind: 'choice', options: ['short', 'long', 'root'] },
    },
  },
  {
    name: 'party without operations',
    setup: setup('party'),
    operations: null,
    expected: { 'booking.location_key': LOCATION, 'booking.starts_at': STARTS_AT, 'booking.party_size': { kind: 'decimal' } },
  },
  {
    name: 'party with operations',
    setup: setup('party'),
    operations: partyOps(),
    expected: { 'booking.location_key': { kind: 'choice', options: ['restaurant'] }, 'booking.starts_at': STARTS_AT, 'booking.party_size': { kind: 'decimal' } },
  },
  {
    name: 'business without a presentation',
    setup: omit(setup('service'), 'presentation'),
    operations: serviceOps(),
    expected: { 'booking.location_key': { kind: 'choice', options: ['salon'] }, 'booking.starts_at': STARTS_AT },
  },
  {
    name: 'time_slot ignores a presentation',
    setup: setup('time_slot', { presentation: 'party' }),
    operations: null,
    expected: { 'booking.location_key': LOCATION, 'booking.starts_at': STARTS_AT, 'booking.host_key': { kind: 'choice' } },
  },
  {
    name: 'known operations without locations or appointment give empty options',
    setup: setup('time_slot'),
    operations: { confirmationMode: 'automatic' },
    expected: { 'booking.location_key': { kind: 'choice', options: [] }, 'booking.starts_at': STARTS_AT, 'booking.host_key': { kind: 'choice', options: [] } },
  },
];

// Public definition cases (expected values are generated and pinned) ------

export const publicMeta = {
  version: 3,
  operationsRevision: 7,
  turnstile: { siteKey: '1x00000000000000000000AA', action: 'reservation' },
  endpoints: {
    availability: 'https://book.yatris.jp/api/public/websites/42/reservations/consultation/availability',
    holds: 'https://book.yatris.jp/api/public/websites/42/reservations/consultation/holds',
    bookings: 'https://book.yatris.jp/api/public/websites/42/reservations/consultation/bookings',
    receipt: 'https://book.yatris.jp/api/public/websites/42/reservations/consultation/receipt',
  },
};

export const publicCases: { name: string; setup: Json; operations: Json; meta: Json }[] = [
  {
    name: 'policy defaults, manual approval and host choice',
    setup: setup('time_slot'),
    operations: {
      confirmationMode: 'manual',
      resources: [host('sato', '佐藤'), host('tanaka', '田中')],
      appointment: { durationMinutes: 30, hostStrategy: 'one_available', hostResourceKeys: ['tanaka', 'sato'], visitorChoosesHost: true },
    },
    meta: { ...publicMeta, turnstile: null },
  },
  {
    name: 'service practitioners only when the visitor chooses',
    setup: setup('service', { copy: { pendingMessage: '確認中です。' }, success: { redirectPath: '/salon/thanks/' } }),
    operations: serviceOps({
      services: [
        {
          key: 'head_spa',
          label: 'ヘッドスパ',
          durationMinutes: 60,
          requirements: [
            { resourceKeys: ['suzuki', 'yamada'], count: 1 },
            { resourceKeys: ['spa_room'], count: 1 },
            { resourceKeys: ['yamada'], count: 1 },
          ],
          visitorChoosesPractitioner: true,
        },
        { key: 'color', label: 'カラー', durationMinutes: 90, requirements: [{ resourceKeys: ['yamada', 'suzuki'], count: 1 }] },
      ],
    }),
    meta: publicMeta,
  },
  {
    name: 'party with a capacity pool',
    setup: setup('party'),
    operations: poolOps({ timezone: 'Asia/Tokyo', slotIntervalMinutes: 30, approvalWindowMinutes: 60 }),
    meta: publicMeta,
  },
];
