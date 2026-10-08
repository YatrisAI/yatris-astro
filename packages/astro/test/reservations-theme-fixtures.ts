/**
 * Source of contracts/reservations/v1/fixtures/theme.json (README "Theme").
 * Expectations are written by hand: issues in their exact order (sorted by
 * path, then code), the normalized theme, and the encoded parameter as the
 * base64url of a hand-written canonical JSON string (encoded with Node's
 * Buffer, independently of the implementation under test).
 */

type Json = any;
type IssueJson = { path: string; code: string };

const issue = (path: string, code: string): IssueJson => ({ path, code });
const b64 = (canonical: string) => Buffer.from(canonical, 'utf8').toString('base64url');

export interface ThemeValidateFixture {
  name: string;
  theme: Json;
  errors: IssueJson[];
  /** The normalized theme; null when invalid. */
  normalized: Json | null;
  /** encodeTheme(theme); null when invalid. */
  encoded: string | null;
}

export interface ThemeDecodeFixture {
  name: string;
  encoded: Json;
  errors: IssueJson[];
  /** The normalized theme; null when invalid. */
  theme: Json | null;
}

const valid = (name: string, theme: Json, normalized: Json, canonical: string): ThemeValidateFixture => ({ name, theme, errors: [], normalized, encoded: b64(canonical) });
const invalid = (name: string, theme: Json, ...errors: IssueJson[]): ThemeValidateFixture => ({ name, theme, errors, normalized: null, encoded: null });

const JP_STACK = '"Noto Sans JP", "ヒラギノ角ゴ ProN", Meiryo, sans-serif';
const LONG_JP = 'あ'.repeat(200);

export const themeValidateFixtures: ThemeValidateFixture[] = [
  valid('empty theme', {}, {}, '{}'),
  valid('one colour, uppercase normalized to lowercase', { primary: '#1A2B3C' }, { primary: '#1a2b3c' }, '{"primary":"#1a2b3c"}'),
  valid(
    'every token, keys sorted',
    {
      radius: 8,
      spacing: 'comfortable',
      primary: '#4F46E5',
      onPrimary: '#FFFFFF',
      background: '#ffffff',
      surface: '#F8FAFC',
      text: '#0F172A',
      mutedText: '#64748B',
      border: '#E2E8F0',
      error: '#B91C1C',
      focus: '#2563EB',
      fontFamily: JP_STACK,
      headingFontFamily: 'serif',
    },
    {
      background: '#ffffff',
      border: '#e2e8f0',
      error: '#b91c1c',
      focus: '#2563eb',
      fontFamily: JP_STACK,
      headingFontFamily: 'serif',
      mutedText: '#64748b',
      onPrimary: '#ffffff',
      primary: '#4f46e5',
      radius: 8,
      spacing: 'comfortable',
      surface: '#f8fafc',
      text: '#0f172a',
    },
    '{"background":"#ffffff","border":"#e2e8f0","error":"#b91c1c","focus":"#2563eb","fontFamily":"\\"Noto Sans JP\\", \\"ヒラギノ角ゴ ProN\\", Meiryo, sans-serif","headingFontFamily":"serif","mutedText":"#64748b","onPrimary":"#ffffff","primary":"#4f46e5","radius":8,"spacing":"comfortable","surface":"#f8fafc","text":"#0f172a"}',
  ),
  valid('radius bounds and compact spacing', { radius: 0, spacing: 'compact' }, { radius: 0, spacing: 'compact' }, '{"radius":0,"spacing":"compact"}'),
  valid('radius 24 and spacious spacing', { radius: 24, spacing: 'spacious' }, { radius: 24, spacing: 'spacious' }, '{"radius":24,"spacing":"spacious"}'),
  valid('bare family names with hyphens and digits', { fontFamily: 'system-ui, -apple-system, Segoe UI, M PLUS 1p' }, { fontFamily: 'system-ui, -apple-system, Segoe UI, M PLUS 1p' }, '{"fontFamily":"system-ui, -apple-system, Segoe UI, M PLUS 1p"}'),
  valid('Noto serif body with a sans heading', { headingFont: 'sans', font: 'serif' }, { font: 'serif', headingFont: 'sans' }, '{"font":"serif","headingFont":"sans"}'),
  valid('font next to the compatibility font stack', { font: 'sans', fontFamily: 'serif' }, { font: 'sans', fontFamily: 'serif' }, '{"font":"sans","fontFamily":"serif"}'),
  valid('a 200-character font stack', { fontFamily: 'a'.repeat(200) }, { fontFamily: 'a'.repeat(200) }, `{"fontFamily":"${'a'.repeat(200)}"}`),
  invalid('not an object', 'primary', issue('', 'invalid_type')),
  invalid('null', null, issue('', 'invalid_type')),
  invalid('unknown key', { css: 'body{}' }, issue('/css', 'unknown_property')),
  invalid('three-digit colour', { primary: '#fff' }, issue('/primary', 'pattern_mismatch')),
  invalid('named colour', { text: 'red' }, issue('/text', 'pattern_mismatch')),
  invalid('colour with a non-hex digit', { border: '#12345g' }, issue('/border', 'pattern_mismatch')),
  invalid('colour with alpha', { surface: '#11223344' }, issue('/surface', 'pattern_mismatch')),
  invalid('colour as a number', { focus: 123456 }, issue('/focus', 'invalid_type')),
  invalid('font with url(', { fontFamily: 'url(https://example.com/font.woff2)' }, issue('/fontFamily', 'pattern_mismatch')),
  invalid('font with a semicolon', { fontFamily: 'serif; color: red' }, issue('/fontFamily', 'pattern_mismatch')),
  invalid('font with braces', { fontFamily: 'serif}body{color:red' }, issue('/fontFamily', 'pattern_mismatch')),
  invalid('font with a backslash', { fontFamily: '\\66 ont' }, issue('/fontFamily', 'pattern_mismatch')),
  invalid('font with angle brackets', { headingFontFamily: '</style><script>' }, issue('/headingFontFamily', 'pattern_mismatch')),
  invalid('font with single quotes', { fontFamily: "'Noto Sans JP', sans-serif" }, issue('/fontFamily', 'pattern_mismatch')),
  invalid('font with an unbalanced quote', { fontFamily: '"Noto Sans JP, sans-serif' }, issue('/fontFamily', 'pattern_mismatch')),
  invalid('font with an empty item', { fontFamily: 'Arial,,serif' }, issue('/fontFamily', 'pattern_mismatch')),
  invalid('font with a quote inside a name', { fontFamily: 'Noto"Sans' }, issue('/fontFamily', 'pattern_mismatch')),
  invalid('empty font', { fontFamily: '' }, issue('/fontFamily', 'pattern_mismatch'), issue('/fontFamily', 'too_short')),
  invalid('font of 201 characters', { fontFamily: 'a'.repeat(201) }, issue('/fontFamily', 'too_long')),
  invalid('unknown spacing', { spacing: 'large' }, issue('/spacing', 'invalid_enum')),
  invalid('unknown font', { font: 'mincho' }, issue('/font', 'invalid_enum')),
  invalid('font as a family name', { headingFont: 'Noto Serif JP' }, issue('/headingFont', 'invalid_enum')),
  invalid('font as a number', { font: 1 }, issue('/font', 'invalid_type')),
  invalid('radius above 24', { radius: 25 }, issue('/radius', 'out_of_range')),
  invalid('negative radius', { radius: -1 }, issue('/radius', 'out_of_range')),
  invalid('fractional radius', { radius: 4.5 }, issue('/radius', 'invalid_type')),
  invalid('radius as a string', { radius: '4' }, issue('/radius', 'invalid_type')),
  invalid('several problems, sorted by path', { text: 'blue', radius: 99, css: 'x', primary: '#000' }, issue('/css', 'unknown_property'), issue('/primary', 'pattern_mismatch'), issue('/radius', 'out_of_range'), issue('/text', 'pattern_mismatch')),
  invalid('encoded theme over 1023 characters', { fontFamily: LONG_JP, headingFontFamily: LONG_JP }, issue('', 'too_long')),
];

