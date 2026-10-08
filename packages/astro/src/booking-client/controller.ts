import { validateSubmission, type FileDescriptor, type SubmissionResult } from '../forms/answers.js';
import type { AnswerValue } from '../forms/conditions.js';
import type { QuestionContext } from '../forms/context.js';
import { nodeType } from '../forms/registry.js';
import { flatten, type FormDeclaration } from '../forms/tree.js';
import { h } from '../forms-client/dom.js';
import { buildViews, describeFile, type FieldEnv, type View } from '../forms-client/fields.js';
import { loadTurnstile, turnstileSize, type TurnstileApi } from '../forms-client/turnstile.js';
import { displayValue, fieldMessage, formMessage } from '../forms-client/ui.js';
import { reservationContext } from '../reservations/context.js';
import { bookingMessage, INSTANCE_PATTERN, isBookingOrigin, isNavigatePath, isWebOrigin, type BookingMessageType, type BookingStatus } from '../reservations/embed.js';
import { RESERVATION_API_ERRORS, type ReservationApiErrorCode } from '../reservations/messages.js';
import type { ReservationPublicDefinition } from '../reservations/public.js';
import { validateTheme, type ReservationTheme } from '../reservations/theme.js';
import { liveApi } from './api.js';
import { ALL_STEPS, contextValuesOf, durationOf, flowOf, keptSelection, selectionProblem, serviceOf, stepsOf, type BookingFlow, type BookingStep, type SelectionProblem } from './flow.js';
import { icon } from './icons.js';
import { availabilityMatrix, dayList, matrixLegend, pagerButton, pickerSkeleton, placeSlots, tokens, weekGrid, type PlacedSlot } from './picker.js';
import { previewApi, type PreviewApi } from './preview-api.js';
import { addDays, browserTimeZone, daysBetween, formatDateLabel, formatDateTime, formatTime, isTimeZone, localDate, localDateTime, timeZoneLabel, zoned } from './time.js';
import type { AcceptedResponse, ApiResult, AvailabilityDay, BookingApi, BookingConfig, HoldResponse, ReceiptResponse, Selection, Slot } from './types.js';
import { UI } from './ui.js';

/**
 * One mounted booking flow (contract README "Wire formats" and "Booking
 * UI") in three steps:
 *
 * 1. `select`: the mode's own choices (location, host, service, variant,
 *    practitioner, party size) as controls above the slot picker, and the
 *    date and time together: a five-day week grid (a day strip and slot list
 *    in narrow frames) or, for parties, the seven-day 空席表. Choosing a time
 *    acquires a hold.
 * 2. `details`: the held date and time, the questions, the booking terms
 *    (duration, location, confirmation policy, cutoff disclosure) and the
 *    submit button.
 * 3. `outcome`.
 *
 * It never claims a booking without an `accepted` response and never falls
 * back to synthetic data in a live mount.
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
  /** The mount's width, which picks the week grid (≥ 640px) or the day list (default: the root's width; 0 = unknown, the grid). */
  measureWidth?: () => number;
  /** Milliseconds between receipt polls while a booking is `confirming`. */
  receiptPollMs?: number;
  random?: () => number;
}

export type { BookingFlow, BookingStep };
/** Days fetched per availability request. */
const FETCH_DAYS = 14;
/** Days per page: the week grid and the 空席表. */
const GRID_DAYS = 5;
const MATRIX_DAYS = 7;
/** Below this mount width the week grid becomes a day strip and slot list. */
const COMPACT_WIDTH = 640;
/** Party sizes shown as pills; larger sizes go in a select. */
const PARTY_PILLS = 8;
/** The party size chosen for the visitor until they choose another. */
const DEFAULT_PARTY_SIZE = 2;
/** Staff cards shown before 「すべて表示」. */
const STAFF_VISIBLE = 8;
/** Question selects with this many options or fewer render as radio cards. */
const SELECT_AS_CHOICES = 6;
const MAX_RECEIPT_POLLS = 20;

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
        size: turnstileSize(slot),
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

interface Parts {
  steps: HTMLElement[];
  chip: HTMLElement;
  chipLabel: HTMLElement;
  chipValue: HTMLElement;
  notice: HTMLElement;
  holdBar: HTMLElement;
  sections: Record<BookingStep, HTMLElement>;
  headings: Partial<Record<BookingStep, HTMLElement>>;
  /** The service step's variant and practitioner choices, redrawn per service. */
  serviceDetails: HTMLElement;
  picker: HTMLElement;
  holdChallenge: HTMLElement | null;
  summary: HTMLElement;
  terms: HTMLElement;
  submitChallenge: HTMLElement | null;
  submit: HTMLButtonElement;
  form: HTMLFormElement;
  errorSummary: HTMLElement;
  honeypot: HTMLInputElement;
  status: HTMLElement;
}

