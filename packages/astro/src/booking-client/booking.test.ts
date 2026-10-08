// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewEntry } from '../reservations-config.js';
import { RESERVATION_API_ERRORS } from '../reservations/messages.js';
import { reservationPublicDefinition, type ReservationPublicDefinition } from '../reservations/public.js';
import { validateBookingMessage } from '../reservations/embed.js';
import type { ReservationOperations, ReservationSetup } from '../reservations/types.js';
import type { TurnstileApi } from '../forms-client/turnstile.js';
import { BOOKING_UI, cutoffNotice, mountBooking, type BookingConfig, type BookingController, type BookingOptions } from './index.js';

// happy-dom rewrites import.meta.url, so resolve from the repository root vitest runs in.
const example = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'contracts/reservations/v1/examples', `${name}.json`), 'utf8')) as ReservationSetup;
const BOOK = 'https://book.yatris.jp';
const BASE = `${BOOK}/api/public/websites/42/reservations/consultation`;
const DEFINITION_URL = BASE;
const PARENT = 'https://www.example.jp';
const INSTANCE = 'inst_0123456789abcdef';
/** Sunday 2026-11-01 09:00 in Tokyo. */
const NOW = Date.parse('2026-11-01T09:00:00+09:00');

async function definitionOf(operations: Partial<ReservationOperations> = {}, setupExtra: Partial<ReservationSetup> = {}): Promise<ReservationPublicDefinition> {
  const setup = { ...example('consultation'), ...setupExtra };
  return reservationPublicDefinition(setup, { ...setup.operations!, ...operations }, {
    version: 3,
    operationsRevision: 7,
    turnstile: null,
    endpoints: { availability: `${BASE}/availability`, holds: `${BASE}/holds`, bookings: `${BASE}/bookings`, receipt: `${BASE}/receipt` },
  });
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const rejected = (code: keyof typeof RESERVATION_API_ERRORS) => json(RESERVATION_API_ERRORS[code].status[0], { status: 'rejected', code, message: 'server text' });

const SLOTS = [
  { start: '2026-11-03T10:00:00+09:00', end: '2026-11-03T10:30:00+09:00' },
  { start: '2026-11-03T10:30:00+09:00', end: '2026-11-03T11:00:00+09:00' },
];

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** A stand-in for the booking API. `replies` overrides responses per endpoint, in order. */
function fakeBooking(definition: ReservationPublicDefinition, replies: Partial<Record<'holds' | 'bookings' | 'receipt', Response[]>> = {}, expiresAt = '2026-11-01T09:10:00+09:00') {
  const calls: Call[] = [];
  let holds = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const headers = Object.fromEntries([...new Headers(init.headers).entries()].map(([k, v]) => [k.toLowerCase(), v]));
    const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, headers, body });
    if (url === DEFINITION_URL) return json(200, definition);
    const endpoint = url.slice(BASE.length + 1) as 'availability' | 'holds' | 'bookings' | 'receipt';
    const queued = (replies as Record<string, Response[] | undefined>)[endpoint]?.shift();
    if (queued) return queued;
    switch (endpoint) {
      case 'availability': {
        const { from, to } = body as { from: string; to: string };
        const days = [];
        for (let d = Date.parse(`${from}T00:00:00Z`); d <= Date.parse(`${to}T00:00:00Z`); d += 864e5) {
          const date = new Date(d).toISOString().slice(0, 10);
          days.push({ date, slots: date === '2026-11-03' ? SLOTS : [] });
        }
        return json(200, { timezone: 'Asia/Tokyo', operationsRevision: 7, days });
      }
      case 'holds': {
        holds += 1;
        const start = (body as { start: string }).start;
        return json(201, { holdToken: `hold-${holds}`, expiresAt, start, end: SLOTS.find((s) => s.start === start)!.end });
      }
      case 'bookings':
        return json(202, { status: 'accepted', receipt: 'rcpt-secret', state: 'confirmed', success: { mode: 'message', message: 'ご予約ありがとうございます。' }, managementUrl: `${BOOK}/manage/tok-secret` });
      default:
        return json(404, {});
    }
  });
  return { fetch, calls };
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

