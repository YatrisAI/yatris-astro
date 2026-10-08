import { flatten } from '../forms/tree.js';
import { RESERVATION_API_ERRORS } from '../reservations/messages.js';
import type { ReservationPublicDefinition } from '../reservations/public.js';
import type { HoursEntry } from '../reservations/types.js';
import { durationOf, flowOf, selectionProblem, serviceOf } from './flow.js';
import { addDays, daysBetween, isoWithOffset, localDate, weekdayOf, zonedToInstant } from './time.js';
import type { AcceptedResponse, ApiResult, AvailabilityResponse, BookingApi, PreviewBookingConfig, Selection, Slot } from './types.js';
import { UI } from './ui.js';

/**
 * The synthetic booking API of a preview mount. It answers from the local
 * declaration and a synthetic opening-hours pattern, in the browser, and
 * never calls `fetch`: no hold, booking or mail ever leaves the page. It
 * judges selections as the server does (`validation_failed` with
 * `invalid_selection`), and never shows sensitive answers in its log.
 */

/** Used when the declaration seeds no hours: weekdays 10:00–12:00 and 13:00–17:00. */
export const SYNTHETIC_WEEKLY_HOURS: HoursEntry[] = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).flatMap((day) => [
  { day, start: '10:00', end: '12:00' },
  { day, start: '13:00', end: '17:00' },
]);

export interface PreviewApi extends BookingApi {
  /** What a live mount would have sent, newest last (holds and bookings), sensitive answers redacted. */
  readonly sent: Record<string, unknown>[];
}

/** A small deterministic hash, so the same slots look "taken" (or nearly so) on every load. */
function hash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return h >>> 0;
}
const taken = (key: string) => hash(key) % 4 === 0;
const few = (key: string) => hash(`few|${key}`) % 5 === 0;

/** Whether the synthetic venue is closed on a venue-local date (no opening ranges). */
export function syntheticClosed(config: PreviewBookingConfig, date: string): boolean {
  const exception = config.synthetic?.exceptions?.find((e) => e.date === date);
  if (exception) return exception.closed === true || !exception.hours?.length;
  const weekly = config.synthetic?.weeklyHours?.length ? config.synthetic.weeklyHours : SYNTHETIC_WEEKLY_HOURS;
  return !weekly.some((h) => h.day === weekdayOf(date));
}

/**
 * Synthetic slots of one venue-local date for a selection: on the slot grid,
 * inside the opening ranges (a slot's whole duration fits its range, so a
 * long dinner never runs past closing), after the lead time and within the
 * horizon, with some shown as taken. Taken slots depend on the selection, as
 * they would for different practitioners or party sizes.
 */
export function syntheticSlots(definition: ReservationPublicDefinition, config: PreviewBookingConfig, date: string, now: number, selection: Selection = {}): Slot[] {
  const { timezone, slotIntervalMinutes, minimumLeadMinutes, bookingHorizonDays } = definition.policies;
  const duration = durationOf(definition, selection) ?? definition.appointment?.durationMinutes ?? 30;
  const today = localDate(now, timezone);
  if (daysBetween(today, date) < 0 || daysBetween(today, date) > bookingHorizonDays) return [];
  const exception = config.synthetic?.exceptions?.find((e) => e.date === date);
  if (exception?.closed) return [];
  const weekly = config.synthetic?.weeklyHours?.length ? config.synthetic.weeklyHours : SYNTHETIC_WEEKLY_HOURS;
  const ranges = exception?.hours ?? weekly.filter((h) => h.day === weekdayOf(date));
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const flavour = [selection.serviceKey, selection.variantKey, selection.practitionerKey, selection.partySize].filter((v) => v !== undefined).join('|');
  const slots: Slot[] = [];
  for (const range of ranges) {
    const end = minutes(range.end);
    for (let m = Math.ceil(minutes(range.start) / slotIntervalMinutes) * slotIntervalMinutes; m + duration <= end; m += slotIntervalMinutes) {
      const start = zonedToInstant(date, hhmm(m), timezone);
      const key = `${date}T${hhmm(m)}${flavour ? `|${flavour}` : ''}`;
      if (start === null || start < now + minimumLeadMinutes * 60000 || taken(key)) continue;
      slots.push({ start: isoWithOffset(start, timezone), end: isoWithOffset(start + duration * 60000, timezone), ...(few(key) ? { few: true } : {}) });
    }
  }
  return slots.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

/** The keys of the definition's questions marked `sensitive: true`. */
export function sensitiveKeys(definition: Pick<ReservationPublicDefinition, 'questions'>): Set<string> {
  return new Set(
    flatten(definition.questions)
      .filter((e) => e.node.sensitive === true)
      .map((e) => e.node.key),
  );
}

/** The `bookings` request as the preview log shows it: sensitive answers and their files replaced. */
export function redactedBooking(body: FormData, sensitive: Set<string>): Record<string, unknown> {
  const entry: Record<string, unknown> = { request: 'bookings' };
  for (const [name, value] of body.entries()) {
    const file = /^files\[([^\]]+)\]\[\]$/.exec(name);
    if (file && sensitive.has(file[1]!)) entry[name] = UI.previewSensitive;
    else if (name === 'answers' && typeof value === 'string') {
      try {
        const answers = JSON.parse(value) as Record<string, unknown>;
        for (const key of Object.keys(answers)) if (sensitive.has(key)) answers[key] = UI.previewSensitive;
        entry[name] = JSON.stringify(answers);
      } catch {
        entry[name] = UI.previewSensitive;
      }
    } else entry[name] = typeof value === 'string' ? value : `${value.name} (${value.size} bytes)`;
  }
  return entry;
}

