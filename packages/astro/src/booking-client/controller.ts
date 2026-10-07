import { validateSubmission, type FileDescriptor, type SubmissionResult } from '../forms/answers.js';
import type { AnswerValue } from '../forms/conditions.js';
import type { QuestionContext } from '../forms/context.js';
import { nodeType } from '../forms/registry.js';
import { flatten, type FormDeclaration } from '../forms/tree.js';
import { h } from '../forms-client/dom.js';
import { buildViews, describeFile, type FieldEnv, type View } from '../forms-client/fields.js';
import { loadTurnstile, type TurnstileApi } from '../forms-client/turnstile.js';
import { displayValue, fieldMessage, formMessage } from '../forms-client/ui.js';
import { reservationContext } from '../reservations/context.js';
import { bookingMessage, INSTANCE_PATTERN, isBookingOrigin, isNavigatePath, isWebOrigin, type BookingMessageType, type BookingStatus } from '../reservations/embed.js';
import { RESERVATION_API_ERRORS, type ReservationApiErrorCode } from '../reservations/messages.js';
import type { ReservationPublicDefinition } from '../reservations/public.js';
import { validateTheme, type ReservationTheme } from '../reservations/theme.js';
import { liveApi } from './api.js';
import { previewApi, type PreviewApi } from './preview-api.js';
import {
  addDays,
  browserTimeZone,
  daysBetween,
  formatDateLabel,
  formatDateTime,
  formatTime,
  isTimeZone,
  localDate,
  localDateTime,
  timeZoneLabel,
} from './time.js';
import type { AcceptedResponse, ApiResult, AvailabilityResponse, BookingApi, BookingConfig, HoldResponse, ReceiptResponse, Selection, Slot } from './types.js';
import { UI } from './ui.js';

/**
 * One mounted booking flow (contract README "Wire formats"), `time_slot`
 * mode: date → time (acquires a hold) → contact details and questions →
 * review → submit → outcome. It never claims a booking without an
 * `accepted` response and never falls back to synthetic data in a live
 * mount. Service and party flows add steps in a later contract issue.
 */

export interface BookingOptions {
  /** Network access for live mounts (default: the global fetch). Preview mounts never call it. */
  fetch?: typeof fetch;
  now?: () => number;
  /** Moves a directly opened page to the success path (default `location.assign`). */
  navigate?: (path: string) => void;
  /** Loads the Turnstile API (default: Cloudflare's script, on demand). */
  turnstile?: () => Promise<TurnstileApi>;
  /** Where protocol messages go when embedded (default `window.parent`). */
  parent?: { postMessage(message: unknown, targetOrigin: string): void } | null;
  /** The visitor's zone for the display switch (default: the browser's). */
  visitorTimeZone?: string | null;
  /** The height reported to the parent (default: the bottom of the mount). */
  measureHeight?: () => number;
  /** Milliseconds between receipt polls while a booking is `confirming`. */
  receiptPollMs?: number;
  random?: () => number;
}

export type BookingStep = 'date' | 'time' | 'details' | 'review' | 'outcome';
const STEPS: BookingStep[] = ['date', 'time', 'details', 'review', 'outcome'];
const WINDOW_DAYS = 14;
const MAX_RECEIPT_POLLS = 20;
const SUPPORTED_MODES = ['time_slot'];

interface Attempt {
  key: string;
  answersJson: string;
  holdToken: string;
  files: [string, File][];
}

let mounts = 0;

/** Single-use Turnstile tokens: one widget per slot, reset after every use. */
class Challenge {
  state: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private api: TurnstileApi | null = null;
  private widget: string | null = null;
  private token: string | null = null;
  private slot: HTMLElement | null = null;

  constructor(
    private readonly settings: { siteKey: string; action: string },
    private readonly loader: () => Promise<TurnstileApi>,
  ) {}

  async mount(slot: HTMLElement): Promise<void> {
    if (this.slot === slot && (this.state === 'loading' || this.state === 'ready')) return;
    this.remove();
    this.slot = slot;
    this.state = 'loading';
    try {
      const api = await this.loader();
      if (this.slot !== slot) return;
      this.widget = api.render(slot, {
        sitekey: this.settings.siteKey,
        action: this.settings.action,
        language: 'ja',
        callback: (token: string) => {
          this.token = token;
        },
        'expired-callback': () => {
          this.token = null;
        },
        'error-callback': () => {
          this.token = null;
        },
      });
      this.api = api;
      this.state = 'ready';
    } catch {
      this.state = 'failed';
    }
  }

  value(): string | null {
    if (this.token) return this.token;
    if (!this.api || this.widget === null) return null;
    return this.api.getResponse(this.widget) || null;
  }

  reset(): void {
    this.token = null;
    if (this.api && this.widget !== null) this.api.reset(this.widget);
  }

  remove(): void {
    if (this.api && this.widget !== null) this.api.remove(this.widget);
    this.api = null;
    this.widget = null;
    this.token = null;
    this.slot = null;
    this.state = 'idle';
  }
}

export class BookingController {
  readonly ready: Promise<void>;
  definition: ReservationPublicDefinition | null = null;
  step: BookingStep = 'date';
  selection: Selection = {};
  hold: HoldResponse | null = null;
  /** The zone times are shown in; the venue zone unless the visitor switches. */
  displayTimeZone = 'Asia/Tokyo';
  views: View[] = [];
  pending = false;
  outcome: AcceptedResponse | null = null;
  /** The preview API's request log (preview mounts only). */
  readonly previewLog: PreviewApi['sent'] | null = null;

  private readonly prefix = `yb${++mounts}`;
  private readonly api: BookingApi;
  private readonly now: () => number;
  private readonly embed: { instance: string; parentOrigin: string } | null;
  private readonly bookingOrigin: string | null;
  private body: HTMLElement;
  private declaration: FormDeclaration | null = null;
  private context: QuestionContext = {};
  private result: SubmissionResult | null = null;
  private shownErrors = new Map<string, string>();
  private attempt: Attempt | null = null;
  private windowStart = '';
  private days = new Map<string, Slot[]>();
  private chosenDate: string | null = null;
  private holdTimer: ReturnType<typeof setInterval> | null = null;
  private receiptTimer: ReturnType<typeof setTimeout> | null = null;
  private blockedUntil = 0;
  private lastHeight = 0;
  private readySent = false;
  private holdChallenge: Challenge | null = null;
  private submitChallenge: Challenge | null = null;
  private parts: {
    steps: HTMLElement[];
    timeZone: HTMLElement;
    notice: HTMLElement;
    holdBar: HTMLElement;
    sections: Record<BookingStep, HTMLElement>;
    headings: Partial<Record<BookingStep, HTMLElement>>;
    datesBox: HTMLElement;
    timesBox: HTMLElement;
    form: HTMLFormElement;
    summary: HTMLElement;
    honeypot: HTMLInputElement;
    status: HTMLElement;
  } | null = null;

