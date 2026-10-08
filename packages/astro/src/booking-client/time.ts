/**
 * Time-zone arithmetic for the booking UI, on `Intl` only. Instants are epoch
 * milliseconds; venue-local dates are `YYYY-MM-DD` strings. Display changes
 * never alter an instant: the UI always sends the server's own slot strings.
 */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zoned(ms: number, timeZone: string): ZonedParts {
  const parts: Record<string, number> = {};
  for (const part of formatter(timeZone).formatToParts(new Date(ms))) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return { year: parts.year!, month: parts.month!, day: parts.day!, hour: parts.hour! % 24, minute: parts.minute!, second: parts.second! };
}

const pad = (n: number, width = 2) => String(n).padStart(width, '0');

/** `YYYY-MM-DD` of an instant in a zone. */
export function localDate(ms: number, timeZone: string): string {
  const p = zoned(ms, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** `YYYY-MM-DDTHH:MM:SS` of an instant in a zone (the `booking.starts_at` context value). */
export function localDateTime(ms: number, timeZone: string): string {
  const p = zoned(ms, timeZone);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`;
}

/** The zone's UTC offset at an instant, in minutes. */
export function offsetMinutes(ms: number, timeZone: string): number {
  const p = zoned(ms, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

/** ISO 8601 with the zone's offset: `2026-11-02T10:00:00+09:00`. */
export function isoWithOffset(ms: number, timeZone: string): string {
  const offset = offsetMinutes(ms, timeZone);
  const sign = offset < 0 ? '-' : '+';
  const abs = Math.abs(offset);
  return `${localDateTime(ms, timeZone)}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/**
 * The instant of a venue-local wall-clock time, or null when it does not
 * exist (a daylight-saving gap). In a repeated hour the earlier instant wins.
 */
export function zonedToInstant(date: string, time: string, timeZone: string): number | null {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const [hh, mm] = time.split(':').map(Number) as [number, number];
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const target = `${date}T${time}:00`;
  const candidates = new Set<number>();
  for (const probe of [wall - 864e5 / 2, wall, wall + 864e5 / 2]) candidates.add(wall - offsetMinutes(probe, timeZone) * 60000);
  const matches = [...candidates].filter((t) => localDateTime(t, timeZone) === target).sort((a, b) => a - b);
  return matches[0] ?? null;
}

/** Days since the epoch of a `YYYY-MM-DD` date. */
function dayNumber(date: string): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 864e5;
}

export function addDays(date: string, days: number): string {
  const t = new Date((dayNumber(date) + days) * 864e5);
  return `${pad(t.getUTCFullYear(), 4)}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

export const WEEKDAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const;
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

export function weekdayOf(date: string): (typeof WEEKDAY_NAMES)[number] {
  return WEEKDAY_NAMES[new Date(dayNumber(date) * 864e5).getUTCDay()]!;
}

/** `11月2日（月）` */
export function formatDateLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${m}月${d}日（${WEEKDAY_JA[new Date(dayNumber(date) * 864e5).getUTCDay()]}）`;
}

/** `2026年11月2日（月）` */
export function formatFullDate(date: string): string {
  return `${Number(date.slice(0, 4))}年${formatDateLabel(date)}`;
}

/** `10:00` in a zone. */
export function formatTime(ms: number, timeZone: string): string {
  const p = zoned(ms, timeZone);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

/** `2026年11月2日（月）10:00` in a zone. */
export function formatDateTime(ms: number, timeZone: string): string {
  return `${formatFullDate(localDate(ms, timeZone))} ${formatTime(ms, timeZone)}`;
}

/** A Japanese name for a zone: `日本時間（Asia/Tokyo）`. */
export function timeZoneLabel(timeZone: string): string {
  if (timeZone === 'Asia/Tokyo') return '日本時間（Asia/Tokyo）';
  try {
    const name = new Intl.DateTimeFormat('ja-JP', { timeZone, timeZoneName: 'long' }).formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value;
    return name ? `${name}（${timeZone}）` : timeZone;
  } catch {
    return timeZone;
  }
}

/** The browser's zone, or null when it cannot be determined. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

export function isTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}
