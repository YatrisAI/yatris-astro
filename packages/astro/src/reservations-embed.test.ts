// @vitest-environment happy-dom
// @vitest-environment-options {"settings":{"disableIframePageLoading":true,"disableJavaScriptFileLoading":true}}
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMBED_UI, IFRAME_SANDBOX, mountEmbeds, PARENT_MAX_HEIGHT, type ReservationEmbedController } from './reservations-embed.js';
import { reservationEmbedConfig, serializeEmbedConfig, type ReservationEmbedProps } from './reservations-mount.js';
import type { ReservationsRuntime } from './reservations-config.js';
import { encodeTheme } from './reservations/theme.js';

const BOOK = 'https://book.yatris.jp';
const PARENT = 'https://www.example.jp';
const INSTANCE = 'inst_0123456789abcdef';
const LIVE: ReservationsRuntime = { mode: 'live', bookingOrigin: BOOK, websiteId: 42 };

/** Renders what ReservationEmbed.astro renders for a live embed. */
function render(runtime: ReservationsRuntime, props: ReservationEmbedProps = { setupKey: 'consultation' }) {
  const config = reservationEmbedConfig(runtime, props);
  const root = document.createElement('div');
  root.className = 'yr-embed';
  root.setAttribute('data-yatris-booking', config.setupKey);
  root.setAttribute('data-yr-mode', config.mode);
  const script = document.createElement('script');
  script.type = 'application/json';
  script.setAttribute('data-yr-config', '');
  script.textContent = serializeEmbedConfig(config);
  const status = Object.assign(document.createElement('p'), { className: 'yr-status' });
  const frame = Object.assign(document.createElement('div'), { className: 'yr-frame' });
  root.append(script, status, frame);
  if (config.mode === 'preview') root.append(Object.assign(document.createElement('div'), { className: 'yr-preview-mount' }));
  document.body.replaceChildren(root);
  return { root, config };
}

function setup(props?: ReservationEmbedProps, options: Parameters<typeof mountEmbeds>[1] = {}) {
  const { root } = render(LIVE, props);
  const navigate = vi.fn();
  const [controller] = mountEmbeds(null, { parentOrigin: PARENT, newInstance: () => INSTANCE, navigate, ...options });
  // happy-dom loads no iframe page, so give the frame a window of its own.
  if (controller?.iframe) Object.defineProperty(controller.iframe, 'contentWindow', { value: { postMessage: vi.fn() } });
  return { root, controller: controller!, navigate };
}