  constructor(
    readonly root: HTMLElement,
    readonly config: BookingConfig,
    private readonly options: BookingOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    root.setAttribute('data-yb-mounted', 'true');
    // yf-root: the forms field styles (YatrisForm.css) apply to the questions.
    root.classList.add('yb-root', 'yf-root');
    root.replaceChildren();
    applyTheme(root, config.theme);

    if (config.mode === 'live') {
      const doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
      this.api = liveApi(config, doFetch, this.now);
      this.embed = validEmbed(config.embed);
      this.bookingOrigin = new URL(config.definitionUrl).origin;
    } else {
      const log = h('pre', { class: 'yb-preview-log' }, UI.previewNothing);
      const api = config.definition ? previewApi(config, this.now, (entry) => (log.textContent = JSON.stringify(entry, null, 2))) : null;
      this.api = api ?? (null as unknown as BookingApi);
      this.previewLog = api?.sent ?? null;
      this.embed = null;
      this.bookingOrigin = null;
      root.setAttribute('data-yb-preview', 'true');
      root.append(previewMarker(config.source, log));
    }

    this.body = h('div', { class: 'yb-body' });
    root.append(this.body);
    this.post('status', { status: 'loading' });
    this.observeHeight();
    this.ready = this.start();
  }

  // Lifecycle --------------------------------------------------------------

  private async start(): Promise<void> {
    const config = this.config;
    if (config.mode === 'preview') {
      if (config.problem || !config.definition) {
        const problem = config.problem ?? { message: UI.unavailable, issues: [] };
        return this.showUnavailable(problem.message, false, 'unavailable', problem.issues.map((i) => `${i.path || '/'} ${i.code}`));
      }
    }
    await this.load();
  }

  /** Loads (or reloads after a failure) and renders the definition. */
  async load(): Promise<void> {
    this.setState('loading');
    this.body.replaceChildren(h('p', { class: 'yb-loading', role: 'status' }, UI.loading));
    const loaded = await this.api.definition(false);
    if (!loaded.ok) {
      if (loaded.code === 'setup_unavailable') return this.showUnavailable(UI.unavailable, false, 'unavailable');
      return this.showUnavailable(UI.loadFailed, true, 'error');
    }
    const problem = this.checkDefinition(loaded.data);
    if (problem) {
      console.warn(`[yatris booking] "${this.config.setupKey}" cannot be shown: ${problem}`);
      return this.showUnavailable(UI.unsupported, false, 'unavailable');
    }
    this.render(loaded.data);
  }

  private checkDefinition(d: ReservationPublicDefinition): string | null {
    if (!d || typeof d !== 'object' || d.contractVersion !== 1) return 'contract version is not supported';
    if (!d.setup || !d.policies || !Array.isArray(d.questions) || !Array.isArray(d.locations)) return 'the definition is malformed';
    if (!SUPPORTED_MODES.includes(d.setup.mode) || !d.appointment) return `mode ${String(d.setup.mode)} is not supported by this version of the booking UI`;
    if (!isTimeZone(d.policies.timezone)) return `unknown time zone ${d.policies.timezone}`;
    const unknown = flatten(d.questions).filter((e) => !nodeType(e.node.type)).map((e) => String(e.node.type));
    if (unknown.length) return `unknown node types ${unknown.join(', ')}`;
    const live = this.api as ReturnType<typeof liveApi>;
    if (this.config.mode === 'live' && !live.endpoints(d)) return 'the endpoints are missing or on another origin';
    return null;
  }

  private setState(state: string): void {
    this.root.setAttribute('data-yb-state', state);
  }

  private showUnavailable(message: string, retry: boolean, status: BookingStatus, details: string[] = []): void {
    this.clearHoldTimer();
    this.setState('unavailable');
    const box = h('div', { class: 'yb-unavailable', role: 'alert' }, h('p', { class: 'yb-unavailable-message' }, message));
    if (details.length) box.append(h('ul', { class: 'yb-unavailable-details' }, ...details.map((d) => h('li', {}, d))));
    if (retry) {
      const button = h('button', { type: 'button', class: 'yb-retry yb-button' }, UI.retry);
      button.addEventListener('click', () => void this.load());
      box.append(button);
    }
    this.body.replaceChildren(box);
    this.post('status', { status });
    this.postHeight();
  }

  // Rendering --------------------------------------------------------------

