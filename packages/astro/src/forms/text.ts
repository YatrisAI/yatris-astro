/**
 * Text rules shared by the declaration validator and the answer validator.
 * Every rule here is spelled out in contracts/forms/v1/README.md so the PHP
 * implementation can match it exactly; do not swap a regex for a library
 * call whose behavior differs between JavaScript and PHP (String#trim, for
 * example, does not treat U+0085 as whitespace while Unicode does).
 */

/** Unicode White_Space, listed explicitly. */
const WS = '\\t\\n\\u000B\\f\\r \\u0085\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF';
const TRIM = new RegExp(`^[${WS}]+|[${WS}]+$`, 'gu');
const ONLY_WS = new RegExp(`^[${WS}]*$`, 'u');

export function trim(value: string): string {
  return value.replace(TRIM, '');
}

export function isBlank(value: string): boolean {
  return ONLY_WS.test(value);
}

/** Length in Unicode code points, as JSON Schema and PHP's mb_strlen count. */
export function length(value: string): number {
  let n = 0;
  for (const _ of value) n++;
  return n;
}

export function nfkc(value: string): string {
  return value.normalize('NFKC');
}

/** CRLF and lone CR become LF. */
export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n?/g, '\n');
}

/** C0 controls and DEL. Single-line text allows none of them. */
export const LINE_PATTERN = '^[^\\u0000-\\u001F\\u007F]*$';
/** Multi-line text allows tab, LF and CR, and no other C0 control or DEL. */
export const MULTILINE_PATTERN = '^[^\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F\\u007F]*$';

const LINE = new RegExp(LINE_PATTERN, 'u');
const MULTILINE = new RegExp(MULTILINE_PATTERN, 'u');

export function isSingleLine(value: string): boolean {
  return LINE.test(value);
}

export function isMultiline(value: string): boolean {
  return MULTILINE.test(value);
}

export const EMAIL_PATTERN =
  "^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$";
const EMAIL = new RegExp(EMAIL_PATTERN, 'u');

export function isEmail(value: string): boolean {
  return length(value) <= 254 && EMAIL.test(value);
}

/**
 * A same-Website path: one leading slash, then printable ASCII URL
 * characters only. No scheme, no host, no backslash, no whitespace.
 */
export const PATH_PATTERN = "^/(?![/\\\\])[A-Za-z0-9\\-._~!$&'()*+,;=:@%/?#]*$";

const URL_HOST = '(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,62})(?:\\.[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]{0,62}))*|\\[[0-9A-Fa-f:.]+\\])';
const URL = new RegExp(`^(https?)://${URL_HOST}(?::[0-9]{1,5})?(?:[/?#][^\\s]*)?$`, 'iu');

/** An absolute http(s) URL with a host and no credentials. Returns its scheme. */
export function urlScheme(value: string): 'http' | 'https' | null {
  const m = URL.exec(value);
  return m ? (m[1]!.toLowerCase() as 'http' | 'https') : null;
}

const TEL = /^\+?[0-9()\- ]*[0-9][0-9()\- ]*$/u;

export function isTel(value: string): boolean {
  return TEL.test(value);
}

const HIRAGANA_TO_KATAKANA = /[ぁ-ゖ]/gu;
const KATAKANA_TO_HIRAGANA = /[ァ-ヶ]/gu;
const KATAKANA_ONLY = /^[ァ-ヺー・ ]+$/u;
const HIRAGANA_ONLY = /^[ぁ-ゖー・ ]+$/u;

/** NFKC (half-width to full-width kana, U+3000 to space), then hiragana to katakana. */
export function toKatakana(value: string): string {
  return nfkc(value).replace(HIRAGANA_TO_KATAKANA, (c) => String.fromCodePoint(c.codePointAt(0)! + 0x60));
}

export function toHiragana(value: string): string {
  return nfkc(value).replace(KATAKANA_TO_HIRAGANA, (c) => String.fromCodePoint(c.codePointAt(0)! - 0x60));
}

export function isKatakana(value: string): boolean {
  return KATAKANA_ONLY.test(value);
}

export function isHiragana(value: string): boolean {
  return HIRAGANA_ONLY.test(value);
}
