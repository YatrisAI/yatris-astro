import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { missingCapabilities } from '../forms-client/capabilities.js';
import { FORMS_LOCK_PATH, readFormsLock } from '../forms-lock.js';
import { scanDeclarations } from '../forms-local.js';
import { requiredCapabilities } from '../forms/public.js';
import { projectWebsiteId } from '../schema.js';
import { describeFailure, RemoteError, RemoteSetupError, type Remote } from '../yatris-remote.js';
import type { Finding } from './findings.js';

/**
 * Contact-form checks for `yatris doctor` (YatrisCMS#392, spec §13):
 * declarations are valid, every `<YatrisForm form="x">` mount has
 * `src/forms/x.json`, redirect thanks routes exist as pages, this renderer
 * supports every capability a declaration needs, the forms lock is sound,
 * and, when the repository is paired and a credential is available, Yatris
 * readiness for each form. Remote checks that cannot run are reported as
 * `unverified`, never as passed.
 */

export interface FormsDoctorOptions {
  /** Connects to Yatris; absent means offline (`--offline`). May throw RemoteSetupError. */
  remote?: () => Remote;
}

interface Mount {
  file: string;
  form: string | null;
}

const PAGE_EXTENSIONS = ['astro', 'md', 'mdx', 'html', 'ts', 'js'];

export async function checkForms(root: string, options: FormsDoctorOptions = {}): Promise<Finding[]> {
  const findings: Finding[] = [];
  const error = (code: string, message: string, file?: string) => findings.push({ severity: 'error', code, message, file });
  const warn = (code: string, message: string, file?: string) => findings.push({ severity: 'warning', code, message, file });

  const scan = scanDeclarations(root);
  const mounts = findMounts(root);
  if (scan.total === 0 && mounts.length === 0) return findings;

  for (const invalid of scan.invalid) {
    const codes = invalid.json !== undefined ? 'invalid_json' : invalid.errors.slice(0, 5).map((i) => `${i.path || '/'} ${i.code}`).join(', ');
    error('forms-invalid', `the declaration is invalid (${codes}); run \`npx yatris forms validate\``, invalid.path);
  }
  const declared = new Set([...scan.valid.map((d) => d.key), ...scan.invalid.map((i) => i.expectedKey)]);

  for (const mount of mounts) {
    if (mount.form === null) warn('forms-mount-dynamic', '<YatrisForm> has a computed form key, so the doctor cannot check its declaration; use a literal form="<key>"', mount.file);
    else if (!declared.has(mount.form)) error('forms-mount-missing', `<YatrisForm form="${mount.form}"> has no declaration src/forms/${mount.form}.json; write one, or bring an existing Yatris form in with \`npx yatris forms pull ${mount.form}\``, mount.file);
  }

  for (const { key, path, declaration } of scan.valid) {
    const success = declaration.success as { mode?: string; redirectPath?: string };
    if (success.mode === 'redirect' && typeof success.redirectPath === 'string') {
      const route = findRoute(root, success.redirectPath);
      if (route === 'dynamic') warn('forms-thanks-unverified', `the thanks route ${success.redirectPath} may be served by a dynamic route; check it builds`, path);
      else if (route === null) error('forms-thanks-missing', `success.redirectPath ${success.redirectPath} has no page under src/pages/; create it (noindex) or switch to message mode`, path);
    }
    const missing = missingCapabilities(requiredCapabilities(declaration));
    if (missing.length) error('forms-capability-unsupported', `this @yatris/astro renderer cannot draw ${missing.join(', ')}, so "${key}" would show the unavailable state; update @yatris/astro with \`npm run yatris:update\``, path);
  }

  try {
    const lock = readFormsLock(root);
    const paired = projectWebsiteId(root);
    if (lock && paired !== null && lock.websiteId !== paired) error('forms-lock-website-mismatch', `the lock is for Website ${lock.websiteId}, but .yatris/project.json names Website ${paired}`, FORMS_LOCK_PATH);
  } catch (problem) {
    error('forms-lock-invalid', (problem as Error).message, FORMS_LOCK_PATH);
  }

  findings.push(...(await remoteReadiness([...new Set([...scan.valid.map((d) => d.key), ...mounts.flatMap((m) => (m.form ? [m.form] : []))])].sort(), options)));
  return findings;
}

