// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { previewEntry } from '../reservations-config.js';
import { validateBookingMessage } from '../reservations/embed.js';
import { RESERVATION_API_ERRORS } from '../reservations/messages.js';
import { reservationPublicDefinition, type ReservationPublicDefinition } from '../reservations/public.js';
import type { ReservationOperations, ReservationSetup } from '../reservations/types.js';
import {
  BOOKING_UI,
  cellState,
  contextValuesOf,
  durationOf,
  keptSelection,
  matrixRows,
  mountBooking,
  placeSlots,
  previewApi,
  selectionProblem,
  stepsOf,
  syntheticClosed,
  type BookingConfig,
  type BookingOptions,
  type PreviewBookingConfig,
} from './index.js';

/**
 * The business flows (YatrisCMS#426), each in the three steps select →
 * details → outcome: service (service, variant and practitioner cards above
 * the week grid) and party (人数 pills above the 空席表), live and in the
 * synthetic preview.
 */

// happy-dom rewrites import.meta.url, so resolve from the repository root vitest runs in.
const example = (name: string) => JSON.parse(readFileSync(join(process.cwd(), 'contracts/reservations/v1/examples', `${name}.json`), 'utf8')) as ReservationSetup;
const BOOK = 'https://book.yatris.jp';
const base = (key: string) => `${BOOK}/api/public/websites/42/reservations/${key}`;
const PARENT = 'https://www.example.jp';
const INSTANCE = 'inst_0123456789abcdef';
/** Sunday 2026-11-01 09:00 in Tokyo. */
const NOW = Date.parse('2026-11-01T09:00:00+09:00');
const ALLERGY = 'ラテックスにかぶれやすい体質です';

async function definitionFor(name: 'salon' | 'restaurant', operations: Partial<ReservationOperations> = {}, setupExtra: Partial<ReservationSetup> = {}): Promise<ReservationPublicDefinition> {
  const setup = Object.fromEntries(Object.entries({ ...example(name), ...setupExtra }).filter(([, v]) => v !== undefined)) as unknown as ReservationSetup;
  const b = base(name);
  return reservationPublicDefinition(setup, { ...setup.operations!, ...operations } as ReservationOperations, {
    version: 3,
    operationsRevision: 7,
    turnstile: null,
    endpoints: { availability: `${b}/availability`, holds: `${b}/holds`, bookings: `${b}/bookings`, receipt: `${b}/receipt` },
  });
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const invalidSelection = () => json(422, { status: 'rejected', code: 'validation_failed', message: 'x', fieldErrors: {}, formErrors: ['invalid_selection'] });

const SLOTS = [
  { start: '2026-11-03T12:00:00+09:00', end: '2026-11-03T13:15:00+09:00' },
  { start: '2026-11-03T13:00:00+09:00', end: '2026-11-03T14:15:00+09:00' },
];

interface Call {
  url: string;
  method: string;
  body: unknown;
}

type Endpoint = 'availability' | 'holds' | 'bookings' | 'receipt';

/** A stand-in for the booking API of one setup. `replies` overrides responses per endpoint, in order. */
function fakeBooking(definition: ReservationPublicDefinition, replies: Partial<Record<Endpoint, Response[]>> = {}, holdExtra: Record<string, unknown> = {}) {
  const b = base(definition.setup.key);
  const calls: Call[] = [];
  let holds = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? 'GET';
    const body = init.body instanceof FormData ? Object.fromEntries(init.body.entries()) : init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    if (url === b) return json(200, definition);
    const endpoint = url.slice(b.length + 1) as Endpoint;
    const queued = replies[endpoint]?.shift();
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
        return json(201, { holdToken: `hold-${holds}`, expiresAt: '2026-11-01T09:05:00+09:00', start, end: SLOTS.find((s) => s.start === start)!.end, ...holdExtra });
      }
      case 'bookings':
        return json(202, { status: 'accepted', receipt: 'rcpt-secret', state: 'confirmed', success: { mode: 'message', message: 'ご予約ありがとうございます。' } });
      default:
        return json(404, {});
    }
  });
  const sent = (endpoint: Endpoint) => calls.filter((c) => c.url === `${b}/${endpoint}`).map((c) => c.body);
  return { fetch, calls, sent };
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setTimeout(r, 0));
};

const live = (key: string, extra: Partial<Extract<BookingConfig, { mode: 'live' }>> = {}): BookingConfig => ({ mode: 'live', setupKey: key, definitionUrl: base(key), bookingSession: 'session-abc', ...extra });

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
const step = (root: HTMLElement) => root.getAttribute('data-yb-step');