function liveConfig(extra: Partial<Extract<BookingConfig, { mode: 'live' }>> = {}): BookingConfig {
  return { mode: 'live', setupKey: 'consultation', definitionUrl: DEFINITION_URL, bookingSession: 'session-abc', ...extra };
}

async function mount(config: BookingConfig, options: BookingOptions = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  const controller = mountBooking(root, config, { now: () => NOW, visitorTimeZone: 'Asia/Tokyo', ...options });
  await controller.ready;
  await flush();
  return { root, controller };
}

const q = <T extends Element = HTMLElement>(root: HTMLElement, selector: string) => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el as unknown as T;
};


async function chooseLocation(root: HTMLElement, key: string) {
  const radio = q<HTMLInputElement>(root, `input[type="radio"][value="${key}"]`);
  radio.checked = true;
  radio.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

/** Clicks a slot of the week grid (or the day list): the date and the time in one step. */
async function chooseTime(root: HTMLElement, index = 0) {
  root.querySelectorAll<HTMLButtonElement>('.yb-time')[index]!.click();
  await flush();
}

function type(root: HTMLElement, key: string, value: string) {
  const input = q<HTMLInputElement>(root, `[data-yf-field="${key}"] input, [data-yf-field="${key}"] textarea`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

function fillDetails(root: HTMLElement) {
  type(root, 'name', '山田 太郎');
  type(root, 'email', 'taro@example.jp');
  const topic = q<HTMLInputElement>(root, '[data-yf-field="topic"] input[value="website"]');
  topic.checked = true;
  topic.dispatchEvent(new Event('change', { bubbles: true }));
}

async function submit(root: HTMLElement) {
  q<HTMLButtonElement>(root, '.yb-submit').click();
  await flush();
}

async function changeDateTime(root: HTMLElement) {
  q<HTMLButtonElement>(root, '[data-yb-section="details"] .yb-back').click();
  await flush();
}

const step = (root: HTMLElement) => root.getAttribute('data-yb-step');
const reviewRow = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll('.yb-review-row')].find((r) => r.querySelector('dt')!.textContent === label)?.querySelector('dd')?.textContent ?? null;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('time-slot flow', () => {
  it('goes select → details → outcome, holding the slot and submitting once', async () => {
    const api = fakeBooking(await definitionOf());
    const { root, controller } = await mount(liveConfig(), { fetch: api.fetch });
    const steps: string[] = [step(root)!];

    // Three steps, the first current.
    expect([...root.querySelectorAll('.yb-step-label')].map((li) => li.textContent)).toEqual(['日時を選択', '情報を入力', '完了']);
    expect(q(root, '.yb-step[aria-current="step"]').getAttribute('data-yb-step-item')).toBe('select');
    expect(q(root, '.yb-chip').textContent).toBe('所要時間1時間');
    expect(q(root, '.yb-picker-hint').textContent).toBe(BOOKING_UI.chooseLocationFirst);
    await chooseLocation(root, 'online');

    // A five-day week grid: an empty day is marked, each slot is a button at its time.
    expect([...root.querySelectorAll('.yb-day-col')].map((c) => c.getAttribute('data-yb-date'))).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05']);
    expect(q(root, '[data-yb-date="2026-11-02"]').getAttribute('data-yb-empty')).toBe('true');
    expect(q(root, '[data-yb-date="2026-11-02"]').getAttribute('aria-label')).toBe('11月2日（月）　空きなし');
    expect(q(root, '[data-yb-date="2026-11-03"]').getAttribute('aria-label')).toBe('11月3日（火）　空き2件');
    const slot = q(root, '.yb-time');
    expect(slot.textContent).toBe('10:00-10:30');
    expect(slot.getAttribute('aria-label')).toBe('11月3日（火）10:00〜10:30を選択');
    expect(q(root, '.yb-period').textContent).toBe('2026年11月');
    expect(q(root, '.yb-tz').textContent).toBe('日本時間（Asia/Tokyo）');
    // Only the hours the slots use (padded), not the whole day.
    expect([...root.querySelectorAll('.yb-hours-start .yb-hour')].map((h) => h.textContent)).toEqual(['10:00', '11:00']);

    await chooseTime(root);
    steps.push(step(root)!);
    expect(document.activeElement?.textContent).toBe(BOOKING_UI.detailsHeading);
    expect(q(root, '.yb-hold').textContent).toContain('残り 10分00秒');
    expect(q(root, '.yb-summary-when').textContent).toBe('2026年11月3日（火） 10:00〜10:30');
    expect(q(root, '.yb-summary-tz').textContent).toBe('日本時間（Asia/Tokyo）');
    expect(reviewRow(root, '方法・場所')).toBe('オンライン（Google Meet）');
    expect(reviewRow(root, '所要時間')).toBe('1時間');
    expect(q(root, '.yb-policy').textContent).toBe(BOOKING_UI.policyAutomatic);
    expect(root.querySelector('.yb-cutoff')).toBeNull();
    expect(q(root, '.yb-submit').textContent).toBe('予約を確定する');
    expect(root.querySelectorAll('.yb-step-done')).toHaveLength(1);
    fillDetails(root);
    await submit(root);
    steps.push(step(root)!);

    expect(steps).toEqual(['select', 'details', 'outcome']);
    expect(api.calls.map((c) => `${c.method} ${c.url.slice(BASE.length) || '/'}`)).toEqual(['GET /', 'POST /availability', 'POST /holds', 'POST /bookings']);
    for (const call of api.calls.filter((c) => c.method === 'POST')) expect(call.headers['x-booking-session'], call.url).toBe('session-abc');
    expect(api.calls[1]!.body).toEqual({ from: '2026-11-01', to: '2026-11-14', selection: { locationKey: 'online' } });
    expect(api.calls[2]!.body).toEqual({ selection: { locationKey: 'online' }, start: '2026-11-03T10:00:00+09:00' });
    const booking = api.calls[3]!.body as Record<string, string>;
    expect(booking).toMatchObject({ holdToken: 'hold-1', setupVersion: '3', operationsRevision: '7', hp_website: '' });
    expect(JSON.parse(booking.answers!)).toEqual({ name: '山田 太郎', email: 'taro@example.jp', topic: 'website' });
    expect(booking.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);

    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約が確定しました');
    expect(q(root, '.yb-success').getAttribute('data-yb-tone')).toBe('success');
    expect(q(root, '.yb-outcome-when').textContent).toBe('2026年11月3日（火） 10:00〜10:30日本時間（Asia/Tokyo）');
    const manage = q<HTMLAnchorElement>(root, '.yb-manage-link');
    expect(manage.href).toBe(`${BOOK}/manage/tok-secret`);
    expect(manage.textContent).toBe('予約の確認・変更・キャンセル');
    expect(manage.target).toBe('_blank');
    expect(manage.rel).toBe('noopener noreferrer');
    expect(q(root, '.yb-manage-note').textContent).toContain('メールでもお送りします');
    // Answers are cleared after acceptance.
    expect(q<HTMLInputElement>(root, '[data-yf-field="name"] input').value).toBe('');
    controller.destroy();
  });

  it('evaluates booking.* conditions with the held selection', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseTime(root);
    expect(q(root, '[data-yf-field="office_note"]').hidden).toBe(true);
    await changeDateTime(root);
    expect(step(root)).toBe('select');
    await chooseLocation(root, 'office');
    await chooseTime(root);
    expect(q(root, '[data-yf-field="office_note"]').hidden).toBe(false);
  });

  it('replaces the previous hold when the visitor picks another time', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseTime(root, 0);
    await changeDateTime(root);
    expect(step(root)).toBe('select');
    expect(document.activeElement?.textContent).toBe(BOOKING_UI.selectHeading);
    // The held time is marked; the cached week is redrawn without asking again.
    expect(root.querySelectorAll('.yb-time')[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(api.calls.filter((c) => c.url.endsWith('/availability'))).toHaveLength(1);
    await chooseTime(root, 1);
    const holds = api.calls.filter((c) => c.url.endsWith('/holds')).map((c) => c.body);
    expect(holds).toEqual([
      { selection: { locationKey: 'online' }, start: SLOTS[0]!.start },
      { selection: { locationKey: 'online' }, start: SLOTS[1]!.start, replaceHoldToken: 'hold-1' },
    ]);
    expect(step(root)).toBe('details');
  });

  it('switches the display time zone without changing the instant sent', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch, visitorTimeZone: 'America/New_York' });
    await chooseLocation(root, 'online');
    const select = q<HTMLSelectElement>(root, '.yb-tz-select');
    expect([...select.options].map((o) => o.value)).toEqual(['Asia/Tokyo', 'America/New_York']);
    select.value = 'America/New_York';
    select.dispatchEvent(new Event('change'));
    await flush();
    // 10:00 JST on 3 Nov is 20:00 EST on 2 Nov: the slot moves to that column.
    const slot = q(root, '.yb-time');
    expect(slot.textContent).toBe('20:00-20:30');
    expect(slot.getAttribute('aria-label')).toBe('11月2日（月）20:00〜20:30を選択');
    expect(slot.closest('.yb-day-col')!.getAttribute('data-yb-date')).toBe('2026-11-02');
    await chooseTime(root, 0);
    expect(api.calls.find((c) => c.url.endsWith('/holds'))!.body).toMatchObject({ start: '2026-11-03T10:00:00+09:00' });
    const summary = q(root, '.yb-summary').textContent!;
    expect(summary).toContain('2026年11月2日（月） 20:00〜20:30');
    expect(summary).toContain('2026年11月3日（火） 10:00〜10:30　日本時間（Asia/Tokyo）');
  });

  it('moves between slots with the arrow keys, one tab stop for the grid', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    const [first, second] = [...root.querySelectorAll<HTMLButtonElement>('.yb-time')];
    expect([first!.tabIndex, second!.tabIndex]).toEqual([0, -1]);
    first!.focus();
    first!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(second);
    expect([first!.tabIndex, second!.tabIndex]).toEqual([-1, 0]);
    second!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }));
    expect(document.activeElement).toBe(first);
  });

  it('pages through the weeks, fetching only days it does not have', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    const prev = q<HTMLButtonElement>(root, '.yb-nav-prev');
    expect(prev.disabled).toBe(true);
    expect(prev.textContent).toBe('前へ');
    q<HTMLButtonElement>(root, '.yb-nav-next').click();
    await flush();
    expect(root.querySelector('.yb-day-col')).toBeNull(); // an empty page: no hours drawn
    expect(q(root, '.yb-empty').textContent).toContain(BOOKING_UI.noSlotsInPage);
    expect(q(root, '.yb-status').textContent).toBe('2026年11月');
    q<HTMLButtonElement>(root, '.yb-nav-next').click();
    await flush();
    const ranges = api.calls.filter((c) => c.url.endsWith('/availability')).map((c) => [(c.body as { from: string }).from, (c.body as { to: string }).to]);
    expect(ranges).toEqual([
      ['2026-11-01', '2026-11-14'],
      ['2026-11-15', '2026-11-28'],
    ]);
  });

  it('shows a day strip and a slot list in a narrow frame', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch, measureWidth: () => 390 });
    await chooseLocation(root, 'online');
    expect(root.getAttribute('data-yb-layout')).toBe('list');
    const days = [...root.querySelectorAll<HTMLButtonElement>('.yb-strip-day')];
    expect(days.map((d) => d.disabled)).toEqual([true, true, false, true, true]);
    expect(q(root, '.yb-strip-day[aria-pressed="true"]').getAttribute('data-yb-date')).toBe('2026-11-03');
    expect([...root.querySelectorAll('.yb-slot-list .yb-time')].map((b) => b.textContent)).toEqual(['10:00-10:30', '10:30-11:00']);
    await chooseTime(root, 1);
    expect(step(root)).toBe('details');
  });

  it('says a manual booking is a request, not a confirmation, with its deadline', async () => {
    const definition = await definitionOf({ confirmationMode: 'manual', approvalWindowMinutes: 720 });
    const api = fakeBooking(definition, {
      bookings: [json(202, { status: 'accepted', receipt: 'r', state: 'pending_approval', approvalDeadline: '2026-11-01T21:00:00+09:00', success: { mode: 'message', message: '受け付けました。' } })],
    });
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseTime(root);
    expect(q(root, '.yb-policy').textContent).toBe(BOOKING_UI.policyManual('12時間'));
    expect(q(root, '.yb-submit').textContent).toBe('予約をリクエストする');
    expect(root.textContent).not.toContain('予約を確定する');
    fillDetails(root);
    await submit(root);
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約リクエストを受け付けました（まだ確定していません）');
    expect(q(root, '.yb-success').getAttribute('data-yb-tone')).toBe('pending');
    expect(q(root, '.yb-outcome-deadline').textContent).toContain('2026年11月1日（日） 21:00');
    expect(root.textContent).not.toContain('予約が確定しました');
  });

  it('discloses that a booking inside the cutoffs cannot be changed online', async () => {
    expect(cutoffNotice(23 * 3600e3, 1440, 1440)).toBe(BOOKING_UI.cutoffBoth);
    expect(cutoffNotice(25 * 3600e3, 1440, 1440)).toBeNull();
    expect(cutoffNotice(3 * 3600e3, 240, 60)).toBe(BOOKING_UI.cutoffCancel);
    expect(cutoffNotice(3 * 3600e3, 0, 0)).toBeNull();
    const api = fakeBooking(await definitionOf(), {}, '2026-11-02T12:10:00+09:00');
    // 10:00 on 3 Nov is 22 hours away.
    const { root } = await mount(liveConfig(), { fetch: api.fetch, now: () => Date.parse('2026-11-02T12:00:00+09:00') });
    await chooseLocation(root, 'online');
    await chooseTime(root);
    // Above the submit button, inside the terms.
    expect(q(root, '.yb-terms .yb-cutoff').textContent).toBe(BOOKING_UI.cutoffBoth);
  });

  it('returns to fresh availability when the slot is gone, and reuses the key on a retryable failure', async () => {
    const api = fakeBooking(await definitionOf(), { bookings: [rejected('temporarily_unavailable'), rejected('slot_unavailable')] });
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseTime(root);
    fillDetails(root);
    await submit(root);
    expect(q(root, '.yb-notice').textContent).toBe(RESERVATION_API_ERRORS.temporarily_unavailable.message);
    expect(step(root)).toBe('details');
    await submit(root);
    const keys = api.calls.filter((c) => c.url.endsWith('/bookings')).map((c) => (c.body as Record<string, string>).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(step(root)).toBe('select');
    expect(q(root, '.yb-notice').textContent).toBe(RESERVATION_API_ERRORS.slot_unavailable.message);
    expect(api.calls.at(-1)!.url).toBe(`${BASE}/availability`);
  });

  it('sends the visitor back to the picker when the hold lapses', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = NOW;
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch, now: () => now });
    await chooseLocation(root, 'online');
    await chooseTime(root);
    now = Date.parse('2026-11-01T09:10:01+09:00');
    vi.advanceTimersByTime(1000);
    await flush();
    expect(step(root)).toBe('select');
    expect(q(root, '.yb-notice').textContent).toBe(BOOKING_UI.holdExpired);
  });

  it('challenges only the final submit, never choosing a slot', async () => {
    const definition = { ...(await definitionOf()), turnstile: { siteKey: 'site', action: 'reservation' } };
    let n = 0;
    const rendered: HTMLElement[] = [];
    const turnstile: TurnstileApi = {
      render: (el, options) => {
        rendered.push(el);
        expect(options.appearance).toBe('interaction-only');
        (options.callback as (token: string) => void)(`token-${++n}`);
        return `w${n}`;
      },
      reset: vi.fn(),
      remove: vi.fn(),
      getResponse: () => undefined,
    };
    const api = fakeBooking(definition);
    const { root } = await mount(liveConfig(), { fetch: api.fetch, turnstile: async () => turnstile });
    await chooseLocation(root, 'online');
    await flush();
    expect(rendered).toHaveLength(0);
    await chooseTime(root);
    fillDetails(root);
    await flush();
    expect(rendered).toHaveLength(1);
    expect(rendered[0]!.closest('form')).not.toBeNull();
    await submit(root);
    expect(api.calls.find((c) => c.url.endsWith('/holds'))!.body).not.toHaveProperty('turnstileToken');
    expect(api.calls.find((c) => c.url.endsWith('/bookings'))!.body).toMatchObject({ turnstileToken: 'token-1' });
  });

  it('shows the unavailable state for an unknown setup and a retry after a failed load', async () => {
    const gone = vi.fn(async () => json(404, { status: 'rejected', code: 'setup_unavailable', message: 'x' }));
    let { root } = await mount(liveConfig(), { fetch: gone });
    expect(root.getAttribute('data-yb-state')).toBe('unavailable');
    expect(root.querySelector('.yb-retry')).toBeNull();
    const down = vi.fn(async () => {
      throw new TypeError('offline');
    });
    ({ root } = await mount(liveConfig(), { fetch: down }));
    expect(q(root, '.yb-unavailable-message').textContent).toBe(BOOKING_UI.loadFailed);
    expect(root.querySelector('.yb-retry')).not.toBeNull();
  });

  it('shows skeletons, not only text, while loading', async () => {
    let release: (r: Response) => void = () => {};
    const definition = await definitionOf();
    const fetch = vi.fn(async (input: RequestInfo | URL) => (String(input) === DEFINITION_URL ? json(200, definition) : new Promise<Response>((r) => (release = r))));
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const controller = mountBooking(root, liveConfig(), { fetch, now: () => NOW, visitorTimeZone: 'Asia/Tokyo' });
    expect(root.querySelector('.yb-skeleton')).not.toBeNull(); // the definition
    await controller.ready;
    await chooseLocation(root, 'online');
    expect(q(root, '.yb-picker').getAttribute('aria-busy')).toBe('true');
    expect(root.querySelector('.yb-picker .yb-skeleton-grid')).not.toBeNull();
    expect(q(root, '.yb-status').textContent).toBe(BOOKING_UI.loadingAvailability);
    release(json(200, { timezone: 'Asia/Tokyo', operationsRevision: 7, days: [] }));
    await flush();
    expect(root.querySelector('.yb-skeleton')).toBeNull();
  });

  it('does not show a management link on another origin', async () => {
    const api = fakeBooking(await definitionOf(), {
      bookings: [json(202, { status: 'accepted', receipt: 'r', state: 'confirmed', success: { mode: 'message', message: 'ok' }, managementUrl: 'https://evil.example/manage/x' })],
    });
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseTime(root);
    fillDetails(root);
    await submit(root);
    expect(root.querySelector('.yb-manage-link')).toBeNull();
  });
});

