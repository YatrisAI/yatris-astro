import { checkNode } from '../forms/declaration.js';
import { checkObject, pointer, tidy, type Issue } from '../forms/spec.js';
import { dateToDays } from '../forms/temporal.js';
import { MODES, OPERATIONS, PRESENTATIONS, REFERENCE_KINDS, type ReservationMode, type ReservationPresentation, type ResourceKind } from './registry.js';
import type { HoursException, ReservationOperations, ReservationResource, ReservationResult } from './types.js';

/**
 * Validates an operations object (contract v1, README "Operations"): a
 * declaration's seed (prefix `/operations`) or a live operations revision in
 * Yatris (prefix ""). Shape first; semantics only when the shape is valid.
 * Issues are deduplicated and sorted by path, then code, exactly as forms.
 */

export interface OperationsOptions {
  mode: ReservationMode;
  /** Required for `business`; ignored for `time_slot`. Missing for `business`: mode-section checks are skipped. */
  presentation?: ReservationPresentation | null;
  /** JSON Pointer prefix for every issue path; default "". */
  pathPrefix?: string;
}

/**
 * `UTC`, or an Area/Location name with one or two location segments, each
 * segment starting with an ASCII capital. Offsets (`+09:00`), abbreviations
 * (`JST`) and single-segment legacy names (`Japan`) never match.
 */
export const TIMEZONE_PATTERN = '^(?:UTC|[A-Z][A-Za-z_]*(?:/[A-Z][A-Za-z0-9_+-]*){1,2})$';
const TIMEZONE = new RegExp(TIMEZONE_PATTERN, 'u');

/** An absolute `https://` URL: lowercase scheme, a DNS host (ASCII labels), an optional port, then printable ASCII only. */
export const HTTPS_URL_PATTERN =
  '^https://[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?(?:[/?#][\\x21-\\x7E]*)?$';
const HTTPS_URL = new RegExp(HTTPS_URL_PATTERN, 'u');

/**
 * A valid IANA zone: matches TIMEZONE_PATTERN and the runtime's time zone
 * database knows it (aliases included). PHP: the same pattern, then
 * `new DateTimeZone($tz)` must not throw.
 */
