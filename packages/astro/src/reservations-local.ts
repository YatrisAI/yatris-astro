import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { declarationFiles } from './forms-config.js';
import type { Issue } from './forms/spec.js';
import { RESERVATIONS_DIR } from './reservations-config.js';
import { validateSetup } from './reservations/setup.js';
import type { ReservationSetup } from './reservations/types.js';
import { sha256 } from './schema.js';

/**
 * The local setup declarations (`src/reservations/*.json`, never
 * `*.brief.json`), read and validated once for `reservations plan` and
 * `apply`, as forms-local.ts does for contact forms.
 */

export interface LocalSetup {
  key: string;
  /** Project-relative path, e.g. `src/reservations/consultation.json`. */
  path: string;
  /** `sha256:<hex>` of the file's bytes (plan staleness). */
  sha256: string;
  /** `sha256:<hex>` of the setup definition without `$schema` and `operations` (pull's baseline check). */
  definitionSha256: string;
  declaration: ReservationSetup;
  warnings: Issue[];
}

export interface InvalidSetup {
  path: string;
  /** `invalid_json` with the parser message, or validator issues. */
  json?: string;
  errors: Issue[];
  expectedKey: string;
}

export interface SetupScan {
  /** Directory as shown to people (project-relative). */
  shown: string;
  exists: boolean;
  valid: LocalSetup[];
  invalid: InvalidSetup[];
  /** Number of declaration files. */
  total: number;
}

export function scanSetups(cwd: string, dir: string = RESERVATIONS_DIR): SetupScan {
  const full = resolve(cwd, dir);
  const shown = relative(cwd, full).replaceAll('\\', '/') || '.';
  const scan: SetupScan = { shown, exists: existsSync(full), valid: [], invalid: [], total: 0 };
  if (!scan.exists) return scan;
  for (const name of declarationFiles(full)) {
    scan.total++;
    const path = `${shown}/${name}`;
    const expectedKey = name.slice(0, -'.json'.length);
    const bytes = readFileSync(join(full, name));
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
      scan.invalid.push({ path, json: (error as Error).message, errors: [], expectedKey });
      continue;
    }
    const result = validateSetup(value);
    const errors = [...result.errors];
    // The declaration lives at src/reservations/<key>.json (contract README §1).
    if (result.valid && (value as { key?: unknown }).key !== expectedKey) errors.push({ path: '/key', code: 'filename_mismatch' });
    if (errors.length) scan.invalid.push({ path, errors, expectedKey });
    else scan.valid.push({ key: expectedKey, path, sha256: sha256(bytes), definitionSha256: definitionSha256(value), declaration: value as ReservationSetup, warnings: result.warnings });
  }
  return scan;
}

/** `validate`-style lines for every declaration, in file order. */
export function setupScanLines(scan: SetupScan): string[] {
  const lines: string[] = [];
  const entries = [...scan.valid.map((v) => ({ path: v.path, valid: v })), ...scan.invalid.map((i) => ({ path: i.path, invalid: i }))].sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const entry of entries) {
    if ('invalid' in entry && entry.invalid) {
      const i = entry.invalid;
      if (i.json !== undefined) {
        lines.push(`✖ ${i.path}: invalid_json ${i.json}`);
        continue;
      }
      lines.push(`✖ ${i.path}: ${i.errors.length} error${i.errors.length === 1 ? '' : 's'}`);
      for (const issue of i.errors) lines.push(`    ${issue.path || '/'} ${issue.code}${issue.code === 'filename_mismatch' ? ` (key must be "${i.expectedKey}")` : ''}`);
    } else if ('valid' in entry && entry.valid) {
      lines.push(`✔ ${entry.path}: valid (${entry.valid.key})`);
      for (const issue of entry.valid.warnings) lines.push(`  ⚠ ${entry.path}: ${issue.path || '/'} ${issue.code}`);
    }
  }
  return lines;
}

/**
 * The setup definition of a declaration: everything but `$schema` (an editor
 * hint) and `operations` (the seed Yatris uses once, at creation). This is
 * what Yatris compares and what `get_reservation_setup` returns.
 */
export function setupDefinition(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const { $schema: _schema, operations: _operations, ...definition } = value as Record<string, unknown>;
  return definition;
}

/** A local hash of the setup definition (canonical JSON, no `$schema`, no `operations`). Never compared with Yatris digests. */
export function definitionSha256(value: unknown): string {
  return sha256(Buffer.from(canonical(setupDefinition(value))));
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
