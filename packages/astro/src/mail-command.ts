import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { EMAIL_PATTERN } from './forms/text.js';
import { describeFailure, EXIT, resolveRemote, TOKEN_ENV, type RemoteOptions } from './yatris-remote.js';

/**
 * `yatris mail sync --env-file <path>` (YatrisCMS#390, spec §11.2, decisions
 * §5): the trusted local helper that imports a Website's customer SMTP
 * settings into Yatris as a *pending* mail profile, for a person to test and
 * activate on the Yatris メールの連携 (Connections) page.
 *
 * The secret stays inside this process. It is read from the ignored env file
 * (or this shell's environment), sent once to `import_mail_profile` over the
 * authenticated MCP connection, and never printed, logged, written to a file,
 * echoed in an error or put on a command line. Errors name variables, never
 * values. Empty SMTP variables mean "send nothing", never "remove the
 * profile": this command cannot remove or deactivate anything.
 */

export const SMTP_VARIABLES = ['YATRIS_SMTP_HOST', 'YATRIS_SMTP_PORT', 'YATRIS_SMTP_SECURITY', 'YATRIS_SMTP_USERNAME', 'YATRIS_SMTP_PASSWORD'] as const;
export const MAIL_VARIABLES = ['YATRIS_MAIL_FROM_ADDRESS', 'YATRIS_MAIL_FROM_NAME', 'YATRIS_MAIL_REPLY_TO_ADDRESS'] as const;
const ALL = [...SMTP_VARIABLES, ...MAIL_VARIABLES];
const REQUIRED = ALL.filter((name) => name !== 'YATRIS_MAIL_REPLY_TO_ADDRESS');

export const MAIL_HELP = `  mail sync --env-file=<path> [--json]
             Import the Website's customer SMTP settings into Yatris as a
             pending mail profile, from the ignored env file (YATRIS_SMTP_HOST,
             _PORT, _SECURITY (starttls|tls), _USERNAME, _PASSWORD,
             YATRIS_MAIL_FROM_ADDRESS, _FROM_NAME, optional
             YATRIS_MAIL_REPLY_TO_ADDRESS) or this shell's environment. Never
             prints a value. Empty SMTP variables send nothing; it never
             removes a profile. Then test and activate it on the Yatris
             メールの連携 page. Needs a paired repository and ${TOKEN_ENV}.`;

export interface MailCommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

