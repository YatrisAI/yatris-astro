import type { PreviewBookingConfig } from './booking-client/types.js';
import type { EmbedMountConfig } from './reservations-mount.js';
import { bookingEmbedUrl, isWebOrigin, newInstanceId, parseBookingMessage, type BookingMessage } from './reservations/embed.js';

/**
 * The parent side of `<ReservationEmbed>` (`@yatris/astro/reservations/embed`),
 * in the browser. It creates the booking iframe with a fresh instance id,
 * accepts protocol messages only from that iframe on the configured booking
 * origin (parseBookingMessage), follows `height`, `status` and `navigate`,
 * and shows loading, unavailable and retry states. It never posts messages
 * to the iframe. The direct-link fallback stays visible throughout.
 */

export const EMBED_UI = {
  loading: '予約画面を読み込んでいます…',
  unavailable: '現在、オンライン予約はご利用いただけません。',
  loadFailed: '予約画面を読み込めませんでした。通信状況をご確認のうえ、もう一度お試しいただくか、下のリンクから予約ページを開いてください。',
  retry: '再読み込み',
  previewUnavailable: 'このプレビューは astro dev で YATRIS_RESERVATIONS_PREVIEW=1 を設定したときだけ表示できます。',
};

/** The tallest the parent lets the iframe grow, in CSS pixels. */
export const PARENT_MAX_HEIGHT = 10000;
/** How long the parent waits for `ready` before offering a retry. */
export const READY_TIMEOUT_MS = 20000;
/** The iframe's sandbox: scripts, forms and its own origin; popups (new tabs) escape it; no top navigation. */
export const IFRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox';

/** The dev-only preview mounter (`@yatris/astro/booking/preview`); null in every build. */
export interface BookingPreviewModule {
  mountPreview(root: HTMLElement, config: PreviewBookingConfig): unknown;
}

export interface EmbedOptions {
  /** The embedding page's origin (default `location.origin`). */
  parentOrigin?: string;
  newInstance?: () => string;
  /** Navigates this page after a validated `navigate` message (default `location.assign`). */
  navigate?: (path: string) => void;
  readyTimeoutMs?: number;
  /** Where `message` events are listened for (default `window`). */
  target?: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

export type EmbedState = 'loading' | 'ready' | 'unavailable' | 'error';

type LiveConfig = Extract<EmbedMountConfig, { mode: 'live' }>;

export class ReservationEmbedController {
  state: EmbedState = 'loading';
  instance = '';
  iframe: HTMLIFrameElement | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly onMessage = (event: Event): void => {
    this.receive(event as MessageEvent);
  };
  private readonly target: Pick<Window, 'addEventListener' | 'removeEventListener'>;
  private readonly status: HTMLElement;
  private readonly frameBox: HTMLElement;

  constructor(
    readonly root: HTMLElement,
    readonly config: LiveConfig,
    private readonly options: EmbedOptions = {},
  ) {
    this.target = options.target ?? window;
    root.setAttribute('data-yr-mounted', 'true');
    this.status = root.querySelector<HTMLElement>('.yr-status') ?? root.appendChild(Object.assign(document.createElement('p'), { className: 'yr-status' }));
    this.status.setAttribute('role', 'status');
    this.frameBox = root.querySelector<HTMLElement>('.yr-frame') ?? root.insertBefore(Object.assign(document.createElement('div'), { className: 'yr-frame' }), this.status.nextSibling);
    this.target.addEventListener('message', this.onMessage);
    this.load();
  }

  /** (Re)creates the iframe with a new instance id. */
  load(): void {
    this.clear();
    const parentOrigin = this.options.parentOrigin ?? window.location.origin;
    if (!isWebOrigin(parentOrigin)) {
      console.warn('[yatris reservations] this page has no web origin, so the booking page cannot be embedded; use the direct link');
      this.setState('unavailable');
      return;
    }
    this.instance = (this.options.newInstance ?? newInstanceId)();
    const iframe = document.createElement('iframe');
    iframe.className = 'yr-iframe';
    iframe.title = this.config.title;
    iframe.setAttribute('sandbox', IFRAME_SANDBOX);
    iframe.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
    iframe.src = bookingEmbedUrl({ origin: this.config.bookingOrigin, websiteId: this.config.websiteId, setupKey: this.config.setupKey, instance: this.instance, parentOrigin, theme: this.config.theme });
    this.iframe = iframe;
    this.frameBox.replaceChildren(iframe);
    this.setState('loading');
    this.timer = setTimeout(() => {
      if (this.state === 'loading') this.fail();
    }, this.options.readyTimeoutMs ?? READY_TIMEOUT_MS);
  }

