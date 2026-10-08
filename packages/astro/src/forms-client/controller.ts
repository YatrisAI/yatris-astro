import { validateSubmission, type FileDescriptor, type SubmissionResult } from '../forms/answers.js';
import { API_ERRORS, type ApiErrorCode } from '../forms/messages.js';
import type { PublicDefinition } from '../forms/public.js';
import { nodeType } from '../forms/registry.js';
import { flatten, type FormDeclaration } from '../forms/tree.js';
import { missingCapabilities, SUPPORTED_CONTRACT_VERSIONS } from './capabilities.js';
import { h } from './dom.js';
import { buildViews, describeFile, isSafePath, type FieldEnv, type View } from './fields.js';
import { loadTurnstile, turnstileSize, type TurnstileApi } from './turnstile.js';
import type { ClassSlot, MountConfig } from './types.js';
import { displayValue, fieldMessage, formMessage, UI } from './ui.js';

/**
 * One mounted form: loads the published definition, renders it, runs
 * conditions and validation on every change, and submits to Yatris with the
 * contract v1 wire format (README §6). It never claims success without an
 * `accepted` response and never falls back to a local preview.
 */

export interface MountOptions {
  /** Network access. Live mounts use the browser's fetch; preview mounts a synthetic one. */
  fetch?: typeof fetch;
  /** Moves to the success page after an accepted submission (default `location.assign`). */
  navigate?: (path: string) => void;
  /** Loads the Turnstile API (default: Cloudflare's script, on demand). */
  turnstile?: () => Promise<TurnstileApi>;
  /** Adds preview chrome around the form. */
  decorate?: (root: HTMLElement) => void;
  random?: () => number;
  now?: () => number;
}

type Step = 'input' | 'confirm' | 'done';

interface Attempt {
  key: string;
  answersJson: string;
  version: number;
  files: [string, File][];
}

type Loaded = { ok: true; definition: PublicDefinition } | { ok: false; message: string; retry: boolean };

const LOAD_TIMEOUT_MS = 15000;
const MAX_BLOCK_SECONDS = 600;
let mounts = 0;

export class FormController {
  readonly ready: Promise<void>;
  definition: PublicDefinition | null = null;
  views: View[] = [];
  step: Step = 'input';
  pending = false;

  private readonly prefix = `yf${++mounts}`;
  private readonly doFetch: typeof fetch;
  private readonly navigate: (path: string) => void;
  private readonly now: () => number;
  private body: HTMLElement;
  private declaration: FormDeclaration | null = null;
  private result: SubmissionResult | null = null;
  private shownErrors = new Map<string, string>();
  private attempt: Attempt | null = null;
  private blockedUntil = 0;
  private parts: {
    form: HTMLFormElement;
    summary: HTMLElement;
    notices: Record<'input' | 'confirm', HTMLElement>;
    submit: HTMLButtonElement;
    confirmSubmit: HTMLButtonElement | null;
    back: HTMLButtonElement | null;
    confirm: HTMLElement | null;
    confirmHeading: HTMLElement | null;
    confirmList: HTMLElement | null;
    steps: HTMLElement[];
    status: HTMLElement;
    success: HTMLElement;
    honeypot: HTMLInputElement;
    turnstileSlot: HTMLElement;
  } | null = null;
  private turnstile: { api: TurnstileApi; widget: string } | null = null;
  private turnstileState: 'idle' | 'loading' | 'ready' | 'failed' = 'idle';
  private token: string | null = null;

  constructor(
    readonly root: HTMLElement,
    readonly config: MountConfig,
    private readonly options: MountOptions = {},
  ) {
    this.doFetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
    this.navigate = options.navigate ?? ((path) => window.location.assign(path));
    this.now = options.now ?? Date.now;
    root.setAttribute('data-yf-mounted', 'true');
    root.replaceChildren();
    if (config.mode === 'preview') root.setAttribute('data-yf-preview', 'true');
    options.decorate?.(root);
    this.body = h('div', { class: 'yf-body' });
    root.append(this.body);
    this.ready = this.start();
  }

  private cls(slot: ClassSlot | null, base: string): string {
    const extra = slot ? this.config.classes?.[slot] : undefined;
    return extra ? `${base} ${extra}` : base;
  }