export function isValidTimezone(value: string): boolean {
  if (!TIMEZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export function isHttpsUrl(value: string): boolean {
  return HTTPS_URL.test(value);
}

export function validateOperations(value: unknown, options: OperationsOptions): ReservationResult {
  const presentation = modePresentation(options);
  const prefix = options.pathPrefix ?? '';
  if (typeof prefix !== 'string') throw new TypeError('pathPrefix must be a string.');

  const shape: Issue[] = [];
  checkObject(OPERATIONS.props, OPERATIONS.required, value, prefix, shape, checkNode);
  if (shape.length) return { valid: false, errors: tidy(shape), warnings: [] };

  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  checkOperations(value as ReservationOperations, options.mode, presentation, prefix, errors, warnings);
  const tidied = tidy(errors);
  return { valid: tidied.length === 0, errors: tidied, warnings: tidy(warnings) };
}

/** The effective presentation: null for time_slot, possibly null (unknown) for business. Throws on bad options. */
export function modePresentation(options: { mode: unknown; presentation?: unknown }): ReservationPresentation | null {
  if (!MODES.includes(options.mode as ReservationMode)) throw new TypeError(`Reservation mode must be one of ${MODES.join(', ')}.`);
  const presentation = options.presentation ?? null;
  if (presentation !== null && !PRESENTATIONS.includes(presentation as ReservationPresentation)) {
    throw new TypeError(`Reservation presentation must be one of ${PRESENTATIONS.join(', ')} or null.`);
  }
  return options.mode === 'time_slot' ? null : (presentation as ReservationPresentation | null);
}

const SECTIONS = ['appointment', 'services', 'party'] as const;

/** Semantic rules 1-11 on a shape-valid operations object. */
export function checkOperations(
  ops: ReservationOperations,
  mode: ReservationMode,
  presentation: ReservationPresentation | null,
  prefix: string,
  errors: Issue[],
  warnings: Issue[],
): void {
  const at = (...parts: (string | number)[]) => parts.reduce<string>((path, part) => pointer(path, part), prefix);
  const push = (path: string, code: string) => errors.push({ path, code });

  // 1. Timezone and slot grid.
  if (ops.timezone !== undefined && !isValidTimezone(ops.timezone)) push(at('timezone'), 'invalid_timezone');
  if (ops.slotIntervalMinutes !== undefined && 1440 % ops.slotIntervalMinutes !== 0) push(at('slotIntervalMinutes'), 'invalid_slot_interval');

  // 2. Duplicate keys, each list on its own.
  duplicateKeys(ops.locations, at('locations'), errors);
  duplicateKeys(ops.resources, at('resources'), errors);
  duplicateKeys(ops.services, at('services'), errors);
  ops.services?.forEach((service, i) => duplicateKeys(service.variants, at('services', i, 'variants'), errors));
  duplicateKeys(ops.party?.combinations, at('party', 'combinations'), errors);

  // 3-4. Hours and exceptions.
  if (ops.venueHours?.weekly) checkHours(ops.venueHours.weekly, at('venueHours', 'weekly'), errors);
  if (ops.venueHours?.exceptions) checkExceptions(ops.venueHours.exceptions, at('venueHours', 'exceptions'), errors);
  ops.resources?.forEach((resource, i) => {
    if (resource.weeklyHours) checkHours(resource.weeklyHours, at('resources', i, 'weeklyHours'), errors);
    if (resource.exceptions) checkExceptions(resource.exceptions, at('resources', i, 'exceptions'), errors);
  });

  // 5. Locations.
  ops.locations?.forEach((location, i) => {
    if (location.meetingUrl !== undefined) {
      if (location.type !== 'online') push(at('locations', i, 'meetingUrl'), 'location_field_not_allowed');
      else if (!isHttpsUrl(location.meetingUrl)) push(at('locations', i, 'meetingUrl'), 'invalid_url');
    }
    if (location.address !== undefined && location.type !== 'in_person') push(at('locations', i, 'address'), 'location_field_not_allowed');
  });

  // 6. Resources.
  ops.resources?.forEach((resource, i) => {
    if (resource.kind === 'pool' && resource.capacity === undefined) push(at('resources', i, 'capacity'), 'required_property');
    if (resource.kind !== 'pool' && resource.capacity !== undefined) push(at('resources', i, 'capacity'), 'resource_field_not_allowed');
    if (resource.kind === 'table' && resource.seats === undefined) push(at('resources', i, 'seats'), 'required_property');
    if (resource.kind !== 'table' && resource.seats !== undefined) push(at('resources', i, 'seats'), 'resource_field_not_allowed');
    if (resource.seats !== undefined && resource.seats.min > resource.seats.max) push(at('resources', i, 'seats'), 'min_exceeds_max');
  });

  // 7. Mode sections.
  const section = mode === 'time_slot' ? 'appointment' : presentation === 'service' ? 'services' : presentation === 'party' ? 'party' : null;
  if (section !== null) {
    if (ops[section] === undefined) push(at(section), 'required_property');
    for (const other of SECTIONS) if (other !== section && ops[other] !== undefined) push(at(other), 'section_not_allowed');
  }

  // 8. Resource references: the first resource with a key wins (later duplicates are rule 2 errors).
  const resources = new Map<string, ReservationResource>();
  for (const resource of ops.resources ?? []) if (!resources.has(resource.key)) resources.set(resource.key, resource);
  const reference = (key: string, path: string, kinds: readonly ResourceKind[]) => {
    const resource = resources.get(key);
    if (!resource) push(path, 'unknown_resource');
    else if (!kinds.includes(resource.kind)) push(path, 'resource_kind_mismatch');
  };

  // 9. Appointment.
  const appointment = ops.appointment;
  if (appointment) {
    appointment.hostResourceKeys.forEach((key, i) => reference(key, at('appointment', 'hostResourceKeys', i), REFERENCE_KINDS.host));
    if (appointment.hostStrategy === 'single') {
      if (appointment.hostResourceKeys.length !== 1) push(at('appointment', 'hostResourceKeys'), 'single_host_count');
      if (appointment.visitorChoosesHost === true) push(at('appointment', 'visitorChoosesHost'), 'host_choice_not_allowed');
    }
  }

  // 10. Services.
  ops.services?.forEach((service, i) => {
    service.requirements.forEach((requirement, j) => {
      requirement.resourceKeys.forEach((key, k) => reference(key, at('services', i, 'requirements', j, 'resourceKeys', k), REFERENCE_KINDS.requirement));
      if (requirement.count > requirement.resourceKeys.length) push(at('services', i, 'requirements', j, 'count'), 'count_exceeds_resources');
    });
  });

  // 11. Party.
  const party = ops.party;
  if (party) {
    if (party.minSize > party.maxSize) push(at('party'), 'min_exceeds_max');
    if (party.poolResourceKey !== undefined) reference(party.poolResourceKey, at('party', 'poolResourceKey'), REFERENCE_KINDS.pool);
    party.tableResourceKeys?.forEach((key, i) => reference(key, at('party', 'tableResourceKeys', i), REFERENCE_KINDS.table));
    if (party.strategy === 'pool') {
      if (party.poolResourceKey === undefined) push(at('party', 'poolResourceKey'), 'required_property');
      if (party.tableResourceKeys !== undefined) push(at('party', 'tableResourceKeys'), 'party_field_not_allowed');
      if (party.combinations !== undefined) push(at('party', 'combinations'), 'party_field_not_allowed');
    } else {
      if (party.tableResourceKeys === undefined) push(at('party', 'tableResourceKeys'), 'required_property');
      if (party.poolResourceKey !== undefined) push(at('party', 'poolResourceKey'), 'party_field_not_allowed');
    }
    party.combinations?.forEach((combination, i) => {
      combination.resourceKeys.forEach((key, k) => {
        const path = at('party', 'combinations', i, 'resourceKeys', k);
        reference(key, path, REFERENCE_KINDS.table);
        if (party.tableResourceKeys !== undefined && !party.tableResourceKeys.includes(key)) push(path, 'combination_table_not_listed');
      });
      if (combination.seats.min > combination.seats.max) push(at('party', 'combinations', i, 'seats'), 'min_exceeds_max');
    });
  }

  if (ops.confirmationMode === undefined) warnings.push({ path: at('confirmationMode'), code: 'confirmation_mode_missing' });
}

function duplicateKeys(items: { key: string }[] | undefined, path: string, errors: Issue[]): void {
  const seen = new Set<string>();
  items?.forEach((item, i) => {
    if (seen.has(item.key)) errors.push({ path: pointer(pointer(path, i), 'key'), code: 'duplicate_key' });
    seen.add(item.key);
  });
}

/**
 * Half-open [start, end) intervals on "HH:MM" strings, which compare
 * correctly as strings. An entry with start >= end is `invalid_interval` and
 * takes no part in overlap checks. Weekly entries overlap only on the same
 * day; exception hours (no `day`) all share one day. Touching is allowed.
 */
function checkHours(entries: { day?: string; start: string; end: string }[], path: string, errors: Issue[]): void {
  entries.forEach((entry, j) => {
    const at = pointer(path, j);
    if (entry.start >= entry.end) return void errors.push({ path: at, code: 'invalid_interval' });
    const overlaps = entries
      .slice(0, j)
      .some((other) => other.day === entry.day && other.start < other.end && other.start < entry.end && entry.start < other.end);
    if (overlaps) errors.push({ path: at, code: 'overlapping_hours' });
  });
}

function checkExceptions(exceptions: HoursException[], path: string, errors: Issue[]): void {
  const seen = new Set<string>();
  exceptions.forEach((exception, i) => {
    const at = pointer(path, i);
    if ((exception.closed === true) === (exception.hours !== undefined)) errors.push({ path: at, code: 'invalid_exception' });
    if (dateToDays(exception.date) === null) errors.push({ path: pointer(at, 'date'), code: 'invalid_date' });
    if (seen.has(exception.date)) errors.push({ path: at, code: 'duplicate_date' });
    seen.add(exception.date);
    if (exception.hours) checkHours(exception.hours, pointer(at, 'hours'), errors);
  });
}