  private render(definition: ReservationPublicDefinition): void {
    this.holdChallenge?.remove();
    this.submitChallenge?.remove();
    this.definition = definition;
    const venue = definition.policies.timezone;
    this.displayTimeZone = venue;
    this.declaration = { contractVersion: 1, key: definition.setup.key, name: definition.setup.name, locale: 'ja', fields: definition.questions };
    this.context = reservationContext({ mode: definition.setup.mode as 'time_slot', presentation: undefined }, null);
    const turnstile = this.config.mode === 'live' ? (this.config.turnstile ?? definition.turnstile) : null;
    const loader = this.options.turnstile ?? loadTurnstile;
    this.holdChallenge = turnstile ? new Challenge(turnstile, loader) : null;
    this.submitChallenge = turnstile ? new Challenge(turnstile, loader) : null;
    if (definition.locations.length === 1) this.selection = { locationKey: definition.locations[0]!.key };
    else this.selection = {};

    const stepItems = UI.steps.map((label) => h('li', { class: 'yb-step' }, label));
    const sections = Object.fromEntries(STEPS.map((step) => [step, h('section', { class: `yb-section yb-section-${step}`, hidden: true, 'data-yb-section': step })])) as Record<BookingStep, HTMLElement>;
    const notice = h('p', { class: 'yb-notice', role: 'alert', hidden: true, tabindex: '-1' });
    const holdBar = h('p', { class: 'yb-hold', role: 'status', hidden: true });
    const status = h('p', { class: 'yb-status', role: 'status', 'aria-live': 'polite' });

    // Date step: heading, duration, location and host choice, the dates.
    const dateHeading = h('h2', { class: 'yb-heading', tabindex: '-1' }, UI.dateHeading);
    const datesBox = h('div', { class: 'yb-dates-box' });
    sections.date.append(dateHeading, h('p', { class: 'yb-duration' }, UI.duration(definition.appointment!.durationMinutes)));
    if (definition.locations.length) sections.date.append(this.locationChoice(definition));
    if (definition.appointment!.visitorChoosesHost && definition.appointment!.hosts.length) sections.date.append(this.hostChoice(definition));
    sections.date.append(datesBox);

    const timesBox = h('div', { class: 'yb-times-box' });
    sections.time.append(timesBox);

    // Details step: the questions, rendered by the forms field renderer.
    const detailsHeading = h('h2', { class: 'yb-heading', tabindex: '-1' }, UI.detailsHeading);
    const form = h('form', { class: 'yb-form yf-form', novalidate: true, 'aria-label': UI.detailsHeading });
    const summary = h('div', { class: 'yf-error-summary', role: 'alert', tabindex: '-1', hidden: true });
    const fields = h('div', { class: 'yf-section' });
    const env: FieldEnv = {
      id: (key) => `${this.prefix}-${key}`,
      cls: (_slot, base) => base,
      hidden: {},
      changed: () => this.refresh(),
      blurred: (key) => this.onBlur(key),
      random: this.options.random ?? Math.random,
    };
    this.views = buildViews(definition.questions, env, fields);
    const honeypot = h('input', { type: 'text', name: 'hp_website', id: `${this.prefix}-hp`, tabindex: '-1', autocomplete: 'off' });
    const trap = h(
      'div',
      { class: 'yf-hp', 'aria-hidden': 'true', style: 'position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;overflow:hidden!important;' },
      h('label', { for: honeypot.id }, UI.honeypotLabel),
      honeypot,
    );
    const backToTimes = h('button', { type: 'button', class: 'yb-back yb-button-secondary' }, UI.backToTimes);
    backToTimes.addEventListener('click', () => this.goTo('time'));
    const toReview = h('button', { type: 'submit', class: 'yb-next yb-button' }, UI.toReview);
    form.append(summary, fields, trap, h('div', { class: 'yb-actions' }, backToTimes, toReview));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.toReview();
    });
    sections.details.append(detailsHeading, form);

    const timeZone = h('div', { class: 'yb-tz' });
    this.body.replaceChildren(
      h('p', { class: 'yb-title' }, definition.setup.name),
      h('ol', { class: 'yb-steps', 'aria-label': UI.stepsLabel }, ...stepItems),
      timeZone,
      holdBar,
      notice,
      ...STEPS.map((step) => sections[step]),
      status,
    );
    this.parts = { steps: stepItems, timeZone, notice, holdBar, sections, headings: { date: dateHeading, details: detailsHeading }, datesBox, timesBox, form, summary, honeypot, status };
    this.renderTimeZone();
    this.shownErrors.clear();
    this.windowStart = localDate(this.now(), venue);
    this.days.clear();
    this.chosenDate = null;
    this.showStep('date', false);
    this.refresh();
    if (!this.readySent) {
      this.readySent = true;
      this.post('ready');
    }
    this.post('status', { status: 'ready' });
    void this.loadAvailability();
  }

  private locationChoice(definition: ReservationPublicDefinition): HTMLElement {
    const fieldset = h('fieldset', { class: 'yb-choice-group' }, h('legend', { class: 'yb-legend' }, UI.locationLegend));
    for (const location of definition.locations) {
      const id = `${this.prefix}-location-${location.key}`;
      const input = h('input', { type: 'radio', name: `${this.prefix}-location`, id, value: location.key, class: 'yb-choice-input', checked: this.selection.locationKey === location.key });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        this.selection = { ...this.selection, locationKey: location.key };
        this.refresh();
        void this.loadAvailability();
      });
      fieldset.append(h('div', { class: 'yb-choice' }, input, h('label', { for: id, class: 'yb-choice-label' }, location.label)));
    }
    return fieldset;
  }

  private hostChoice(definition: ReservationPublicDefinition): HTMLElement {
    const id = `${this.prefix}-host`;
    const select = h('select', { id, class: 'yb-select' }, h('option', { value: '' }, UI.anyHost), ...definition.appointment!.hosts.map((host) => h('option', { value: host.key }, host.label)));
    select.addEventListener('change', () => {
      const { hostKey: _previous, ...rest } = this.selection;
      this.selection = select.value ? { ...rest, hostKey: select.value } : rest;
      this.refresh();
      void this.loadAvailability();
    });
    return h('div', { class: 'yb-field' }, h('label', { for: id, class: 'yb-label' }, UI.hostLabel), select);
  }

  /** The display-zone switch: the venue zone, plus the visitor's when it differs. */
  private renderTimeZone(): void {
    const p = this.parts!;
    const venue = this.definition!.policies.timezone;
    const visitor = this.options.visitorTimeZone === undefined ? browserTimeZone() : this.options.visitorTimeZone;
    if (!visitor || visitor === venue || !isTimeZone(visitor)) {
      // One zone only: the time step and the review name it.
      p.timeZone.replaceChildren();
      return;
    }
    const id = `${this.prefix}-tz`;
    const select = h('select', { id, class: 'yb-select yb-tz-select' }, ...[venue, visitor].map((zone) => h('option', { value: zone, selected: zone === this.displayTimeZone }, timeZoneLabel(zone))));
    select.addEventListener('change', () => {
      this.displayTimeZone = select.value;
      this.rerenderTimes();
    });
    p.timeZone.replaceChildren(
      h('div', { class: 'yb-field yb-tz-field' }, h('label', { for: id, class: 'yb-label' }, UI.timeZoneLabel), select),
      h('p', { class: 'yb-tz-note' }, UI.timeZoneNote(timeZoneLabel(venue))),
    );
  }

  private rerenderTimes(): void {
    if (this.step === 'time') this.renderTimes();
    if (this.step === 'review') this.renderReview(false);
    this.updateHoldBar();
  }

  private showStep(step: BookingStep, focus = true): void {
    const p = this.parts!;
    this.step = step;
    for (const s of STEPS) p.sections[s].hidden = s !== step;
    const index = STEPS.indexOf(step);
    p.steps.forEach((li, i) => {
      if (i === index) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
      li.classList.toggle('yb-step-done', i < index);
    });
    p.timeZone.hidden = !p.timeZone.hasChildNodes() || step === 'details' || step === 'outcome';
    this.setState(step === 'outcome' ? 'done' : 'ready');
    this.root.setAttribute('data-yb-step', step);
    this.updateHoldBar();
    if (focus) p.headings[step]?.focus();
    this.postHeight();
  }

  private goTo(step: BookingStep): void {
    if (this.pending) return;
    this.notice(null);
    if (step === 'time') this.renderTimes();
    this.showStep(step);
  }

  private notice(message: string | null, focus = false): void {
    const p = this.parts;
    if (!p) return;
    p.notice.textContent = message ?? '';
    p.notice.hidden = !message;
    if (message && focus) p.notice.focus();
    this.postHeight();
  }

  // Availability -----------------------------------------------------------

  private windowEnd(): string {
    const policies = this.definition!.policies;
    const last = addDays(localDate(this.now(), policies.timezone), policies.bookingHorizonDays);
    const end = addDays(this.windowStart, WINDOW_DAYS - 1);
    return daysBetween(end, last) < 0 ? last : end;
  }

  /** Fetches availability for the current window and selection and redraws the dates (and times). */
  async loadAvailability(): Promise<void> {
    const p = this.parts!;
    const definition = this.definition!;
    if (definition.locations.length && !this.selection.locationKey) {
      p.datesBox.replaceChildren(h('p', { class: 'yb-hint' }, UI.chooseLocationFirst));
      this.postHeight();
      return;
    }
    p.datesBox.setAttribute('aria-busy', 'true');
    p.status.textContent = UI.loadingAvailability;
    const from = this.windowStart;
    const to = this.windowEnd();
    const result = await this.api.availability({ from, to, selection: { ...this.selection } });
    p.datesBox.removeAttribute('aria-busy');
    p.status.textContent = '';
    if (!result.ok) {
      if (result.code === 'version_changed') return this.versionChanged();
      if (result.code === 'setup_unavailable') return this.showUnavailable(UI.unavailable, false, 'unavailable');
      const retry = h('button', { type: 'button', class: 'yb-retry yb-button' }, UI.reloadAvailability);
      retry.addEventListener('click', () => void this.loadAvailability());
      p.datesBox.replaceChildren(h('p', { class: 'yb-error', role: 'alert' }, this.errorMessage(result)), retry);
      this.postHeight();
      return;
    }
    if (result.data.operationsRevision !== definition.setup.operationsRevision) return this.versionChanged();
    this.days = new Map(result.data.days.map((day) => [day.date, Array.isArray(day.slots) ? day.slots : []]));
    this.renderDates(from, to, result.data);
    if (this.step === 'time') this.renderTimes();
    this.postHeight();
  }

  private renderDates(from: string, to: string, availability: AvailabilityResponse): void {
    const p = this.parts!;
    const today = localDate(this.now(), this.definition!.policies.timezone);
    const prev = h('button', { type: 'button', class: 'yb-nav yb-button-secondary', disabled: daysBetween(today, from) <= 0 }, UI.previousWeeks);
    const next = h('button', { type: 'button', class: 'yb-nav yb-button-secondary', disabled: daysBetween(to, addDays(today, this.definition!.policies.bookingHorizonDays)) <= 0 }, UI.nextWeeks);
    prev.addEventListener('click', () => {
      const start = addDays(this.windowStart, -WINDOW_DAYS);
      this.windowStart = daysBetween(today, start) < 0 ? today : start;
      void this.loadAvailability();
    });
    next.addEventListener('click', () => {
      this.windowStart = addDays(to, 1);
      void this.loadAvailability();
    });
    const list = h('ul', { class: 'yb-dates', 'aria-label': UI.datesLabel });
    let any = false;
    for (const day of availability.days) {
      const count = day.slots.length;
      any ||= count > 0;
      const button = h(
        'button',
        { type: 'button', class: 'yb-date', 'data-yb-date': day.date, disabled: count === 0, 'aria-pressed': String(this.chosenDate === day.date) },
        h('span', { class: 'yb-date-label' }, formatDateLabel(day.date)),
        h('span', { class: 'yb-date-status' }, count ? UI.available : UI.full),
      );
      button.addEventListener('click', () => {
        this.chosenDate = day.date;
        this.goTo('time');
      });
      list.append(h('li', {}, button));
    }
    p.datesBox.replaceChildren(
      h('div', { class: 'yb-dates-nav' }, prev, h('span', { class: 'yb-range' }, `${formatDateLabel(from)}〜${formatDateLabel(to)}`), next),
      list,
      ...(any ? [] : [h('p', { class: 'yb-hint' }, UI.noDatesInRange)]),
    );
  }

  private renderTimes(): void {
    const p = this.parts!;
    const date = this.chosenDate;
    if (!date) return;
    const zone = this.displayTimeZone;
    const heading = h('h2', { class: 'yb-heading', tabindex: '-1' }, UI.timeHeading(formatDateLabel(date)));
    p.headings.time = heading;
    const slots = this.days.get(date) ?? [];
    const list = h('ul', { class: 'yb-times' });
    for (const slot of slots) {
      const start = Date.parse(slot.start);
      const end = Date.parse(slot.end);
      const sameDay = localDate(start, zone) === date;
      const label = `${sameDay ? '' : `${formatDateLabel(localDate(start, zone))} `}${formatTime(start, zone)}〜${formatTime(end, zone)}`;
      const held = this.hold !== null && Date.parse(this.hold.start) === start;
      const button = h('button', { type: 'button', class: 'yb-time', 'data-yb-start': slot.start, 'aria-pressed': String(held) }, label);
      button.addEventListener('click', () => void this.acquireHold(slot));
      list.append(h('li', {}, button));
    }
    const back = h('button', { type: 'button', class: 'yb-back yb-button-secondary' }, UI.backToDates);
    back.addEventListener('click', () => this.goTo('date'));
    const challenge = this.holdChallenge ? h('div', { class: 'yb-turnstile', role: 'group', 'aria-label': UI.verificationLabel }) : null;
    p.timesBox.replaceChildren(
      heading,
      h('p', { class: 'yb-duration' }, `${UI.duration(this.definition!.appointment!.durationMinutes)}　${UI.timesShownIn(timeZoneLabel(zone))}`),
      slots.length ? list : h('p', { class: 'yb-hint' }, UI.noSlots),
      ...(challenge ? [challenge] : []),
      h('div', { class: 'yb-actions' }, back),
    );
    if (challenge) void this.holdChallenge!.mount(challenge);
  }

  // Holds ------------------------------------------------------------------

  private async acquireHold(slot: Slot): Promise<void> {
    if (this.pending || this.blocked()) return;
    this.notice(null);
    let turnstileToken: string | undefined;
    if (this.holdChallenge) {
      turnstileToken = this.holdChallenge.value() ?? undefined;
      if (!turnstileToken) return this.notice(this.holdChallenge.state === 'failed' ? UI.verificationUnavailable : UI.verificationPending, true);
    }
    this.setPending(true, UI.holding);
    let result: ApiResult<HoldResponse>;
    try {
      result = await this.api.hold({
        selection: { ...this.selection },
        start: slot.start,
        ...(turnstileToken ? { turnstileToken } : {}),
        ...(this.hold ? { replaceHoldToken: this.hold.holdToken } : {}),
      });
    } finally {
      this.holdChallenge?.reset();
      this.setPending(false);
    }
    if (!result.ok) return this.holdFailed(result);
    if (typeof result.data.holdToken !== 'string' || Number.isNaN(Date.parse(result.data.expiresAt)) || Number.isNaN(Date.parse(result.data.start))) {
      return this.notice(RESERVATION_API_ERRORS.temporarily_unavailable.message, true);
    }
    this.hold = result.data;
    this.attempt = null;
    this.startHoldTimer();
    this.refresh();
    this.showStep('details');
  }

  private holdFailed(result: Extract<ApiResult<unknown>, { ok: false }>): void {
    switch (result.code) {
      case 'version_changed':
        void this.versionChanged();
        return;
      case 'setup_unavailable':
        return this.showUnavailable(UI.unavailable, false, 'unavailable');
      case 'slot_unavailable':
      case 'hold_expired':
      case 'validation_failed':
        this.releaseHold();
        this.notice(RESERVATION_API_ERRORS[result.code === 'validation_failed' ? 'slot_unavailable' : result.code].message, true);
        void this.loadAvailability();
        return;
      default:
        this.retryNotice(result);
    }
  }

  private startHoldTimer(): void {
    this.clearHoldTimer();
    this.holdTimer = setInterval(() => this.updateHoldBar(), 1000);
    this.updateHoldBar();
  }

  private clearHoldTimer(): void {
    if (this.holdTimer) clearInterval(this.holdTimer);
    this.holdTimer = null;
  }

  private releaseHold(): void {
    this.clearHoldTimer();
    this.hold = null;
    this.attempt = null;
    this.updateHoldBar();
  }

  /** The countdown while a hold is kept; on expiry, back to the times with fresh availability. */
  private updateHoldBar(): void {
    const p = this.parts;
    if (!p) return;
    const hold = this.hold;
    const show = hold !== null && (this.step === 'details' || this.step === 'review');
    if (!hold) {
      p.holdBar.hidden = true;
      return;
    }
    const left = Date.parse(hold.expiresAt) - this.now();
    if (left <= 0) {
      if (this.pending) return;
      this.releaseHold();
      if (this.step === 'details' || this.step === 'review') {
        this.renderTimes();
        this.showStep('time');
        this.notice(UI.holdExpired, true);
        void this.loadAvailability();
      }
      return;
    }
    const seconds = Math.ceil(left / 1000);
    const text = UI.holdCountdown(`${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`);
    if (p.holdBar.textContent !== text) p.holdBar.textContent = text;
    p.holdBar.hidden = !show;
  }

  // Questions --------------------------------------------------------------

  private inputs(): View[] {
    return this.views.filter((v) => v.input);
  }

  /** The `booking.*` values of the held selection, as the server evaluates them. */
  contextValues(): Record<string, AnswerValue> {
    const values: Record<string, AnswerValue> = {};
    if (this.selection.locationKey !== undefined) values['booking.location_key'] = this.selection.locationKey;
    if (this.selection.hostKey !== undefined) values['booking.host_key'] = this.selection.hostKey;
    if (this.hold) values['booking.starts_at'] = localDateTime(Date.parse(this.hold.start), this.definition!.policies.timezone);
    return values;
  }

  private validate(): SubmissionResult {
    const answers: Record<string, unknown> = {};
    const files: Record<string, FileDescriptor[]> = {};
    for (const view of this.inputs()) {
      if (view.node.type === 'file') {
        const list = view.files();
        if (list.length) files[view.node.key] = list.map(describeFile);
      } else {
        const raw = view.read();
        if (raw !== undefined) answers[view.node.key] = raw;
      }
    }
    return validateSubmission(this.declaration!, { answers, files }, { timeZone: this.definition!.policies.timezone, checkQuiz: false, context: this.context, contextValues: this.contextValues() });
  }

  /** Activity as forms A1: inactive nodes hide and lose their answers; errors on screen follow. */
  private refresh(): SubmissionResult | null {
    if (!this.declaration) return null;
    let result = this.validate();
    const active = new Set(result.active);
    let cleared = false;
    for (const view of this.views) {
      const on = active.has(view.node.key);
      if (view.el) view.el.hidden = !on;
      if (!on && view.input && view.node.type !== 'hidden') {
        const raw = view.read();
        if ((raw !== undefined && raw !== false && !(Array.isArray(raw) && raw.length === 0)) || view.files().length) cleared = true;
        view.clear();
        view.setError(null);
        this.shownErrors.delete(view.node.key);
      }
    }
    if (cleared) result = this.validate();
    const required = new Set(result.required);
    for (const view of this.inputs()) view.setRequired(required.has(view.node.key));
    const byKey = new Map(this.views.map((v) => [v.node.key, v]));
    const valueOf = (key: string) => {
      const view = byKey.get(key);
      if (!view || !active.has(key)) return '';
      if (view.node.type === 'file') return displayValue(view.node, view.files());
      return result.answers[key] === undefined ? '' : displayValue(view.node, result.answers[key]);
    };
    for (const view of this.views) view.refresh?.(valueOf);
    for (const key of [...this.shownErrors.keys()]) {
      const code = result.fieldErrors[key];
      const view = byKey.get(key);
      if (code && view) view.setError(fieldMessage(code, view.node));
      else {
        this.shownErrors.delete(key);
        view?.setError(null);
      }
    }
    if (this.shownErrors.size === 0 && this.parts) this.parts.summary.hidden = true;
    this.result = result;
    this.postHeight();
    return result;
  }

  private onBlur(key: string): void {
    const view = this.views.find((v) => v.node.key === key);
    const code = this.result?.fieldErrors[key];
    if (!view || !code || code === 'required' || code === 'must_accept') return;
    this.shownErrors.set(key, code);
    view.setError(fieldMessage(code, view.node));
  }

  private showErrors(fieldErrors: Record<string, string>, formErrors: string[]): void {
    const p = this.parts!;
    if (this.step !== 'details') this.showStep('details', false);
    this.shownErrors = new Map(Object.entries(fieldErrors));
    const items: HTMLElement[] = [];
    let first: HTMLElement | null = null;
    for (const view of this.inputs()) {
      const code = fieldErrors[view.node.key];
      const message = code ? fieldMessage(code, view.node) : null;
      view.setError(message);
      if (!message) continue;
      const target = view.el && !view.el.hidden ? view.focusTarget() : null;
      first ??= target;
      const text = view.node.label ? `${view.node.label}：${message}` : message;
      if (target?.id) {
        const link = h('a', { href: `#${target.id}` }, text);
        link.addEventListener('click', (event) => {
          event.preventDefault();
          target.focus();
          target.scrollIntoView?.({ block: 'center' });
        });
        items.push(h('li', {}, link));
      } else items.push(h('li', {}, text));
    }
    for (const code of formErrors) items.push(h('li', {}, formMessage(code)));
    p.summary.replaceChildren(h('p', { class: 'yf-error-summary-title' }, UI.errorSummary), h('ul', {}, ...items));
    p.summary.hidden = items.length === 0;
    if (first) first.focus();
    else if (items.length) p.summary.focus();
    this.postHeight();
  }

  private toReview(): void {
    if (this.pending) return;
    this.notice(null);
    const result = this.refresh()!;
    if (Object.keys(result.fieldErrors).length || result.formErrors.length) return this.showErrors(result.fieldErrors, result.formErrors);
    this.parts!.summary.hidden = true;
    this.renderReview(true);
  }

  // Review and submission ---------------------------------------------------

  private renderReview(enter: boolean): void {
    const p = this.parts!;
    const definition = this.definition!;
    const hold = this.hold;
    if (!hold) return this.goTo('time');
    const venue = definition.policies.timezone;
    const zone = this.displayTimeZone;
    const start = Date.parse(hold.start);
    const end = Date.parse(hold.end);
    const manual = definition.policies.confirmationMode === 'manual';
    const row = (label: string, value: string, key?: string) => h('div', { class: 'yb-review-row', ...(key ? { 'data-yb-field': key } : {}) }, h('dt', {}, label), h('dd', {}, value));

    const when = `${formatDateTime(start, zone)}〜${formatTime(end, zone)}　${timeZoneLabel(zone)}`;
    const rows: HTMLElement[] = [row(UI.reviewDateTime, zone === venue ? when : `${when}${UI.reviewVenueTime(`${formatDateTime(start, venue)}〜${formatTime(end, venue)}　${timeZoneLabel(venue)}`)}`)];
    rows.push(row(UI.reviewDuration, UI.minutes(definition.appointment!.durationMinutes)));
    const location = definition.locations.find((l) => l.key === this.selection.locationKey);
    if (location) rows.push(row(UI.reviewLocation, location.label));
    if (hold.hostLabel) rows.push(row(UI.reviewHost, hold.hostLabel));
    const result = this.result ?? this.validate();
    const active = new Set(result.active);
    for (const view of this.inputs()) {
      const { node } = view;
      if (!active.has(node.key) || node.type === 'hidden' || node.type === 'quiz') continue;
      const value = node.type === 'file' ? view.files() : result.answers[node.key];
      rows.push(row(String(node.label ?? node.key), (value === undefined ? '' : displayValue(node, value)) || UI.empty, node.key));
    }

    const policy = manual ? UI.policyManual(definition.policies.approvalWindowMinutes ? UI.minutes(definition.policies.approvalWindowMinutes) : null) : UI.policyAutomatic;
    const cutoff = cutoffNotice(start - this.now(), definition.policies.cancelCutoffMinutes, definition.policies.rescheduleCutoffMinutes);
    const heading = h('h2', { class: 'yb-heading', tabindex: '-1' }, UI.reviewHeading);
    p.headings.review = heading;
    const back = h('button', { type: 'button', class: 'yb-back yb-button-secondary' }, UI.back);
    back.addEventListener('click', () => this.goTo('details'));
    const submit = h('button', { type: 'button', class: 'yb-submit yb-button' }, manual ? UI.submitManual : UI.submitAutomatic);
    submit.addEventListener('click', () => void this.submit());
    const challenge = this.submitChallenge ? h('div', { class: 'yb-turnstile', role: 'group', 'aria-label': UI.verificationLabel }) : null;
    p.sections.review.replaceChildren(
      heading,
      h('dl', { class: 'yb-review' }, ...rows),
      h('p', { class: manual ? 'yb-policy yb-policy-manual' : 'yb-policy' }, policy),
      ...(cutoff ? [h('p', { class: 'yb-cutoff', role: 'note' }, cutoff)] : []),
      ...(challenge ? [challenge] : []),
      h('div', { class: 'yb-actions' }, back, submit),
    );
    if (challenge) void this.submitChallenge!.mount(challenge);
    if (enter) this.showStep('review');
    else this.postHeight();
  }

  private blocked(): boolean {
    return this.blockedUntil > this.now();
  }

  private setPending(pending: boolean, label: string = UI.sending): void {
    this.pending = pending;
    this.root.toggleAttribute('data-yb-pending', pending);
    for (const button of Array.from(this.root.querySelectorAll<HTMLButtonElement>('.yb-submit, .yb-time, .yb-back'))) {
      if (pending) button.setAttribute('aria-disabled', 'true');
      else button.removeAttribute('aria-disabled');
    }
    if (this.parts) this.parts.status.textContent = pending ? label : '';
  }

  /** Submits the booking: multipart, one idempotency key per deliberate attempt. */
  async submit(): Promise<void> {
    if (this.pending || this.blocked()) return;
    const definition = this.definition!;
    const hold = this.hold;
    if (!hold) return this.goTo('time');
    this.notice(null);
    const result = this.refresh()!;
    if (Object.keys(result.fieldErrors).length || result.formErrors.length) return this.showErrors(result.fieldErrors, result.formErrors);
    let turnstileToken: string | null = null;
    if (this.submitChallenge) {
      turnstileToken = this.submitChallenge.value();
      if (!turnstileToken) return this.notice(this.submitChallenge.state === 'failed' ? UI.verificationUnavailable : UI.verificationPending, true);
    }

    const answers: Record<string, unknown> = { ...result.answers };
    const active = new Set(result.active);
    const files: [string, File][] = [];
    for (const view of this.inputs()) {
      if (!active.has(view.node.key)) continue;
      if (view.node.type === 'quiz' && view.read() !== undefined) answers[view.node.key] = view.read();
      if (view.node.type === 'file') for (const file of view.files()) files.push([view.node.key, file]);
    }
    const answersJson = JSON.stringify(answers);
    const previous = this.attempt;
    const attempt =
      previous && previous.answersJson === answersJson && previous.holdToken === hold.holdToken && sameFiles(previous.files, files)
        ? previous
        : { key: newIdempotencyKey(), answersJson, holdToken: hold.holdToken, files };
    this.attempt = attempt;

    const body = new FormData();
    body.append('holdToken', attempt.holdToken);
    body.append('answers', attempt.answersJson);
    body.append('setupVersion', String(definition.setup.version));
    body.append('operationsRevision', String(definition.setup.operationsRevision));
    body.append('idempotencyKey', attempt.key);
    if (turnstileToken) body.append('turnstileToken', turnstileToken);
    for (const [key, file] of attempt.files) body.append(`files[${key}][]`, file, file.name);
    body.append('hp_website', this.parts!.honeypot.value);

    this.setPending(true);
    let response: ApiResult<AcceptedResponse>;
    try {
      response = await this.api.book(body);
    } finally {
      this.submitChallenge?.reset();
      this.setPending(false);
    }
    if (response.ok && response.data.status === 'accepted') return this.accepted(response.data);
    if (response.ok) return this.retryNotice({ ok: false, code: 'temporarily_unavailable', status: 200, data: null, retryAfter: null });
    this.bookingFailed(response);
  }

  private bookingFailed(result: Extract<ApiResult<unknown>, { ok: false }>): void {
    const message = this.errorMessage(result);
    switch (result.code) {
      case 'validation_failed': {
        this.attempt = null;
        const fieldErrors = stringRecord(result.data?.fieldErrors);
        const formErrors = Array.isArray(result.data?.formErrors) ? (result.data!.formErrors as unknown[]).filter((c): c is string => typeof c === 'string') : [];
        if (formErrors.includes('invalid_selection')) {
          this.releaseHold();
          this.goTo('date');
          this.notice(message, true);
          void this.loadAvailability();
          return;
        }
        this.showErrors(fieldErrors, formErrors);
        if (!Object.keys(fieldErrors).length && !formErrors.length) this.notice(message, true);
        return;
      }
      case 'version_changed':
        void this.versionChanged();
        return;
      case 'hold_expired':
      case 'slot_unavailable':
      case 'approval_window_closed':
        this.releaseHold();
        this.renderTimes();
        this.showStep('time');
        this.notice(message, true);
        void this.loadAvailability();
        return;
      case 'setup_unavailable':
        return this.showUnavailable(UI.unavailable, false, 'unavailable');
      case 'idempotency_conflict':
      case 'payload_too_large':
        this.attempt = null;
        this.notice(message, true);
        return;
      default:
        // network, rate_limited, verification_failed, temporarily_unavailable,
        // calendar_unavailable: retryable as is, with the same key.
        this.retryNotice(result);
    }
  }

  private errorMessage(result: Extract<ApiResult<unknown>, { ok: false }>): string {
    if (result.code === 'network') return UI.networkError;
    return RESERVATION_API_ERRORS[result.code as ReservationApiErrorCode].message;
  }

  private retryNotice(result: Extract<ApiResult<unknown>, { ok: false }>): void {
    let message = this.errorMessage(result);
    if (result.code === 'rate_limited' && result.retryAfter) {
      message += UI.retryAfter(result.retryAfter);
      this.blockedUntil = this.now() + Math.min(result.retryAfter, 600) * 1000;
    }
    this.notice(message, true);
  }

  /**
   * The setup or operations changed under the visitor: reload the definition,
   * keep the answers that still fit, drop the hold and start again from the
   * dates. Never resubmits by itself.
   */
  private async versionChanged(): Promise<void> {
    const before = new Map(this.inputs().map((v) => [v.node.key, { type: v.node.type, raw: v.read(), files: v.files() }]));
    const selection = { ...this.selection };
    const loaded = await this.api.definition(true);
    if (!loaded.ok) return this.showUnavailable(loaded.code === 'setup_unavailable' ? UI.unavailable : UI.loadFailed, loaded.code !== 'setup_unavailable', loaded.code === 'setup_unavailable' ? 'unavailable' : 'error');
    const problem = this.checkDefinition(loaded.data);
    if (problem) return this.showUnavailable(UI.unsupported, false, 'unavailable');
    this.releaseHold();
    this.render(loaded.data);
    if (selection.locationKey && loaded.data.locations.some((l) => l.key === selection.locationKey)) {
      this.selection.locationKey = selection.locationKey;
      const radio = this.root.querySelector<HTMLInputElement>(`input[type="radio"][value="${selection.locationKey}"]`);
      if (radio) radio.checked = true;
      void this.loadAvailability();
    }
    for (const view of this.inputs()) {
      const old = before.get(view.node.key);
      if (old && old.type === view.node.type && view.node.type !== 'acceptance' && view.node.type !== 'quiz') view.restore(old.raw, old.files);
    }
    this.refresh();
    this.notice(RESERVATION_API_ERRORS.version_changed.message, true);
  }

  // Outcome ----------------------------------------------------------------

  private accepted(data: AcceptedResponse): void {
    const definition = this.definition!;
    const hold = this.hold;
    this.outcome = data;
    this.attempt = null;
    this.clearHoldTimer();
    // Clear the answers, so going back never shows or resends them.
    for (const view of this.inputs()) {
      view.clear();
      view.setError(null);
    }
    this.parts!.honeypot.value = '';
    this.holdChallenge?.remove();
    this.submitChallenge?.remove();
    this.renderOutcome(data, hold, definition);
    this.hold = null;
    this.showStep('outcome');
    this.post('status', { status: 'submitted' });

    if (data.state === 'confirming') this.pollReceipt(data.receipt, 0);
    if (data.success?.mode === 'redirect' && isNavigatePath(data.success.path)) {
      if (this.config.mode === 'preview') return;
      if (this.embed) this.post('navigate', { path: data.success.path });
      else (this.options.navigate ?? ((path: string) => window.location.assign(path)))(data.success.path);
    }
  }

  private renderOutcome(data: AcceptedResponse | (Pick<AcceptedResponse, 'state'> & Partial<AcceptedResponse>), hold: HoldResponse | null, definition: ReservationPublicDefinition, state: ReceiptResponse['state'] = data.state): void {
    const p = this.parts!;
    const venue = definition.policies.timezone;
    const headings: Record<ReceiptResponse['state'], string> = {
      confirmed: UI.confirmedHeading,
      pending_approval: UI.pendingHeading,
      confirming: UI.confirmingHeading,
      rejected: UI.rejectedHeading,
      expired: UI.expiredHeading,
      cancelled: UI.cancelledHeading,
    };
    const heading = h('h2', { class: 'yb-heading yb-outcome-heading', tabindex: '-1', 'data-yb-outcome': state }, headings[state]);
    p.headings.outcome = heading;
    const children: HTMLElement[] = [heading];
    if (hold) {
      const start = Date.parse(hold.start);
      children.push(h('p', { class: 'yb-outcome-when' }, `${formatDateTime(start, venue)}〜${formatTime(Date.parse(hold.end), venue)}　${timeZoneLabel(venue)}`));
    }
    if (state === 'pending_approval') {
      const deadline = data.approvalDeadline ? Date.parse(data.approvalDeadline) : NaN;
      if (!Number.isNaN(deadline)) children.push(h('p', { class: 'yb-outcome-deadline' }, UI.pendingDeadline(`${formatDateTime(deadline, venue)}（${timeZoneLabel(venue)}）`)));
    }
    if (state === 'confirming') children.push(h('p', { class: 'yb-outcome-note' }, UI.confirmingNote));
    if (data.success?.mode === 'message' && typeof data.success.message === 'string') children.push(h('p', { class: 'yb-outcome-message' }, data.success.message));
    if (data.success?.mode === 'redirect') {
      children.push(h('p', { class: 'yb-outcome-note' }, this.config.mode === 'preview' ? UI.previewRedirect(data.success.path) : UI.redirecting));
    }
    const manage = this.managementUrl(data.managementUrl);
    if (manage) {
      children.push(
        h(
          'div',
          { class: 'yb-manage' },
          h('a', { class: 'yb-manage-link', href: manage, target: '_blank', rel: 'noopener noreferrer' }, UI.manageLink),
          h('p', { class: 'yb-manage-note' }, UI.manageNote),
        ),
      );
    }
    p.sections.outcome.replaceChildren(...children);
  }

  /** A management URL is shown only when it is an absolute URL on the booking origin. */
  private managementUrl(value: unknown): string | null {
    if (typeof value !== 'string' || !this.bookingOrigin) return null;
    try {
      const url = new URL(value);
      return url.origin === this.bookingOrigin && isBookingOrigin(url.origin) && !url.username && !url.password ? url.href : null;
    } catch {
      return null;
    }
  }

  private pollReceipt(receipt: string, count: number): void {
    if (count >= MAX_RECEIPT_POLLS) return;
    this.receiptTimer = setTimeout(async () => {
      const result = await this.api.receipt(receipt);
      if (!this.outcome || this.step !== 'outcome') return;
      if (result.ok && result.data.state && result.data.state !== 'confirming') {
        const definition = this.definition!;
        this.renderOutcome(this.outcome, null, definition, result.data.state);
        this.parts!.headings.outcome?.focus();
        this.postHeight();
        return;
      }
      this.pollReceipt(receipt, count + 1);
    }, this.options.receiptPollMs ?? 3000);
  }

  /** Stops timers; the mount stays as it is. */
  destroy(): void {
    this.clearHoldTimer();
    if (this.receiptTimer) clearTimeout(this.receiptTimer);
    this.holdChallenge?.remove();
    this.submitChallenge?.remove();
  }

  // Embedding --------------------------------------------------------------

  /** Posts a protocol message to the parent, to its exact origin only. Never booking details. */
  private post(type: BookingMessageType, payload?: Record<string, unknown>): void {
    if (!this.embed) return;
    const target = this.options.parent === undefined ? (typeof window !== 'undefined' && window.parent !== window ? window.parent : null) : this.options.parent;
    if (!target) return;
    const message = (bookingMessage as (instance: string, type: BookingMessageType, payload?: Record<string, unknown>) => unknown)(this.embed.instance, type, ...(payload ? [payload] : []));
    target.postMessage(message, this.embed.parentOrigin);
  }

  private postHeight(): void {
    if (!this.embed) return;
    const measured = this.options.measureHeight ? this.options.measureHeight() : Math.ceil(this.root.getBoundingClientRect().bottom + (window.scrollY || 0));
    const height = Math.min(20000, Math.max(1, Math.ceil(measured)));
    if (!Number.isFinite(measured) || measured < 1 || height === this.lastHeight) return;
    this.lastHeight = height;
    this.post('height', { height });
  }

  private observeHeight(): void {
    if (!this.embed || typeof ResizeObserver !== 'function') return;
    new ResizeObserver(() => this.postHeight()).observe(this.root);
  }

}

