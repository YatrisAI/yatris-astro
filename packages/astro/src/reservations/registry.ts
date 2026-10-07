import { FORM_KEY_PATTERN, KEY, LABEL, PATH } from '../forms/registry.js';
import type { PropSpec } from '../forms/spec.js';
import { DATE_PATTERN } from '../forms/temporal.js';

/**
 * The reservation registry (contract v1): the setup declaration and the
 * operations object, described once in the forms property-spec language.
 * The same description drives the shape validator and the published JSON
 * Schema (json-schema.ts). Adding a property is a versioned contract change.
 */

export const RESERVATION_CONTRACT_VERSION = 1;

export const MODES = ['time_slot', 'business'] as const;
export type ReservationMode = (typeof MODES)[number];
export const PRESENTATIONS = ['party', 'service'] as const;
export type ReservationPresentation = (typeof PRESENTATIONS)[number];

/** Setup keys use the form key grammar. */
export const SETUP_KEY_PATTERN = FORM_KEY_PATTERN;
/** Wall-clock times in hours lists: 00:00 to 23:59, minutes only. */
export const HOURS_TIME_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9]$';
export const WEEKDAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
export const LOCATION_TYPES = ['online', 'in_person', 'phone'] as const;
export const RESOURCE_KINDS = ['host', 'practitioner', 'room', 'equipment', 'table', 'pool'] as const;
export type ResourceKind = (typeof RESOURCE_KINDS)[number];

const str = (min: number, max: number, text: 'line' | 'multiline' = 'line'): PropSpec => ({ kind: 'string', min, max, text });
const oneOf = (...values: readonly string[]): PropSpec => ({ kind: 'string', enum: values });
const int = (min: number, max: number): PropSpec => ({ kind: 'integer', min, max });
const bool: PropSpec = { kind: 'boolean' };
const object = (props: Record<string, PropSpec>, required: string[] = []): PropSpec => ({ kind: 'object', props, required });
const list = (items: PropSpec, min: number, max: number, unique = false): PropSpec => ({ kind: 'array', items, min, max, ...(unique ? { unique } : {}) });

const TIME: PropSpec = { kind: 'string', min: 1, max: 5, pattern: HOURS_TIME_PATTERN };
const DATE: PropSpec = { kind: 'string', min: 1, max: 10, pattern: DATE_PATTERN };
const KEYS = (min: number, max: number): PropSpec => list(KEY, min, max, true);
const BUFFER = int(0, 240);
const SEATS = object({ min: int(1, 500), max: int(1, 500) }, ['min', 'max']);
const DURATION = int(5, 480);

const HOURS = list(object({ day: oneOf(...WEEKDAYS), start: TIME, end: TIME }, ['day', 'start', 'end']), 0, 50);
const EXCEPTIONS = list(
  object({ date: DATE, closed: bool, hours: list(object({ start: TIME, end: TIME }, ['start', 'end']), 1, 10) }, ['date']),
  0,
  366,
);