describe('theme', () => {
  it('applies validated tokens as custom properties', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig({ theme: { primary: '#4F46E5', mutedText: '#64748b', radius: 12, spacing: 'compact', font: 'serif', headingFont: 'sans', fontFamily: '"Comic Sans MS", cursive' } }), { fetch: api.fetch });
    expect(root.style.getPropertyValue('--yb-primary')).toBe('#4f46e5');
    expect(root.style.getPropertyValue('--yb-muted-text')).toBe('#64748b');
    expect(root.style.getPropertyValue('--yb-radius')).toBe('12px');
    expect(root.getAttribute('data-yb-spacing')).toBe('compact');
    expect(root.getAttribute('data-yb-themed')).toBe('true');
    // Always Noto: `font` picks sans or serif, a font stack is ignored.
    expect(root.getAttribute('data-yb-font')).toBe('serif');
    expect(root.getAttribute('data-yb-heading-font')).toBe('sans');
    expect(root.style.getPropertyValue('--yb-font-family')).toBe('');
  });

  it('ignores an invalid theme entirely', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig({ theme: { primary: 'red' } as never }), { fetch: api.fetch });
    expect(root.style.getPropertyValue('--yb-primary')).toBe('');
    expect(root.hasAttribute('data-yb-themed')).toBe(false);
  });
});

