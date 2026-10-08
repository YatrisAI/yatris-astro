import type { PreviewBookingConfig } from './booking-client/types.js';
import type { ReservationsRuntime } from './reservations-config.js';
import { bookingPageUrl } from './reservations/embed.js';
import { SETUP_KEY_PATTERN } from './reservations/registry.js';
import { encodeTheme, validateTheme, type ReservationTheme } from './reservations/theme.js';

export type { ReservationsRuntime } from './reservations-config.js';

/**
 * What `<ReservationEmbed>` renders for one embed
 * (`@yatris/astro/reservations/mount`): the configuration written into the
 * page. Server-side only and pure. A live embed carries only public
 * identifiers (booking origin, Website id, setup key) and the validated,
 * encoded theme: never a Delivery, MCP, OAuth or SMTP value.
 */

export const DEFAULT_EMBED_TITLE = 'ご予約';

export interface ReservationEmbedProps {
  /** The setup key, e.g. "consultation" (the declaration `src/reservations/consultation.json`). */
  setupKey: string;
  /** Theme tokens (contract README "Theme"). Validated at build time. */
  theme?: ReservationTheme;
  /** The iframe's accessible title (default 「ご予約」). */
  title?: string;
}

interface EmbedBase {
  setupKey: string;
  title: string;
}

export type EmbedMountConfig =
  | (EmbedBase & {
      mode: 'live';
      bookingOrigin: string;
      websiteId: number;
      /** The encoded theme parameter, or null without tokens. */
      theme: string | null;
      /** The direct booking page (the fallback link). */
      directUrl: string;
    })
  | (EmbedBase & { mode: 'preview'; booking: PreviewBookingConfig })
  | (EmbedBase & { mode: 'unconfigured'; reason: string });

export function reservationEmbedConfig(runtime: ReservationsRuntime, props: ReservationEmbedProps): EmbedMountConfig {
  const setupKey = props.setupKey;
  if (typeof setupKey !== 'string' || !new RegExp(SETUP_KEY_PATTERN, 'u').test(setupKey)) {
    throw new Error(`<ReservationEmbed setupKey=${JSON.stringify(setupKey)}>: setupKey must be a setup key (${SETUP_KEY_PATTERN}), such as "consultation".`);
  }
  const title = props.title ?? DEFAULT_EMBED_TITLE;
  if (typeof title !== 'string' || title.trim() === '' || [...title].length > 200 || /[\u0000-\u001f\u007f]/.test(title)) {
    throw new Error(`<ReservationEmbed setupKey="${setupKey}">: title must be a single line of 1 to 200 characters.`);
  }
  let theme: ReservationTheme | null = null;
  if (props.theme !== undefined) {
    const result = validateTheme(props.theme);
    if (!result.valid) {
      throw new Error(`<ReservationEmbed setupKey="${setupKey}">: theme is invalid (${result.errors.map((e) => `${e.path || '/'} ${e.code}`).join(', ')}); see contracts/reservations/v1/README.md "Theme".`);
    }
    theme = Object.keys(result.theme!).length ? result.theme : null;
  }
  const base = { setupKey, title };
  switch (runtime.mode) {
    case 'live': {
      const encoded = theme ? encodeTheme(theme) : null;
      return { ...base, mode: 'live', bookingOrigin: runtime.bookingOrigin, websiteId: runtime.websiteId, theme: encoded, directUrl: bookingPageUrl({ origin: runtime.bookingOrigin, websiteId: runtime.websiteId, setupKey, theme: encoded }) };
    }
    case 'preview': {
      const entry = runtime.previews[setupKey];
      const source = entry?.source ?? `src/reservations/${setupKey}.json`;
      const booking: PreviewBookingConfig = entry
        ? { mode: 'preview', setupKey, source, theme, ...(entry.definition ? { definition: entry.definition } : {}), ...(entry.synthetic ? { synthetic: entry.synthetic } : {}), ...(entry.problem ? { problem: entry.problem } : {}) }
        : { mode: 'preview', setupKey, source, theme, problem: { message: `${source} がありません。プレビューする予約の宣言を作成してください。`, issues: [] } };
      return { ...base, mode: 'preview', booking };
    }
    default:
      return { ...base, mode: 'unconfigured', reason: runtime.reason };
  }
}

/** JSON safe to place inside `<script type="application/json">`: no `<`, `>`, `&` or line separators. */
export function serializeEmbedConfig(config: EmbedMountConfig): string {
  return JSON.stringify(config)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}
