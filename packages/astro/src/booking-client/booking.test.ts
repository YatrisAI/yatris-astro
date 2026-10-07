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

async function chooseDate(root: HTMLElement, date = '2026-11-03') {
  q<HTMLButtonElement>(root, `[data-yb-date="${date}"]`).click();
  await flush();
}

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

async function fillDetails(root: HTMLElement) {
  type(root, 'name', '山田 太郎');
  type(root, 'email', 'taro@example.jp');
  const topic = q<HTMLInputElement>(root, '[data-yf-field="topic"] input[value="website"]');
  topic.checked = true;
  topic.dispatchEvent(new Event('change', { bubbles: true }));
  q<HTMLButtonElement>(root, '.yb-next').click();
  await flush();
}

async function submit(root: HTMLElement) {
  q<HTMLButtonElement>(root, '.yb-submit').click();
  await flush();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('time-slot flow', () => {
  it('goes date → time → details → review → outcome, holding the slot and submitting once', async () => {
    const api = fakeBooking(await definitionOf());
    const { root, controller } = await mount(liveConfig(), { fetch: api.fetch });
    const steps: string[] = [root.getAttribute('data-yb-step')!];

    expect(q(root, '.yb-hint').textContent).toBe(BOOKING_UI.chooseLocationFirst);
    await chooseLocation(root, 'online');
    expect(q(root, '[data-yb-date="2026-11-02"]').hasAttribute('disabled')).toBe(true);
    await chooseDate(root);
    steps.push(root.getAttribute('data-yb-step')!);
    expect(q(root, '.yb-times').textContent).toContain('10:00〜10:30');
    expect(root.textContent).toContain('日本時間（Asia/Tokyo）');
    await chooseTime(root);
    steps.push(root.getAttribute('data-yb-step')!);
    expect(document.activeElement?.textContent).toBe(BOOKING_UI.detailsHeading);
    expect(q(root, '.yb-hold').textContent).toContain('残り 10分00秒');
    await fillDetails(root);
    steps.push(root.getAttribute('data-yb-step')!);
    const review = q(root, '.yb-review').textContent!;
    expect(review).toContain('2026年11月3日（火） 10:00〜10:30');
    expect(review).toContain('オンライン（Google Meet）');
    expect(review).toContain('山田 太郎');
    expect(q(root, '.yb-policy').textContent).toBe(BOOKING_UI.policyAutomatic);
    expect(root.querySelector('.yb-cutoff')).toBeNull();
    await submit(root);
    steps.push(root.getAttribute('data-yb-step')!);

    expect(steps).toEqual(['date', 'time', 'details', 'review', 'outcome']);
    expect(api.calls.map((c) => `${c.method} ${c.url.slice(BASE.length) || '/'}`)).toEqual(['GET /', 'POST /availability', 'POST /holds', 'POST /bookings']);
    for (const call of api.calls.filter((c) => c.method === 'POST')) expect(call.headers['x-booking-session'], call.url).toBe('session-abc');
    expect(api.calls[1]!.body).toEqual({ from: '2026-11-01', to: '2026-11-14', selection: { locationKey: 'online' } });
    expect(api.calls[2]!.body).toEqual({ selection: { locationKey: 'online' }, start: '2026-11-03T10:00:00+09:00' });
    const booking = api.calls[3]!.body as Record<string, string>;
    expect(booking).toMatchObject({ holdToken: 'hold-1', setupVersion: '3', operationsRevision: '7', hp_website: '' });
    expect(JSON.parse(booking.answers!)).toEqual({ name: '山田 太郎', email: 'taro@example.jp', topic: 'website' });
    expect(booking.idempotencyKey).toMatch(/^[A-Za-z0-9_-]{16,128}$/);

    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約が確定しました');
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
    await chooseDate(root);
    await chooseTime(root);
    expect(q(root, '[data-yf-field="office_note"]').hidden).toBe(true);
    q<HTMLButtonElement>(root, '[data-yb-section="details"] .yb-back').click();
    q<HTMLButtonElement>(root, '[data-yb-section="time"] .yb-back').click();
    expect(root.getAttribute('data-yb-step')).toBe('date');
    await chooseLocation(root, 'office');
    await chooseDate(root);
    await chooseTime(root);
    expect(q(root, '[data-yf-field="office_note"]').hidden).toBe(false);
  });

  it('replaces the previous hold when the visitor picks another time', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseDate(root);
    await chooseTime(root, 0);
    q<HTMLButtonElement>(root, '[data-yb-section="details"] .yb-back').click();
    expect(root.getAttribute('data-yb-step')).toBe('time');
    await chooseTime(root, 1);
    const holds = api.calls.filter((c) => c.url.endsWith('/holds')).map((c) => c.body);
    expect(holds).toEqual([
      { selection: { locationKey: 'online' }, start: SLOTS[0]!.start },
      { selection: { locationKey: 'online' }, start: SLOTS[1]!.start, replaceHoldToken: 'hold-1' },
    ]);
    expect(root.getAttribute('data-yb-step')).toBe('details');
  });

  it('switches the display time zone without changing the instant sent', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch, visitorTimeZone: 'America/New_York' });
    await chooseLocation(root, 'online');
    await chooseDate(root);
    const select = q<HTMLSelectElement>(root, '.yb-tz-select');
    expect([...select.options].map((o) => o.value)).toEqual(['Asia/Tokyo', 'America/New_York']);
    select.value = 'America/New_York';
    select.dispatchEvent(new Event('change'));
    // 10:00 JST on 3 Nov is 20:00 EST on 2 Nov.
    expect(root.querySelectorAll('.yb-time')[0]!.textContent).toBe('11月2日（月） 20:00〜20:30');
    await chooseTime(root, 0);
    expect(api.calls.find((c) => c.url.endsWith('/holds'))!.body).toMatchObject({ start: '2026-11-03T10:00:00+09:00' });
    await fillDetails(root);
    const when = root.querySelector('.yb-review-row dd')!.textContent!;
    expect(when).toContain('2026年11月2日（月） 20:00〜20:30');
    expect(when).toContain('2026年11月3日（火） 10:00〜10:30　日本時間（Asia/Tokyo）');
  });

  it('says a manual booking is a request, not a confirmation, with its deadline', async () => {
    const definition = await definitionOf({ confirmationMode: 'manual', approvalWindowMinutes: 720 });
    const api = fakeBooking(definition, {
      bookings: [json(202, { status: 'accepted', receipt: 'r', state: 'pending_approval', approvalDeadline: '2026-11-01T21:00:00+09:00', success: { mode: 'message', message: '受け付けました。' } })],
    });
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseDate(root);
    await chooseTime(root);
    await fillDetails(root);
    expect(q(root, '.yb-policy').textContent).toBe(BOOKING_UI.policyManual('12時間'));
    expect(q(root, '.yb-submit').textContent).toBe('予約をリクエストする');
    await submit(root);
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約リクエストを受け付けました（まだ確定していません）');
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
    await chooseDate(root);
    await chooseTime(root);
    await fillDetails(root);
    expect(q(root, '.yb-cutoff').textContent).toBe(BOOKING_UI.cutoffBoth);
  });

  it('returns to fresh availability when the slot is gone, and reuses the key on a retryable failure', async () => {
    const api = fakeBooking(await definitionOf(), { bookings: [rejected('temporarily_unavailable'), rejected('slot_unavailable')] });
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseDate(root);
    await chooseTime(root);
    await fillDetails(root);
    await submit(root);
    expect(q(root, '.yb-notice').textContent).toBe(RESERVATION_API_ERRORS.temporarily_unavailable.message);
    expect(root.getAttribute('data-yb-step')).toBe('review');
    await submit(root);
    const keys = api.calls.filter((c) => c.url.endsWith('/bookings')).map((c) => (c.body as Record<string, string>).idempotencyKey);
    expect(keys[0]).toBe(keys[1]);
    expect(root.getAttribute('data-yb-step')).toBe('time');
    expect(q(root, '.yb-notice').textContent).toBe(RESERVATION_API_ERRORS.slot_unavailable.message);
    expect(api.calls.at(-1)!.url).toBe(`${BASE}/availability`);
  });

  it('sends the visitor back to the times when the hold lapses', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = NOW;
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig(), { fetch: api.fetch, now: () => now });
    await chooseLocation(root, 'online');
    await chooseDate(root);
    await chooseTime(root);
    now = Date.parse('2026-11-01T09:10:01+09:00');
    vi.advanceTimersByTime(1000);
    await flush();
    expect(root.getAttribute('data-yb-step')).toBe('time');
    expect(q(root, '.yb-notice').textContent).toBe(BOOKING_UI.holdExpired);
  });

  it('uses Turnstile for holds and bookings, one token each', async () => {
    const definition = { ...(await definitionOf()), turnstile: { siteKey: 'site', action: 'reservation' } };
    let n = 0;
    const turnstile: TurnstileApi = {
      render: (_el, options) => {
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
    await chooseDate(root);
    await chooseTime(root);
    await fillDetails(root);
    await flush();
    await submit(root);
    expect(api.calls.find((c) => c.url.endsWith('/holds'))!.body).toMatchObject({ turnstileToken: 'token-1' });
    expect(api.calls.find((c) => c.url.endsWith('/bookings'))!.body).toMatchObject({ turnstileToken: 'token-2' });
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

  it('does not show a management link on another origin', async () => {
    const api = fakeBooking(await definitionOf(), {
      bookings: [json(202, { status: 'accepted', receipt: 'r', state: 'confirmed', success: { mode: 'message', message: 'ok' }, managementUrl: 'https://evil.example/manage/x' })],
    });
    const { root } = await mount(liveConfig(), { fetch: api.fetch });
    await chooseLocation(root, 'online');
    await chooseDate(root);
    await chooseTime(root);
    await fillDetails(root);
    await submit(root);
    expect(root.querySelector('.yb-manage-link')).toBeNull();
  });
});

describe('theme', () => {
  it('applies validated tokens as custom properties', async () => {
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig({ theme: { primary: '#4F46E5', mutedText: '#64748b', radius: 12, spacing: 'compact', fontFamily: '"Noto Sans JP", sans-serif' } }), { fetch: api.fetch });
    expect(root.style.getPropertyValue('--yb-primary')).toBe('#4f46e5');
    expect(root.style.getPropertyValue('--yb-muted-text')).toBe('#64748b');
    expect(root.style.getPropertyValue('--yb-radius')).toBe('12px');
    expect(root.getAttribute('data-yb-spacing')).toBe('compact');
  });

  it('ignores an invalid theme entirely', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = fakeBooking(await definitionOf());
    const { root } = await mount(liveConfig({ theme: { primary: 'red' } as never }), { fetch: api.fetch });
    expect(root.style.getPropertyValue('--yb-primary')).toBe('');
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
    await chooseLocation(root, 'online');
    await chooseDate(root);
    await chooseTime(root);
    await fillDetails(root);
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

  it('posts nothing without valid embed settings', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const posted: unknown[] = [];
    const parent = { postMessage: (message: unknown) => posted.push(message) };
    const api = fakeBooking(await definitionOf());
    await mount(liveConfig({ embed: { instance: INSTANCE, parentOrigin: '*' } }), { fetch: api.fetch, parent });
    await mount(liveConfig(), { fetch: api.fetch, parent });
    expect(posted).toEqual([]);
  });

  it('navigates a directly opened page itself after acceptance', async () => {
    const definition = await definitionOf({}, { success: { redirectPath: '/thanks/' } });
    const api = fakeBooking(definition, { bookings: [json(202, { status: 'accepted', receipt: 'r', state: 'confirmed', success: { mode: 'redirect', path: '/thanks/' } })] });
    const navigate = vi.fn();
    const { root } = await mount(liveConfig(), { fetch: api.fetch, navigate });
    await chooseLocation(root, 'online');
    await chooseDate(root);
    await chooseTime(root);
    await fillDetails(root);
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
    await chooseLocation(root, 'online');
    const firstOpen = root.querySelector<HTMLButtonElement>('.yb-date:not([disabled])')!;
    await chooseDate(root, firstOpen.getAttribute('data-yb-date')!);
    await chooseTime(root);
    await fillDetails(root);
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
  });

  it('explains an invalid, missing or unsupported declaration instead of a flow', async () => {
    expect(previewEntry('x', 'src/reservations/x.json', () => '{').problem!.message).toContain('JSON として読み込めません');
    expect(previewEntry('x', 'src/reservations/x.json', () => '{}').problem!.issues.length).toBeGreaterThan(0);
    expect(previewEntry('other', 'src/reservations/other.json', () => JSON.stringify(example('consultation'))).problem!.issues).toEqual([{ path: '/key', code: 'filename_mismatch' }]);
    expect(previewEntry('salon', 'src/reservations/salon.json', () => JSON.stringify(example('salon'))).problem!.message).toContain('time_slot');
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
    expect(controller.step).toBe('date');
  });
});
