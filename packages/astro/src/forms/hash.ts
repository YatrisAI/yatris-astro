/**
 * Hashing for definition digests and submission idempotency. Uses WebCrypto,
 * so it runs unchanged in the browser renderer and in Node.
 */

const encoder = new TextEncoder();

export async function sha256Hex(data: string | Uint8Array): Promise<string> {
  const bytes = typeof data === 'string' ? encoder.encode(data) : data;
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Canonical JSON: object keys sorted by UTF-16 code unit, no whitespace,
 * JSON.stringify string escaping (PHP: JSON_UNESCAPED_UNICODE |
 * JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS). Only integers
 * may appear as numbers; decimals are canonical strings by then.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error(`Canonical JSON allows integers only, got ${value}.`);
    return String(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  throw new Error(`Canonical JSON cannot encode ${typeof value}.`);
}

export interface HashedFilePart {
  field: string;
  sha256: string;
  size: number;
}

/**
 * The idempotency fingerprint of a submission request. It covers the exact
 * bytes of the `answers` part, so a retry must resend the same serialized
 * string (the renderer keeps it), plus every file part in send order.
 *
 *   sha256( "yatris-form-submission-v1\n"
 *         + publicKey + "\n" + version + "\n"
 *         + sha256hex(answers bytes) + "\n"
 *         + for each file part: field + ":" + sha256hex(bytes) + ":" + size + "\n" )
 */
export async function requestHash(publicKey: string, version: number, answersJson: string, files: HashedFilePart[]): Promise<string> {
  let input = `yatris-form-submission-v1\n${publicKey}\n${version}\n${await sha256Hex(answersJson)}\n`;
  for (const f of files) input += `${f.field}:${f.sha256}:${f.size}\n`;
  return sha256Hex(input);
}