const msg = (extra: Record<string, unknown>) => ({ source: 'yatris-booking', version: 1, instance: INSTANCE, ...extra });
const deliver = (controller: ReservationEmbedController, data: unknown, overrides: Partial<{ origin: string; source: unknown }> = {}) =>
  controller.receive({ origin: BOOK, source: controller.iframe?.contentWindow, data, ...overrides } as unknown as MessageEvent);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('<ReservationEmbed> parent', () => {
  it('creates an accessible, sandboxed iframe to the booking page', () => {
    const theme = { primary: '#4F46E5', radius: 8 };
    const { root, controller } = setup({ setupKey: 'consultation', theme, title: '無料相談のご予約' });
    const iframe = root.querySelector('iframe')!;
    expect(iframe.title).toBe('無料相談のご予約');
    expect(iframe.getAttribute('sandbox')).toBe(IFRAME_SANDBOX);
    expect(iframe.getAttribute('src')).toBe(`${BOOK}/book/42/consultation?embed=1&instance=${INSTANCE}&parentOrigin=https%3A%2F%2Fwww.example.jp&theme=${encodeTheme(theme)}`);
    expect(root.getAttribute('data-yr-state')).toBe('loading');
    expect(root.querySelector('.yr-status')!.textContent).toBe(EMBED_UI.loading);
    expect(controller.instance).toBe(INSTANCE);
  });

  it('defaults the title to ご予約 and carries only public identifiers', () => {
    const config = reservationEmbedConfig(LIVE, { setupKey: 'consultation' });
    expect(config).toEqual({ setupKey: 'consultation', title: 'ご予約', mode: 'live', bookingOrigin: BOOK, websiteId: 42, theme: null, directUrl: `${BOOK}/book/42/consultation` });
  });

  it('follows ready, height, status and navigate from its own iframe', () => {
    const { root, controller, navigate } = setup();
    expect(deliver(controller, msg({ type: 'ready' }))).not.toBeNull();
    expect(root.getAttribute('data-yr-state')).toBe('ready');
    expect(root.querySelector<HTMLElement>('.yr-status')!.hidden).toBe(true);
    deliver(controller, msg({ type: 'height', height: 812 }));
    expect(controller.iframe!.style.height).toBe('812px');
    deliver(controller, msg({ type: 'height', height: 20000 }));
    expect(controller.iframe!.style.height).toBe(`${PARENT_MAX_HEIGHT}px`);
    deliver(controller, msg({ type: 'status', status: 'submitted' }));
    expect(root.getAttribute('data-yr-submitted')).toBe('true');
    deliver(controller, msg({ type: 'navigate', path: '/thanks/' }));
    expect(navigate).toHaveBeenCalledWith('/thanks/');
  });

  it('silently drops messages from another origin, window or instance, and malformed ones', () => {
    const { root, controller, navigate } = setup();
    expect(deliver(controller, msg({ type: 'navigate', path: '/x/' }), { origin: 'https://evil.example' })).toBeNull();
    expect(deliver(controller, msg({ type: 'navigate', path: '/x/' }), { source: window })).toBeNull();
    expect(deliver(controller, msg({ type: 'navigate', path: '/x/', instance: 'other_0123456789abcd' }))).toBeNull();
    expect(deliver(controller, msg({ type: 'navigate', path: 'https://evil.example/' }))).toBeNull();
    expect(deliver(controller, msg({ type: 'height', height: 500, extra: 1 }))).toBeNull();
    expect(deliver(controller, msg({ type: 'close' }))).toBeNull();
    expect(navigate).not.toHaveBeenCalled();
    expect(root.getAttribute('data-yr-state')).toBe('loading');
  });

  it('listens on window and never posts to the iframe', () => {
    const listeners: ((event: Event) => void)[] = [];
    const target = { addEventListener: (_type: string, listener: (event: Event) => void) => listeners.push(listener), removeEventListener: vi.fn() };
    const { controller } = setup(undefined, { target: target as never });
    const post = (controller.iframe!.contentWindow as unknown as { postMessage: ReturnType<typeof vi.fn> }).postMessage;
    listeners[0]!({ origin: BOOK, source: controller.iframe!.contentWindow, data: msg({ type: 'ready' }) } as unknown as Event);
    expect(controller.state).toBe('ready');
    expect(post).not.toHaveBeenCalled();
  });

  it('offers a retry when the booking page never becomes ready, with a new instance', () => {
    vi.useFakeTimers();
    let n = 0;
    const { root, controller } = setup(undefined, { newInstance: () => `inst_${String(++n).padStart(16, '0')}`, readyTimeoutMs: 1000 });
    vi.advanceTimersByTime(1000);
    expect(root.getAttribute('data-yr-state')).toBe('error');
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.querySelector('.yr-status')!.textContent).toContain(EMBED_UI.loadFailed);
    root.querySelector<HTMLButtonElement>('.yr-retry')!.click();
    expect(root.getAttribute('data-yr-state')).toBe('loading');
    expect(controller.instance).toBe('inst_0000000000000002');
    expect(root.querySelector('iframe')!.getAttribute('src')).toContain('instance=inst_0000000000000002');
  });

  it('shows the unavailable and error states the booking page reports', () => {
    let { root, controller } = setup();
    deliver(controller, msg({ type: 'status', status: 'unavailable' }));
    expect(root.getAttribute('data-yr-state')).toBe('unavailable');
    expect(root.querySelector('.yr-status')!.textContent).toBe(EMBED_UI.unavailable);
    expect(root.querySelector('.yr-retry')).toBeNull();
    ({ root, controller } = setup());
    deliver(controller, msg({ type: 'status', status: 'error' }));
    expect(root.getAttribute('data-yr-state')).toBe('error');
    expect(root.querySelector('.yr-retry')).not.toBeNull();
  });

  it('never fakes a booking: an unpaired build or a preview without the dev module is unavailable', () => {
    const unconfigured = reservationEmbedConfig({ mode: 'unconfigured', reason: 'not paired' }, { setupKey: 'consultation' });
    expect(unconfigured).toEqual({ setupKey: 'consultation', title: 'ご予約', mode: 'unconfigured', reason: 'not paired' });
    const { root } = render({ mode: 'preview', previews: {} });
    expect(mountEmbeds(null)).toEqual([]);
    expect(root.getAttribute('data-yr-state')).toBe('unavailable');
    expect(root.querySelector('iframe')).toBeNull();
    expect(root.textContent).toContain(EMBED_UI.previewUnavailable);
  });

  it('refuses invalid props at build time', () => {
    expect(() => reservationEmbedConfig(LIVE, { setupKey: 'Consultation' })).toThrow(/setupKey must be a setup key/);
    expect(() => reservationEmbedConfig(LIVE, { setupKey: 'consultation', title: '' })).toThrow(/title/);
    expect(() => reservationEmbedConfig(LIVE, { setupKey: 'consultation', theme: { primary: 'red' } as never })).toThrow(/\/primary pattern_mismatch/);
    expect(() => reservationEmbedConfig(LIVE, { setupKey: 'consultation', theme: { css: 'x' } as never })).toThrow(/\/css unknown_property/);
  });
});
