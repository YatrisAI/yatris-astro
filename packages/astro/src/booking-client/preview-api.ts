import { RESERVATION_API_ERRORS } from '../reservations/messages.js';
import type { ReservationPublicDefinition } from '../reservations/public.js';
import type { HoursEntry } from '../reservations/types.js';
import { addDays, daysBetween, isoWithOffset, localDate, weekdayOf, zonedToInstant } from './time.js';
import type { AcceptedResponse, ApiResult, AvailabilityResponse, BookingApi, PreviewBookingConfig, Slot } from './types.js';
import { UI } from './ui.js';

/**
 * The synthetic booking API of a preview mount. It answers from the local
 * declaration and a synthetic opening-hours pattern, in the browser, and
 * never calls `fetch`: no hold, booking or mail ever leaves the page.
 */

/** Used when the declaration seeds no hours: weekdays 10:00–12:00 and 13:00–17:00. */
export const SYNTHETIC_WEEKLY_HOURS: HoursEntry[] = (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).flatMap((day) => [
  { day, start: '10:00', end: '12:00' },
  { day, start: '13:00', end: '17:00' },
]);

export interface PreviewApi extends BookingApi {
  /** What a live mount would have sent, newest last (holds and bookings). */
  readonly sent: Record<string, unknown>[];
}

/** A small deterministic hash, so the same slots look "taken" on every load. */
function taken(key: string): boolean {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
  return (h >>> 0) % 4 === 0;
}

export function syntheticSlots(definition: ReservationPublicDefinition, config: PreviewBookingConfig, date: string, now: number): Slot[] {
  const { timezone, slotIntervalMinutes, minimumLeadMinutes, bookingHorizonDays } = definition.policies;
  const duration = definition.appointment?.durationMinutes ?? 30;
  const today = localDate(now, timezone);
  if (daysBetween(today, date) < 0 || daysBetween(today, date) > bookingHorizonDays) return [];
  const exception = config.synthetic?.exceptions?.find((e) => e.date === date);
  if (exception?.closed) return [];
  const weekly = config.synthetic?.weeklyHours?.length ? config.synthetic.weeklyHours : SYNTHETIC_WEEKLY_HOURS;
  const ranges = exception?.hours ?? weekly.filter((h) => h.day === weekdayOf(date));
  const minutes = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
  const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const slots: Slot[] = [];
  for (const range of ranges) {
    const end = minutes(range.end);
    for (let m = Math.ceil(minutes(range.start) / slotIntervalMinutes) * slotIntervalMinutes; m + duration <= end; m += slotIntervalMinutes) {
      const start = zonedToInstant(date, hhmm(m), timezone);
      if (start === null || start < now + minimumLeadMinutes * 60000 || taken(`${date}T${hhmm(m)}`)) continue;
      slots.push({ start: isoWithOffset(start, timezone), end: isoWithOffset(start + duration * 60000, timezone) });
    }
  }
  return slots.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

export function previewApi(config: PreviewBookingConfig, now: () => number, onSent?: (entry: Record<string, unknown>) => void): PreviewApi {
  const definition = config.definition!;
  const sent: Record<string, unknown>[] = [];
  let holds = 0;
  const ok = <T>(data: T): ApiResult<T> => ({ ok: true, data });
  const reject = <T>(code: keyof typeof RESERVATION_API_ERRORS): ApiResult<T> => ({
    ok: false,
    code,
    status: RESERVATION_API_ERRORS[code].status[0],
    data: { status: 'rejected', code, message: RESERVATION_API_ERRORS[code].message },
    retryAfter: null,
  });
  const record = (entry: Record<string, unknown>) => {
    sent.push(entry);
    onSent?.(entry);
    console.info('[yatris reservations preview] not sent:', entry);
  };

  return {
    sent,
    definition: async () => ok(definition),
    async availability({ from, to }) {
      const days: AvailabilityResponse['days'] = [];
      for (let date = from; daysBetween(date, to) >= 0; date = addDays(date, 1)) days.push({ date, slots: syntheticSlots(definition, config, date, now()) });
      return ok({ timezone: definition.policies.timezone, operationsRevision: definition.setup.operationsRevision, days });
    },
    async hold({ selection, start, replaceHoldToken }) {
      record({ request: 'holds', selection, start, ...(replaceHoldToken ? { replaceHoldToken } : {}) });
      const date = localDate(Date.parse(start), definition.policies.timezone);
      const slot = syntheticSlots(definition, config, date, now()).find((s) => Date.parse(s.start) === Date.parse(start));
      if (!slot) return reject('slot_unavailable');
      const appointment = definition.appointment;
      const host = appointment?.visitorChoosesHost ? (appointment.hosts.find((h) => h.key === selection.hostKey) ?? appointment.hosts[0]) : undefined;
      holds += 1;
      return ok({
        holdToken: `preview-hold-${holds}`,
        expiresAt: isoWithOffset(now() + definition.policies.holdMinutes * 60000, definition.policies.timezone),
        start: slot.start,
        end: slot.end,
        ...(host ? { hostLabel: host.label } : {}),
      });
    },
    async book(body) {
      const entry: Record<string, unknown> = { request: 'bookings' };
      for (const [name, value] of body.entries()) entry[name] = typeof value === 'string' ? value : `${value.name} (${value.size} bytes)`;
      record(entry);
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
