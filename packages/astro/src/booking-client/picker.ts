import { h } from '../forms-client/dom.js';
import { icon } from './icons.js';
import { formatDateLabel, formatTime, localDate, weekdayOf, zoned } from './time.js';
import type { AvailabilityDay, Slot } from './types.js';
import { UI } from './ui.js';

/**
 * The slot pickers of the select step, as pure DOM builders: the week grid
 * (appointments and services, TimeRex-style), its compact day strip + slot
 * list for narrow frames, and the restaurant 空席表 (party). The controller
 * owns paging, fetching and holds; these only draw a page and report the
 * chosen slot. Every slot button is `.yb-time` with the server's own
 * `start` string in `data-yb-start`.
 */

/** Date, time, range, zone and party-size tokens that must never break inside. */
const TOKEN = /(?:\d{4}年)?\d{1,2}月\d{1,2}日（.）|\d{1,2}:\d{2}(?:〜\d{1,2}:\d{2})?|[^\s（]*時間（[A-Za-z_/+-]+）|\d+名(?:以上)?|\d+分\d{2}秒|（[^）]{1,8}）/gu;

/**
 * Text as nodes, with every date, time, zone and 「○名」 token in a
 * `.yb-nw` (nowrap) span, so Japanese text breaks between tokens and never
 * inside 「10月9日（金）」 or 「14:00〜14:30」. textContent is unchanged.
 */