export class BookingController {
  readonly ready: Promise<void>;
  definition: ReservationPublicDefinition | null = null;
  /** The flow of the loaded definition. */
  flow: BookingFlow = 'time_slot';
  /** The steps of this flow, in order. */
  steps: BookingStep[] = stepsOf('time_slot');
  step: BookingStep = 'select';
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
  /** Where relative consent privacy links open (live mounts). */
  private readonly siteOrigin: string | null;
  private body: HTMLElement;
  /** A hold dropped by a selection change, still named as `replaceHoldToken` on the next hold. */
  private staleHoldToken: string | null = null;
  /** Only the newest availability response is drawn. */
  private availabilitySeq = 0;
  private declaration: FormDeclaration | null = null;
  private context: QuestionContext = {};
  private result: SubmissionResult | null = null;
  private shownErrors = new Map<string, string>();
  private attempt: Attempt | null = null;
  /** Availability of the current selection, by venue date. */
  private days = new Map<string, AvailabilityDay>();
  /** The first venue date of the visible page. */
  private pageStart = '';
  /** The day whose times the compact list shows. */
  private chosenDate: string | null = null;
  /** The mount is narrower than COMPACT_WIDTH: day strip + slot list instead of the week grid. */
  private compact = false;
  /** Announce the period after the visitor pages. */
  private announcePage = false;
  private holdTimer: ReturnType<typeof setInterval> | null = null;
  private receiptTimer: ReturnType<typeof setTimeout> | null = null;
  private blockedUntil = 0;
  private lastHeight = 0;
  private readySent = false;
  private holdChallenge: Challenge | null = null;
  private submitChallenge: Challenge | null = null;
  private parts: Parts | null = null;

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
      this.siteOrigin = typeof config.siteOrigin === 'string' && isWebOrigin(config.siteOrigin) ? config.siteOrigin : (this.embed?.parentOrigin ?? null);
    } else {
      const log = h('pre', { class: 'yb-preview-log' }, UI.previewNothing);
      const api = config.definition ? previewApi(config, this.now, (entry) => (log.textContent = JSON.stringify(entry, null, 2))) : null;
      this.api = api ?? (null as unknown as BookingApi);
      this.previewLog = api?.sent ?? null;
      this.embed = null;
      this.bookingOrigin = null;
      this.siteOrigin = null;
      root.setAttribute('data-yb-preview', 'true');
      root.append(previewMarker(config.source, log));
    }

    // Embedded (an iframe or the in-page preview): no page background and no card, the host page shows through.
    root.setAttribute('data-yb-frame', (config.mode === 'live' && config.embed) || config.mode === 'preview' ? 'embed' : 'page');
    this.body = h('div', { class: 'yb-body' });
    root.append(this.body);
    this.post('status', { status: 'loading' });
    this.observeSize();
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
    this.body.replaceChildren(
      h(
        'div',
        { class: 'yb-card yb-card-loading' },
        h('p', { class: 'yb-loading yb-sr', role: 'status' }, UI.loading),
        h('div', { class: 'yb-skeleton-header', 'aria-hidden': 'true' }, h('span', { class: 'yb-bone yb-bone-chip' }), h('span', { class: 'yb-bone yb-bone-title' }), h('span', { class: 'yb-bone yb-bone-steps' })),
        pickerSkeleton('grid', GRID_DAYS),
      ),
    );
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
    const flow = flowOf(d);
    if (!flow) return `mode ${String(d.setup.mode)}/${String(d.setup.presentation)} is not supported by this version of the booking UI`;
    const section = sectionProblem(d, flow);
    if (section) return section;
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
    const box = h('div', { class: 'yb-card yb-unavailable', role: 'alert' }, icon('info', 'yb-icon yb-unavailable-icon'), h('p', { class: 'yb-unavailable-message' }, message));
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

  /**
   * Draws the definition. `keep` is the selection before a reload: what is
   * still valid is kept. The flow always starts at the select step.
   */
  private render(definition: ReservationPublicDefinition, keep?: Selection): void {
    this.holdChallenge?.remove();
    this.submitChallenge?.remove();
    this.definition = definition;
    this.flow = flowOf(definition)!;
    this.steps = stepsOf(this.flow);
    const venue = definition.policies.timezone;
    this.displayTimeZone = venue;
    this.declaration = { contractVersion: 1, key: definition.setup.key, name: definition.setup.name, locale: 'ja', fields: definition.questions };
    this.context = reservationContext({ mode: definition.setup.mode as 'time_slot' | 'business', presentation: this.flow === 'time_slot' ? undefined : this.flow }, null);
    const turnstile = this.config.mode === 'live' ? (this.config.turnstile ?? definition.turnstile) : null;
    const loader = this.options.turnstile ?? loadTurnstile;
    this.holdChallenge = turnstile ? new Challenge(turnstile, loader) : null;
    this.submitChallenge = turnstile ? new Challenge(turnstile, loader) : null;
    this.selection = keptSelection(definition, keep);
    if (this.flow === 'party' && this.selection.partySize === undefined) {
      const { minSize, maxSize } = definition.party!;
      this.selection.partySize = Math.min(maxSize, Math.max(minSize, DEFAULT_PARTY_SIZE));
    }
    this.staleHoldToken = null;
    this.root.setAttribute('data-yb-flow', this.flow);
    this.compact = this.measureCompact();
    this.root.setAttribute('data-yb-layout', this.compact ? 'list' : 'grid');

    const labels = this.flow === 'party' ? UI.partyStepLabels : UI.stepLabels;
    const stepItems = this.steps.map((step, i) =>
      h('li', { class: 'yb-step', 'data-yb-step-item': step }, h('span', { class: 'yb-step-badge', 'aria-hidden': 'true' }, String(i + 1)), h('span', { class: 'yb-step-label' }, labels[i]!), h('span', { class: 'yb-sr yb-step-state' })),
    );
    const sections = Object.fromEntries(ALL_STEPS.map((step) => [step, h('section', { class: `yb-section yb-section-${step}`, hidden: true, 'data-yb-section': step })])) as Record<BookingStep, HTMLElement>;
    const notice = h('p', { class: 'yb-notice', role: 'alert', hidden: true, tabindex: '-1' });
    const holdBar = h('p', { class: 'yb-hold', role: 'status', hidden: true });
    const status = h('p', { class: 'yb-status yb-sr', role: 'status', 'aria-live': 'polite' });
    const headings: Partial<Record<BookingStep, HTMLElement>> = {};

    // Header: the duration chip, the setup name and the single location.
    const chipLabel = h('span', { class: 'yb-chip-label' });
    const chipValue = h('span', { class: 'yb-chip-value' });
    const chip = h('p', { class: 'yb-chip' }, icon('clock'), chipLabel, chipValue);
    const only = definition.locations.length === 1 ? definition.locations[0]! : null;
    const header = h(
      'header',
      { class: 'yb-header' },
      chip,
      h('p', { class: 'yb-title' }, definition.setup.name),
      ...(only ? [h('p', { class: 'yb-place' }, icon('pin'), h('span', { class: 'yb-sr' }, `${UI.locationInfo}：`), only.label)] : []),
    );

    // Step 1: the choices, then the picker.
    headings.select = h('h2', { class: 'yb-heading', tabindex: '-1' }, this.flow === 'party' ? UI.partySelectHeading : UI.selectHeading);
    const serviceDetails = h('div', { class: 'yb-service-details' });
    const controls = h('div', { class: 'yb-controls' });
    if (definition.locations.length > 1) controls.append(this.locationChoice(definition));
    if (this.flow === 'time_slot' && definition.appointment!.visitorChoosesHost && definition.appointment!.hosts.length) controls.append(this.hostChoice(definition));
    if (this.flow === 'service') controls.append(this.serviceChoice(definition), serviceDetails);
    if (this.flow === 'party') controls.append(this.partyChoice(definition));
    const picker = h('div', { class: 'yb-picker' });
    const holdChallenge = this.holdChallenge ? h('div', { class: 'yb-turnstile', role: 'group', 'aria-label': UI.verificationLabel }) : null;
    sections.select.append(headings.select, ...(controls.hasChildNodes() ? [controls] : []), picker, ...(holdChallenge ? [holdChallenge] : []));

    // Step 2: the held time, the questions, the terms and the submit button.
    headings.details = h('h2', { class: 'yb-heading', tabindex: '-1' }, UI.detailsHeading);
    const summary = h('div', { class: 'yb-summary' });
    const form = h('form', { class: 'yb-form yf-form', novalidate: true, 'aria-label': UI.detailsHeading });
    const errorSummary = h('div', { class: 'yf-error-summary', role: 'alert', tabindex: '-1', hidden: true });
    const fields = h('div', { class: 'yf-section' });
    const env: FieldEnv = {
      id: (key) => `${this.prefix}-${key}`,
      cls: (_slot, base) => base,
      hidden: {},
      changed: () => this.refresh(),
      blurred: (key) => this.onBlur(key),
      random: this.options.random ?? Math.random,
      selectAsChoices: SELECT_AS_CHOICES,
    };
    this.views = buildViews(definition.questions, env, fields);
    const honeypot = h('input', { type: 'text', name: 'hp_website', id: `${this.prefix}-hp`, tabindex: '-1', autocomplete: 'off' });
    const trap = h(
      'div',
      { class: 'yf-hp', 'aria-hidden': 'true', style: 'position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;overflow:hidden!important;' },
      h('label', { for: honeypot.id }, UI.honeypotLabel),
      honeypot,
    );
    const terms = h('div', { class: 'yb-terms' });
    const submitChallenge = this.submitChallenge ? h('div', { class: 'yb-turnstile', role: 'group', 'aria-label': UI.verificationLabel }) : null;
    const manual = definition.policies.confirmationMode === 'manual';
    const submit = h('button', { type: 'submit', class: 'yb-submit yb-button yb-button-lg' }, manual ? UI.submitManual : UI.submitAutomatic);
    form.append(errorSummary, fields, trap, terms, ...(submitChallenge ? [submitChallenge] : []), h('div', { class: 'yb-actions yb-actions-submit' }, submit));
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.submit();
    });
    sections.details.append(headings.details, summary, holdBar, form);
    this.openPolicyLinksOnSite(fields);

    this.body.replaceChildren(
      h(
        'div',
        { class: 'yb-card' },
        header,
        h('ol', { class: 'yb-steps', 'aria-label': UI.stepsLabel }, ...stepItems),
        notice,
        ...ALL_STEPS.map((step) => sections[step]),
        status,
      ),
    );
    this.parts = { steps: stepItems, chip, chipLabel, chipValue, notice, holdBar, sections, headings, serviceDetails, picker, holdChallenge, summary, terms, submitChallenge, submit, form, errorSummary, honeypot, status };
    if (this.flow === 'service') this.renderServiceDetails();
    this.renderHeader();
    this.shownErrors.clear();
    this.days.clear();
    this.pageStart = this.today();
    this.chosenDate = null;
    this.showStep('select', false);
    this.refresh();
    if (holdChallenge) void this.holdChallenge!.mount(holdChallenge);
    if (!this.readySent) {
      this.readySent = true;
      this.post('ready');
    }
    this.post('status', { status: 'ready' });
    void this.loadAvailability();
  }

  /**
   * Consent questions link their privacy policy by a site path. On the
   * booking origin such a path would open the booking host, so it is
   * resolved against the Website's origin when one is known.
   */
  private openPolicyLinksOnSite(fields: HTMLElement): void {
    if (!this.siteOrigin) return;
    for (const link of Array.from(fields.querySelectorAll<HTMLAnchorElement>('.yf-policy a[href^="/"]'))) {
      link.href = new URL(link.getAttribute('href')!, this.siteOrigin).href;
      link.rel = 'noopener noreferrer';
    }
  }

  /** A row of radio chips (the native radios stay focusable and keyboard-operable). */
  private chips(legend: string, className: string, options: { key: string; label: string; detail?: string; checked: boolean; data: Record<string, string>; onPick: () => void }[], name: string): HTMLElement {
    const fieldset = h('fieldset', { class: `yb-control yb-chips ${className}` }, h('legend', { class: 'yb-control-label' }, legend));
    const row = h('div', { class: 'yb-chip-row' });
    for (const option of options) {
      const id = `${this.prefix}-${name}-${option.key}`;
      const input = h('input', { type: 'radio', name: `${this.prefix}-${name}`, id, value: option.key, class: 'yb-choice-input', checked: option.checked, ...option.data });
      input.addEventListener('change', () => {
        if (input.checked) option.onPick();
      });
      row.append(
        h(
          'div',
          { class: 'yb-choice yb-option' },
          input,
          h('label', { for: id, class: 'yb-choice-label' }, h('span', { class: 'yb-option-label' }, option.label), ...(option.detail ? [h('span', { class: 'yb-option-detail' }, option.detail)] : [])),
        ),
      );
    }
    fieldset.append(row);
    return fieldset;
  }

  private locationChoice(definition: ReservationPublicDefinition): HTMLElement {
    return this.chips(
      UI.locationLegend,
      'yb-locations',
      definition.locations.map((location) => ({
        key: location.key,
        label: location.label,
        checked: this.selection.locationKey === location.key,
        data: {},
        onPick: () => this.changeSelection({ ...this.selection, locationKey: location.key }),
      })),
      'location',
    );
  }

  private hostChoice(definition: ReservationPublicDefinition): HTMLElement {
    return this.staffChoice(UI.hostLabel, 'host', definition.appointment!.hosts, this.selection.hostKey, (key) => {
      const { hostKey: _previous, ...rest } = this.selection;
      this.changeSelection(key ? { ...rest, hostKey: key } : rest);
    });
  }

  /**
   * Hosts or practitioners as a grid of radio cards (a salon can have twenty
   * or more): 「指定しない（おまかせ）」 first and the default, an initial per
   * person, a filter field and 「すべて表示」 when there are more than
   * STAFF_VISIBLE. Arrow keys move within the radio group.
   */
  private staffChoice(legend: string, name: string, people: { key: string; label: string }[], chosen: string | undefined, onPick: (key: string | undefined) => void, note?: string): HTMLElement {
    const group = `${this.prefix}-${name}`;
    const noteId = `${group}-note`;
    const fieldset = h('fieldset', { class: `yb-control yb-staff yb-${name}s`, ...(note ? { 'aria-describedby': noteId } : {}) }, h('legend', { class: 'yb-control-label' }, legend));
    const grid = h('div', { class: 'yb-staff-grid' });
    const card = (key: string, label: string, avatar: Node, index: number) => {
      const id = `${group}-${index}`;
      const input = h('input', { type: 'radio', name: group, id, value: key, class: 'yb-choice-input', checked: (chosen ?? '') === key, [`data-yb-${name}`]: key });
      input.addEventListener('change', () => {
        if (input.checked) onPick(key || undefined);
      });
      const box = h('div', { class: key ? 'yb-choice yb-staff-card' : 'yb-choice yb-staff-card yb-staff-any', 'data-yb-label': label }, input, h('label', { for: id, class: 'yb-choice-label' }, h('span', { class: 'yb-avatar', 'aria-hidden': 'true' }, avatar), h('span', { class: 'yb-staff-name' }, ...tokens(label))));
      grid.append(box);
      return box;
    };
    card('', UI.anyStaff, icon('users'), 0);
    const cards = people.map((person, i) => card(person.key, person.label, document.createTextNode(initialOf(person.label)), i + 1));
    fieldset.append(grid);
    if (people.length > STAFF_VISIBLE) {
      let expanded = false;
      const more = h('button', { type: 'button', class: 'yb-button-secondary yb-staff-more', 'aria-expanded': 'false' }, UI.showAllStaff(people.length));
      const empty = h('p', { class: 'yb-hint', hidden: true, role: 'status' }, UI.noStaffMatch);
      const search = h('input', { type: 'search', class: 'yb-input yb-staff-search', 'aria-label': UI.staffSearch(legend), placeholder: UI.staffSearchPlaceholder, autocomplete: 'off', enterkeyhint: 'search' });
      const apply = () => {
        const query = search.value.trim().toLowerCase();
        let shown = 0;
        cards.forEach((box, i) => {
          const checked = (box.querySelector('input') as HTMLInputElement).checked;
          const match = query ? box.getAttribute('data-yb-label')!.toLowerCase().includes(query) : expanded || i < STAFF_VISIBLE || checked;
          box.hidden = !match;
          if (match) shown++;
        });
        more.hidden = expanded || query !== '';
        empty.hidden = !query || shown > 0;
        this.postHeight();
      };
      search.addEventListener('input', apply);
      more.addEventListener('click', () => {
        expanded = true;
        more.setAttribute('aria-expanded', 'true');
        apply();
        (cards[STAFF_VISIBLE]?.querySelector('input') as HTMLInputElement | null)?.focus();
      });
      fieldset.insertBefore(search, grid);
      fieldset.append(empty, more);
      apply();
    }
    if (note) fieldset.append(h('p', { class: 'yb-hint', id: noteId }, note));
    return fieldset;
  }

  /**
   * A new selection: conditions on `booking.*` are recalculated (inactive
   * answers clear), the old availability is dropped, and a held time no
   * longer matches, so it is released locally and replaced explicitly by the
   * next hold. The picker reloads.
   */
  private changeSelection(next: Selection): void {
    this.selection = next;
    if (this.hold) {
      this.staleHoldToken = this.hold.holdToken;
      this.releaseHold();
    }
    this.days.clear();
    this.chosenDate = null;
    this.notice(null);
    this.renderHeader();
    this.refresh();
    if (this.step === 'select') void this.loadAvailability();
  }

  /** The services as chips, each with its duration (with variants, their range). */
  private serviceChoice(definition: ReservationPublicDefinition): HTMLElement {
    return this.chips(
      UI.serviceLegend,
      'yb-services',
      definition.services!.map((service) => {
        const durations = service.variants.map((v) => v.durationMinutes);
        const min = Math.min(...durations);
        const max = Math.max(...durations);
        return {
          key: service.key,
          label: service.label,
          detail: !durations.length ? UI.minutes(service.durationMinutes) : min === max ? UI.minutes(min) : UI.range(UI.minutes(min), UI.minutes(max)),
          checked: this.selection.serviceKey === service.key,
          data: { 'data-yb-service': service.key },
          onPick: () => {
            const { locationKey } = this.selection;
            this.changeSelection({ ...(locationKey !== undefined ? { locationKey } : {}), serviceKey: service.key });
            this.renderServiceDetails();
          },
        };
      }),
      'service',
    );
  }

  /** The chosen service's variants (each with its own duration) and practitioner preference. */
  private renderServiceDetails(): void {
    const p = this.parts!;
    const service = serviceOf(this.definition!, this.selection);
    const children: HTMLElement[] = [];
    if (service?.variants.length) {
      children.push(
        this.chips(
          UI.variantLegend,
          'yb-variants',
          service.variants.map((variant) => ({
            key: `${service.key}-${variant.key}`,
            label: variant.label,
            detail: UI.minutes(variant.durationMinutes),
            checked: this.selection.variantKey === variant.key,
            data: { 'data-yb-variant': variant.key },
            onPick: () => this.changeSelection({ ...this.selection, variantKey: variant.key }),
          })),
          'variant',
        ),
      );
    }
    if (service?.visitorChoosesPractitioner && service.practitioners.length) {
      children.push(
        this.staffChoice(
          UI.practitionerLabel,
          'practitioner',
          service.practitioners,
          this.selection.practitionerKey,
          (key) => {
            const { practitionerKey: _previous, ...rest } = this.selection;
            this.changeSelection(key ? { ...rest, practitionerKey: key } : rest);
          },
          UI.anyPractitionerNote,
        ),
      );
    }
    p.serviceDetails.replaceChildren(...children);
    p.serviceDetails.hidden = children.length === 0;
    this.postHeight();
  }

  /** 「ご利用人数」: pills for the first sizes, a select for the rest. */
  private partyChoice(definition: ReservationPublicDefinition): HTMLElement {
    const { minSize, maxSize } = definition.party!;
    const sizes = Array.from({ length: maxSize - minSize + 1 }, (_, i) => minSize + i);
    const pills = sizes.slice(0, PARTY_PILLS);
    const more = sizes.slice(PARTY_PILLS);
    const name = `${this.prefix}-party`;
    const hint = `${name}-hint`;
    const fieldset = h('fieldset', { class: 'yb-control yb-chips yb-party', 'aria-describedby': hint }, h('legend', { class: 'yb-control-label' }, icon('users'), UI.partyLegend));
    const row = h('div', { class: 'yb-chip-row yb-pill-row' });
    let select: HTMLSelectElement | null = null;
    let moreBox: HTMLElement | null = null;
    for (const size of pills) {
      const id = `${name}-${size}`;
      const input = h('input', { type: 'radio', name, id, value: String(size), class: 'yb-choice-input', checked: this.selection.partySize === size, 'data-yb-party': String(size) });
      input.addEventListener('change', () => {
        if (!input.checked) return;
        if (select) select.value = '';
        moreBox?.removeAttribute('data-yb-selected');
        this.changeSelection({ ...this.selection, partySize: size });
      });
      row.append(h('div', { class: 'yb-choice yb-pill' }, input, h('label', { for: id, class: 'yb-choice-label' }, h('span', { class: 'yb-pill-num' }, String(size)), h('span', { class: 'yb-pill-unit' }, '名'))));
    }
    if (more.length) {
      select = h(
        'select',
        { id: `${name}-more`, class: 'yb-select yb-party-size', 'aria-label': UI.partyMore(more[0]!) },
        h('option', { value: '' }, UI.partyMore(more[0]!)),
        ...more.map((size) => h('option', { value: String(size), selected: size === this.selection.partySize }, UI.partyOption(size))),
      );
      const control = select;
      control.addEventListener('change', () => {
        const size = Number(control.value);
        if (!control.value || !more.includes(size)) return;
        for (const radio of Array.from(row.querySelectorAll<HTMLInputElement>('input[type="radio"]'))) radio.checked = false;
        moreBox?.setAttribute('data-yb-selected', 'true');
        this.changeSelection({ ...this.selection, partySize: size });
      });
      moreBox = h('div', { class: 'yb-pill-more', 'data-yb-selected': more.includes(this.selection.partySize ?? -1) ? 'true' : undefined }, control);
      row.append(moreBox);
    }
    fieldset.append(row, h('p', { class: 'yb-hint', id: hint }, UI.partyRange(minSize, maxSize)));
    return fieldset;
  }

  /** 「カット（ロング）」, 「4名」 or null (time slot). */
  private selectionLabel(): string | null {
    const definition = this.definition!;
    if (this.flow === 'party') return this.selection.partySize === undefined ? null : UI.partyOption(this.selection.partySize);
    if (this.flow !== 'service') return null;
    const service = serviceOf(definition, this.selection);
    if (!service) return null;
    const variant = service.variants.find((v) => v.key === this.selection.variantKey);
    return variant ? `${service.label}（${variant.label}）` : service.label;
  }

  /** The duration chip: the selection's duration, or the range a service choice can have. */
  private renderHeader(): void {
    const p = this.parts;
    if (!p) return;
    const definition = this.definition!;
    let value: string | null = null;
    const minutes = durationOf(definition, this.selection);
    if (minutes !== null) value = UI.minutes(minutes);
    else if (this.flow === 'service') {
      const service = serviceOf(definition, this.selection);
      const all = (service ? [service] : definition.services!).flatMap((s) => (s.variants.length ? s.variants.map((v) => v.durationMinutes) : [s.durationMinutes]));
      const min = Math.min(...all);
      const max = Math.max(...all);
      value = min === max ? UI.minutes(min) : UI.range(UI.minutes(min), UI.minutes(max));
    }
    p.chipLabel.textContent = this.flow === 'party' ? UI.diningChip : UI.durationChip;
    p.chipValue.textContent = value ?? '';
    p.chip.hidden = value === null;
  }

  private showStep(step: BookingStep, focus = true): void {
    const p = this.parts!;
    this.step = step;
    for (const s of ALL_STEPS) p.sections[s].hidden = s !== step;
    const index = this.steps.indexOf(step);
    p.steps.forEach((li, i) => {
      const done = i < index;
      if (i === index) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
      li.classList.toggle('yb-step-done', done);
      const badge = li.querySelector('.yb-step-badge')!;
      badge.replaceChildren(done ? icon('check') : String(i + 1));
      li.querySelector('.yb-step-state')!.textContent = done ? UI.stepDone : '';
    });
    this.setState(step === 'outcome' ? 'done' : 'ready');
    this.root.setAttribute('data-yb-step', step);
    if (step === 'details') {
      this.renderDetails();
      if (p.submitChallenge) void this.submitChallenge!.mount(p.submitChallenge);
    }
    this.updateHoldBar();
    if (focus) p.headings[step]?.focus();
    this.postHeight();
  }

  private goTo(step: BookingStep): void {
    if (this.pending) return;
    this.notice(null);
    this.showStep(step);
    if (step === 'select') void this.loadAvailability();
  }

  private notice(message: string | null, focus = false): void {
    const p = this.parts;
    if (!p) return;
    p.notice.textContent = message ?? '';
    p.notice.hidden = !message;
    if (message && focus) p.notice.focus();
    this.postHeight();
  }

  // Layout -------------------------------------------------------------------

  private measureCompact(): boolean {
    const width = this.options.measureWidth ? this.options.measureWidth() : this.root.getBoundingClientRect().width;
    return Number.isFinite(width) && width > 0 && width < COMPACT_WIDTH;
  }

  /** Follows the mount's size: the parent's iframe height, and the grid / list switch. */
  private observeSize(): void {
    if (typeof ResizeObserver !== 'function') return;
    new ResizeObserver(() => {
      this.postHeight();
      const compact = this.measureCompact();
      if (compact === this.compact || !this.parts) return;
      this.compact = compact;
      this.root.setAttribute('data-yb-layout', compact ? 'list' : 'grid');
      // While a hint stands in for the picker (no menu chosen yet), there is no grid or list to redraw
      if (this.step === 'select' && this.flow !== 'party' && !this.pickerHint()) this.renderPicker();
    }).observe(this.root);
  }

  // Availability -----------------------------------------------------------

  private today(): string {
    return localDate(this.now(), this.definition!.policies.timezone);
  }

  /** The last bookable venue date. */
  private lastDate(): string {
    return addDays(this.today(), this.definition!.policies.bookingHorizonDays);
  }

  private pageDays(): number {
    return this.flow === 'party' ? MATRIX_DAYS : GRID_DAYS;
  }

  private pageDates(): string[] {
    return Array.from({ length: this.pageDays() }, (_, i) => addDays(this.pageStart, i));
  }

  /** Moves to the page containing `date` (pages start at today, every pageDays days). */
  private showPageOf(date: string): void {
    const today = this.today();
    const n = this.pageDays();
    const offset = Math.max(0, Math.min(daysBetween(today, date), daysBetween(today, this.lastDate())));
    this.pageStart = addDays(today, Math.floor(offset / n) * n);
    this.announcePage = true;
    void this.loadAvailability();
  }

  /** What blocks asking the server, as the picker's hint, or null. */
  private pickerHint(): string | null {
    const definition = this.definition!;
    const own = selectionProblem(definition, this.selection);
    if (own === 'service') return serviceOf(definition, this.selection) ? UI.chooseVariantFirst : UI.chooseServiceFirst;
    if (own === 'party') return UI.choosePartyFirst;
    if (definition.locations.length && !this.selection.locationKey) return UI.chooseLocationFirst;
    return null;
  }

  /** Fetches the availability the visible page still lacks (14 days at a time), then draws the picker. */
  async loadAvailability(): Promise<void> {
    const p = this.parts!;
    const definition = this.definition!;
    const seq = ++this.availabilitySeq;
    p.picker.removeAttribute('aria-busy');
    if (p.status.textContent === UI.loadingAvailability) p.status.textContent = '';
    const hint = this.pickerHint();
    if (hint) {
      p.picker.replaceChildren(h('div', { class: 'yb-picker-hint' }, icon('info'), h('p', { class: 'yb-hint' }, hint)));
      this.postHeight();
      return;
    }
    const today = this.today();
    const last = this.lastDate();
    const dates = this.pageDates();
    // Another display zone can move a slot across midnight: keep the neighbouring venue days too.
    const around = this.displayTimeZone === definition.policies.timezone ? dates : [addDays(dates[0]!, -1), ...dates, addDays(dates.at(-1)!, 1)];
    const missing = around.filter((d) => daysBetween(today, d) >= 0 && daysBetween(d, last) >= 0 && !this.days.has(d));
    if (!missing.length) return this.renderPicker();

    p.picker.replaceChildren(this.toolbar(), pickerSkeleton(this.flow === 'party' ? 'matrix' : this.compact ? 'list' : 'grid', this.pageDays()));
    p.picker.setAttribute('aria-busy', 'true');
    p.status.textContent = UI.loadingAvailability;
    this.postHeight();
    const from = missing[0]!;
    let to = addDays(from, FETCH_DAYS - 1);
    if (daysBetween(to, missing.at(-1)!) > 0) to = missing.at(-1)!;
    if (daysBetween(to, last) < 0) to = last;
    const result = await this.api.availability({ from, to, selection: { ...this.selection } });
    if (seq !== this.availabilitySeq || this.definition !== definition) return;
    p.picker.removeAttribute('aria-busy');
    p.status.textContent = '';
    if (!result.ok) {
      if (result.code === 'version_changed') return void this.versionChanged();
      if (result.code === 'setup_unavailable') return this.showUnavailable(UI.unavailable, false, 'unavailable');
      if (isInvalidSelection(result)) return this.selectionRejected();
      this.pickerError(this.errorMessage(result));
      return;
    }
    if (result.data.operationsRevision !== definition.setup.operationsRevision) return void this.versionChanged();
    for (const day of result.data.days) {
      if (!day || typeof day.date !== 'string') continue;
      this.days.set(day.date, { date: day.date, slots: Array.isArray(day.slots) ? day.slots : [], ...(typeof day.closed === 'boolean' ? { closed: day.closed } : {}) });
    }
    this.renderPicker();
  }

  /** The picker's error state with a retry. */
  private pickerError(message: string): void {
    const p = this.parts!;
    const retry = h('button', { type: 'button', class: 'yb-retry yb-button-secondary' }, UI.reloadAvailability);
    retry.addEventListener('click', () => {
      this.days.clear();
      void this.loadAvailability();
    });
    p.picker.replaceChildren(h('div', { class: 'yb-picker-hint yb-picker-error' }, h('p', { class: 'yb-error', role: 'alert' }, message), retry));
    this.postHeight();
  }

  /** The pager, the period and the time-zone label or switch. */
  private toolbar(): HTMLElement {
    const definition = this.definition!;
    const today = this.today();
    const n = this.pageDays();
    const dates = this.pageDates();
    const party = this.flow === 'party';
    const prev = pagerButton('prev', party ? UI.previousWeek : UI.previousPage, daysBetween(today, this.pageStart) <= 0, () => this.showPageOf(addDays(this.pageStart, -n)));
    const next = pagerButton('next', party ? UI.nextWeek : UI.nextPage, daysBetween(addDays(this.pageStart, n), this.lastDate()) < 0, () => this.showPageOf(addDays(this.pageStart, n)));
    prev.setAttribute('data-yb-focus', 'prev');
    next.setAttribute('data-yb-focus', 'next');
    const period = h('span', { class: 'yb-period' }, ...tokens(this.periodLabel(dates)));
    const bar = h('div', { class: party ? 'yb-toolbar yb-toolbar-matrix' : 'yb-toolbar' }, h('div', { class: 'yb-pager' }, prev, period, next));
    if (party) {
      const id = `${this.prefix}-jump`;
      const input = h('input', { type: 'date', id, class: 'yb-input yb-date-input', min: today, max: this.lastDate(), value: this.pageStart, 'data-yb-focus': 'jump' });
      input.addEventListener('change', () => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(input.value)) this.showPageOf(input.value);
      });
      bar.append(h('div', { class: 'yb-jump' }, h('label', { for: id, class: 'yb-jump-label' }, icon('calendar'), UI.jumpToDate), input));
    }
    const venue = definition.policies.timezone;
    const visitor = this.options.visitorTimeZone === undefined ? browserTimeZone() : this.options.visitorTimeZone;
    if (visitor && visitor !== venue && isTimeZone(visitor)) {
      const id = `${this.prefix}-tz`;
      const select = h('select', { id, class: 'yb-select yb-tz-select', 'data-yb-focus': 'tz', 'aria-describedby': `${id}-note` }, ...[venue, visitor].map((zone) => h('option', { value: zone, selected: zone === this.displayTimeZone }, timeZoneLabel(zone))));
      select.addEventListener('change', () => {
        this.displayTimeZone = select.value;
        this.rerenderTimes();
      });
      bar.append(h('div', { class: 'yb-tz' }, h('label', { for: id, class: 'yb-tz-label' }, icon('globe'), h('span', { class: 'yb-sr' }, UI.timeZoneLabel)), select, h('p', { class: 'yb-tz-note yb-sr', id: `${id}-note` }, UI.timeZoneNote(timeZoneLabel(venue)))));
    } else if (!party) {
      bar.append(h('p', { class: 'yb-tz' }, icon('globe'), timeZoneLabel(this.displayTimeZone)));
    }
    return bar;
  }

  /** 「2026年11月」 (grid) or 「11月1日（日）〜11月7日（土）」 (空席表). */
  private periodLabel(dates: string[]): string {
    const first = dates[0]!;
    const last = dates.at(-1)!;
    if (this.flow === 'party') return `${formatDateLabel(first)}〜${formatDateLabel(last)}`;
    const [y1, m1] = first.split('-').map(Number) as [number, number];
    const [y2, m2] = last.split('-').map(Number) as [number, number];
    if (y1 === y2 && m1 === m2) return UI.month(y1, m1);
    return UI.monthRange(UI.month(y1, m1), y1 === y2 ? `${m2}月` : UI.month(y2, m2));
  }

  /** The empty state of a page, with a jump to the next day with times when one is known. */
  private emptyPage(dates: string[], placed: Map<string, PlacedSlot[]>): HTMLElement {
    const box = h('div', { class: 'yb-empty' }, icon('calendar', 'yb-icon yb-empty-icon'), h('p', { class: 'yb-empty-text' }, UI.noSlotsInPage));
    const later = [...placed.keys()].filter((d) => daysBetween(dates.at(-1)!, d) > 0 && placed.get(d)!.length).sort()[0];
    if (later) {
      const jump = h('button', { type: 'button', class: 'yb-button-secondary yb-next-available' }, h('span', {}, ...tokens(UI.nextAvailable(formatDateLabel(later)))));
      jump.addEventListener('click', () => this.showPageOf(later));
      box.append(jump);
    }
    return box;
  }

  /** Draws the visible page: week grid, day list or 空席表. */
  private renderPicker(): void {
    const p = this.parts!;
    const definition = this.definition!;
    const focusKey = p.picker.contains(document.activeElement) ? (document.activeElement as HTMLElement).getAttribute('data-yb-focus') : null;
    const zone = this.displayTimeZone;
    const today = localDate(this.now(), zone);
    const dates = this.pageDates();
    const placed = placeSlots(this.days.values(), zone);
    const heldStart = this.hold ? Date.parse(this.hold.start) : null;
    const choose = (slot: Slot) => void this.acquireHold(slot);
    const children: HTMLElement[] = [this.toolbar()];
    if (this.flow === 'party') {
      const first = this.now() + definition.policies.minimumLeadMinutes * 60000;
      const firstParts = zoned(first, zone);
      const matrix = availabilityMatrix({
        dates,
        today,
        zone,
        earliest: { date: localDate(first, zone), minute: firstParts.hour * 60 + firstParts.minute },
        days: this.days,
        placed,
        heldStart,
        party: UI.partyOption(this.selection.partySize!),
        intervalMinutes: definition.policies.slotIntervalMinutes,
        onChoose: choose,
      });
      children.push(matrix ? h('div', { class: 'yb-matrix-wrap' }, matrix) : this.emptyPage(dates, placed), matrixLegend());
      const lead = definition.policies.minimumLeadMinutes;
      if (lead > 0) children.push(h('p', { class: 'yb-lead-note' }, UI.leadNote(UI.minutes(lead))));
    } else if (this.compact) {
      const withSlots = dates.filter((d) => placed.get(d)?.length);
      if (!this.chosenDate || !withSlots.includes(this.chosenDate)) this.chosenDate = withSlots[0] ?? null;
      children.push(
        dayList({
          dates,
          today,
          zone,
          placed,
          heldStart,
          chosen: this.chosenDate,
          onDay: (date) => {
            this.chosenDate = date;
            this.renderPicker();
            p.picker.querySelector<HTMLElement>(`[data-yb-date="${date}"]`)?.focus();
          },
          onChoose: choose,
          empty: this.emptyPage(dates, placed),
        }),
      );
    } else {
      const interval = definition.policies.slotIntervalMinutes;
      children.push(weekGrid({ dates, today, zone, placed, heldStart, rowMinutes: Math.min(60, Math.max(15, interval)), onChoose: choose, empty: this.emptyPage(dates, placed) }));
    }
    p.picker.replaceChildren(...children);
    if (focusKey) {
      const target = p.picker.querySelector<HTMLElement>(`[data-yb-focus="${focusKey}"]:not(:disabled)`) ?? p.picker.querySelector<HTMLElement>('[data-yb-focus]:not(:disabled)');
      target?.focus();
    }
    if (this.announcePage) {
      this.announcePage = false;
      p.status.textContent = this.periodLabel(dates);
    }
    this.postHeight();
  }

  private rerenderTimes(): void {
    if (this.step === 'select') void this.loadAvailability();
    if (this.step === 'details') this.renderDetails();
    this.updateHoldBar();
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
    const replace = this.hold?.holdToken ?? this.staleHoldToken;
    let result: ApiResult<HoldResponse>;
    try {
      result = await this.api.hold({
        selection: { ...this.selection },
        start: slot.start,
        ...(turnstileToken ? { turnstileToken } : {}),
        ...(replace ? { replaceHoldToken: replace } : {}),
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
    this.staleHoldToken = null;
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
        if (isInvalidSelection(result)) return this.selectionRejected();
        this.backToTimes(RESERVATION_API_ERRORS[result.code === 'validation_failed' ? 'slot_unavailable' : result.code].message);
        return;
      default:
        this.retryNotice(result);
    }
  }

  /** The held time is gone: back to the picker with fresh availability and a notice. */
  private backToTimes(message: string): void {
    this.releaseHold();
    this.days.clear();
    this.showStep('select', false);
    this.notice(message, true);
    void this.loadAvailability();
  }

  /**
   * The server answered `validation_failed` + `invalid_selection` (its
   * operations may have changed under the visitor): drop the hold, return to
   * the select step with a notice naming the choice to change, and wait for
   * the visitor (a retry or a new choice) rather than asking again.
   */
  private selectionRejected(): void {
    const definition = this.definition!;
    const choice: SelectionProblem = selectionProblem(definition, this.selection) ?? (this.flow === 'time_slot' ? 'date' : this.flow);
    if (this.hold) this.staleHoldToken = this.hold.holdToken;
    this.releaseHold();
    this.attempt = null;
    this.days.clear();
    this.availabilitySeq++;
    if (this.step !== 'select') this.showStep('select', false);
    this.pickerError(UI.availabilityFailed);
    this.notice(UI.invalidSelection[choice] ?? UI.invalidSelection.date!, true);
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

  /** The countdown while a hold is kept; on expiry, back to the picker with fresh availability. */
  private updateHoldBar(): void {
    const p = this.parts;
    if (!p) return;
    const hold = this.hold;
    if (!hold) {
      p.holdBar.hidden = true;
      return;
    }
    const left = Date.parse(hold.expiresAt) - this.now();
    if (left <= 0) {
      if (this.pending) return;
      if (this.step === 'details') this.backToTimes(UI.holdExpired);
      else this.releaseHold();
      return;
    }
    const seconds = Math.ceil(left / 1000);
    const text = UI.holdCountdown(`${Math.floor(seconds / 60)}分${String(seconds % 60).padStart(2, '0')}秒`);
    if (p.holdBar.textContent !== text) p.holdBar.replaceChildren(icon('clock'), h('span', {}, ...tokens(text)));
    p.holdBar.hidden = this.step !== 'details';
  }

  // Questions --------------------------------------------------------------

  private inputs(): View[] {
    return this.views.filter((v) => v.input);
  }

  /** The `booking.*` values of the held selection, as the server evaluates them. */
  contextValues(): Record<string, AnswerValue> {
    const definition = this.definition!;
    return contextValuesOf(definition, this.selection, this.hold ? localDateTime(Date.parse(this.hold.start), definition.policies.timezone) : null);
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
    if (this.shownErrors.size === 0 && this.parts) this.parts.errorSummary.hidden = true;
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
    p.errorSummary.replaceChildren(h('p', { class: 'yf-error-summary-title' }, UI.errorSummary), h('ul', {}, ...items));
    p.errorSummary.hidden = items.length === 0;
    if (first) first.focus();
    else if (items.length) p.errorSummary.focus();
    this.postHeight();
  }

  // Details: the held time and the booking terms ----------------------------

  /** The summary box (date, time, zone and the mode's choice) and the terms above the submit button. */
  private renderDetails(): void {
    const p = this.parts!;
    const definition = this.definition!;
    const hold = this.hold;
    if (!hold) return;
    const venue = definition.policies.timezone;
    const zone = this.displayTimeZone;
    const start = Date.parse(hold.start);
    const end = Date.parse(hold.end);
    const manual = definition.policies.confirmationMode === 'manual';
    const row = (label: string, value: string, key?: string) => h('div', { class: 'yb-review-row', ...(key ? { 'data-yb-field': key } : {}) }, h('dt', {}, label), h('dd', {}, value));
    const minutes = durationOf(definition, this.selection);

    const chosen: HTMLElement[] = [];
    const what = this.selectionLabel();
    if (what) chosen.push(row(this.flow === 'party' ? UI.reviewParty : UI.reviewService, what, `booking.${this.flow}`));
    if (this.flow === 'party' && minutes !== null) chosen.push(row(UI.reviewDiningDuration, UI.minutes(minutes)));
    const change = h('button', { type: 'button', class: 'yb-back yb-button-secondary' }, UI.changeDateTime);
    change.addEventListener('click', () => this.goTo('select'));
    p.summary.replaceChildren(
      h(
        'div',
        { class: 'yb-summary-main' },
        h('p', { class: 'yb-summary-label' }, icon('calendar'), UI.summaryWhen),
        h('p', { class: 'yb-summary-when' }, ...tokens(`${formatDateTime(start, zone)}〜${formatTime(end, zone)}`)),
        h('p', { class: 'yb-summary-tz' }, icon('globe'), timeZoneLabel(zone)),
        ...(zone === venue ? [] : [h('p', { class: 'yb-summary-venue' }, ...tokens(UI.reviewVenueTime(`${formatDateTime(start, venue)}〜${formatTime(end, venue)}　${timeZoneLabel(venue)}`)))]),
        ...(chosen.length ? [h('dl', { class: 'yb-review yb-summary-list' }, ...chosen)] : []),
      ),
      change,
    );

    const rows: HTMLElement[] = [];
    if (this.flow !== 'party' && minutes !== null) rows.push(row(UI.reviewDuration, UI.minutes(minutes)));
    const location = definition.locations.find((l) => l.key === this.selection.locationKey);
    if (location) rows.push(row(UI.reviewLocation, location.label));
    if (this.flow === 'time_slot' && hold.hostLabel) rows.push(row(UI.reviewHost, hold.hostLabel));
    if (this.flow === 'service' && serviceOf(definition, this.selection)?.visitorChoosesPractitioner) {
      rows.push(row(UI.reviewPractitioner, typeof hold.practitionerLabel === 'string' ? hold.practitionerLabel : UI.reviewAnyPractitioner));
    }
    const policy = manual ? UI.policyManual(definition.policies.approvalWindowMinutes ? UI.minutes(definition.policies.approvalWindowMinutes) : null) : UI.policyAutomatic;
    const cutoff = cutoffNotice(start - this.now(), definition.policies.cancelCutoffMinutes, definition.policies.rescheduleCutoffMinutes);
    p.terms.replaceChildren(
      h('h3', { class: 'yb-terms-heading' }, UI.termsHeading),
      ...(rows.length ? [h('dl', { class: 'yb-review' }, ...rows)] : []),
      h('p', { class: manual ? 'yb-policy yb-policy-manual' : 'yb-policy' }, icon(manual ? 'clock' : 'check'), h('span', {}, policy)),
      ...(cutoff ? [h('p', { class: 'yb-cutoff', role: 'note' }, icon('info'), h('span', {}, cutoff))] : []),
    );
    this.postHeight();
  }

  // Submission ---------------------------------------------------------------

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
    if (!hold) return this.goTo('select');
    this.notice(null);
    const result = this.refresh()!;
    if (Object.keys(result.fieldErrors).length || result.formErrors.length) return this.showErrors(result.fieldErrors, result.formErrors);
    this.parts!.errorSummary.hidden = true;
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
        if (formErrors.includes('invalid_selection')) return this.selectionRejected();
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
        this.backToTimes(message);
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
   * keep the choices and answers that still fit, drop the hold and start
   * again from the select step. Never resubmits by itself.
   */
  private async versionChanged(): Promise<void> {
    const before = new Map(this.inputs().map((v) => [v.node.key, { type: v.node.type, raw: v.read(), files: v.files() }]));
    const selection = { ...this.selection };
    const loaded = await this.api.definition(true);
    if (!loaded.ok) return this.showUnavailable(loaded.code === 'setup_unavailable' ? UI.unavailable : UI.loadFailed, loaded.code !== 'setup_unavailable', loaded.code === 'setup_unavailable' ? 'unavailable' : 'error');
    const problem = this.checkDefinition(loaded.data);
    if (problem) return this.showUnavailable(UI.unsupported, false, 'unavailable');
    this.releaseHold();
    this.render(loaded.data, selection);
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
    const tone = state === 'confirmed' ? 'success' : state === 'pending_approval' || state === 'confirming' ? 'pending' : 'neutral';
    const heading = h('h2', { class: 'yb-heading yb-outcome-heading', tabindex: '-1', 'data-yb-outcome': state }, headings[state]);
    p.headings.outcome = heading;
    const children: HTMLElement[] = [h('span', { class: 'yb-success-icon', 'aria-hidden': 'true' }, icon(tone === 'success' ? 'check' : tone === 'pending' ? 'clock' : 'info')), heading];
    const facts: HTMLElement[] = [];
    if (hold) {
      const start = Date.parse(hold.start);
      facts.push(
        h(
          'p',
          { class: 'yb-outcome-when' },
          icon('calendar'),
          h('span', {}, ...tokens(`${formatDateTime(start, venue)}〜${formatTime(Date.parse(hold.end), venue)}`), h('span', { class: 'yb-outcome-tz' }, timeZoneLabel(venue))),
        ),
      );
    }
    const what = hold ? this.selectionLabel() : null;
    if (what) facts.push(h('p', { class: 'yb-outcome-what' }, icon(this.flow === 'party' ? 'users' : 'check'), h('span', {}, what)));
    if (facts.length) children.push(h('div', { class: 'yb-outcome-facts' }, ...facts));
    if (state === 'pending_approval') {
      const deadline = data.approvalDeadline ? Date.parse(data.approvalDeadline) : NaN;
      if (!Number.isNaN(deadline)) children.push(h('p', { class: 'yb-outcome-deadline' }, ...tokens(UI.pendingDeadline(`${formatDateTime(deadline, venue)}（${timeZoneLabel(venue)}）`))));
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
          h('a', { class: 'yb-manage-link yb-button-secondary', href: manage, target: '_blank', rel: 'noopener noreferrer' }, UI.manageLink),
          h('p', { class: 'yb-manage-note' }, UI.manageNote),
        ),
      );
    }
    p.sections.outcome.replaceChildren(h('div', { class: 'yb-success', 'data-yb-tone': tone }, ...children));
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

/**
 * Applies validated theme tokens: colours as `--yb-*` custom properties,
 * `--yb-radius` in px, `data-yb-spacing`, and `data-yb-font` /
 * `data-yb-heading-font` (`sans` or `serif`, both Noto). `fontFamily` and
 * `headingFontFamily` stay valid but are ignored: Noto always wins.
 * `data-yb-themed` marks a mount with any token, so the restaurant default
 * palette gives way to the site's brand.
 */
export function applyTheme(root: HTMLElement, theme: ReservationTheme | null | undefined): void {
  if (!theme) return;
  const result = validateTheme(theme);
  if (!result.valid) {
    console.warn('[yatris booking] theme ignored:', result.errors.map((e) => `${e.path || '/'} ${e.code}`).join(', '));
    return;
  }
  const entries = Object.entries(result.theme!);
  if (entries.length) root.setAttribute('data-yb-themed', 'true');
  for (const [key, value] of entries) {
    if (key === 'spacing') root.setAttribute('data-yb-spacing', String(value));
    else if (key === 'radius') root.style.setProperty('--yb-radius', `${value}px`);
    else if (key === 'font') root.setAttribute('data-yb-font', String(value));
    else if (key === 'headingFont') root.setAttribute('data-yb-heading-font', String(value));
    else if (key === 'fontFamily' || key === 'headingFontFamily') continue;
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

const isMinutes = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0;
const isLabelled = (value: unknown): boolean => !!value && typeof (value as { key?: unknown }).key === 'string' && typeof (value as { label?: unknown }).label === 'string';

/** Why the definition's mode section cannot be drawn, or null. */
function sectionProblem(d: ReservationPublicDefinition, flow: BookingFlow): string | null {
  if (flow === 'time_slot') return d.appointment && isMinutes(d.appointment.durationMinutes) && Array.isArray(d.appointment.hosts) ? null : 'the appointment section is malformed';
  if (flow === 'service') {
    const ok =
      Array.isArray(d.services) &&
      d.services.length > 0 &&
      d.services.every((s) => isLabelled(s) && isMinutes(s.durationMinutes) && Array.isArray(s.variants) && s.variants.every((v) => isLabelled(v) && isMinutes(v.durationMinutes)) && Array.isArray(s.practitioners) && s.practitioners.every(isLabelled));
    return ok ? null : 'the services section is malformed';
  }
  const party = d.party;
  const size = (n: unknown) => typeof n === 'number' && Number.isInteger(n) && n >= 1;
  return party && size(party.minSize) && size(party.maxSize) && party.minSize <= party.maxSize && isMinutes(party.durationMinutes) ? null : 'the party section is malformed';
}

/** `validation_failed` with `formErrors: ["invalid_selection"]`: the server did not accept the selection. */
function isInvalidSelection(result: Extract<ApiResult<unknown>, { ok: false }>): boolean {
  return result.code === 'validation_failed' && Array.isArray(result.data?.formErrors) && (result.data.formErrors as unknown[]).includes('invalid_selection');
}

function validEmbed(embed: { instance: string; parentOrigin: string } | null | undefined): { instance: string; parentOrigin: string } | null {
  if (!embed) return null;
  if (typeof embed.instance === 'string' && new RegExp(INSTANCE_PATTERN).test(embed.instance) && isWebOrigin(embed.parentOrigin)) return { instance: embed.instance, parentOrigin: embed.parentOrigin };
  console.warn('[yatris booking] embed settings are invalid; no messages will be posted to the parent page');
  return null;
}

/** The avatar text of a staff card: two Latin initials, or the first character of a Japanese name. */
export function initialOf(label: string): string {
  const name = label.replace(/[（(].*$/u, '').trim() || label.trim();
  if (/^[A-Za-z]/.test(name)) return name.split(/\s+/).slice(0, 2).map((word) => word[0]!.toUpperCase()).join('');
  return [...name][0] ?? '・';
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