  private setState(state: string): void {
    this.root.setAttribute('data-yf-state', state);
  }

  private async start(): Promise<void> {
    const config = this.config;
    if (config.mode === 'unconfigured') {
      console.warn(`[yatris forms] "${config.form}" cannot load: ${config.reason}`);
      return this.showUnavailable(UI.unavailable, false);
    }
    if (config.mode === 'preview' && config.problem) {
      return this.showUnavailable(config.problem.message, false, config.problem.issues.map((i) => `${i.path || '/'} ${i.code}`));
    }
    await this.load();
  }

  /** Loads (or reloads after a failure) and renders the definition. */
  async load(): Promise<void> {
    this.setState('loading');
    this.body.replaceChildren(h('p', { class: 'yf-loading', role: 'status' }, UI.loading));
    const loaded = await this.fetchDefinition(false);
    if (!loaded.ok) return this.showUnavailable(loaded.message, loaded.retry);
    this.render(loaded.definition);
  }

  private definitionUrl(): string {
    return this.config.mode === 'live' ? this.config.definitionUrl : 'preview:definition';
  }

  private async fetchDefinition(revalidate: boolean): Promise<Loaded> {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS) : null;
    let response: Response;
    try {
      // Normal HTTP caching applies (Yatris sends an ETag); a stale-version refresh revalidates.
      response = await this.doFetch(this.definitionUrl(), {
        headers: { accept: 'application/json' },
        credentials: 'omit',
        cache: revalidate ? 'no-cache' : 'default',
        signal: controller?.signal,
      });
    } catch {
      return { ok: false, message: UI.loadFailed, retry: true };
    } finally {
      if (timer) clearTimeout(timer);
    }
    if (response.status === 404 || response.status === 410) return { ok: false, message: UI.unavailable, retry: false };
    if (!response.ok) return { ok: false, message: UI.loadFailed, retry: true };
    let definition: PublicDefinition;
    try {
      definition = (await response.json()) as PublicDefinition;
    } catch {
      return { ok: false, message: UI.loadFailed, retry: true };
    }
    const problem = this.checkDefinition(definition);
    if (problem) {
      console.warn(`[yatris forms] "${this.config.form}" cannot be shown by this renderer: ${problem}`);
      return { ok: false, message: UI.unsupported, retry: false };
    }
    return { ok: true, definition };
  }

  /** Why this renderer must not draw a definition, or null when it can draw all of it. */
  private checkDefinition(d: PublicDefinition): string | null {
    if (!d || typeof d !== 'object') return 'the definition is not an object';
    if (!SUPPORTED_CONTRACT_VERSIONS.includes(d.contractVersion)) return `contract version ${String(d.contractVersion)} is not supported`;
    if (!Array.isArray(d.capabilities) || !Array.isArray(d.fields) || !d.form || typeof d.form.version !== 'number' || !d.submission || typeof d.submission.endpoint !== 'string') {
      return 'the definition is malformed';
    }
    const missing = missingCapabilities(d.capabilities);
    if (missing.length) return `missing capabilities ${missing.join(', ')}`;
    const unknown = flatten(d.fields).filter((e) => !nodeType(e.node.type)).map((e) => String(e.node.type));
    if (unknown.length) return `unknown node types ${unknown.join(', ')}`;
    if (this.config.mode === 'live') {
      try {
        if (new URL(d.submission.endpoint, this.config.definitionUrl).origin !== new URL(this.config.definitionUrl).origin) return 'the submission endpoint is on another origin';
      } catch {
        return 'the submission endpoint is not a URL';
      }
    }
    return null;
  }

  private showUnavailable(message: string, retry: boolean, details: string[] = []): void {
    this.setState('unavailable');
    const box = h('div', { class: 'yf-unavailable', role: 'alert' }, h('p', { class: 'yf-unavailable-message' }, message));
    if (details.length) box.append(h('ul', { class: 'yf-unavailable-details' }, ...details.map((d) => h('li', {}, d))));
    if (retry) {
      const button = h('button', { type: 'button', class: 'yf-retry' }, UI.retry);
      button.addEventListener('click', () => void this.load());
      box.append(button);
    }
    this.body.replaceChildren(box);
  }

  // Rendering --------------------------------------------------------------

  private render(definition: PublicDefinition): void {
    this.removeTurnstile();
    this.definition = definition;
    this.declaration = {
      contractVersion: 1,
      key: definition.form.key,
      name: definition.form.name,
      locale: definition.form.locale as 'ja' | 'en',
      fields: definition.fields,
      uploads: definition.submission.uploads,
    };
    const confirmEnabled = definition.confirmStep?.enabled === true;
    const confirmStep = (definition.confirmStep ?? {}) as Record<string, string | undefined>;

    const env: FieldEnv = {
      id: (key) => `${this.prefix}-${key}`,
      cls: (slot, base) => this.cls(slot, base),
      hidden: this.config.hidden ?? {},
      changed: (key) => this.onChange(key),
      blurred: (key) => this.onBlur(key),
      random: this.options.random ?? Math.random,
    };

    const form = h('form', { class: this.cls('form', 'yf-form'), novalidate: true, 'aria-label': definition.form.name });
    const summary = h('div', { class: 'yf-error-summary', role: 'alert', tabindex: '-1', hidden: true });
    const section = h('div', { class: 'yf-section' });
    this.views = buildViews(definition.fields, env, section);
    this.warnUndeclaredHidden();

    // A visually hidden trap field; people never see or reach it.
    const honeypot = h('input', { type: 'text', name: definition.submission.honeypotField, id: `${this.prefix}-hp`, tabindex: '-1', autocomplete: 'off' });
    const trap = h(
      'div',
      { class: 'yf-hp', 'aria-hidden': 'true', style: 'position:absolute!important;left:-10000px!important;top:auto!important;width:1px!important;height:1px!important;overflow:hidden!important;' },
      h('label', { for: honeypot.id }, UI.honeypotLabel),
      honeypot,
    );

    const turnstileSlot = h('div', { class: 'yf-turnstile', 'aria-label': UI.verificationLabel, role: 'group' });
    const submitLabel = String(definition.submit.label ?? UI.confirmSubmit);
    const submit = h('button', { type: 'submit', class: this.cls('submit', 'yf-submit') }, submitLabel);
    const inputNotice = h('p', { class: 'yf-form-error', role: 'alert', hidden: true });
    const actions = h('div', { class: this.cls('actions', 'yf-actions') });
    if (!confirmEnabled && definition.submission.turnstile) actions.append(turnstileSlot);
    actions.append(submit);
    form.append(summary, section, trap, inputNotice, actions);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      void this.onSubmit();
    });

    let confirm: HTMLElement | null = null;
    let confirmHeading: HTMLElement | null = null;
    let confirmList: HTMLElement | null = null;
    let confirmSubmit: HTMLButtonElement | null = null;
    let back: HTMLButtonElement | null = null;
    const confirmNotice = h('p', { class: 'yf-form-error', role: 'alert', hidden: true });
    if (confirmEnabled) {
      confirmHeading = h('h2', { class: 'yf-confirm-heading', tabindex: '-1' }, confirmStep.heading ?? UI.confirmHeading);
      confirmList = h('dl', { class: 'yf-confirm-list' });
      back = h('button', { type: 'button', class: 'yf-back' }, confirmStep.backLabel ?? UI.back);
      confirmSubmit = h('button', { type: 'button', class: this.cls('submit', 'yf-submit') }, confirmStep.submitLabel ?? UI.confirmSubmit);
      const confirmActions = h('div', { class: this.cls('actions', 'yf-actions') }, back);
      if (definition.submission.turnstile) confirmActions.append(turnstileSlot);
      confirmActions.append(confirmSubmit);
      confirm = h('section', { class: 'yf-confirm', hidden: true }, confirmHeading, h('p', { class: 'yf-confirm-intro' }, UI.confirmIntro), confirmList, confirmNotice, confirmActions);
      back.addEventListener('click', () => {
        if (this.pending) return;
        this.showStep('input');
        this.views.find((v) => v.input && v.el && !v.el.hidden)?.focusTarget()?.focus();
      });
      confirmSubmit.addEventListener('click', () => void this.onConfirm());
    }

    const steps = confirmEnabled ? UI.steps.map((label) => h('li', { class: 'yf-step' }, label)) : [];
    const stepList = confirmEnabled ? h('ol', { class: 'yf-steps', 'aria-label': UI.stepsLabel }, ...steps) : null;
    const status = h('p', { class: 'yf-status', role: 'status', 'aria-live': 'polite' });
    const success = h('div', { class: this.cls('success', 'yf-success'), tabindex: '-1', hidden: true });

    this.body.replaceChildren(...[stepList, form, confirm, status, success].filter((x): x is HTMLElement => x !== null));
    this.parts = {
      form,
      summary,
      notices: { input: inputNotice, confirm: confirmNotice },
      submit,
      confirmSubmit,
      back,
      confirm,
      confirmHeading,
      confirmList,
      steps,
      status,
      success,
      honeypot,
      turnstileSlot,
    };
    this.shownErrors.clear();
    this.showStep('input');
    this.refresh();
    if (definition.submission.turnstile && !confirmEnabled) void this.initTurnstile();
  }

  private warnUndeclaredHidden(): void {
    const declared = new Set(this.views.filter((v) => v.node.type === 'hidden').map((v) => v.node.key));
    const extra = Object.keys(this.config.hidden ?? {}).filter((k) => !declared.has(k));
    if (extra.length) console.warn(`[yatris forms] "${this.config.form}": hidden values for undeclared fields are ignored: ${extra.join(', ')}`);
  }

  private showStep(step: Step): void {
    const p = this.parts!;
    this.step = step;
    p.form.hidden = step !== 'input';
    if (p.confirm) p.confirm.hidden = step !== 'confirm';
    p.success.hidden = step !== 'done';
    const index = step === 'input' ? 0 : step === 'confirm' ? 1 : 2;
    p.steps.forEach((li, i) => {
      if (i === index) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
    this.setState(step === 'input' ? 'ready' : step);
    this.root.setAttribute('data-yf-step', step);
  }

  // Answers, conditions and validation -----------------------------------

  private inputs(): View[] {
    return this.views.filter((v) => v.input);
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
    return validateSubmission(this.declaration!, { answers, files }, { timeZone: this.config.timeZone, checkQuiz: false });
  }

  /**
   * Re-evaluates activity (A1 semantics): inactive nodes are hidden, inactive
   * inputs lose their value, errors and files. Then reflections, required
   * markers and the errors already on screen follow the new answers.
   */
  private refresh(): SubmissionResult {
    let result = this.validate();
    const active = new Set(result.active);
    let cleared = false;
    for (const view of this.views) {
      const on = active.has(view.node.key);
      if (view.el) view.el.hidden = !on;
      if (!on && view.input && view.node.type !== 'hidden') {
        if (view.read() !== undefined && view.read() !== false && !(Array.isArray(view.read()) && (view.read() as unknown[]).length === 0)) cleared = true;
        if (view.files().length) cleared = true;
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
      if (code && view) {
        this.shownErrors.set(key, code);
        view.setError(fieldMessage(code, view.node));
      } else {
        this.shownErrors.delete(key);
        view?.setError(null);
      }
    }
    if (this.shownErrors.size === 0 && this.parts) this.parts.summary.hidden = true;
    this.result = result;
    return result;
  }

  private onChange(_key: string): void {
    this.refresh();
  }

  /** On leaving a field, show a problem with what was typed (not "required": the visitor may come back). */
  private onBlur(key: string): void {
    const result = this.result;
    const view = this.views.find((v) => v.node.key === key);
    if (!result || !view) return;
    const code = result.fieldErrors[key];
    if (!code || code === 'required' || code === 'must_accept') return;
    this.shownErrors.set(key, code);
    view.setError(fieldMessage(code, view.node));
  }

  private showErrors(fieldErrors: Record<string, string>, formErrors: string[]): void {
    const p = this.parts!;
    if (this.step !== 'input') this.showStep('input');
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
      } else {
        items.push(h('li', {}, text));
      }
    }
    for (const code of formErrors) items.push(h('li', {}, formMessage(code)));
    p.summary.replaceChildren(h('p', { class: 'yf-error-summary-title' }, UI.errorSummary), h('ul', {}, ...items));
    p.summary.hidden = items.length === 0;
    if (first) first.focus();
    else if (items.length) p.summary.focus();
  }

  private notice(message: string | null): void {
    const p = this.parts;
    if (!p) return;
    for (const [step, el] of Object.entries(p.notices)) {
      const show = Boolean(message) && step === (this.step === 'confirm' ? 'confirm' : 'input');
      el.textContent = show ? message : '';
      el.hidden = !show;
    }
  }

  // Submission --------------------------------------------------------------

  private async onSubmit(): Promise<void> {
    if (this.pending || this.blocked()) return;
    this.notice(null);
    const result = this.refresh();
    if (Object.keys(result.fieldErrors).length || result.formErrors.length) {
      this.showErrors(result.fieldErrors, result.formErrors);
      return;
    }
    this.parts!.summary.hidden = true;
    if (this.definition!.confirmStep?.enabled === true) {
      this.showConfirm(result);
      return;
    }
    await this.send(result);
  }

  private async onConfirm(): Promise<void> {
    if (this.pending || this.blocked()) return;
    this.notice(null);
    const result = this.refresh();
    if (Object.keys(result.fieldErrors).length || result.formErrors.length) {
      this.showErrors(result.fieldErrors, result.formErrors);
      return;
    }
    await this.send(result);
  }

  private showConfirm(result: SubmissionResult): void {
    const p = this.parts!;
    const active = new Set(result.active);
    const rows: HTMLElement[] = [];
    for (const view of this.inputs()) {
      const { node } = view;
      if (!active.has(node.key) || node.type === 'hidden' || node.type === 'quiz') continue;
      const value = node.type === 'file' ? view.files() : result.answers[node.key];
      const text = value === undefined ? '' : displayValue(node, value);
      rows.push(h('div', { class: 'yf-confirm-row', 'data-yf-field': node.key }, h('dt', {}, String(node.label ?? node.key)), h('dd', {}, text || UI.empty)));
    }
    p.confirmList!.replaceChildren(...rows);
    this.showStep('confirm');
    p.confirmHeading!.focus();
    if (this.definition!.submission.turnstile) void this.initTurnstile();
  }

  private blocked(): boolean {
    return this.blockedUntil > this.now();
  }

  private setPending(pending: boolean): void {
    const p = this.parts!;
    this.pending = pending;
    this.root.classList.toggle('yf-pending', pending);
    if (pending) this.root.setAttribute('data-yf-pending', 'true');
    else this.root.removeAttribute('data-yf-pending');
    p.form.setAttribute('aria-busy', String(pending));
    const pendingLabel = String(this.definition!.submit.pendingLabel ?? UI.sending);
    for (const button of [p.submit, p.confirmSubmit, p.back]) {
      if (!button) continue;
      button.disabled = pending || this.blocked();
    }
    const active = this.step === 'confirm' ? p.confirmSubmit : p.submit;
    if (active) {
      if (pending) {
        active.dataset.label = active.textContent ?? '';
        active.textContent = pendingLabel;
      } else if (active.dataset.label !== undefined) {
        active.textContent = active.dataset.label;
        delete active.dataset.label;
      }
    }
    p.status.textContent = pending ? pendingLabel : '';
  }

  private async send(result: SubmissionResult): Promise<void> {
    if (this.pending) return;
    const definition = this.definition!;
    this.setPending(true);
    let finished = false;
    try {
      let token: string | null = null;
      if (definition.submission.turnstile) {
        token = this.turnstileToken();
        if (!token) {
          this.notice(this.turnstileState === 'failed' ? UI.verificationUnavailable : UI.verificationPending);
          return;
        }
      }

      const answers: Record<string, unknown> = { ...result.answers };
      const active = new Set(result.active);
      const files: [string, File][] = [];
      for (const view of this.inputs()) {
        if (!active.has(view.node.key)) continue;
        if (view.node.type === 'quiz') {
          const raw = view.read();
          if (raw !== undefined) answers[view.node.key] = raw;
        }
        if (view.node.type === 'file') for (const file of view.files()) files.push([view.node.key, file]);
      }
      const answersJson = JSON.stringify(answers);
      const version = definition.form.version;
      // One key per deliberate submission; a retry of the same payload reuses
      // it and resends the same answer bytes (the server's request hash).
      const previous = this.attempt;
      const attempt =
        previous && previous.answersJson === answersJson && previous.version === version && sameFiles(previous.files, files)
          ? previous
          : { key: newIdempotencyKey(), answersJson, version, files };
      this.attempt = attempt;

      const body = new FormData();
      body.append('version', String(attempt.version));
      body.append('answers', attempt.answersJson);
      // `[]` so PHP keeps every repeated part (README §6).
      for (const [key, file] of attempt.files) body.append(`files[${key}][]`, file, file.name);
      body.append('idempotencyKey', attempt.key);
      if (token) body.append('turnstileToken', token);
      body.append(definition.submission.honeypotField, this.parts!.honeypot.value);

      let response: Response;
      try {
        response = await this.doFetch(definition.submission.endpoint, { method: 'POST', body, credentials: 'omit', headers: { accept: 'application/json' } });
      } catch {
        this.notice(UI.networkError);
        return;
      }
      finished = await this.handleResponse(response);
    } finally {
      if (!finished) {
        this.setPending(false);
        // Turnstile tokens are single-use; the next attempt needs a fresh one.
        this.resetTurnstile();
      }
    }
  }

  /** Handles a submission response; true when the form is finished (accepted). */
  private async handleResponse(response: Response): Promise<boolean> {
    let data: Record<string, any> | null = null;
    try {
      data = (await response.json()) as Record<string, any>;
    } catch {
      data = null;
    }
    if (response.ok && data?.status === 'accepted') {
      this.accepted();
      return true;
    }

    const code = rejectionCode(response.status, data);
    const message = API_ERRORS[code].message;
    switch (code) {
      case 'validation_failed': {
        this.attempt = null;
        const fieldErrors = stringRecord(data?.fieldErrors);
        const formErrors = Array.isArray(data?.formErrors) ? (data!.formErrors as unknown[]).filter((c): c is string => typeof c === 'string') : [];
        this.notice(null);
        this.showErrors(fieldErrors, formErrors);
        if (!Object.keys(fieldErrors).length && !formErrors.length) this.notice(message);
        break;
      }
      case 'form_version_changed':
        await this.versionChanged();
        break;
      case 'rate_limited': {
        const seconds = retryAfterSeconds(response.headers.get('retry-after'), this.now());
        this.notice(seconds === null ? message : `${message}${UI.retryAfter(seconds)}`);
        if (seconds) this.block(seconds);
        break;
      }
      case 'verification_failed':
      case 'temporarily_unavailable':
        // Retryable as is: the input stays and a retry reuses the key.
        this.notice(message);
        break;
      default:
        // idempotency_conflict, payload_too_large, form_unavailable: the next
        // try is a fresh, deliberate submission.
        this.attempt = null;
        this.notice(message);
    }
    return false;
  }

  private block(seconds: number): void {
    const p = this.parts!;
    const wait = Math.min(seconds, MAX_BLOCK_SECONDS);
    this.blockedUntil = this.now() + wait * 1000;
    for (const button of [p.submit, p.confirmSubmit]) if (button) button.disabled = true;
    setTimeout(() => {
      if (this.pending) return;
      for (const button of [p.submit, p.confirmSubmit]) if (button) button.disabled = false;
    }, wait * 1000);
  }

  private accepted(): void {
    const p = this.parts!;
    const success = this.definition!.success as { mode?: string; message?: string; redirectPath?: string };
    this.attempt = null;
    this.resetAnswers();
    this.removeTurnstile();
    this.pending = false;
    this.root.classList.remove('yf-pending');
    this.root.removeAttribute('data-yf-pending');
    if (success.mode === 'redirect' && typeof success.redirectPath === 'string' && isSafePath(success.redirectPath)) {
      // The destination is fixed by the published definition, never by visitor input.
      this.setState('done');
      p.status.textContent = '';
      this.navigate(success.redirectPath);
      return;
    }
    p.success.replaceChildren(h('p', { class: 'yf-success-message' }, success.message ?? UI.defaultSuccess));
    p.status.textContent = '';
    this.showStep('done');
    p.success.focus();
  }

  /** Clears every visitor answer, so going back to the page never shows or resends them. */
  private resetAnswers(): void {
    for (const view of this.inputs()) {
      view.clear();
      view.setError(null);
    }
    this.shownErrors.clear();
    if (this.parts) {
      this.parts.honeypot.value = '';
      this.parts.summary.hidden = true;
    }
    this.notice(null);
  }

  /**
   * The published version changed under the visitor: reload it, keep only
   * answers that still fit, mark what changed, and wait for the visitor to
   * review and submit again. Never resubmits by itself.
   */
  private async versionChanged(): Promise<void> {
    const before = new Map(this.inputs().map((v) => [v.node.key, { node: v.node, raw: v.read(), files: v.files() }]));
    const loaded = await this.fetchDefinition(true);
    if (!loaded.ok) {
      if (loaded.message === UI.unsupported || loaded.message === UI.unavailable) return this.showUnavailable(loaded.message, false);
      this.notice(UI.versionReloadFailed);
      return;
    }
    this.attempt = null;
    this.render(loaded.definition);
    const changed: View[] = [];
    for (const view of this.inputs()) {
      if (view.node.type === 'hidden') continue;
      const old = before.get(view.node.key);
      if (!old || old.node.type !== view.node.type) {
        changed.push(view);
        continue;
      }
      const same = JSON.stringify(old.node) === JSON.stringify(view.node);
      const hadAnswer = old.raw !== undefined && old.raw !== false && !(Array.isArray(old.raw) && old.raw.length === 0);
      // Consent is given to a specific text, and a quiz question may differ: ask again.
      if ((view.node.type === 'acceptance' && !same) || view.node.type === 'quiz') {
        if (!same || hadAnswer) changed.push(view);
        continue;
      }
      const complete = view.restore(old.raw, old.files);
      if (!same || !complete) changed.push(view);
    }
    this.refresh();
    for (const view of changed) {
      if (!view.el) continue;
      view.el.setAttribute('data-yf-changed', 'true');
      view.el.append(h('p', { class: 'yf-changed-note' }, UI.changedField));
    }
    this.notice(API_ERRORS.form_version_changed.message);
    const firstChanged = changed.find((v) => v.el && !v.el.hidden)?.focusTarget();
    (firstChanged ?? this.parts!.notices.input).focus?.();
  }

  // Turnstile ---------------------------------------------------------------

  private async initTurnstile(): Promise<void> {
    const settings = this.definition?.submission.turnstile;
    if (!settings || this.turnstileState === 'loading' || this.turnstileState === 'ready') return;
    this.turnstileState = 'loading';
    const slot = this.parts!.turnstileSlot;
    try {
      const api = await (this.options.turnstile ?? loadTurnstile)();
      if (this.parts?.turnstileSlot !== slot) return; // re-rendered meanwhile
      const widget = api.render(slot, {
        sitekey: settings.siteKey,
        action: settings.action,
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
      this.turnstile = { api, widget };
      this.turnstileState = 'ready';
    } catch {
      this.turnstileState = 'failed';
    }
  }

  private turnstileToken(): string | null {
    if (this.token) return this.token;
    if (!this.turnstile) return null;
    return this.turnstile.api.getResponse(this.turnstile.widget) || null;
  }

  private resetTurnstile(): void {
    this.token = null;
    if (this.turnstile) this.turnstile.api.reset(this.turnstile.widget);
  }

  private removeTurnstile(): void {
    if (this.turnstile) this.turnstile.api.remove(this.turnstile.widget);
    this.turnstile = null;
    this.token = null;
    this.turnstileState = 'idle';
  }
}

function sameFiles(a: [string, File][], b: [string, File][]): boolean {
  return a.length === b.length && a.every(([key, file], i) => b[i]![0] === key && b[i]![1] === file);
}

/** 16–128 characters of [A-Za-z0-9_-] (README §6). */
export function newIdempotencyKey(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  return [...c.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The API error code of a rejected response; from the body, else from the HTTP status. */
export function rejectionCode(status: number, data: Record<string, any> | null): ApiErrorCode {
  if (data?.status === 'rejected' && typeof data.code === 'string' && Object.hasOwn(API_ERRORS, data.code)) return data.code as ApiErrorCode;
  if (status === 404 || status === 410) return 'form_unavailable';
  if (status === 409) return 'form_version_changed';
  if (status === 413) return 'payload_too_large';
  if (status === 429) return 'rate_limited';
  return 'temporarily_unavailable';
}

/** Seconds from a Retry-After header (delta seconds or an HTTP date). */
export function retryAfterSeconds(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}

function stringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === 'string'));
}
