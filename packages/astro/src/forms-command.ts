import { existsSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { declarationFiles, FORMS_DIR } from './forms-config.js';
import { validateDeclaration } from './forms/declaration.js';

/**
 * `yatris forms …` (YatrisCMS#380, spec §13). `validate` checks every
 * declaration offline. Synchronization with Yatris (`plan`, `apply`, `pull`)
 * is not available yet; those commands say so and exit with
 * EXIT_UNAVAILABLE, never with a fake success (decisions §9).
 */

export interface FormsCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** sysexits EX_UNAVAILABLE: the command exists but its service does not yet. */
export const EXIT_UNAVAILABLE = 69;

export const FORMS_HELP = `  forms validate [--dir=src/forms]
             Check every form declaration (src/forms/*.json, not *.brief.json)
             against the contact-form contract: schema, conditions and mail
             templates. Offline; exits 1 on any error.
  forms plan | apply | pull
             Contact-form synchronization with Yatris. Not available yet: it
             arrives in a later release, and these exit ${EXIT_UNAVAILABLE} without
             touching anything.`;

const SYNC_ACTIONS = ['plan', 'apply', 'pull'];

export function runForms(argv: string[], cwd: string): FormsCommandResult {
  const [action, ...rest] = argv;

  if (action === 'validate') return validateForms(rest, cwd);

  if (action !== undefined && SYNC_ACTIONS.includes(action)) {
    return {
      code: EXIT_UNAVAILABLE,
      stdout: '',
      stderr: `yatris forms ${action}: contact-form synchronization with Yatris is not available yet; it arrives in a later release of @yatris/astro. Nothing was compared, written or sent. Check declarations offline with \`yatris forms validate\`; until synchronization ships, Yatris staff import a declaration through the internal form builder.`,
    };
  }

  return { code: 1, stdout: '', stderr: `yatris forms: unknown action "${action ?? ''}"\n\nUsage:\n${FORMS_HELP}` };
}

function validateForms(argv: string[], cwd: string): FormsCommandResult {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { dir: { type: 'string' } } }));
  } catch (error) {
    return { code: 1, stdout: '', stderr: `yatris forms validate: ${(error as Error).message}` };
  }
  const dir = resolve(cwd, values.dir ?? FORMS_DIR);
  const shown = relative(cwd, dir).replaceAll('\\', '/') || '.';
  if (!existsSync(dir)) {
    if (values.dir !== undefined) return { code: 1, stdout: '', stderr: `yatris forms validate: ${shown} does not exist.` };
    return { code: 0, stdout: `forms: no declarations (${shown}/ does not exist).`, stderr: '' };
  }
  const files = declarationFiles(dir);
  if (files.length === 0) return { code: 0, stdout: `forms: no declarations in ${shown}/.`, stderr: '' };

  const lines: string[] = [];
  let invalid = 0;
  for (const name of files) {
    const path = `${shown}/${name}`;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (error) {
      invalid++;
      lines.push(`✖ ${path}: invalid_json ${(error as Error).message}`);
      continue;
    }
    const result = validateDeclaration(value);
    const errors = [...result.errors];
    const key = (value as { key?: unknown })?.key;
    const expected = name.slice(0, -'.json'.length);
    // The declaration lives at src/forms/<key>.json (contract README §1).
    if (result.valid && key !== expected) errors.push({ path: '/key', code: 'filename_mismatch' });
    if (errors.length) {
      invalid++;
      lines.push(`✖ ${path}: ${errors.length} error${errors.length === 1 ? '' : 's'}`);
      for (const issue of errors) lines.push(`    ${issue.path || '/'} ${issue.code}${issue.code === 'filename_mismatch' ? ` (key must be "${expected}")` : ''}`);
    } else {
      lines.push(`✔ ${path}: valid (${String(key)})`);
    }
    for (const issue of result.warnings) lines.push(`  ⚠ ${path}: ${issue.path || '/'} ${issue.code}`);
  }
  const summary = `${files.length} declaration${files.length === 1 ? '' : 's'}, ${invalid} invalid`;
  return invalid ? { code: 1, stdout: '', stderr: `${lines.join('\n')}\n${summary}` } : { code: 0, stdout: `${lines.join('\n')}\n${summary}`, stderr: '' };
}