export function tokens(text: string): (Node | string)[] {
  const out: (Node | string)[] = [];
  let last = 0;
  for (const match of text.matchAll(TOKEN)) {
    if (match.index! > last) out.push(text.slice(last, match.index));
    out.push(h('span', { class: 'yb-nw' }, match[0]));
    last = match.index! + match[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];
const WEEKDAY_INDEX: Record<string, number> = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };

/** A slot placed in the display zone. */
export interface PlacedSlot {
  slot: Slot;
  start: number;
  end: number;
  /** The display-zone date it starts on. */
  date: string;
  /** Minutes after midnight in the display zone. */
  minute: number;
  few: boolean;
}

/** The slots of the cached venue days, grouped by their display-zone date and ordered by start. */
export function placeSlots(days: Iterable<AvailabilityDay>, zone: string): Map<string, PlacedSlot[]> {
  const out = new Map<string, PlacedSlot[]>();
  for (const day of days) {
    for (const slot of day.slots) {
      const start = Date.parse(slot.start);
      const end = Date.parse(slot.end);
      if (Number.isNaN(start) || Number.isNaN(end)) continue;
      const parts = zoned(start, zone);
      const date = localDate(start, zone);
      const placed: PlacedSlot = { slot, start, end, date, minute: parts.hour * 60 + parts.minute, few: slot.few === true };
      const list = out.get(date);
      if (list) list.push(placed);
      else out.set(date, [placed]);
    }
  }
  for (const list of out.values()) list.sort((a, b) => a.start - b.start);
  return out;
}

const weekday = (date: string) => WEEKDAY_INDEX[weekdayOf(date)]!;
const dayNumber = (date: string) => String(Number(date.slice(8, 10)));
/** `sat` / `sun` for the weekend colours, else undefined. */
const weekend = (date: string) => (weekday(date) === 6 ? 'sat' : weekday(date) === 0 ? 'sun' : undefined);

function slotButton(slot: PlacedSlot, zone: string, held: boolean, onChoose: (slot: Slot) => void, className: string): HTMLButtonElement {
  const start = formatTime(slot.start, zone);
  const end = formatTime(slot.end, zone);
  const button = h(
    'button',
    { type: 'button', class: `yb-time ${className}`, 'data-yb-start': slot.slot.start, 'aria-pressed': String(held), 'aria-label': UI.slotLabel(formatDateLabel(slot.date), start, end) },
    h('span', { class: 'yb-slot-start' }, start),
    h('span', { class: 'yb-slot-sep' }, '-'),
    h('span', { class: 'yb-slot-end' }, end),
  );
  button.addEventListener('click', () => onChoose(slot.slot));
  return button;
}

// Keyboard ---------------------------------------------------------------

export interface RoveItem {
  el: HTMLElement;
  /** The day column. */
  col: number;
  /** The position in the column (minutes or a row index). */
  row: number;
}

/**
 * One tab stop for a set of slot buttons (roving tabindex): Tab enters at the
 * held slot or the first one; ↑/↓ move within the day, ←/→ to the nearest
 * time of the previous or next day with slots, Home/End to the day's first
 * and last.
 */
export function roving(items: RoveItem[], current?: Element | null): void {
  if (!items.length) return;
  const initial = items.find((i) => i.el === current) ?? items[0]!;
  for (const item of items) {
    item.el.tabIndex = item === initial ? 0 : -1;
    item.el.addEventListener('focus', () => {
      for (const other of items) other.el.tabIndex = other === item ? 0 : -1;
    });
    item.el.addEventListener('keydown', (event) => {
      const target = move(items, item, (event as KeyboardEvent).key);
      if (!target) return;
      event.preventDefault();
      target.el.focus();
    });
  }
}

function move(items: RoveItem[], from: RoveItem, key: string): RoveItem | undefined {
  const column = items.filter((i) => i.col === from.col).sort((a, b) => a.row - b.row);
  switch (key) {
    case 'ArrowUp':
      return [...column].reverse().find((i) => i.row < from.row);
    case 'ArrowDown':
      return column.find((i) => i.row > from.row);
    case 'Home':
      return column[0] === from ? undefined : column[0];
    case 'End':
      return column.at(-1) === from ? undefined : column.at(-1);
    case 'ArrowLeft':
    case 'ArrowRight': {
      const dir = key === 'ArrowLeft' ? -1 : 1;
      const cols = [...new Set(items.map((i) => i.col))].filter((c) => (dir < 0 ? c < from.col : c > from.col)).sort((a, b) => dir * (a - b));
      if (cols[0] === undefined) return undefined;
      return items.filter((i) => i.col === cols[0]).reduce((best, i) => (Math.abs(i.row - from.row) < Math.abs(best.row - from.row) ? i : best));
    }
    default:
      return undefined;
  }
}

// Week grid ----------------------------------------------------------------

export interface WeekGridInput {
  dates: string[];
  today: string;
  zone: string;
  placed: Map<string, PlacedSlot[]>;
  heldStart: number | null;
  /** The minutes one slot row stands for (the slot interval, 15–60). */
  rowMinutes: number;
  onChoose: (slot: Slot) => void;
  /** Drawn instead of the hours when the page has no slot. */
  empty: HTMLElement;
}

/** Half an hour of air above the first slot and below the last. */
const GRID_PAD_MINUTES = 30;

/**
 * Days as columns, hours labelled on both sides, each slot a filled button
 * at its time. Only the hours the page's slots use are drawn (padded), and
 * an empty day is visibly empty.
 */
export function weekGrid(input: WeekGridInput): HTMLElement {
  const { dates, zone, rowMinutes } = input;
  const columns = dates.map((date) => input.placed.get(date) ?? []);
  const head = h(
    'div',
    { class: 'yb-week-head', 'aria-hidden': 'true' },
    h('span', { class: 'yb-week-corner' }),
    ...dates.map((date, i) =>
      h(
        'span',
        { class: 'yb-day-head', 'data-yb-weekend': weekend(date), 'data-yb-today': date === input.today ? 'true' : undefined, 'data-yb-empty': columns[i]!.length ? undefined : 'true' },
        h('span', { class: 'yb-day-num' }, dayNumber(date)),
        h('span', { class: 'yb-day-wd' }, WEEKDAY_JA[weekday(date)]!),
      ),
    ),
    h('span', { class: 'yb-week-corner' }),
  );
  const all = columns.flat();
  // Rows under half an hour (a 15-minute grid) are drawn a little shorter.
  const grid = h('div', { class: 'yb-week', 'data-yb-dense': rowMinutes < 30 ? 'true' : undefined });
  grid.style.setProperty('--yb-days', String(dates.length));
  if (!all.length) {
    grid.append(head, h('div', { class: 'yb-week-empty' }, input.empty));
    return grid;
  }

  const first = Math.min(...all.map((s) => s.minute));
  const last = Math.max(...all.map((s) => s.minute + rowMinutes));
  const rangeStart = Math.max(0, Math.floor(first / 60) * 60 - GRID_PAD_MINUTES);
  const rangeEnd = Math.min(1440, Math.ceil(last / 60) * 60 + GRID_PAD_MINUTES);
  const at = (el: HTMLElement, minute: number) => {
    el.style.setProperty('--yb-at', String(minute - rangeStart));
    return el;
  };

  const body = h('div', { class: 'yb-week-body' });
  body.style.setProperty('--yb-minutes', String(rangeEnd - rangeStart));
  body.style.setProperty('--yb-row-minutes', String(rowMinutes));
  const hours = (side: string) => {
    const box = h('div', { class: `yb-hours yb-hours-${side}`, 'aria-hidden': 'true' });
    for (let m = Math.ceil((rangeStart + 1) / 60) * 60; m < rangeEnd; m += 60) box.append(at(h('span', { class: 'yb-hour' }, `${String(m / 60).padStart(2, '0')}:00`), m));
    return box;
  };
  const lines = h('div', { class: 'yb-week-lines', 'aria-hidden': 'true' });
  for (let m = Math.ceil(rangeStart / 30) * 30; m <= rangeEnd; m += 30) lines.append(at(h('span', { class: m % 60 === 0 ? 'yb-line yb-line-hour' : 'yb-line' }), m));

  const items: RoveItem[] = [];
  let held: HTMLElement | null = null;
  body.append(hours('start'), lines);
  dates.forEach((date, col) => {
    const slots = columns[col]!;
    const list = h('ul', { class: 'yb-day-slots' });
    for (const slot of slots) {
      const isHeld = input.heldStart === slot.start;
      const button = at(slotButton(slot, zone, isHeld, input.onChoose, 'yb-slot'), slot.minute);
      if (isHeld) held = button;
      items.push({ el: button, col, row: slot.minute });
      list.append(h('li', {}, button));
    }
    const column = h(
      'div',
      { class: 'yb-day-col', role: 'group', 'aria-label': UI.dayGroup(formatDateLabel(date), slots.length), 'data-yb-date': date, 'data-yb-empty': slots.length ? undefined : 'true', 'data-yb-today': date === input.today ? 'true' : undefined },
      list,
    );
    // Column 1 holds the hour labels.
    column.style.setProperty('grid-column', String(col + 2));
    body.append(column);
  });
  body.append(hours('end'));
  roving(items, held);
  grid.append(head, body);
  return grid;
}

// Compact: day strip + slot list ---------------------------------------------

export interface DayListInput {
  dates: string[];
  today: string;
  zone: string;
  placed: Map<string, PlacedSlot[]>;
  heldStart: number | null;
  chosen: string | null;
  onDay: (date: string) => void;
  onChoose: (slot: Slot) => void;
  empty: HTMLElement;
}

/**
 * Narrow frames: the same page of days as a strip of large day buttons
 * (empty days disabled), then the chosen day's times as a list of large
 * buttons. Reads better at 360px than a squeezed grid: full-size touch
 * targets, no tiny text, no tall empty hour rows.
 */
export function dayList(input: DayListInput): HTMLElement {
  const strip = h('div', { class: 'yb-strip', role: 'group', 'aria-label': UI.weekLabel });
  let any = false;
  for (const date of input.dates) {
    const count = input.placed.get(date)?.length ?? 0;
    any ||= count > 0;
    const button = h(
      'button',
      {
        type: 'button',
        class: 'yb-strip-day',
        'data-yb-date': date,
        'data-yb-weekend': weekend(date),
        'data-yb-today': date === input.today ? 'true' : undefined,
        'aria-pressed': String(input.chosen === date),
        'aria-label': UI.dayGroup(formatDateLabel(date), count),
        disabled: count === 0,
      },
      h('span', { class: 'yb-day-wd' }, WEEKDAY_JA[weekday(date)]!),
      h('span', { class: 'yb-day-num' }, dayNumber(date)),
      h('span', { class: count ? 'yb-strip-dot' : 'yb-strip-dot yb-strip-dot-none' }),
    );
    button.addEventListener('click', () => input.onDay(date));
    strip.append(button);
  }
  const box = h('div', { class: 'yb-daylist' }, strip);
  const slots = input.chosen ? (input.placed.get(input.chosen) ?? []) : [];
  if (!any) box.append(h('div', { class: 'yb-week-empty' }, input.empty));
  else if (!slots.length) box.append(h('p', { class: 'yb-hint yb-daylist-empty' }, UI.noSlotsOnDay));
  else {
    const list = h('ul', { class: 'yb-slot-list', 'aria-label': formatDateLabel(input.chosen!) });
    for (const slot of slots) list.append(h('li', {}, slotButton(slot, input.zone, input.heldStart === slot.start, input.onChoose, 'yb-slot yb-slot-wide')));
    box.append(h('p', { class: 'yb-daylist-date' }, ...tokens(formatDateLabel(input.chosen!))), list);
  }
  return box;
}

// 空席表 -------------------------------------------------------------------------

export type CellState = 'open' | 'few' | 'full' | 'outside';
const SYMBOL: Record<CellState, string> = { open: '○', few: '△', full: '×', outside: '–' };
const STATE_TEXT: Record<CellState, string> = { open: UI.cellOpen, few: UI.cellFew, full: UI.cellFull, outside: UI.cellOutside };

export interface MatrixInput {
  dates: string[];
  today: string;
  zone: string;
  /** The cached venue days, for `closed`. */
  days: Map<string, AvailabilityDay>;
  placed: Map<string, PlacedSlot[]>;
  heldStart: number | null;
  /** 「2名」 */
  party: string;
  intervalMinutes: number;
  /** The first bookable moment (now + the lead time) in the display zone: earlier cells are –. */
  earliest: { date: string; minute: number };
  onChoose: (slot: Slot) => void;
}

/** The row times: every start in the page, with short gaps (≤ 1 hour) filled on the slot grid. */
export function matrixRows(dates: string[], placed: Map<string, PlacedSlot[]>, intervalMinutes: number): number[] {
  const starts = [...new Set(dates.flatMap((d) => (placed.get(d) ?? []).map((s) => s.minute)))].sort((a, b) => a - b);
  const rows: number[] = [];
  const step = Math.max(5, intervalMinutes);
  starts.forEach((minute, i) => {
    const previous = starts[i - 1];
    if (previous !== undefined && minute - previous <= 60) for (let m = previous + step; m < minute; m += step) rows.push(m);
    rows.push(minute);
  });
  return [...new Set(rows)].sort((a, b) => a - b);
}

/**
 * What one cell says. A slot is ○ (△ when the server marks it `few`).
 * Without one: a `closed` day is –; on a day with slots, a time between its
 * first and last slot is × (booked) and any other –; an empty day is × when
 * the server says it is open (`closed: false`), else – (unknown: nothing is
 * invented). A time before the first bookable moment (`past`) is –.
 */
export function cellState(minute: number, slots: PlacedSlot[], day: AvailabilityDay | undefined, past = false): { state: CellState; slot?: PlacedSlot } {
  const slot = slots.find((s) => s.minute === minute);
  if (slot) return { state: slot.few ? 'few' : 'open', slot };
  if (past || !day || day.closed === true) return { state: 'outside' };
  if (slots.length) return { state: minute > slots[0]!.minute && minute < slots.at(-1)!.minute ? 'full' : 'outside' };
  return { state: day.closed === false ? 'full' : 'outside' };
}

/** The seven-day 空席表: dates as columns, times as rows, a symbol per cell. Null when no time has a slot. */
export function availabilityMatrix(input: MatrixInput): HTMLElement | null {
  const { dates, zone } = input;
  const rows = matrixRows(dates, input.placed, input.intervalMinutes);
  if (!rows.length) return null;
  const header = h(
    'tr',
    {},
    h('th', { scope: 'col', class: 'yb-mx-corner' }, UI.matrixTime),
    ...dates.map((date) => {
      const closed = input.days.get(date)?.closed === true;
      return h(
        'th',
        { scope: 'col', class: 'yb-mx-day', 'data-yb-weekend': weekend(date), 'data-yb-today': date === input.today ? 'true' : undefined, 'data-yb-closed': closed ? 'true' : undefined, 'data-yb-date': date },
        h('span', { class: 'yb-sr' }, `${formatDateLabel(date)}${closed ? ` ${UI.dayClosed}` : ''}`),
        h('span', { class: 'yb-mx-wd', 'aria-hidden': 'true' }, WEEKDAY_JA[weekday(date)]!),
        h('span', { class: 'yb-mx-num', 'aria-hidden': 'true' }, dayNumber(date)),
        ...(closed ? [h('span', { class: 'yb-mx-closed', 'aria-hidden': 'true' }, UI.dayClosed)] : []),
      );
    }),
  );
  const items: RoveItem[] = [];
  let held: HTMLElement | null = null;
  const body = h('tbody', {});
  rows.forEach((minute, r) => {
    const time = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
    const gap = r > 0 && minute - rows[r - 1]! > 60;
    const tr = h('tr', { class: [minute % 60 === 0 ? 'yb-mx-hour' : 'yb-mx-half', gap ? 'yb-mx-break' : ''].filter(Boolean).join(' ') }, h('th', { scope: 'row', class: 'yb-mx-time' }, time));
    dates.forEach((date, col) => {
      const day = input.days.get(date);
      const past = date < input.earliest.date || (date === input.earliest.date && minute < input.earliest.minute);
      const { state, slot } = cellState(minute, input.placed.get(date) ?? [], day, past);
      const cell = h('td', { class: `yb-mx-cell yb-cell-${state}`, 'data-yb-today': date === input.today ? 'true' : undefined, 'data-yb-closed': day?.closed === true ? 'true' : undefined });
      if (slot) {
        const isHeld = input.heldStart === slot.start;
        const button = h(
          'button',
          {
            type: 'button',
            class: `yb-time yb-mx-btn yb-cell-${state}`,
            'data-yb-start': slot.slot.start,
            'aria-pressed': String(isHeld),
            'aria-label': UI.cellLabel(formatDateLabel(date), formatTime(slot.start, zone), input.party, STATE_TEXT[state]),
          },
          h('span', { class: 'yb-sym', 'aria-hidden': 'true' }, SYMBOL[state]),
        );
        button.addEventListener('click', () => input.onChoose(slot.slot));
        if (isHeld) held = button;
        items.push({ el: button, col, row: r });
        cell.append(button);
      } else cell.append(h('span', { class: 'yb-sym', 'aria-hidden': 'true' }, SYMBOL[state]), h('span', { class: 'yb-sr' }, STATE_TEXT[state]));
      tr.append(cell);
    });
    body.append(tr);
  });
  roving(items, held);
  return h('table', { class: 'yb-matrix' }, h('caption', { class: 'yb-sr' }, UI.matrixCaption(input.party)), h('thead', {}, header), body);
}

/** The 空席表 legend. */
export function matrixLegend(): HTMLElement {
  return h(
    'ul',
    { class: 'yb-legend', 'aria-label': UI.legend },
    ...(['open', 'few', 'full', 'outside'] as const).map((state) => h('li', { class: 'yb-legend-item' }, h('span', { class: `yb-legend-sym yb-cell-${state}`, 'aria-hidden': 'true' }, SYMBOL[state]), STATE_TEXT[state])),
  );
}

// Loading ------------------------------------------------------------------

/** Placeholder blocks shaped like the picker while availability loads (decorative). */
export function pickerSkeleton(kind: 'grid' | 'list' | 'matrix', days: number): HTMLElement {
  const box = h('div', { class: `yb-skeleton yb-skeleton-${kind}`, 'aria-hidden': 'true' });
  if (kind === 'list') {
    const strip = h('div', { class: 'yb-skeleton-strip' });
    for (let i = 0; i < days; i++) strip.append(h('span', { class: 'yb-bone yb-bone-day' }));
    const list = h('div', { class: 'yb-skeleton-slots' });
    for (let i = 0; i < 6; i++) list.append(h('span', { class: 'yb-bone yb-bone-slot' }));
    box.append(strip, list);
    return box;
  }
  box.style.setProperty('--yb-days', String(days));
  for (let d = 0; d < days; d++) {
    const col = h('div', { class: 'yb-skeleton-col' }, h('span', { class: 'yb-bone yb-bone-head' }));
    const count = kind === 'matrix' ? 6 : [3, 5, 2, 4, 0, 3, 4][d % 7]!;
    for (let i = 0; i < count; i++) col.append(h('span', { class: 'yb-bone yb-bone-slot' }));
    box.append(col);
  }
  return box;
}

/** The previous / next buttons of a pager. */
export function pagerButton(direction: 'prev' | 'next', text: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const button = h('button', { type: 'button', class: `yb-nav yb-nav-${direction}`, disabled });
  if (direction === 'prev') button.append(icon('chevronLeft'), h('span', { class: 'yb-nav-text' }, text));
  else button.append(h('span', { class: 'yb-nav-text' }, text), icon('chevronRight'));
  button.addEventListener('click', onClick);
  return button;
}