export const themeDecodeFixtures: ThemeDecodeFixture[] = [
  { name: 'canonical encoding', encoded: b64('{"primary":"#1a2b3c","radius":6}'), errors: [], theme: { primary: '#1a2b3c', radius: 6 } },
  { name: 'non-canonical JSON is accepted and normalized', encoded: b64('{ "radius": 6, "primary": "#1A2B3C" }'), errors: [], theme: { primary: '#1a2b3c', radius: 6 } },
  { name: 'Japanese font stack', encoded: b64('{"fontFamily":"\\"ヒラギノ角ゴ ProN\\", sans-serif"}'), errors: [], theme: { fontFamily: '"ヒラギノ角ゴ ProN", sans-serif' } },
  { name: 'not a string', encoded: 42, errors: [issue('', 'invalid_type')], theme: null },
  { name: 'empty string', encoded: '', errors: [issue('', 'invalid_encoding')], theme: null },
  { name: 'padding is not allowed', encoded: 'e30=', errors: [issue('', 'invalid_encoding')], theme: null },
  { name: 'standard base64 alphabet is not allowed', encoded: Buffer.from('{"fontFamily":"???"}').toString('base64').replace(/=+$/, ''), errors: [issue('', 'invalid_encoding')], theme: null },
  { name: 'impossible length', encoded: 'e30xx', errors: [issue('', 'invalid_encoding')], theme: null },
  { name: 'not UTF-8', encoded: Buffer.from([0x7b, 0xff, 0x7d]).toString('base64url'), errors: [issue('', 'invalid_encoding')], theme: null },
  { name: 'not JSON', encoded: b64('primary=#ffffff'), errors: [issue('', 'invalid_encoding')], theme: null },
  { name: 'JSON that is not an object', encoded: b64('"#ffffff"'), errors: [issue('', 'invalid_type')], theme: null },
  { name: 'unknown key', encoded: b64('{"css":"body{}"}'), errors: [issue('/css', 'unknown_property')], theme: null },
  { name: 'longer than 1023 characters', encoded: 'A'.repeat(1024), errors: [issue('', 'too_long')], theme: null },
];