/** The prominent preview label, with the request a live mount would have sent. */
function previewMarker(source: string, log: HTMLElement): HTMLElement {
  return h(
    'div',
    { class: 'yb-preview-marker', role: 'note', 'data-yb-preview-module': PREVIEW_MARKER_ID },
    h('p', { class: 'yb-preview-title' }, UI.previewMarker),
    h('p', { class: 'yb-preview-source' }, UI.previewSource(source)),
    h('details', { class: 'yb-preview-details' }, h('summary', {}, UI.previewLog), log),
  );
}

export const PREVIEW_MARKER_ID = 'yatris-booking-preview';

/** Applies validated theme tokens as `--yb-*` custom properties and `data-yb-spacing`. */
export function applyTheme(root: HTMLElement, theme: ReservationTheme | null | undefined): void {
  if (!theme) return;
  const result = validateTheme(theme);
  if (!result.valid) {
    console.warn('[yatris booking] theme ignored:', result.errors.map((e) => `${e.path || '/'} ${e.code}`).join(', '));
    return;
  }
  for (const [key, value] of Object.entries(result.theme!)) {
    if (key === 'spacing') root.setAttribute('data-yb-spacing', String(value));
    else if (key === 'radius') root.style.setProperty('--yb-radius', `${value}px`);
    else root.style.setProperty(`--yb-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`, String(value));
  }
}