async function remoteReadiness(keys: string[], options: FormsDoctorOptions): Promise<Finding[]> {
  if (keys.length === 0) return [];
  const unverified = (message: string): Finding[] => [{ severity: 'unverified', code: 'forms-remote-unverified', message: `Yatris readiness of ${keys.join(', ')} was not checked: ${message}` }];
  if (!options.remote) return unverified('offline (--offline)');

  let remote: Remote;
  try {
    remote = options.remote();
  } catch (error) {
    if (error instanceof RemoteSetupError) return unverified(error.message.replace(/; nothing was sent\.?$/, ''));
    throw error;
  }

  const findings: Finding[] = [];
  for (const key of keys) {
    let answer: { readiness?: Array<{ code?: unknown; label?: unknown; ok?: unknown; blocking?: unknown; detail?: unknown }>; published_version?: unknown; has_unpublished_changes?: unknown; review_url?: unknown };
    try {
      answer = (await remote.call('get_contact_form_readiness', { website: remote.websiteId, key })) as typeof answer;
    } catch (error) {
      if (error instanceof RemoteError && error.kind === 'tool_error' && error.code === 'not_found') {
        findings.push({ severity: 'warning', code: 'forms-remote-missing', message: `"${key}" does not exist in Yatris yet, so a live page shows the unavailable state. \`npx yatris forms plan\` and \`apply\` save it as a draft; staff publish it.`, file: `src/forms/${key}.json` });
        continue;
      }
      // Unreachable, unknown tool, refused credential: unknown, not passed
      return [...findings, ...unverifiedRest(keys.slice(keys.indexOf(key)), describeFailure(error, 'get_contact_form_readiness').message)];
    }
    const blocking = (Array.isArray(answer?.readiness) ? answer.readiness : []).filter((item) => item && item.blocking === true && item.ok !== true);
    const notes: string[] = [];
    if (answer?.published_version === null || answer?.published_version === undefined) notes.push('not published');
    if (answer?.has_unpublished_changes === true) notes.push('unpublished draft changes');
    if (blocking.length || notes.length) {
      const items = blocking.map((item) => `${String(item.label ?? item.code)}${typeof item.detail === 'string' && item.detail ? ` (${item.detail})` : ''}`);
      findings.push({
        severity: 'warning',
        code: 'forms-remote-not-ready',
        message: `Yatris: ${[...notes, ...items].join('; ')}${typeof answer.review_url === 'string' ? `. Review: ${answer.review_url}` : ''}`,
        file: `src/forms/${key}.json`,
      });
    }
  }
  return findings;
}

function unverifiedRest(keys: string[], reason: string): Finding[] {
  return [{ severity: 'unverified', code: 'forms-remote-unverified', message: `Yatris readiness of ${keys.join(', ')} was not checked: ${reason}` }];
}

/** `<YatrisForm …>` mounts in src/ pages, layouts and components. */
export function findMounts(root: string): Mount[] {
  const src = join(root, 'src');
  if (!existsSync(src)) return [];
  const mounts: Mount[] = [];
  for (const entry of readdirSync(src, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !/\.(astro|mdx)$/.test(entry.name)) continue;
    const full = join(entry.parentPath, entry.name);
    const file = relative(root, full).replaceAll('\\', '/');
    const text = readFileSync(full, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
    for (const match of text.matchAll(/<YatrisForm\b([^>]*?)\/?>/g)) {
      const attrs = match[1];
      const literal = /(?:^|\s)form\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`$]*)`)\s*\})/.exec(attrs);
      mounts.push({ file, form: literal ? (literal.slice(1).find((v) => v !== undefined) ?? null) : null });
    }
  }
  return mounts;
}

/** The page serving `path` under src/pages, 'dynamic' when only a dynamic route could, or null. */
export function findRoute(root: string, path: string): string | 'dynamic' | null {
  const pages = join(root, 'src/pages');
  const clean = path.split(/[?#]/)[0].replace(/^\/+|\/+$/g, '');
  const candidates = clean === '' ? PAGE_EXTENSIONS.map((ext) => `index.${ext}`) : PAGE_EXTENSIONS.flatMap((ext) => [`${clean}.${ext}`, `${clean}/index.${ext}`]);
  for (const candidate of candidates) if (existsSync(join(pages, candidate))) return `src/pages/${candidate}`;
  // A [param] or [...rest] route along the way might serve it
  const segments = clean === '' ? [] : clean.split('/');
  let dir = pages;
  for (let depth = 0; depth <= segments.length && existsSync(dir); depth++) {
    if (readdirSync(dir).some((name) => name.startsWith('['))) return 'dynamic';
    if (depth < segments.length) dir = join(dir, segments[depth]);
  }
  return null;
}
