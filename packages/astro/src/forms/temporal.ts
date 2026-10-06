/**
 * Date, time and local date-time values. Dates are calendar dates with no
 * time zone; a date-time is wall-clock time in the Website's time zone and
 * carries no offset on the wire.
 */

export const DATE_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}$';
export const TIME_PATTERN = '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$';
export const DATETIME_PATTERN = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$';

const DATE = new RegExp(DATE_PATTERN);
const TIME = new RegExp(TIME_PATTERN);
const DATETIME = new RegExp(DATETIME_PATTERN);

/** Days since 1970-01-01 for a valid calendar date, or null. */
export function dateToDays(value: string): number | null {
  if (!DATE.test(value)) return null;
  const [y, m, d] = value.split('-').map(Number) as [number, number, number];
  if (y < 1 || m < 1 || m > 12 || d < 1) return null;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1]!;
  if (d > dim) return null;
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return Math.round(t.getTime() / 86_400_000);
}

/** Seconds since midnight, or null. */
export function timeToSeconds(value: string): number | null {
  if (!TIME.test(value)) return null;
  const [h, m, s = 0] = value.split(':').map(Number) as [number, number, number?];
  return h * 3600 + m * 60 + s;
}

/** "HH:MM" when the seconds are zero, otherwise "HH:MM:SS". */
export function canonicalTime(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return s === 0 ? `${pad(h)}:${pad(m)}` : `${pad(h)}:${pad(m)}:${pad(s)}`;
}

/** Seconds since 1970-01-01T00:00 of the wall-clock value, ignoring zones. */
export function datetimeToSeconds(value: string): number | null {
  if (!DATETIME.test(value)) return null;
  const [date, time] = value.split('T') as [string, string];
  const days = dateToDays(date);
  const secs = timeToSeconds(time);
  return days === null || secs === null ? null : days * 86_400 + secs;
}

export function canonicalDatetime(value: string): string {
  const [date, time] = value.split('T') as [string, string];
  return `${date}T${canonicalTime(timeToSeconds(time)!)}`;
}

/** Offset (seconds east of UTC) of a zone at a UTC instant. */
function offsetAt(utcSeconds: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(utcSeconds * 1000));
  const get = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const t = new Date(0);
  t.setUTCFullYear(get('year'), get('month') - 1, get('day'));
  t.setUTCHours(get('hour'), get('minute'), get('second'));
  return Math.round(t.getTime() / 1000) - utcSeconds;
}

/**
 * Whether a wall-clock time exists once, never (spring-forward gap) or twice
 * (fall-back overlap) in the zone. Asia/Tokyo has no transitions, so every
 * valid value is "unique" there.
 */
export function wallClockStatus(wallSeconds: number, timeZone: string): 'unique' | 'nonexistent' | 'ambiguous' {
  const candidates = new Set([offsetAt(wallSeconds - 86_400, timeZone), offsetAt(wallSeconds + 86_400, timeZone)]);
  let matches = 0;
  for (const offset of candidates) {
    if (offsetAt(wallSeconds - offset, timeZone) === offset) matches++;
  }
  return matches === 0 ? 'nonexistent' : matches > 1 ? 'ambiguous' : 'unique';
}
