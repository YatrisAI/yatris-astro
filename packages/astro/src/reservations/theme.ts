import { canonicalJson } from '../forms/hash.js';
import { checkObject, tidy, type Issue, type PropSpec } from '../forms/spec.js';

/**
 * The embed theme contract (README "Theme"): the validated tokens a Website
 * passes to its hosted booking page. Colours, font stacks, a spacing scale
 * and a corner radius; never CSS, URLs or scripts. The same rules run in the
 * PHP twin, so every rule is a plain pattern, range or enum.
 */

export const THEME_COLOR_TOKENS = ['primary', 'onPrimary', 'background', 'surface', 'text', 'mutedText', 'border', 'error', 'focus'] as const;
export type ThemeColorToken = (typeof THEME_COLOR_TOKENS)[number];
export const THEME_SPACINGS = ['compact', 'comfortable', 'spacious'] as const;
export type ThemeSpacing = (typeof THEME_SPACINGS)[number];
/** The booking UI's typefaces: Noto Sans JP or Noto Serif JP (with system fallbacks). */
export const THEME_FONTS = ['sans', 'serif'] as const;
export type ThemeFont = (typeof THEME_FONTS)[number];

/** `#RRGGBB`, either case; normalized to lowercase. */
export const THEME_COLOR_PATTERN = '^#[0-9A-Fa-f]{6}$';
const FAMILY_START = '[\\p{L}\\p{M}0-9-]';
const FAMILY_REST = '[\\p{L}\\p{M}0-9 -]*';
const FAMILY = `(?: *"${FAMILY_START}${FAMILY_REST}" *| *${FAMILY_START}${FAMILY_REST})`;
/**
 * A font stack: comma-separated family names, each bare or wrapped in
 * straight double quotes. A name is letters of any script (`\p{L}`, with
 * combining marks `\p{M}`), ASCII digits, spaces and hyphens, and starts
 * with a non-space. Spaces may surround each item. Nothing else can appear:
 * no `url(`, semicolons, braces, backslashes, angle brackets or quotes
 * inside names.
 */
export const THEME_FONT_PATTERN = `^${FAMILY}(?:,${FAMILY})*$`;
export const THEME_FONT_MAX_LENGTH = 200;
export const THEME_RADIUS_MAX = 24;
/** The encoded theme (base64url) is at most this many characters. */
export const THEME_MAX_ENCODED_LENGTH = 1023;

const COLOR: PropSpec = { kind: 'string', pattern: THEME_COLOR_PATTERN };
const FONT: PropSpec = { kind: 'string', min: 1, max: THEME_FONT_MAX_LENGTH, pattern: THEME_FONT_PATTERN };

/** Theme properties: every key optional, unknown keys rejected. */
export const THEME: { props: Record<string, PropSpec>; required: readonly string[] } = {
  props: {
    ...Object.fromEntries(THEME_COLOR_TOKENS.map((token) => [token, COLOR])),
    fontFamily: FONT,
    headingFontFamily: FONT,
    font: { kind: 'string', enum: THEME_FONTS },
    headingFont: { kind: 'string', enum: THEME_FONTS },
    spacing: { kind: 'string', enum: THEME_SPACINGS },
    radius: { kind: 'integer', min: 0, max: THEME_RADIUS_MAX },
  },
  required: [],
};

export type ReservationTheme = Partial<Record<ThemeColorToken, string>> & {
  /** Accepted for compatibility; the booking UI ignores it and uses `font`. */
  fontFamily?: string;
  /** Accepted for compatibility; the booking UI ignores it and uses `headingFont`. */
  headingFontFamily?: string;
  /** Body text: Noto Sans JP (`sans`, the default) or Noto Serif JP (`serif`). */
  font?: ThemeFont;
  /** Headings and the setup name: `sans` (default) or `serif`. */
  headingFont?: ThemeFont;
  spacing?: ThemeSpacing;
  /** Corner radius in CSS pixels. */
  radius?: number;
};

export interface ThemeResult {
  valid: boolean;
  errors: Issue[];
  /** The normalized theme (colours lowercase, keys sorted); null when invalid. */
  theme: ReservationTheme | null;
}

const noNodes = (_value: unknown, path: string, issues: Issue[]) => void issues.push({ path, code: 'invalid_type' });

/**
 * Validates a theme. Shape issues use the forms codes (`unknown_property`,
 * `invalid_type`, `invalid_enum`, `pattern_mismatch`, `out_of_range`,
 * `too_short`, `too_long`); a theme whose encoding would exceed
 * THEME_MAX_ENCODED_LENGTH is `too_long` at path `""`.
 */
export function validateTheme(value: unknown): ThemeResult {
  const issues: Issue[] = [];
  checkObject(THEME.props, THEME.required, value, '', issues, noNodes);
  if (issues.length) return { valid: false, errors: tidy(issues), theme: null };
  const theme = normalizeTheme(value as ReservationTheme);
  if (encodeNormalized(theme).length > THEME_MAX_ENCODED_LENGTH) return { valid: false, errors: [{ path: '', code: 'too_long' }], theme: null };
  return { valid: true, errors: [], theme };
}

function normalizeTheme(theme: ReservationTheme): ReservationTheme {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(theme).sort()) {
    const value = (theme as Record<string, unknown>)[key];
    out[key] = (THEME_COLOR_TOKENS as readonly string[]).includes(key) ? (value as string).toLowerCase() : value;
  }
  return out as ReservationTheme;
}

/** base64url (no padding) of the canonical JSON of a normalized theme. */
function encodeNormalized(theme: ReservationTheme): string {
  const bytes = new TextEncoder().encode(canonicalJson(theme));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/**
 * The `theme` query parameter for a theme: base64url, without padding, of
 * the canonical JSON (forms §6) of the normalized theme. Throws a TypeError
 * for an invalid theme. An empty theme encodes to `e30`; callers omit the
 * parameter when there are no tokens.
 */
export function encodeTheme(value: unknown): string {
  const result = validateTheme(value);
  if (!result.valid) throw new TypeError(`Invalid reservation theme: ${result.errors.map((e) => `${e.path || '/'} ${e.code}`).join(', ')}`);
  return encodeNormalized(result.theme!);
}

/**
 * Decodes and validates a `theme` parameter. Anything that is not base64url
 * of UTF-8 JSON is `invalid_encoding` at `""`; longer than
 * THEME_MAX_ENCODED_LENGTH is `too_long` at `""`. The JSON need not be
 * canonical.
 */
export function decodeTheme(text: unknown): ThemeResult {
  const fail = (code: string): ThemeResult => ({ valid: false, errors: [{ path: '', code }], theme: null });
  if (typeof text !== 'string') return fail('invalid_type');
  if (text.length > THEME_MAX_ENCODED_LENGTH) return fail('too_long');
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) return fail('invalid_encoding');
  let value: unknown;
  try {
    const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/'));
    const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return fail('invalid_encoding');
  }
  return validateTheme(value);
}
