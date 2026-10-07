import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { declarationFiles } from './forms-config.js';
import type { Issue } from './forms/spec.js';
import { RESERVATIONS_DIR } from './reservations-config.js';
import { RESERVATIONS_LOCK_PATH } from './reservations-lock.js';
import { applyReservations, DEFAULT_RESERVATIONS_PLAN_PATH, planReservations, pullReservations, statusReservation } from './reservations-sync.js';
import { validateSetup } from './reservations/setup.js';
import { EXIT, TOKEN_ENV, type RemoteOptions } from './yatris-remote.js';

/**
 * `yatris reservations …` (YatrisCMS#421, #432, spec §13.2). `validate`
 * checks setup declarations offline with `validateSetup`. `plan`, `apply` and
 * `pull` synchronize setup definitions with Yatris drafts through the Product
 * MCP (reservations-sync.ts), with the forms sync rules and exit codes (EXIT
 * in yatris-remote.ts). `status` reads readiness and the live operations.
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
             exits 1 on any error.
  reservations plan [--json] [--out=${DEFAULT_RESERVATIONS_PLAN_PATH}]
             Validate, then ask Yatris for a read-only comparison of each setup
             definition with the last sync (${RESERVATIONS_LOCK_PATH}) and the
             current Yatris draft and publication. Writes only the plan file.
             Setup definitions only: daily operations live in Yatris and are
             never drift; the operations seed is used once, at creation.
  reservations apply --plan=<file> [--json]
             Save the planned declarations as Yatris drafts, atomically, if no
             declaration changed since the plan. Never publishes, connects
             accounts or approves bookings. Updates ${RESERVATIONS_LOCK_PATH}.
  reservations pull [<key>…] [--draft] [--json]
             Write the published Yatris setup definitions into
             ${RESERVATIONS_DIR}/ (--draft: the unpublished drafts, a staff
             operation), only where no local edit would be lost. Never writes
             or removes an operations section.
  reservations status <key> [--json]
             Readiness and the current live operations (redacted) from Yatris.
             plan, apply, pull and status need a paired repository and
             ${TOKEN_ENV}. Exit codes as for forms: 0 ok, 1 invalid input,
             2 reconciliation required, 3 stale plan or revision conflict,
             4 not paired, 5 credentials, 69 not offered by Yatris,
             75 backend_unavailable. Omitting a file never deletes a setup.`;

export async function runReservations(argv: string[], cwd: string, remote: RemoteOptions = {}): Promise<ReservationsCommandResult> {
  const [action, ...rest] = argv;
  if (action === 'validate') return validateReservations(rest, cwd);

  if (action === 'plan' || action === 'apply' || action === 'pull' || action === 'status') {
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: action === 'pull' || action === 'status',
        options: {
          json: { type: 'boolean', default: false },
          ...(action === 'plan' ? { out: { type: 'string' as const } } : {}),
          ...(action === 'apply' ? { plan: { type: 'string' as const } } : {}),
          ...(action === 'pull' ? { draft: { type: 'boolean' as const, default: false } } : {}),
        },
      });
    } catch (error) {
      return { code: EXIT.invalid, stdout: '', stderr: `yatris reservations ${action}: ${(error as Error).message}\n\nUsage:\n${RESERVATIONS_HELP}` };
    }
    const values = parsed.values as { json: boolean; out?: string; plan?: string; draft?: boolean };
    if (action === 'plan') return planReservations(cwd, { ...remote, json: values.json, out: values.out });
    if (action === 'apply') {
      if (!values.plan) return { code: EXIT.invalid, stdout: '', stderr: `yatris reservations apply: --plan=<file> is required (the file \`yatris reservations plan\` wrote, by default ${DEFAULT_RESERVATIONS_PLAN_PATH}).` };
      return applyReservations(cwd, { ...remote, json: values.json, plan: values.plan });
    }
    if (action === 'status') {
      if (parsed.positionals.length !== 1) return { code: EXIT.invalid, stdout: '', stderr: 'yatris reservations status: name exactly one setup key, e.g. `yatris reservations status consultation`.' };
      return statusReservation(cwd, { ...remote, json: values.json, key: parsed.positionals[0] });
    }
    return pullReservations(cwd, { ...remote, json: values.json, draft: values.draft, keys: parsed.positionals });
  }

  return { code: EXIT.invalid, stdout: '', stderr: `yatris reservations: unknown action "${action ?? ''}"\n\nUsage:\n${RESERVATIONS_HELP}` };
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
