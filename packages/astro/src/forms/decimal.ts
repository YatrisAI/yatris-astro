/**
 * Exact decimal arithmetic for number and range fields. Values travel as
 * canonical decimal strings ("12.5", "0", "-3") so 0.1 + 0.2 never matters
 * and zero is never confused with empty.
 */

export const DECIMAL_PATTERN = '^-?[0-9]+(\\.[0-9]+)?$';
const DECIMAL = new RegExp(DECIMAL_PATTERN);
const MAX_DIGITS = 30;

interface Scaled {
  value: bigint;
  scale: number;
}

/** Canonical form: no leading zeros, no trailing fractional zeros, no "-0". */
export function canonicalDecimal(input: string): string | null {
  if (!DECIMAL.test(input)) return null;
  const negative = input.startsWith('-');
  const [rawInt, rawFrac = ''] = (negative ? input.slice(1) : input).split('.');
  const int = rawInt!.replace(/^0+(?=\d)/, '');
  const frac = rawFrac.replace(/0+$/, '');
  if (int.length + frac.length > MAX_DIGITS) return null;
  const body = frac ? `${int}.${frac}` : int;
  return negative && body !== '0' ? `-${body}` : body;
}

/** Accepts a JSON number or a decimal string. Exponent notation is rejected. */
export function toDecimal(value: unknown): string | null {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null;
    return canonicalDecimal(String(value));
  }
  if (typeof value === 'string') return canonicalDecimal(value);
  return null;
}

function scaled(d: string): Scaled {
  const [int, frac = ''] = d.split('.');
  return { value: BigInt(int! + frac), scale: frac.length };
}

function align(a: string, b: string): [bigint, bigint] {
  const x = scaled(a);
  const y = scaled(b);
  const scale = Math.max(x.scale, y.scale);
  return [x.value * 10n ** BigInt(scale - x.scale), y.value * 10n ** BigInt(scale - y.scale)];
}

export function compareDecimal(a: string, b: string): number {
  const [x, y] = align(a, b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** True when (value - base) is a whole multiple of a positive step. */
export function onStep(value: string, base: string, step: string): boolean {
  const xs = [value, base, step].map(scaled);
  const scale = Math.max(...xs.map((x) => x.scale));
  const [v, b, s] = xs.map((x) => x.value * 10n ** BigInt(scale - x.scale)) as [bigint, bigint, bigint];
  return s > 0n && (v - b) % s === 0n;
}
