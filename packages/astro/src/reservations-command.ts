import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { declarationFiles } from './forms-config.js';
import type { Issue } from './forms/spec.js';
import { RESERVATIONS_DIR } from './reservations-config.js';
import { validateSetup } from './reservations/setup.js';

/**
 * `yatris reservations …` (YatrisCMS#421, spec §13.2). `validate` checks
 * setup declarations offline with `validateSetup`. Synchronization (`plan`,
 * `apply`, `pull`) follows in a later issue.
 */

export interface ReservationsCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export const RESERVATIONS_HELP = `  reservations validate [<path>…]
             Check reservation setup declarations against the reservation
             contract (shape, questions, identity fields and the operations
             seed). Each path is a declaration file or a directory of them
             (*.json, not *.brief.json); default ${RESERVATIONS_DIR}/. Offline;
             exits 1 on any error.`;

export function runReservations(argv: string[], cwd: string): ReservationsCommandResult {
  const [action, ...rest] = argv;
  if (action === 'validate') return validateReservations(rest, cwd);
  return { code: 1, stdout: '', stderr: `yatris reservations: unknown action "${action ?? ''}"\n\nUsage:\n${RESERVATIONS_HELP}` };
}

interface Checked {
  path: string;
  key?: string;
  json?: string;
  errors: Issue[];
  warnings: Issue[];
  expectedKey: string;
}

function validateReservations(argv: string[], cwd: string): ReservationsCommandResult {
  const unknown = argv.filter((a) => a.startsWith('-'));
  if (unknown.length) return { code: 1, stdout: '', stderr: `yatris reservations validate: unknown option ${unknown[0]}\n\nUsage:\n${RESERVATIONS_HELP}` };
  const explicit = argv.length > 0;
  const targets = explicit ? argv : [RESERVATIONS_DIR];
  const files: string[] = [];
  for (const target of targets) {
    const full = resolve(cwd, target);
    const shown = relative(cwd, full).replaceAll('\\', '/') || '.';
    if (!existsSync(full)) {
      if (explicit) return { code: 1, stdout: '', stderr: `yatris reservations validate: ${shown} does not exist.` };
      return { code: 0, stdout: `reservations: no declarations (${shown}/ does not exist).`, stderr: '' };
    }
    if (statSync(full).isDirectory()) for (const name of declarationFiles(full)) files.push(resolve(full, name));
    // Agent briefs are never declarations, even when named explicitly.
    else if (!full.endsWith('.brief.json')) files.push(full);
  }
  if (files.length === 0) return { code: 0, stdout: `reservations: no declarations in ${targets.join(', ')}.`, stderr: '' };

  const checked = [...new Set(files)].sort().map((file) => check(file, relative(cwd, file).replaceAll('\\', '/')));
  const lines: string[] = [];
  for (const c of checked) {
    if (c.json !== undefined) lines.push(`✖ ${c.path}: invalid_json ${c.json}`);
    else if (c.errors.length) {
      lines.push(`✖ ${c.path}: ${c.errors.length} error${c.errors.length === 1 ? '' : 's'}`);
      for (const issue of c.errors) lines.push(`    ${issue.path || '/'} ${issue.code}${issue.code === 'filename_mismatch' ? ` (key must be "${c.expectedKey}")` : ''}`);
    } else lines.push(`✔ ${c.path}: valid (${c.key})`);
    for (const issue of c.warnings) lines.push(`  ⚠ ${c.path}: ${issue.path || '/'} ${issue.code}`);
  }
  const invalid = checked.filter((c) => c.json !== undefined || c.errors.length).length;
  const summary = `${checked.length} declaration${checked.length === 1 ? '' : 's'}, ${invalid} invalid`;
  return invalid ? { code: 1, stdout: '', stderr: `${lines.join('\n')}\n${summary}` } : { code: 0, stdout: `${lines.join('\n')}\n${summary}`, stderr: '' };
}

function check(file: string, path: string): Checked {
  const expectedKey = basename(file).replace(/\.json$/, '');
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    return { path, json: (error as Error).message, errors: [], warnings: [], expectedKey };
  }
  const result = validateSetup(value);
  const errors = [...result.errors];
  // The declaration lives at src/reservations/<key>.json (contract README §1).
  if (result.valid && (value as { key?: unknown }).key !== expectedKey) errors.push({ path: '/key', code: 'filename_mismatch' });
  return { path, key: (value as { key?: string }).key, errors, warnings: result.warnings, expectedKey };
}
