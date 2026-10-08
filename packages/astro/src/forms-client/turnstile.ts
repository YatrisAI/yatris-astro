/**
 * Cloudflare Turnstile, loaded only for definitions that carry
 * `submission.turnstile`, and only from Cloudflare's own origin. A site with a
 * Content-Security-Policy must allow https://challenges.cloudflare.com for
 * scripts and frames.
 */

export const TURNSTILE_SCRIPT = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

export interface TurnstileApi {
  render(container: HTMLElement, options: Record<string, unknown>): string;
  reset(widget?: string): void;
  remove(widget: string): void;
  getResponse(widget?: string): string | undefined;
}

/** The normal widget is a fixed 300px; anything narrower gets the 150px compact one rather than pushing the layout wide. */
export function turnstileSize(slot: HTMLElement): 'normal' | 'compact' {
  const width = slot.getBoundingClientRect().width;
  return width > 0 && width < 300 ? 'compact' : 'normal';
}

let loading: Promise<TurnstileApi> | null = null;

export function loadTurnstile(): Promise<TurnstileApi> {
  const existing = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
  if (existing) return Promise.resolve(existing);
  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => {
      const api = (window as unknown as { turnstile?: TurnstileApi }).turnstile;
      if (api) resolve(api);
      else {
        loading = null;
        reject(new Error('Turnstile did not initialise'));
      }
    });
    script.addEventListener('error', () => {
      loading = null;
      reject(new Error('Turnstile could not be loaded'));
    });
    document.head.append(script);
  });
  return loading;
}