/**
 * The disclosure before submitting a booking that starts inside a visitor
 * cutoff: online cancellation and/or rescheduling will not be possible.
 */
export function cutoffNotice(untilStartMs: number, cancelCutoffMinutes: number, rescheduleCutoffMinutes: number): string | null {
  const minutes = untilStartMs / 60000;
  const cancel = minutes < cancelCutoffMinutes;
  const reschedule = minutes < rescheduleCutoffMinutes;
  if (cancel && reschedule) return UI.cutoffBoth;
  if (cancel) return UI.cutoffCancel;
  if (reschedule) return UI.cutoffReschedule;
  return null;
}

function validEmbed(embed: { instance: string; parentOrigin: string } | null | undefined): { instance: string; parentOrigin: string } | null {
  if (!embed) return null;
  if (typeof embed.instance === 'string' && new RegExp(INSTANCE_PATTERN).test(embed.instance) && isWebOrigin(embed.parentOrigin)) return { instance: embed.instance, parentOrigin: embed.parentOrigin };
  console.warn('[yatris booking] embed settings are invalid; no messages will be posted to the parent page');
  return null;
}

function sameFiles(a: [string, File][], b: [string, File][]): boolean {
  return a.length === b.length && a.every(([key, file], i) => b[i]![0] === key && b[i]![1] === file);
}

/** 16–128 characters of [A-Za-z0-9_-]. */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  return [...c.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
}