describe('embedded protocol', () => {
  it('posts only protocol messages, only to the exact parent origin, and never booking details', async () => {
    const posted: { message: unknown; origin: string }[] = [];
    const parent = { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) };
    const definition = await definitionOf({}, { success: { redirectPath: '/thanks/' } });
    const api = fakeBooking(definition, {
      bookings: [json(202, { status: 'accepted', receipt: 'rcpt-secret', state: 'confirmed', success: { mode: 'redirect', path: '/thanks/' }, managementUrl: `${BOOK}/manage/tok-secret` })],
    });
    const navigate = vi.fn();
    const { root } = await mount(liveConfig({ embed: { instance: INSTANCE, parentOrigin: PARENT } }), { fetch: api.fetch, parent, navigate, measureHeight: () => 700 + posted.length });
    // Embedded: no page background and no card.
    expect(root.getAttribute('data-yb-frame')).toBe('embed');
    await chooseLocation(root, 'online');
    await chooseTime(root);
    fillDetails(root);
    await submit(root);

    expect(posted.length).toBeGreaterThan(3);
    expect(new Set(posted.map((p) => p.origin))).toEqual(new Set([PARENT]));
    for (const { message } of posted) expect(validateBookingMessage(message, INSTANCE), JSON.stringify(message)).toEqual(message);
    const types = posted.map((p) => (p.message as { type: string; status?: string }).status ?? (p.message as { type: string }).type);
    expect(types[0]).toBe('loading');
    expect(types.filter((t) => t === 'ready')).toHaveLength(2); // the ready message and the ready status
    expect(types).toContain('height');
    expect(types).toContain('submitted');
    expect(posted.at(-1)!.message).toEqual({ source: 'yatris-booking', version: 1, instance: INSTANCE, type: 'navigate', path: '/thanks/' });
    expect(navigate).not.toHaveBeenCalled();
    const all = JSON.stringify(posted);
    for (const secret of ['taro@example.jp', '山田', 'rcpt-secret', 'tok-secret', 'hold-1', 'session-abc', '2026-11-03']) expect(all).not.toContain(secret);
  });

  it('reports the height as the content changes', async () => {
    const heights: number[] = [];
    const parent = { postMessage: (message: unknown) => (message as { type: string }).type === 'height' && heights.push((message as { height: number }).height) };
    let height = 500;
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig({ embed: { instance: INSTANCE, parentOrigin: PARENT } }), { fetch: api.fetch, parent, measureHeight: () => height });
    height = 900;
    await chooseLocation(root, 'online');
    height = 1200;
    await chooseTime(root);
    expect(heights).toEqual([500, 900, 1200]);
  });

  it('posts nothing without valid embed settings', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const posted: unknown[] = [];
    const parent = { postMessage: (message: unknown) => posted.push(message) };
    const api = fakeBooking(await definitionOf());
    await mount(liveConfig({ embed: { instance: INSTANCE, parentOrigin: '*' } }), { fetch: api.fetch, parent });
    const { root } = await mount(liveConfig(), { fetch: api.fetch, parent });
    expect(posted).toEqual([]);
    expect(root.getAttribute('data-yb-frame')).toBe('page');
  });

  it('navigates a directly opened page itself after acceptance', async () => {
    const definition = await definitionOf({}, { success: { redirectPath: '/thanks/' } });
    const api = fakeBooking(definition, { bookings: [json(202, { status: 'accepted', receipt: 'r', state: 'confirmed', success: { mode: 'redirect', path: '/thanks/' } })] });
    const navigate = vi.fn();
    const { root } = await mount(liveConfig(), { fetch: api.fetch, navigate });
    await chooseLocation(root, 'online');
    await chooseTime(root);
    fillDetails(root);
    expect(navigate).not.toHaveBeenCalled();
    await submit(root);
    expect(navigate).toHaveBeenCalledWith('/thanks/');
  });
});

