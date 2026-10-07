import { parseArgs } from 'node:util';
import { FORMS_DIR } from './forms-config.js';
import { scanDeclarations, scanLines } from './forms-local.js';
import { applyForms, DEFAULT_PLAN_PATH, planForms, pullForms } from './forms-sync.js';
import { EXIT, TOKEN_ENV, type RemoteOptions } from './yatris-remote.js';

/**
 * `yatris forms …` (YatrisCMS#380, #392, spec §13). `validate` checks every
 * declaration offline. `plan`, `apply` and `pull` synchronize them with
 * Yatris drafts through the Product MCP (forms-sync.ts); exit codes are
 * EXIT in yatris-remote.ts and contract README §9.
 */

export interface FormsCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** sysexits EX_UNAVAILABLE: Yatris does not offer the capability (yet). */
export const EXIT_UNAVAILABLE = EXIT.unavailable;

export const FORMS_HELP = `  forms validate [--dir=src/forms]
             Check every form declaration (src/forms/*.json, not *.brief.json)
             against the contact-form contract: schema, conditions and mail
             templates. Offline; exits 1 on any error.
  forms plan [--json] [--out=${DEFAULT_PLAN_PATH}]
             Validate, then ask Yatris for a read-only comparison of each
             declaration with the last sync (.yatris/forms.lock.json) and the
             current Yatris draft and publication. Writes only the plan file.
  forms apply --plan=<file> [--json]
             Save the planned declarations as Yatris drafts, atomically, if no
             declaration changed since the plan. Never publishes: a person
             reviews and publishes in Yatris. Updates .yatris/forms.lock.json.
  forms pull [<key>…] [--draft] [--json]
             Write the published Yatris definitions into src/forms/ (--draft:
             the unpublished drafts, a staff operation), only where no local
             edit would be lost, and record the baseline.
             plan, apply and pull need a paired repository and ${TOKEN_ENV}.
             Exit codes: 0 ok, 1 invalid input, 2 reconciliation required,
             3 stale plan or revision conflict, 4 not paired, 5 credentials,
             69 not offered by Yatris, 75 backend_unavailable.`;

export async function runForms(argv: string[], cwd: string, remote: RemoteOptions = {}): Promise<FormsCommandResult> {
  const [action, ...rest] = argv;

  if (action === 'validate') return validateForms(rest, cwd);

  if (action === 'plan' || action === 'apply' || action === 'pull') {
    let parsed;
    try {
      parsed = parseArgs({
        args: rest,
        allowPositionals: action === 'pull',
        options: {
          json: { type: 'boolean', default: false },
          ...(action === 'plan' ? { out: { type: 'string' as const } } : {}),
          ...(action === 'apply' ? { plan: { type: 'string' as const } } : {}),
          ...(action === 'pull' ? { draft: { type: 'boolean' as const, default: false } } : {}),
        },
      });
    } catch (error) {
      return { code: EXIT.invalid, stdout: '', stderr: `yatris forms ${action}: ${(error as Error).message}\n\nUsage:\n${FORMS_HELP}` };
    }
    const values = parsed.values as { json: boolean; out?: string; plan?: string; draft?: boolean };
    if (action === 'plan') return planForms(cwd, { ...remote, json: values.json, out: values.out });
    if (action === 'apply') {
      if (!values.plan) return { code: EXIT.invalid, stdout: '', stderr: `yatris forms apply: --plan=<file> is required (the file \`yatris forms plan\` wrote, by default ${DEFAULT_PLAN_PATH}).` };
      return applyForms(cwd, { ...remote, json: values.json, plan: values.plan });
    }
    return pullForms(cwd, { ...remote, json: values.json, draft: values.draft, keys: parsed.positionals });
  }

  return { code: EXIT.invalid, stdout: '', stderr: `yatris forms: unknown action "${action ?? ''}"\n\nUsage:\n${FORMS_HELP}` };
}

function validateForms(argv: string[], cwd: string): FormsCommandResult {
  let values;
  try {
    ({ values } = parseArgs({ args: argv, options: { dir: { type: 'string' } } }));
  } catch (error) {
    return { code: 1, stdout: '', stderr: `yatris forms validate: ${(error as Error).message}` };
  }
  const scan = scanDeclarations(cwd, values.dir ?? FORMS_DIR);
  if (!scan.exists) {
    if (values.dir !== undefined) return { code: 1, stdout: '', stderr: `yatris forms validate: ${scan.shown} does not exist.` };
    return { code: 0, stdout: `forms: no declarations (${scan.shown}/ does not exist).`, stderr: '' };
  }
  if (scan.total === 0) return { code: 0, stdout: `forms: no declarations in ${scan.shown}/.`, stderr: '' };

  const lines = scanLines(scan);
  const invalid = scan.invalid.length;
  const summary = `${scan.total} declaration${scan.total === 1 ? '' : 's'}, ${invalid} invalid`;
  return invalid ? { code: 1, stdout: '', stderr: `${lines.join('\n')}\n${summary}` } : { code: 0, stdout: `${lines.join('\n')}\n${summary}`, stderr: '' };
}