export async function runMail(argv: string[], cwd: string, remote: RemoteOptions = {}): Promise<MailCommandResult> {
  const [action, ...rest] = argv;
  if (action !== 'sync') return { code: EXIT.invalid, stdout: '', stderr: `yatris mail: unknown action "${action ?? ''}"\n\nUsage:\n${MAIL_HELP}` };

  let values: { 'env-file'?: string; json: boolean };
  try {
    ({ values } = parseArgs({ args: rest, options: { 'env-file': { type: 'string' }, json: { type: 'boolean', default: false } } }));
  } catch {
    // parseArgs quotes unknown arguments; an argument could be a pasted secret
    return { code: EXIT.invalid, stdout: '', stderr: `yatris mail sync: unexpected arguments (values are never accepted on the command line; put them in the env file).\n\nUsage:\n${MAIL_HELP}` };
  }

  const environment = remote.environment ?? process.env;
  let file: Record<string, string> = {};
  if (values['env-file'] !== undefined) {
    const path = resolve(cwd, values['env-file']);
    if (!existsSync(path)) return { code: EXIT.invalid, stdout: '', stderr: `yatris mail sync: ${values['env-file']} does not exist; nothing was sent.` };
    file = parseEnvFile(readFileSync(path, 'utf8'));
  }
  // The file wins; this shell's environment fills names the file lacks
  const read = (name: string): string => (file[name] ?? environment[name] ?? '').trim();
  const settings = Object.fromEntries(ALL.map((name) => [name, read(name)])) as Record<(typeof ALL)[number], string>;
  // Success output may show what Yatris returns (never the password); error
  // text from anywhere is scrubbed of every supplied value
  const scrub = (values: string[]) => (text: string) => values.filter((v) => v.length >= 3).sort((a, b) => b.length - a.length).reduce((out, value) => out.split(value).join('[redacted]'), text);
  const redact = scrub([settings.YATRIS_SMTP_PASSWORD]);
  const redactError = scrub(ALL.map((name) => settings[name]));

  if (SMTP_VARIABLES.every((name) => settings[name] === '')) {
    return { code: EXIT.ok, stdout: 'mail sync: the YATRIS_SMTP_* variables are empty, so nothing was sent. The Website keeps its current mail settings (Yatris platform mail unless a profile is active); this command never removes a profile.', stderr: '' };
  }

  const missing = REQUIRED.filter((name) => settings[name] === '');
  if (missing.length) return { code: EXIT.invalid, stdout: '', stderr: `yatris mail sync: incomplete settings; set ${missing.join(', ')}. Nothing was sent.` };

  const problems: string[] = [];
  const port = Number(settings.YATRIS_SMTP_PORT);
  if (!/^\d{1,5}$/.test(settings.YATRIS_SMTP_PORT) || port < 1 || port > 65535) problems.push('YATRIS_SMTP_PORT is not a port number (1–65535)');
  const security = settings.YATRIS_SMTP_SECURITY.toLowerCase();
  if (security !== 'starttls' && security !== 'tls') problems.push('YATRIS_SMTP_SECURITY must be starttls or tls (certificate verification always stays on)');
  if (!/^[A-Za-z0-9.-]{1,253}$/.test(settings.YATRIS_SMTP_HOST) || settings.YATRIS_SMTP_HOST.startsWith('.') || settings.YATRIS_SMTP_HOST.endsWith('-')) problems.push('YATRIS_SMTP_HOST must be a host name, without a scheme, port or path');
  if (!new RegExp(EMAIL_PATTERN, 'u').test(settings.YATRIS_MAIL_FROM_ADDRESS)) problems.push('YATRIS_MAIL_FROM_ADDRESS is not an email address');
  if (settings.YATRIS_MAIL_REPLY_TO_ADDRESS && !new RegExp(EMAIL_PATTERN, 'u').test(settings.YATRIS_MAIL_REPLY_TO_ADDRESS)) problems.push('YATRIS_MAIL_REPLY_TO_ADDRESS is not an email address');
  if ([...settings.YATRIS_MAIL_FROM_NAME].length > 100 || /[\u0000-\u001f\u007f]/.test(settings.YATRIS_MAIL_FROM_NAME)) problems.push('YATRIS_MAIL_FROM_NAME must be one line of at most 100 characters');
  if (problems.length) return { code: EXIT.invalid, stdout: '', stderr: `yatris mail sync: ${problems.join('; ')}. Nothing was sent.` };

  let answer: Record<string, unknown>;
  try {
    const target = resolveRemote(cwd, remote);
    const result = await target.call('import_mail_profile', {
      website: target.websiteId,
      settings: {
        host: settings.YATRIS_SMTP_HOST,
        port,
        security,
        username: settings.YATRIS_SMTP_USERNAME,
        password: settings.YATRIS_SMTP_PASSWORD,
        from_address: settings.YATRIS_MAIL_FROM_ADDRESS,
        from_name: settings.YATRIS_MAIL_FROM_NAME,
        ...(settings.YATRIS_MAIL_REPLY_TO_ADDRESS ? { reply_to: settings.YATRIS_MAIL_REPLY_TO_ADDRESS } : {}),
      },
      // One key per deliberate import; a transport retry resends this same key
      idempotency_key: `mail-sync-${randomUUID()}`,
    });
    answer = { website: target.websiteId, ...(result as Record<string, unknown>) };
  } catch (error) {
    const { code, message } = describeFailure(error, 'import_mail_profile');
    return { code, stdout: '', stderr: redactError(`yatris mail sync: ${message}`) };
  }

  const shown = stripSecrets(answer);
  if (shown.status !== 'pending_test') {
    return { code: EXIT.backendUnavailable, stdout: '', stderr: redactError(`yatris mail sync: Yatris answered with status ${JSON.stringify(shown.status)}, not pending_test; check the Yatris メールの連携 page before trying again.`) };
  }
  if (values.json) return { code: EXIT.ok, stdout: redact(JSON.stringify(shown, null, 2)), stderr: '' };

  const saved = (shown.settings ?? {}) as Record<string, unknown>;
  const lines = [
    `mail sync: imported the SMTP settings for Website ${String(shown.website)} as a pending profile (revision ${String(shown.revision)}). It is not active yet; the current mail settings stay in use.`,
    ...Object.entries(saved).map(([name, value]) => `  ${name}: ${typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : JSON.stringify(value)}`),
    `Next: ${typeof shown.next === 'string' && shown.next ? shown.next : 'send a test and activate the profile on the Yatris メールの連携 page.'}`,
  ];
  return { code: EXIT.ok, stdout: redact(lines.join('\n')), stderr: '' };
}

/** A copy without any password-like field, however Yatris names it. */
function stripSecrets(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (/pass|secret|token|credential/i.test(key)) continue;
    out[key] = item && typeof item === 'object' && !Array.isArray(item) ? stripSecrets(item as Record<string, unknown>) : item;
  }
  return out;
}

/**
 * Parses dotenv text in-process: `NAME=value`, optional `export `, single or
 * double quotes (double quotes understand \n, \\ and \"), `#` comments, and
 * inline comments after whitespace in unquoted values. Never evaluated.
 */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, name, rest] = match;
    let value: string;
    if (rest.startsWith('"')) {
      const end = closingQuote(rest, '"');
      value = (end === -1 ? rest.slice(1) : rest.slice(1, end)).replace(/\\(["\\n])/g, (_, c: string) => (c === 'n' ? '\n' : c));
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = end === -1 ? rest.slice(1) : rest.slice(1, end);
    } else {
      value = rest.replace(/\s+#.*$/, '').trim();
    }
    out[name] = value;
  }
  return out;
}

function closingQuote(text: string, quote: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === '\\') i++;
    else if (text[i] === quote) return i;
  }
  return -1;
}