/** The operations object: a declaration's seed and the shape of a live operations revision in Yatris. */
export const OPERATIONS: { props: Record<string, PropSpec>; required: readonly string[] } = {
  props: {
    timezone: { kind: 'string', min: 1, max: 64 },
    slotIntervalMinutes: int(5, 120),
    bookingHorizonDays: int(1, 365),
    minimumLeadMinutes: int(0, 43200),
    holdMinutes: int(1, 30),
    confirmationMode: oneOf('automatic', 'manual'),
    approvalWindowMinutes: int(15, 10080),
    cancelCutoffMinutes: int(0, 43200),
    rescheduleCutoffMinutes: int(0, 43200),
    reminderMinutesBefore: int(60, 10080),
    venueHours: object({ weekly: HOURS, exceptions: EXCEPTIONS }),
    locations: list(
      object(
        {
          key: KEY,
          type: oneOf(...LOCATION_TYPES),
          label: LABEL,
          meetingUrl: { kind: 'string', min: 1, max: 2000 },
          address: str(1, 500, 'multiline'),
          instructions: str(1, 1000, 'multiline'),
        },
        ['key', 'type', 'label'],
      ),
      1,
      10,
    ),
    resources: list(
      object(
        {
          key: KEY,
          kind: oneOf(...RESOURCE_KINDS),
          label: LABEL,
          capacity: int(1, 10000),
          seats: SEATS,
          weeklyHours: HOURS,
          exceptions: EXCEPTIONS,
        },
        ['key', 'kind', 'label'],
      ),
      0,
      200,
    ),
    appointment: object(
      {
        durationMinutes: DURATION,
        bufferBeforeMinutes: BUFFER,
        bufferAfterMinutes: BUFFER,
        hostStrategy: oneOf('single', 'one_available'),
        hostResourceKeys: KEYS(1, 50),
        visitorChoosesHost: bool,
      },
      ['durationMinutes', 'hostStrategy', 'hostResourceKeys'],
    ),
    services: list(
      object(
        {
          key: KEY,
          label: LABEL,
          durationMinutes: DURATION,
          bufferBeforeMinutes: BUFFER,
          bufferAfterMinutes: BUFFER,
          variants: list(object({ key: KEY, label: LABEL, durationMinutes: DURATION }, ['key', 'label', 'durationMinutes']), 1, 20),
          requirements: list(object({ resourceKeys: KEYS(1, 50), count: int(1, 5) }, ['resourceKeys', 'count']), 1, 5),
          visitorChoosesPractitioner: bool,
        },
        ['key', 'label', 'durationMinutes', 'requirements'],
      ),
      1,
      100,
    ),
    party: object(
      {
        minSize: int(1, 500),
        maxSize: int(1, 500),
        durationMinutes: int(15, 720),
        bufferAfterMinutes: BUFFER,
        strategy: oneOf('pool', 'tables'),
        poolResourceKey: KEY,
        tableResourceKeys: KEYS(1, 200),
        combinations: list(object({ key: KEY, resourceKeys: KEYS(2, 4), seats: SEATS }, ['key', 'resourceKeys', 'seats']), 0, 100),
      },
      ['minSize', 'maxSize', 'durationMinutes', 'strategy'],
    ),
  },
  required: [],
};

/** Top-level setup declaration properties (`src/reservations/<key>.json`). */
export const SETUP: { props: Record<string, PropSpec>; required: readonly string[] } = {
  props: {
    $schema: { kind: 'string', min: 1, max: 500 },
    contractVersion: int(RESERVATION_CONTRACT_VERSION, RESERVATION_CONTRACT_VERSION),
    key: { kind: 'string', min: 1, max: 64, pattern: SETUP_KEY_PATTERN },
    name: LABEL,
    locale: oneOf('ja'),
    mode: oneOf(...MODES),
    presentation: oneOf(...PRESENTATIONS),
    identityFields: object({ name: KEY, email: KEY, phone: KEY }, ['name', 'email']),
    questions: { kind: 'nodes', min: 1, max: 200 },
    copy: object({ pendingMessage: str(1, 2000, 'multiline'), confirmedMessage: str(1, 2000, 'multiline') }),
    success: object({ redirectPath: PATH }, ['redirectPath']),
    operations: { kind: 'object', props: OPERATIONS.props, required: OPERATIONS.required },
  },
  required: ['contractVersion', 'key', 'name', 'locale', 'mode', 'identityFields', 'questions'],
};

/** Policy values a public definition shows when the operations omit them. */
export const DEFAULT_POLICIES = {
  timezone: 'Asia/Tokyo',
  slotIntervalMinutes: 15,
  bookingHorizonDays: 90,
  minimumLeadMinutes: 120,
  holdMinutes: 5,
  approvalWindowMinutes: 1440,
  cancelCutoffMinutes: 1440,
  rescheduleCutoffMinutes: 1440,
} as const;

/** Resource kinds each reference accepts (README "Operations semantics", rule 8). */
export const REFERENCE_KINDS = {
  host: ['host'],
  requirement: ['practitioner', 'room', 'equipment'],
  pool: ['pool'],
  table: ['table'],
} as const satisfies Record<string, readonly ResourceKind[]>;
