import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import { gunzipSync } from 'node:zlib';

/**
 * Extracts an npm package tarball (gzipped ustar, with pax headers for long
 * names). Done here rather than with `tar`, because on Windows the `tar`
 * first on PATH may be GNU tar, which reads `C:\…` as a remote host.
 * Returns the extracted package directory (npm packs everything under
 * `package/`).
 */
export function extractTarball(file: string, into: string): string {
  const data = gunzipSync(readFileSync(file));
  let offset = 0;
  let paxPath: string | null = null;

  while (offset + 512 <= data.length) {
    const header = data.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;

    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    const prefix = field(header, 345, 155);
    const name = paxPath ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100));
    const body = data.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;

    if (type === 'x') {
      paxPath = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString('utf8'))?.[1] ?? null;
      continue;
    }
    paxPath = null;
    if (type !== '0' && type !== '\0') continue;

    const path = normalize(name);
    if (isAbsolute(path) || path.split(/[\\/]/).includes('..')) throw new Error(`refusing to extract ${name} outside the package`);
    const target = join(into, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, body);
  }

  return join(into, 'package');
}

function field(header: Buffer, start: number, length: number): string {
  const raw = header.subarray(start, start + length);
  const end = raw.indexOf(0);
  return raw.subarray(0, end === -1 ? length : end).toString('utf8');
}