describe('synthetic preview', () => {
  const entry = () => {
    const setup = example('consultation');
    return previewEntry('consultation', 'src/reservations/consultation.json', () => JSON.stringify(setup));
  };

  it('runs the whole flow on synthetic data without any network call', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const optionFetch = vi.fn();
    const preview = entry();
    expect(preview.problem).toBeUndefined();
    const { root, controller } = await mount({ mode: 'preview', setupKey: 'consultation', source: preview.source, definition: preview.definition, synthetic: preview.synthetic }, { fetch: optionFetch });
    expect(q(root, '.yb-preview-title').textContent).toBe('プレビュー：サンプルの空き状況です（実際の予約はできません）');
    expect(q(root, '.yb-preview-source').textContent).toContain('src/reservations/consultation.json');
    // The same card and steps as a live page, embedded in the site.
    expect(root.getAttribute('data-yb-frame')).toBe('embed');
    expect(root.querySelector('.yb-card .yb-steps')).not.toBeNull();
    await chooseLocation(root, 'online');
    await chooseTime(root);
    fillDetails(root);
    await submit(root);
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約が確定しました');
    expect(globalFetch).not.toHaveBeenCalled();
    expect(optionFetch).not.toHaveBeenCalled();
    expect(controller.previewLog!.map((e) => e.request)).toEqual(['holds', 'bookings']);
    expect(q(root, '.yb-preview-log').textContent).toContain('taro@example.jp');
    expect(info).toHaveBeenCalled();
  });

  it('labels synthetic hosts as fake and keeps private seed values out of the page', async () => {
    const setup = example('consultation');
    setup.operations!.appointment!.visitorChoosesHost = true;
    const preview = previewEntry('consultation', 'src/reservations/consultation.json', () => JSON.stringify(setup));
    const hosts = preview.definition!.appointment!.hosts.map((h) => h.label);
    expect(hosts.length).toBeGreaterThan(0);
    for (const label of hosts) expect(label).toMatch(/^架空の担当者[A-Z]（サンプル）$/);
    const text = JSON.stringify(preview);
    for (const secret of ['meet.google.com', 'meetingUrl', 'instructions', 'address']) expect(text).not.toContain(secret);
    for (const real of setup.operations!.resources!.filter((r) => r.kind === 'host').map((r) => r.label)) expect(text).not.toContain(real);

    // Hosts are radio cards, 「指定しない（おまかせ）」 first and chosen.
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const { root, controller } = await mount({ mode: 'preview', setupKey: 'consultation', source: preview.source, definition: preview.definition, synthetic: preview.synthetic });
    expect(root.querySelector('select')).toBeNull();
    const cards = [...root.querySelectorAll<HTMLInputElement>('[data-yb-host]')];
    expect(cards.map((c) => c.value)).toEqual(['', ...preview.definition!.appointment!.hosts.map((h) => h.key)]);
    expect(cards[0]!.checked).toBe(true);
    expect(q(root, '.yb-staff-any').textContent).toBe('指定しない（おまかせ）');
    cards[1]!.checked = true;
    cards[1]!.dispatchEvent(new Event('change', { bubbles: true }));
    expect(controller.selection.hostKey).toBe(cards[1]!.value);
  });

  it('explains an invalid, missing or unsupported declaration instead of a flow', async () => {
    expect(previewEntry('x', 'src/reservations/x.json', () => '{').problem!.message).toContain('JSON として読み込めません');
    expect(previewEntry('x', 'src/reservations/x.json', () => '{}').problem!.issues.length).toBeGreaterThan(0);
    expect(previewEntry('other', 'src/reservations/other.json', () => JSON.stringify(example('consultation'))).problem!.issues).toEqual([{ path: '/key', code: 'filename_mismatch' }]);
    expect(previewEntry('salon', 'src/reservations/salon.json', () => JSON.stringify(example('salon'))).problem).toBeUndefined();
    const { root } = await mount({ mode: 'preview', setupKey: 'x', source: 'src/reservations/x.json', problem: { message: 'src/reservations/x.json がありません。', issues: [] } });
    expect(root.getAttribute('data-yb-state')).toBe('unavailable');
    expect(root.textContent).toContain('がありません');
  });
});

describe('controller surface', () => {
  it('exposes the step and selection', async () => {
    const api = fakeBooking(await definitionOf());
    const { root, controller } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    expect((controller as BookingController).selection).toEqual({ locationKey: 'online' });
    expect(controller.step).toBe('select');
  });
});