  private clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.iframe = null;
    this.frameBox.replaceChildren();
  }

  private fail(): void {
    this.clear();
    this.setState('error');
  }

  private setState(state: EmbedState): void {
    this.state = state;
    this.root.setAttribute('data-yr-state', state);
    this.frameBox.hidden = state === 'unavailable' || state === 'error';
    const text = state === 'loading' ? EMBED_UI.loading : state === 'unavailable' ? EMBED_UI.unavailable : state === 'error' ? EMBED_UI.loadFailed : '';
    this.status.replaceChildren(text);
    this.status.hidden = text === '';
    if (state === 'error') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'yr-retry';
      button.textContent = EMBED_UI.retry;
      button.addEventListener('click', () => this.load());
      this.status.append(' ', button);
    }
  }

  /** Handles one `message` event; anything that fails validation is dropped silently. */
  receive(event: MessageEvent): BookingMessage | null {
    if (!this.iframe) return null;
    const message = parseBookingMessage(event, { origin: this.config.bookingOrigin, frame: this.iframe, instance: this.instance });
    if (!message) return null;
    switch (message.type) {
      case 'ready':
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        if (this.state === 'loading') this.setState('ready');
        break;
      case 'height':
        this.iframe.style.height = `${Math.min(PARENT_MAX_HEIGHT, Math.max(1, message.height))}px`;
        break;
      case 'status':
        if (message.status === 'ready' || message.status === 'loading') {
          if (message.status === 'ready' && this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
          }
          this.setState(message.status);
        } else if (message.status === 'unavailable') {
          this.clear();
          this.setState('unavailable');
        } else if (message.status === 'error') {
          this.fail();
        } else {
          this.root.setAttribute('data-yr-submitted', 'true');
        }
        break;
      case 'navigate':
        (this.options.navigate ?? ((path: string) => window.location.assign(path)))(message.path);
        break;
    }
    return message;
  }

  destroy(): void {
    this.clear();
    this.target.removeEventListener('message', this.onMessage);
  }
}

/** Reads the configuration `<ReservationEmbed>` wrote into an embed element. */
export function readEmbedConfig(root: HTMLElement): EmbedMountConfig | null {
  const text = root.querySelector('script[data-yr-config]')?.textContent ?? '';
  try {
    const config = JSON.parse(text) as EmbedMountConfig;
    if (config && (config.mode === 'live' || config.mode === 'preview' || config.mode === 'unconfigured')) return config;
  } catch {
    // fall through
  }
  return null;
}

/**
 * Mounts every `<ReservationEmbed>` on the page that is not mounted yet.
 * `preview` is the dev-only preview module; it is null in every production
 * build, and a preview embed without it shows the unavailable state (never a
 * fake booking).
 */
export function mountEmbeds(preview: BookingPreviewModule | null = null, options: EmbedOptions = {}): ReservationEmbedController[] {
  const controllers: ReservationEmbedController[] = [];
  for (const root of Array.from(document.querySelectorAll<HTMLElement>('[data-yatris-booking]:not([data-yr-mounted])'))) {
    const config = readEmbedConfig(root);
    if (!config || config.mode === 'unconfigured') {
      root.setAttribute('data-yr-mounted', 'true');
      if (config) console.warn(`[yatris reservations] "${config.setupKey}" is unavailable: ${config.reason}`);
      continue;
    }
    if (config.mode === 'preview') {
      root.setAttribute('data-yr-mounted', 'true');
      const mount = root.querySelector<HTMLElement>('.yr-preview-mount') ?? root;
      if (!preview) {
        root.setAttribute('data-yr-state', 'unavailable');
        mount.replaceChildren(Object.assign(document.createElement('p'), { className: 'yr-status', textContent: EMBED_UI.previewUnavailable }));
        continue;
      }
      preview.mountPreview(mount, config.booking);
      continue;
    }
    controllers.push(new ReservationEmbedController(root, config, options));
  }
  return controllers;
}
