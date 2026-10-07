import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { declarationFiles, FORMS_DIR } from './forms-config.js';
import { validateDeclaration } from './forms/declaration.js';
import type { Issue } from './forms/spec.js';
import type { FormDeclaration } from './forms/tree.js';
import { sha256 } from './schema.js';

/**
 * The local declarations (`src/forms/*.json`, never `*.brief.json`), read and
 * validated once for `forms validate`, `plan`, `apply` and the doctor.
 */

export interface LocalDeclaration {
  key: string;
  /** Project-relative path, e.g. `src/forms/contact.json`. */
  path: string;
  /** `sha256:<hex>` of the file's bytes. */
  sha256: string;
  declaration: FormDeclaration;
  warnings: Issue[];
}

export interface InvalidDeclaration {
  path: string;
  /** `invalid_json` with the parser message, or validator issues. */
  json?: string;
  errors: Issue[];
  expectedKey: string;
}

export interface LocalScan {
  /** Directory as shown to people (project-relative). */
  shown: string;
  exists: boolean;
  valid: LocalDeclaration[];
  invalid: InvalidDeclaration[];
  /** Number of declaration files. */
  total: number;
}

export function scanDeclarations(cwd: string, dir: string = FORMS_DIR): LocalScan {
  const full = resolve(cwd, dir);
  const shown = relative(cwd, full).replaceAll('\\', '/') || '.';
  const scan: LocalScan = { shown, exists: existsSync(full), valid: [], invalid: [], total: 0 };
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
    const result = validateDeclaration(value);
    const errors = [...result.errors];
    // The declaration lives at src/forms/<key>.json (contract README §1).
    if (result.valid && (value as { key?: unknown }).key !== expectedKey) errors.push({ path: '/key', code: 'filename_mismatch' });
    if (errors.length) scan.invalid.push({ path, errors, expectedKey });
    else scan.valid.push({ key: expectedKey, path, sha256: sha256(bytes), declaration: value as FormDeclaration, warnings: result.warnings });
  }
  return scan;
}

/** `validate`-style lines for every declaration, in file order. */
export function scanLines(scan: LocalScan): string[] {
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

/** The `sha256:<hex>` of a project file's bytes, or null when it is absent. */
export function fileSha256(root: string, path: string): string | null {
  const full = join(root, path);
  return existsSync(full) ? sha256(readFileSync(full)) : null;
}