export function previewApi(config: PreviewBookingConfig, now: () => number, onSent?: (entry: Record<string, unknown>) => void): PreviewApi {
  const definition = config.definition!;
  const sensitive = sensitiveKeys(definition);
  const sent: Record<string, unknown>[] = [];
  let holds = 0;
  const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
  const reject = <T>(code: keyof typeof RESERVATION_API_ERRORS, extra: Record<string, unknown> = {}): ApiResult<T> => ({
    ok: false,
    code,
    status: RESERVATION_API_ERRORS[code].status[0],
    data: { status: 'rejected', code, message: RESERVATION_API_ERRORS[code].message, ...extra },
    retryAfter: null,
  });
  const invalidSelection = <T>(): ApiResult<T> => reject('validation_failed', { fieldErrors: {}, formErrors: ['invalid_selection'] });
  const record = (entry: Record<string, unknown>) => {
    sent.push(entry);
    onSent?.(entry);
    console.info('[yatris reservations preview] not sent:', entry);
  };

  return {
    sent,
    definition: async () => ok(definition),
    async availability({ from, to, selection }) {
      if (selectionProblem(definition, selection)) return invalidSelection();
      const days: AvailabilityResponse['days'] = [];
      for (let date = from; daysBetween(date, to) >= 0; date = addDays(date, 1)) days.push({ date, slots: syntheticSlots(definition, config, date, now(), selection), closed: syntheticClosed(config, date) });
      return ok({ timezone: definition.policies.timezone, operationsRevision: definition.setup.operationsRevision, days });
    },
    async hold({ selection, start, replaceHoldToken }) {
      record({ request: 'holds', selection, start, ...(replaceHoldToken ? { replaceHoldToken } : {}) });
      if (selectionProblem(definition, selection)) return invalidSelection();
      const date = localDate(Date.parse(start), definition.policies.timezone);
      const slot = syntheticSlots(definition, config, date, now(), selection).find((s) => Date.parse(s.start) === Date.parse(start));
      if (!slot) return reject('slot_unavailable');
      const flow = flowOf(definition);
      const appointment = definition.appointment;
      const host = flow === 'time_slot' && appointment?.visitorChoosesHost ? (appointment.hosts.find((h) => h.key === selection.hostKey) ?? appointment.hosts[0]) : undefined;
      // "No preference": the synthetic server assigns the first eligible practitioner.
      const service = flow === 'service' ? serviceOf(definition, selection) : null;
      const practitioner = service?.visitorChoosesPractitioner ? (service.practitioners.find((p) => p.key === selection.practitionerKey) ?? service.practitioners[0]) : undefined;
      holds += 1;
      return ok({
        holdToken: `preview-hold-${holds}`,
        expiresAt: isoWithOffset(now() + definition.policies.holdMinutes * 60000, definition.policies.timezone),
        start: slot.start,
        end: slot.end,
        ...(host ? { hostLabel: host.label } : {}),
        ...(practitioner ? { practitionerLabel: practitioner.label } : {}),
      });
    },
    async book(body) {
      record(redactedBooking(body, sensitive));
      const manual = definition.policies.confirmationMode === 'manual';
      const state = manual ? 'pending_approval' : 'confirmed';
      const message = (manual ? definition.copy.pendingMessage : definition.copy.confirmedMessage) ?? (manual ? UI.defaultPendingMessage : UI.defaultConfirmedMessage);
      const accepted: AcceptedResponse = {
        status: 'accepted',
        receipt: 'preview',
        state,
        ...(manual ? { approvalDeadline: isoWithOffset(now() + (definition.policies.approvalWindowMinutes ?? 1440) * 60000, definition.policies.timezone) } : {}),
        success: definition.success ? { mode: 'redirect', path: definition.success.redirectPath } : { mode: 'message', message },
      };
      return ok(accepted);
    },
    receipt: async () => reject('temporarily_unavailable'),
  };
}
