import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { themeDecodeFixtures, themeValidateFixtures } from '../../test/reservations-theme-fixtures.js';
import { decodeTheme, encodeTheme, THEME_COLOR_TOKENS, THEME_MAX_ENCODED_LENGTH, validateTheme } from './index.js';

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/reservations/v1');
const UPDATE = process.env.YATRIS_UPDATE_CONTRACT === '1';

describe('theme validation fixtures', () => {
  it.each(themeValidateFixtures.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    const result = validateTheme(fixture.theme);
    expect(result.errors).toEqual(fixture.errors);
    expect(result.valid).toBe(fixture.errors.length === 0);
    expect(result.theme).toEqual(fixture.normalized);
    if (fixture.encoded === null) {
      expect(() => encodeTheme(fixture.theme)).toThrow(TypeError);
    } else {
      expect(encodeTheme(fixture.theme)).toBe(fixture.encoded);
      expect(fixture.encoded.length).toBeLessThanOrEqual(THEME_MAX_ENCODED_LENGTH);
      // Normalized key order is the canonical order.
      expect(Object.keys(result.theme!)).toEqual(Object.keys(result.theme!).sort());
    }
  });
});

describe('theme decoding fixtures', () => {
  it.each(themeDecodeFixtures.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    const result = decodeTheme(fixture.encoded);
    expect(result.errors).toEqual(fixture.errors);
    expect(result.theme).toEqual(fixture.theme);
  });

  it('round-trips every valid fixture', () => {
    for (const fixture of themeValidateFixtures.filter((f) => f.encoded !== null)) {
      expect(decodeTheme(fixture.encoded).theme).toEqual(fixture.normalized);
    }
  });
});

describe('theme contract coverage', () => {
  it('covers every colour token and every error code', () => {
    const tokens = new Set(themeValidateFixtures.flatMap((f) => (f.theme && typeof f.theme === 'object' ? Object.keys(f.theme) : [])));
    for (const token of [...THEME_COLOR_TOKENS, 'fontFamily', 'headingFontFamily', 'spacing', 'radius']) expect(tokens, token).toContain(token);
    const codes = new Set([...themeValidateFixtures, ...themeDecodeFixtures].flatMap((f) => f.errors.map((e) => e.code)));
    for (const code of ['unknown_property', 'invalid_type', 'invalid_enum', 'pattern_mismatch', 'out_of_range', 'too_short', 'too_long', 'invalid_encoding']) expect(codes, code).toContain(code);
  });

  it('publishes fixtures/theme.json', () => {
    const path = join(CONTRACT, 'fixtures/theme.json');
    const contents = `${JSON.stringify({ validate: themeValidateFixtures, decode: themeDecodeFixtures }, null, 2)}\n`;
    if (UPDATE) writeFileSync(path, contents);
    expect(existsSync(path), 'fixtures/theme.json is missing; run YATRIS_UPDATE_CONTRACT=1 npx vitest run packages/astro/src/reservations').toBe(true);
    expect(readFileSync(path, 'utf8'), 'fixtures/theme.json is stale; run YATRIS_UPDATE_CONTRACT=1 npx vitest run packages/astro/src/reservations').toBe(contents);
  });
});