async function check(root: HTMLElement, selector: string) {
  const input = q<HTMLInputElement>(root, selector);
  input.checked = true;
  input.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

async function pick(root: HTMLElement, selector: string, value: string) {
  const control = q<HTMLSelectElement | HTMLInputElement>(root, selector);
  control.value = value;
  control.dispatchEvent(new Event('change', { bubbles: true }));
  await flush();
}

/** Clicks the first slot (week grid or 空席表 cell): date and time in one step. */
async function chooseTime(root: HTMLElement, index = 0) {
  root.querySelectorAll<HTMLButtonElement>('.yb-time')[index]!.click();
  await flush();
}

async function retryAvailability(root: HTMLElement) {
  q<HTMLButtonElement>(root, '.yb-picker .yb-retry').click();
  await flush();
}

async function changeDateTime(root: HTMLElement) {
  q<HTMLButtonElement>(root, '[data-yb-section="details"] .yb-back').click();
  await flush();
}

function type(root: HTMLElement, key: string, value: string) {
  const input = q<HTMLInputElement>(root, `[data-yf-field="${key}"] input, [data-yf-field="${key}"] textarea`);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

async function fillSalon(root: HTMLElement) {
  type(root, 'name', '山田 花子');
  type(root, 'name_kana', 'ヤマダハナコ');
  type(root, 'email', 'hanako@example.jp');
  type(root, 'phone', '09012345678');
  await check(root, '[data-yf-field="visit"] input[value="first"]');
}

function fillRestaurant(root: HTMLElement) {
  type(root, 'name', '佐藤 一郎');
  type(root, 'email', 'ichiro@example.jp');
  type(root, 'phone', '0612345678');
}

async function submit(root: HTMLElement) {
  q<HTMLButtonElement>(root, '.yb-submit').click();
  await flush();
}

const reviewRow = (root: HTMLElement, label: string) =>
  [...root.querySelectorAll('.yb-review-row')].find((r) => r.querySelector('dt')!.textContent === label)?.querySelector('dd')?.textContent ?? null;

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('selection rules', () => {
  it('names the choice that must change, as the server judges a selection', async () => {
    const salon = await definitionFor('salon');
    for (const flow of ['service', 'party', 'time_slot'] as const) expect(stepsOf(flow)).toEqual(['select', 'details', 'outcome']);
    expect(selectionProblem(salon, { locationKey: 'salon' })).toBe('service');
    expect(selectionProblem(salon, { locationKey: 'salon', serviceKey: 'cut' })).toBe('service'); // variant required
    expect(selectionProblem(salon, { locationKey: 'salon', serviceKey: 'cut', variantKey: 'nope' })).toBe('service');
    expect(selectionProblem(salon, { locationKey: 'salon', serviceKey: 'color', variantKey: 'long' })).toBe('service'); // no variants: not allowed
    expect(selectionProblem(salon, { locationKey: 'salon', serviceKey: 'head_spa', practitionerKey: 'yamada' })).toBe('service'); // no choice offered
    expect(selectionProblem(salon, { locationKey: 'salon', serviceKey: 'cut', variantKey: 'long', practitionerKey: 'spa_room' })).toBe('service');
    expect(selectionProblem(salon, { serviceKey: 'cut', variantKey: 'long' })).toBe('date'); // location required
    expect(selectionProblem(salon, { locationKey: 'salon', serviceKey: 'cut', variantKey: 'long' })).toBeNull();
    expect(selectionProblem(salon, { locationKey: 'salon', serviceKey: 'cut', variantKey: 'long', practitionerKey: 'suzuki' })).toBeNull();

    const restaurant = await definitionFor('restaurant');
    for (const partySize of [undefined, 0, 9, 2.5]) expect(selectionProblem(restaurant, { locationKey: 'restaurant', partySize }), String(partySize)).toBe('party');
    expect(selectionProblem(restaurant, { locationKey: 'restaurant', partySize: 1 })).toBeNull();
    expect(selectionProblem(restaurant, { locationKey: 'restaurant', partySize: 8 })).toBeNull();
    expect(selectionProblem(restaurant, { locationKey: 'restaurant', partySize: 2, serviceKey: 'cut' })).toBe('party');
  });

  it('gives each variant its own duration and the party its dining duration', async () => {
    const salon = await definitionFor('salon');
    expect(durationOf(salon, { serviceKey: 'cut' })).toBeNull();
    expect(durationOf(salon, { serviceKey: 'cut', variantKey: 'short' })).toBe(45);
    expect(durationOf(salon, { serviceKey: 'cut', variantKey: 'long' })).toBe(75);
    expect(durationOf(salon, { serviceKey: 'color' })).toBe(90);
    expect(durationOf(await definitionFor('restaurant'), { partySize: 4 })).toBe(120);
  });

  it('feeds booking.* context values exactly as the server evaluates them', async () => {
    const salon = await definitionFor('salon');
    expect(contextValuesOf(salon, { locationKey: 'salon', serviceKey: 'cut', variantKey: 'long', practitionerKey: 'yamada' }, '2026-11-03T12:00:00')).toEqual({
      'booking.location_key': 'salon',
      'booking.starts_at': '2026-11-03T12:00:00',
      'booking.service_key': 'cut',
      'booking.variant_key': 'long',
    });
    const restaurant = await definitionFor('restaurant');
    expect(contextValuesOf(restaurant, { locationKey: 'restaurant', partySize: 6 }, null)).toEqual({ 'booking.location_key': 'restaurant', 'booking.party_size': '6' });
  });

  it('keeps only the choices that still exist after a reload', async () => {
    const salon = await definitionFor('salon');
    expect(keptSelection(salon, { serviceKey: 'cut', variantKey: 'long', practitionerKey: 'suzuki' })).toEqual({ locationKey: 'salon', serviceKey: 'cut', variantKey: 'long', practitionerKey: 'suzuki' });
    expect(keptSelection(salon, { serviceKey: 'gone', variantKey: 'long' })).toEqual({ locationKey: 'salon' });
    const restaurant = await definitionFor('restaurant');
    expect(keptSelection(restaurant, { partySize: 12 })).toEqual({ locationKey: 'restaurant' });
  });
});

describe('service flow', () => {
  it('goes select → details → outcome with the menu as cards above the grid; 「指定しない」 leaves practitionerKey to the server', async () => {
    const api = fakeBooking(await definitionFor('salon'), {}, { practitionerLabel: '山田' });
    const { root } = await mount(live('salon'), { fetch: api.fetch });
    const steps = [step(root)];
    expect([...root.querySelectorAll('.yb-step-label')].map((li) => li.textContent)).toEqual(['日時を選択', '情報を入力', '完了']);
    expect(api.sent('availability')).toEqual([]); // nothing to ask before a service is chosen
    expect(q(root, '.yb-picker-hint').textContent).toBe(BOOKING_UI.chooseServiceFirst);
    // The single location is an info line, not a chooser.
    expect(q(root, '.yb-place').textContent).toBe('方法・場所：表参道店');
    expect(root.querySelector('.yb-locations')).toBeNull();
    expect(q(root, '.yb-chip').textContent).toBe('所要時間45分〜1時間30分');

    // Every service with its duration; a service with variants shows their range. No dropdowns.
    const services = [...root.querySelectorAll('.yb-services .yb-option')].map((o) => o.textContent);
    expect(services).toEqual(['カット45分〜1時間15分', 'カラー1時間30分', 'ヘッドスパ1時間']);
    expect(root.querySelector('[data-yb-section="select"] select')).toBeNull();

    await check(root, '[data-yb-service="cut"]');
    expect(q(root, '.yb-picker-hint').textContent).toBe(BOOKING_UI.chooseVariantFirst);
    const variants = [...root.querySelectorAll('.yb-variants .yb-option')].map((o) => o.textContent);
    expect(variants).toEqual(['ショート45分', 'ロング1時間15分']);
    await check(root, '[data-yb-variant="long"]');
    expect(q(root, '.yb-chip').textContent).toBe('所要時間1時間15分');

    // Practitioners are cards, 「指定しない（おまかせ）」 first and chosen.
    const practitioners = [...root.querySelectorAll<HTMLInputElement>('[data-yb-practitioner]')];
    expect(practitioners.map((p) => [p.value, p.closest('.yb-staff-card')!.textContent])).toEqual([
      ['', '指定しない（おまかせ）'],
      ['yamada', '山山田'],
      ['suzuki', '鈴鈴木'],
    ]);
    expect(practitioners[0]!.checked).toBe(true);
    expect(step(root)).toBe('select');

    await chooseTime(root);
    steps.push(step(root));
    expect(document.activeElement?.textContent).toBe(BOOKING_UI.detailsHeading);
    expect(q(root, '[data-yf-field="length_note"]').hidden).toBe(false); // booking.variant_key = long
    expect(q(root, '[data-yf-field="health"]').hidden).toBe(true); // booking.service_key = cut
    expect(reviewRow(root, 'メニュー')).toBe('カット（ロング）');
    expect(reviewRow(root, '所要時間')).toBe('1時間15分');
    expect(reviewRow(root, '担当者')).toBe('山田');
    expect(reviewRow(root, '方法・場所')).toBe('表参道店');
    expect(q(root, '.yb-policy').textContent).toBe(BOOKING_UI.policyAutomatic);
    await fillSalon(root);
    await submit(root);
    steps.push(step(root));

    expect(steps).toEqual(['select', 'details', 'outcome']);
    const selection = { locationKey: 'salon', serviceKey: 'cut', variantKey: 'long' };
    expect(api.sent('availability')).toEqual([{ from: '2026-11-01', to: '2026-11-14', selection }]);
    expect(api.sent('holds')).toEqual([{ selection, start: SLOTS[0]!.start }]);
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約が確定しました');
    expect(q(root, '.yb-outcome-what').textContent).toBe('カット（ロング）');
  });

  it('sends a chosen practitioner, and nothing extra for a service without choices', async () => {
    const api = fakeBooking(await definitionFor('salon'));
    const { root, controller } = await mount(live('salon'), { fetch: api.fetch });
    await check(root, '[data-yb-service="color"]');
    expect(root.querySelector('.yb-variants')).toBeNull();
    await check(root, '[data-yb-practitioner="suzuki"]');
    expect(controller.selection).toEqual({ locationKey: 'salon', serviceKey: 'color', practitionerKey: 'suzuki' });

    // Another menu: a service without variants or practitioner choice.
    await check(root, '[data-yb-service="head_spa"]');
    expect(root.querySelector('.yb-variants')).toBeNull();
    expect(root.querySelector('[data-yb-practitioner]')).toBeNull();
    expect(api.sent('availability').map((b) => (b as { selection: unknown }).selection)).toEqual([
      { locationKey: 'salon', serviceKey: 'color' },
      { locationKey: 'salon', serviceKey: 'color', practitionerKey: 'suzuki' },
      { locationKey: 'salon', serviceKey: 'head_spa' },
    ]);
  });

  it('filters a long staff list and shows the first eight until 「すべて表示」', async () => {
    const definition = await definitionFor('salon');
    const color = definition.services!.find((s) => s.key === 'color')!;
    color.practitioners = Array.from({ length: 20 }, (_, i) => ({ key: `p${i}`, label: i === 13 ? '鈴木 一郎' : `スタッフ${i + 1}` }));
    const api = fakeBooking(definition);
    const { root, controller } = await mount(live('salon'), { fetch: api.fetch });
    await check(root, '[data-yb-service="color"]');
    const visible = () => [...root.querySelectorAll<HTMLElement>('.yb-staff-card')].filter((c) => !c.hidden).length;
    expect(visible()).toBe(9); // おまかせ + 8
    const more = q<HTMLButtonElement>(root, '.yb-staff-more');
    expect(more.textContent).toBe('すべて表示（20名）');
    const search = q<HTMLInputElement>(root, '.yb-staff-search');
    expect(search.getAttribute('aria-label')).toBe('担当者のご希望を名前で絞り込む');
    search.value = '鈴木';
    search.dispatchEvent(new Event('input'));
    expect(visible()).toBe(2); // おまかせ stays, plus the match
    expect(more.hidden).toBe(true);
    search.value = '';
    search.dispatchEvent(new Event('input'));
    more.click();
    expect(visible()).toBe(21);
    await check(root, '[data-yb-practitioner="p13"]');
    expect(controller.selection.practitionerKey).toBe('p13');
  });

  it('says a service request needing approval is not yet confirmed', async () => {
    const api = fakeBooking(await definitionFor('salon', { confirmationMode: 'manual', approvalWindowMinutes: 1440 }), {
      bookings: [json(202, { status: 'accepted', receipt: 'r', state: 'pending_approval', approvalDeadline: '2026-11-02T09:00:00+09:00', success: { mode: 'message', message: '受け付けました。' } })],
    });
    const { root } = await mount(live('salon'), { fetch: api.fetch });
    await check(root, '[data-yb-service="color"]');
    await chooseTime(root);
    await fillSalon(root);
    await check(root, '[data-yf-field="health_consent"] input[type="checkbox"]');
    expect(q(root, '.yb-policy').textContent).toBe(BOOKING_UI.policyManual('1日'));
    expect(q(root, '.yb-submit').textContent).toBe('予約をリクエストする');
    expect(reviewRow(root, '担当者')).toBe(BOOKING_UI.reviewAnyPractitioner); // no label from the hold
    await submit(root);
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約リクエストを受け付けました（まだ確定していません）');
    expect(q(root, '.yb-outcome-deadline').textContent).toContain('2026年11月2日（月） 09:00');
    expect(root.textContent).not.toContain('予約が確定しました');
  });

  it('shows clinic intake with an unselected consent, and never echoes sensitive answers to the parent or the console', async () => {
    const posted: { message: unknown; origin: string }[] = [];
    const parent = { postMessage: (message: unknown, origin: string) => posted.push({ message, origin }) };
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void logged.push(args));
    const api = fakeBooking(await definitionFor('salon'));
    const { root } = await mount(live('salon', { embed: { instance: INSTANCE, parentOrigin: PARENT } }), { fetch: api.fetch, parent, measureHeight: () => 800 + posted.length });
    await check(root, '[data-yb-service="color"]');
    await chooseTime(root);

    // booking.service_key = color shows the health group.
    expect(q(root, '[data-yf-field="health"]').hidden).toBe(false);
    const consent = q(root, '[data-yf-field="health_consent"]');
    const box = q<HTMLInputElement>(consent, 'input[type="checkbox"]');
    expect(box.checked).toBe(false);
    expect(q(consent, '.yf-consent').textContent).toContain('施術の安全のためにのみ利用し');
    const policy = q<HTMLAnchorElement>(consent, '.yf-policy a');
    expect(policy.href).toBe(`${PARENT}/privacy/`); // the Website's page, not the booking host's
    expect(policy.target).toBe('_blank');
    expect(q(root, '[data-yf-field="allergy"] textarea').hidden).toBe(false);

    await fillSalon(root);
    type(root, 'allergy', ALLERGY);
    await submit(root);
    expect(step(root)).toBe('details'); // consent is required
    expect(root.querySelector('.yf-error-summary')!.textContent).toContain('健康情報の取り扱い');
    await check(root, '[data-yf-field="health_consent"] input[type="checkbox"]');
    // Sensitive answers are not echoed back on the page.
    expect(q(root, '.yb-terms').textContent).not.toContain(ALLERGY);
    await submit(root);
    expect(step(root)).toBe('outcome');

    // The server receives it (it is the clinic's intake), but nothing else does.
    expect(JSON.parse((api.sent('bookings')[0] as { answers: string }).answers)).toMatchObject({ allergy: ALLERGY, health_consent: true });
    for (const { message } of posted) expect(validateBookingMessage(message, INSTANCE), JSON.stringify(message)).toEqual(message);
    const everything = JSON.stringify(posted) + JSON.stringify(logged);
    for (const secret of [ALLERGY, 'hanako@example.jp', '山田 花子', 'color', 'rcpt-secret']) expect(everything).not.toContain(secret);
    expect(q<HTMLTextAreaElement>(root, '[data-yf-field="allergy"] textarea').value).toBe(''); // cleared after acceptance
  });

  it('uses an explicit siteOrigin for consent links on the direct page', async () => {
    const api = fakeBooking(await definitionFor('salon'));
    const { root } = await mount(live('salon', { siteOrigin: 'https://salon.example.jp' }), { fetch: api.fetch });
    expect(q<HTMLAnchorElement>(root, '[data-yf-field="health_consent"] .yf-policy a').href).toBe('https://salon.example.jp/privacy/');
  });

  it('sends the visitor back to the menu when the server rejects the selection, without asking again by itself', async () => {
    // Availability, then the hold, then the booking each reject the selection once.
    const api = fakeBooking(await definitionFor('salon'), { availability: [invalidSelection()], holds: [invalidSelection()], bookings: [invalidSelection()] });
    const { root } = await mount(live('salon'), { fetch: api.fetch });
    await check(root, '[data-yb-service="color"]');
    expect(step(root)).toBe('select');
    expect(q(root, '.yb-notice').textContent).toBe(BOOKING_UI.invalidSelection.service);
    expect(document.activeElement).toBe(q(root, '.yb-notice'));
    expect(api.sent('availability')).toHaveLength(1);

    await retryAvailability(root);
    await chooseTime(root);
    expect(step(root)).toBe('select');
    expect(q(root, '.yb-notice').textContent).toBe(BOOKING_UI.invalidSelection.service);

    await retryAvailability(root);
    await chooseTime(root);
    await fillSalon(root);
    await check(root, '[data-yf-field="health_consent"] input[type="checkbox"]');
    await submit(root);
    expect(step(root)).toBe('select');
    expect(q(root, '.yb-notice').textContent).toBe(BOOKING_UI.invalidSelection.service);
    expect(root.querySelector('.yb-hold')!.hasAttribute('hidden')).toBe(true);
  });

  it('keeps the menu choice across a version change', async () => {
    const definition = await definitionFor('salon');
    const api = fakeBooking(definition, { availability: [json(200, { timezone: 'Asia/Tokyo', operationsRevision: 8, days: [] })] });
    const { root, controller } = await mount(live('salon'), { fetch: api.fetch });
    await check(root, '[data-yb-service="cut"]');
    await check(root, '[data-yb-variant="short"]');
    await flush();
    expect(q(root, '.yb-notice').textContent).toBe(RESERVATION_API_ERRORS.version_changed.message);
    expect(step(root)).toBe('select');
    expect(controller.selection).toEqual({ locationKey: 'salon', serviceKey: 'cut', variantKey: 'short' });
    expect(q<HTMLInputElement>(root, '[data-yb-variant="short"]').checked).toBe(true);
    expect(api.sent('availability')).toHaveLength(2);
  });
});

describe('party flow (空席表)', () => {
  it('goes select → details → outcome with the size in every request', async () => {
    const api = fakeBooking(await definitionFor('restaurant', { confirmationMode: 'automatic' }, { success: undefined }));
    const { root } = await mount(live('restaurant'), { fetch: api.fetch });
    const steps = [step(root)];
    expect([...root.querySelectorAll('.yb-step-label')].map((li) => li.textContent)).toEqual(['日時を選ぶ', 'お客様情報', '予約完了']);
    expect(q(root, '.yb-heading').textContent).toBe('空いているお時間をお選びください');
    // 「ご利用人数」 pills, 1–8, two people preselected; the dining duration in the header.
    const sizes = [...root.querySelectorAll<HTMLInputElement>('[data-yb-party]')];
    expect(sizes.map((s) => s.value)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8']);
    expect(q<HTMLInputElement>(root, '[data-yb-party="2"]').checked).toBe(true);
    expect(root.querySelector('select.yb-party-size')).toBeNull();
    expect(q(root, '.yb-chip').textContent).toBe('ご利用時間2時間');
    expect(q(root, '.yb-party').textContent).toContain('1〜8名様までご予約いただけます。');

    await check(root, '[data-yb-party="6"]');
    // Seven days, a symbol per cell; the lead-time note under the legend.
    expect(q(root, '.yb-period').textContent).toBe('11月1日（日）〜11月7日（土）');
    expect(q(root, '.yb-nav-prev').textContent).toBe('前の7日');
    expect(q(root, '.yb-nav-next').textContent).toBe('次の7日');
    expect([...root.querySelectorAll('.yb-mx-day')].map((th) => th.getAttribute('data-yb-date'))).toEqual(['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06', '2026-11-07']);
    expect([...root.querySelectorAll('.yb-mx-time')].map((th) => th.textContent)).toEqual(['12:00', '12:30', '13:00']);
    const nov3 = [...root.querySelectorAll('tbody tr')].map((tr) => tr.children[3]!.textContent);
    expect(nov3).toEqual(['○', '×満席', '○']); // between two open times: booked
    const cell = q(root, '.yb-mx-btn');
    expect(cell.getAttribute('aria-label')).toBe('11月3日（火）12:00 6名 予約可');
    expect(q(root, '.yb-legend').textContent).toBe('○予約可△残りわずか×満席–受付時間外・定休日');
    expect(q(root, '.yb-lead-note').textContent).toBe('当日のご予約は2時間前まで承ります。');

    await chooseTime(root);
    steps.push(step(root));
    // The summary box: date, time, 人数, ご利用時間.
    expect(q(root, '.yb-summary').textContent).toContain('2026年11月3日（火） 12:00〜13:15'); // the hold's own end
    expect(reviewRow(root, '人数')).toBe('6名');
    expect(reviewRow(root, 'ご利用時間')).toBe('2時間');
    expect(reviewRow(root, '方法・場所')).toBe('梅田本店');
    // booking.party_size = "6": phone becomes required, the children question appears.
    expect(q(root, '[data-yf-field="children"]').hidden).toBe(false);
    expect(q(root, '[data-yf-field="phone"] input').getAttribute('aria-required')).toBe('true');
    // A short select question is radio cards.
    expect(root.querySelectorAll('[data-yf-field="occasion"] input[type="radio"]')).toHaveLength(3);
    expect(root.querySelector('[data-yf-field="occasion"] select')).toBeNull();
    fillRestaurant(root);
    await submit(root);
    steps.push(step(root));

    expect(steps).toEqual(['select', 'details', 'outcome']);
    expect(api.sent('availability')).toEqual([
      { from: '2026-11-01', to: '2026-11-14', selection: { locationKey: 'restaurant', partySize: 2 } },
      { from: '2026-11-01', to: '2026-11-14', selection: { locationKey: 'restaurant', partySize: 6 } },
    ]);
    expect(api.sent('holds')).toEqual([{ selection: { locationKey: 'restaurant', partySize: 6 }, start: SLOTS[0]!.start }]);
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約が確定しました');
    // Table or pool assignment never appears.
    expect(root.textContent).not.toMatch(/テーブル|個室|t1_t2/);
  });

  it('shows 定休日, 満席 and 残りわずか only when the server says so', async () => {
    const days = [
      { date: '2026-11-01', slots: [] },
      { date: '2026-11-02', slots: [], closed: true },
      { date: '2026-11-03', slots: [{ ...SLOTS[0]!, few: true }, SLOTS[1]!] },
      { date: '2026-11-04', slots: [], closed: false },
    ];
    const api = fakeBooking(await definitionFor('restaurant'), { availability: [json(200, { timezone: 'Asia/Tokyo', operationsRevision: 7, days })] });
    const { root } = await mount(live('restaurant'), { fetch: api.fetch });
    const column = (i: number) => [...root.querySelectorAll('tbody tr')].map((tr) => tr.children[i + 1]!.textContent);
    expect(column(0)).toEqual(['–受付時間外・定休日', '–受付時間外・定休日', '–受付時間外・定休日']); // unknown: nothing invented
    expect(column(1)).toEqual(['–受付時間外・定休日', '–受付時間外・定休日', '–受付時間外・定休日']);
    expect(q(root, '.yb-mx-day[data-yb-date="2026-11-02"]').textContent).toContain('休');
    expect(q(root, '.yb-mx-day[data-yb-date="2026-11-02"]').getAttribute('data-yb-closed')).toBe('true');
    expect(column(2)).toEqual(['△', '×満席', '○']);
    expect(q(root, '.yb-mx-btn').getAttribute('aria-label')).toBe('11月3日（火）12:00 2名 残りわずか');
    expect(column(3)).toEqual(['×満席', '×満席', '×満席']); // open but fully booked
  });

  it('works out each cell from the availability alone', () => {
    const placed = placeSlots([{ date: '2026-11-03', slots: [SLOTS[0]!, { start: '2026-11-03T13:00:00+09:00', end: '2026-11-03T15:00:00+09:00', few: true }, { start: '2026-11-03T18:00:00+09:00', end: '2026-11-03T20:00:00+09:00' }] }], 'Asia/Tokyo');
    const slots = placed.get('2026-11-03')!;
    // Gaps of an hour or less are filled; the long afternoon gap is not.
    expect(matrixRows(['2026-11-03'], placed, 30)).toEqual([720, 750, 780, 1080]);
    expect(cellState(720, slots, { date: '2026-11-03', slots: [] }).state).toBe('open');
    expect(cellState(780, slots, { date: '2026-11-03', slots: [] }).state).toBe('few');
    expect(cellState(750, slots, { date: '2026-11-03', slots: [] }).state).toBe('full');
    expect(cellState(690, slots, { date: '2026-11-03', slots: [] }).state).toBe('outside');
    expect(cellState(750, slots, { date: '2026-11-03', slots: [] }, true).state).toBe('outside'); // before the lead time
    expect(cellState(720, [], { date: '2026-11-04', slots: [], closed: false }).state).toBe('full');
    expect(cellState(720, [], { date: '2026-11-04', slots: [], closed: true }).state).toBe('outside');
    expect(cellState(720, [], { date: '2026-11-04', slots: [] }).state).toBe('outside');
  });

  it('jumps to the week containing a date', async () => {
    const api = fakeBooking(await definitionFor('restaurant'));
    const { root } = await mount(live('restaurant'), { fetch: api.fetch });
    const input = q<HTMLInputElement>(root, '.yb-date-input');
    expect([input.type, input.min, input.value]).toEqual(['date', '2026-11-01', '2026-11-01']);
    input.value = '2026-11-20';
    input.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(q(root, '.yb-period').textContent).toBe('11月15日（日）〜11月21日（土）');
    expect(api.sent('availability').map((b) => (b as { from: string }).from)).toEqual(['2026-11-01', '2026-11-15']);
  });

  it('keeps children hidden and phone optional for a party of one', async () => {
    const api = fakeBooking(await definitionFor('restaurant'));
    const { root } = await mount(live('restaurant'), { fetch: api.fetch });
    await check(root, '[data-yb-party="1"]');
    await chooseTime(root);
    expect(q(root, '[data-yf-field="children"]').hidden).toBe(true);
    expect(q(root, '[data-yf-field="phone"] input').getAttribute('aria-required')).not.toBe('true');
  });

  it('says a party request needing approval is not yet confirmed, then redirects only after acceptance', async () => {
    const api = fakeBooking(await definitionFor('restaurant'), {
      bookings: [json(202, { status: 'accepted', receipt: 'r', state: 'pending_approval', approvalDeadline: '2026-11-01T21:00:00+09:00', success: { mode: 'redirect', path: '/reserve/thanks/' } })],
    });
    const navigate = vi.fn();
    const { root } = await mount(live('restaurant'), { fetch: api.fetch, navigate });
    await chooseTime(root);
    fillRestaurant(root);
    expect(q(root, '.yb-policy').textContent).toBe(BOOKING_UI.policyManual('12時間'));
    expect(q(root, '.yb-submit').textContent).toBe('予約をリクエストする');
    expect(root.querySelector('.yb-cutoff')).toBeNull(); // 51 hours away, outside the 180-minute cutoffs
    expect(navigate).not.toHaveBeenCalled();
    await submit(root);
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約リクエストを受け付けました（まだ確定していません）');
    expect(root.textContent).not.toContain('予約が確定しました');
    expect(navigate).toHaveBeenCalledWith('/reserve/thanks/');
  });

  it('offers sizes past eight in a 「○名以上」 select', async () => {
    const api = fakeBooking(await definitionFor('restaurant', { party: { ...example('restaurant').operations!.party!, minSize: 2, maxSize: 100 } }));
    const { root, controller } = await mount(live('restaurant'), { fetch: api.fetch });
    expect([...root.querySelectorAll<HTMLInputElement>('[data-yb-party]')].map((s) => s.value)).toEqual(['2', '3', '4', '5', '6', '7', '8', '9']);
    const more = q<HTMLSelectElement>(root, 'select.yb-party-size');
    expect(more.options[0]!.textContent).toBe('10名以上');
    expect(more.options).toHaveLength(92);
    await pick(root, 'select.yb-party-size', '12');
    expect(controller.selection.partySize).toBe(12);
    expect(root.querySelector('[data-yb-party]:checked')).toBeNull();
    expect(api.sent('availability').at(-1)).toEqual({ from: '2026-11-01', to: '2026-11-14', selection: { locationKey: 'restaurant', partySize: 12 } });
  });

  it('returns to the party size when the server rejects it', async () => {
    const api = fakeBooking(await definitionFor('restaurant'), { holds: [invalidSelection()] });
    const { root } = await mount(live('restaurant'), { fetch: api.fetch });
    await check(root, '[data-yb-party="8"]');
    await chooseTime(root);
    expect(step(root)).toBe('select');
    expect(q(root, '.yb-notice').textContent).toBe(BOOKING_UI.invalidSelection.party);
    // Nothing was held, so the next hold names no token to replace.
    await retryAvailability(root);
    await chooseTime(root);
    expect(api.sent('holds').at(-1)).toEqual({ selection: { locationKey: 'restaurant', partySize: 8 }, start: SLOTS[0]!.start });
  });

  it('replaces the held time explicitly after the size changes', async () => {
    const api = fakeBooking(await definitionFor('restaurant'));
    const { root } = await mount(live('restaurant'), { fetch: api.fetch });
    await chooseTime(root);
    expect(step(root)).toBe('details');
    await changeDateTime(root);
    expect(step(root)).toBe('select');
    await check(root, '[data-yb-party="4"]');
    await chooseTime(root);
    expect(api.sent('holds')).toEqual([
      { selection: { locationKey: 'restaurant', partySize: 2 }, start: SLOTS[0]!.start },
      { selection: { locationKey: 'restaurant', partySize: 4 }, start: SLOTS[0]!.start, replaceHoldToken: 'hold-1' },
    ]);
  });
});

describe('time-slot flow', () => {
  it('names the location choice when the server rejects the selection, and reloads on request', async () => {
    const setup = example('consultation');
    const b = base('consultation');
    const definition = await reservationPublicDefinition(setup, setup.operations!, {
      version: 3,
      operationsRevision: 7,
      turnstile: null,
      endpoints: { availability: `${b}/availability`, holds: `${b}/holds`, bookings: `${b}/bookings`, receipt: `${b}/receipt` },
    });
    const api = fakeBooking(definition, { availability: [invalidSelection()] });
    const { root } = await mount(live('consultation'), { fetch: api.fetch });
    await check(root, 'input[type="radio"][value="online"]');
    expect(step(root)).toBe('select');
    expect(q(root, '.yb-notice').textContent).toBe(BOOKING_UI.invalidSelection.date);
    await retryAvailability(root);
    expect(root.querySelector('[data-yb-date="2026-11-03"]')).not.toBeNull(); // availability reloaded
  });
});

describe('synthetic preview', () => {
  const previewOf = (name: string, mutate: (setup: ReservationSetup) => void = () => {}): PreviewBookingConfig => {
    const setup = example(name);
    mutate(setup);
    const entry = previewEntry(name, `src/reservations/${name}.json`, () => JSON.stringify(setup));
    expect(entry.problem).toBeUndefined();
    return { mode: 'preview', setupKey: name, source: entry.source, definition: entry.definition, synthetic: entry.synthetic };
  };
  const times = (root: HTMLElement) => [...root.querySelectorAll('.yb-time')].map((b) => b.textContent!);
  const minutesOf = (label: string) => {
    const [a, b] = label.split('-').map((t) => {
      const [h, m] = t.split(':').map(Number);
      return h! * 60 + m!;
    });
    return b! - a!;
  };

  it('previews the service flow with fake practitioners and variant durations, never touching the network', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const config = previewOf('salon');
    const labels = config.definition!.services!.flatMap((s) => s.practitioners.map((p) => p.label));
    expect(labels.length).toBeGreaterThan(0);
    for (const label of labels) expect(label).toMatch(/^架空の担当者[A-Z]（サンプル）$/);
    expect(JSON.stringify(config)).not.toMatch(/山田|鈴木|南青山|meetingUrl|instructions/);

    const { root, controller } = await mount(config, { fetch: vi.fn() });
    expect(q(root, '.yb-preview-title').textContent).toBe('プレビュー：サンプルの空き状況です（実際の予約はできません）');
    expect(step(root)).toBe('select');
    await check(root, '[data-yb-service="cut"]');
    await check(root, '[data-yb-variant="short"]');
    expect(times(root).length).toBeGreaterThan(0);
    for (const label of times(root)) expect(minutesOf(label), label).toBe(45);
    await chooseTime(root);
    await fillSalon(root);
    expect(reviewRow(root, '担当者')).toBe('架空の担当者A（サンプル）'); // the synthetic server's pick for 「指定しない」
    await submit(root);
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約が確定しました');
    expect(globalFetch).not.toHaveBeenCalled();
    expect(controller.previewLog!.map((e) => e.request)).toEqual(['holds', 'bookings']);
    expect(controller.previewLog![0]!.selection).toEqual({ locationKey: 'salon', serviceKey: 'cut', variantKey: 'short' });
  });

  it('previews the party 空席表 inside the lunch and dinner periods, with closed days', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const globalFetch = vi.spyOn(globalThis, 'fetch');
    const config = previewOf('restaurant');
    const { root, controller } = await mount(config);
    expect(step(root)).toBe('select');
    await check(root, '[data-yb-party="4"]');
    // A Tuesday: 11:30–14:00 and 17:30–22:00, two-hour sittings that end by closing.
    const tuesday = [...root.querySelectorAll<HTMLElement>('.yb-mx-btn')].map((b) => b.getAttribute('data-yb-start')!).filter((s) => s.startsWith('2026-11-03'));
    expect(tuesday.length).toBeGreaterThan(0);
    for (const start of tuesday) expect(['11:30', '12:00', '17:30', '18:00', '18:30', '19:00', '19:30', '20:00']).toContain(start.slice(11, 16));
    for (const th of root.querySelectorAll('.yb-mx-day')) expect(th.hasAttribute('data-yb-closed'), th.getAttribute('data-yb-date')!).toBe(syntheticClosed(config, th.getAttribute('data-yb-date')!));
    expect(q(root, '.yb-chip').textContent).toBe('ご利用時間2時間');
    await chooseTime(root);
    fillRestaurant(root);
    await submit(root);
    // The restaurant seeds manual confirmation and a redirect: described, not followed.
    expect(q(root, '.yb-outcome-heading').textContent).toBe('予約リクエストを受け付けました（まだ確定していません）');
    expect(root.textContent).toContain('/reserve/thanks/');
    expect(globalFetch).not.toHaveBeenCalled();
    expect(controller.previewLog![0]!.selection).toEqual({ locationKey: 'restaurant', partySize: 4 });
  });

  it('never shows sensitive answers in the preview log or the console', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const { root, controller } = await mount(previewOf('salon'));
    await check(root, '[data-yb-service="color"]');
    await chooseTime(root);
    await fillSalon(root);
    type(root, 'allergy', ALLERGY);
    await check(root, '[data-yf-field="health_consent"] input[type="checkbox"]');
    await submit(root);
    expect(step(root)).toBe('outcome');
    const answers = JSON.parse(controller.previewLog!.at(-1)!.answers as string);
    expect(answers.allergy).toBe(BOOKING_UI.previewSensitive);
    expect(answers.name).toBe('山田 花子'); // ordinary answers stay visible to the author
    expect(q(root, '.yb-preview-log').textContent).not.toContain(ALLERGY);
    expect(JSON.stringify(info.mock.calls)).not.toContain(ALLERGY);
  });

  it('builds a labelled sample when a business declaration seeds no operations', () => {
    const service = previewOf('salon', (setup) => {
      delete setup.operations;
      setup.questions = setup.questions.filter((q) => q.key !== 'length_note' && q.key !== 'health');
    });
    expect(service.definition!.services).toEqual([
      {
        key: 'sample_menu',
        label: 'サンプルメニュー（架空）',
        durationMinutes: 60,
        variants: [],
        visitorChoosesPractitioner: true,
        practitioners: [
          { key: 'sample_practitioner_a', label: '架空の担当者A（サンプル）' },
          { key: 'sample_practitioner_b', label: '架空の担当者B（サンプル）' },
        ],
      },
    ]);
    const party = previewOf('restaurant', (setup) => {
      delete setup.operations;
    });
    expect(party.definition!.party).toEqual({ minSize: 1, maxSize: 6, durationMinutes: 90 });
    expect(party.definition!.policies.confirmationMode).toBe('automatic');
  });

  it('judges selections as the server does, and simulates closed days and few seats', async () => {
    vi.spyOn(console, 'info').mockImplementation(() => {});
    const config = previewOf('restaurant');
    const api = previewApi(config, () => NOW);
    const bad = await api.availability({ from: '2026-11-03', to: '2026-11-03', selection: { locationKey: 'restaurant', partySize: 9 } });
    expect(bad.ok).toBe(false);
    expect(!bad.ok && bad.data).toMatchObject({ code: 'validation_failed', formErrors: ['invalid_selection'] });
    const held = await api.hold({ selection: { locationKey: 'restaurant' }, start: '2026-11-03T11:30:00+09:00' });
    expect(held.ok).toBe(false);
    const good = await api.availability({ from: '2026-11-01', to: '2026-11-14', selection: { locationKey: 'restaurant', partySize: 2 } });
    expect(good.ok && good.data.days[2]!.slots.length).toBeGreaterThan(0);
    const days = good.ok ? good.data.days : [];
    expect(days.every((d) => typeof d.closed === 'boolean')).toBe(true);
    expect(days.some((d) => d.closed)).toBe(true);
    expect(days.flatMap((d) => d.slots).some((s) => s.few)).toBe(true);
  });
});
