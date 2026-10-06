import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateDeclaration } from './forms/declaration.js';
import { toPublicDefinition, type PublicDefinition } from './forms/public.js';
import type { Issue } from './forms/spec.js';
import type { FormDeclaration } from './forms/tree.js';
import { readPairedProject, yatrisOrigin } from './paired-build.js';

/**
 * Build-time side of `<YatrisForm>` (YatrisCMS#380): decides how forms on
 * this build load, and produces the `virtual:yatris/forms` runtime the
 * component reads.
 *
 * - **live** (default): a paired project. Each mount gets its public key
 *   "<websiteId>.<formKey>" and `<Yatris origin>/api/v1/forms/<publicKey>`,
 *   and the browser fetches the published definition at runtime.
 * - **preview**: `astro dev` with YATRIS_FORMS_PREVIEW=1 only. Mounts carry
 *   the public projection of `src/forms/<key>.json` and submit nowhere.
 * - **unconfigured**: an unpaired project outside preview. Mounts show the
 *   unavailable state. Nothing ever falls back to preview.
 *
 * `astro build` refuses YATRIS_FORMS_PREVIEW outright, so a preview can never
 * ship, and a build never reads `src/forms/`.
 */

export const FORMS_PREVIEW_ENV = 'YATRIS_FORMS_PREVIEW';
export const FORMS_DIR = 'src/forms';
export const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

export interface PreviewEntry {
  /** Project-relative path of the declaration. */
  source: string;
  definition?: PublicDefinition;
  problem?: { message: string; issues: Issue[] };
}

export type FormsRuntime =
  | { mode: 'live'; origin: string; websiteId: number; timeZone: string }
  | { mode: 'preview'; timeZone: string; previews: Record<string, PreviewEntry> }
  | { mode: 'unconfigured'; timeZone: string; reason: string };

/** Whether YATRIS_FORMS_PREVIEW asks for preview. Unknown values are an error, not a guess. */
export function previewRequested(env: Record<string, string | undefined>): boolean {
  const raw = env[FORMS_PREVIEW_ENV];
  if (raw === undefined) return false;
  const value = raw.trim().toLowerCase();
  if (value === '' || value === '0' || value === 'false') return false;
  if (value === '1' || value === 'true') return true;
  throw new Error(`@yatris/astro: ${FORMS_PREVIEW_ENV}=${raw} is not understood; use 1 to preview forms under astro dev, or leave it unset.`);
}

/** Refuses preview anywhere but `astro dev`. Throws for a production build. */
export function assertFormsMode(command: string | undefined, env: Record<string, string | undefined>): boolean {
  const requested = previewRequested(env);
  if (requested && command === 'build') {
    throw new Error(
      `@yatris/astro: ${FORMS_PREVIEW_ENV} is set, but forms preview only runs under \`astro dev\`. A production build never ships a preview form. Unset ${FORMS_PREVIEW_ENV} (keep it in .env.development.local, which builds do not read) and build again.`,
    );
  }
  return requested && command === 'dev';
}

export interface FormsRuntimeSource {
  root: URL;
  command: 'dev' | 'build' | 'preview' | 'sync' | undefined;
  env: Record<string, string | undefined>;
}

export async function formsRuntime(source: FormsRuntimeSource): Promise<FormsRuntime> {
  const preview = assertFormsMode(source.command, source.env);
  const project = readPairedProject(source.root);
  const timeZone = project?.timezone ?? DEFAULT_TIME_ZONE;
  if (preview) return { mode: 'preview', timeZone, previews: await loadPreviews(source.root) };
  if (!project) return { mode: 'unconfigured', timeZone, reason: 'this project is not paired with a Yatris Website yet (run `npx yatris connect`), so there is no published form to load' };
  const origin = yatrisOrigin(project, source.env);
  if (!origin) return { mode: 'unconfigured', timeZone, reason: '.yatris/project.json has no Yatris origin; run `npx yatris connect` again' };
  return { mode: 'live', origin, websiteId: project.websiteId, timeZone };
}

/** Declaration files in `dir`: `*.json`, except agent briefs (`*.brief.json`). */
export function declarationFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json') && !name.endsWith('.brief.json'))
    .sort();
}

/**
 * Public projections of every local declaration, for preview only. The
 * projection drops mail, recipients and quiz answers, so even a preview page
 * never holds them.
 */
export async function loadPreviews(root: URL): Promise<Record<string, PreviewEntry>> {
  const dir = join(fileURLToPath(root), FORMS_DIR);
  const previews: Record<string, PreviewEntry> = {};
  for (const name of declarationFiles(dir)) {
    const key = name.slice(0, -'.json'.length);
    const source = `${FORMS_DIR}/${name}`;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (error) {
      previews[key] = { source, problem: { message: `${source} は JSON として読み込めません（${(error as Error).message}）。`, issues: [] } };
      continue;
    }
    const result = validateDeclaration(value);
    if (!result.valid) {
      previews[key] = { source, problem: { message: `${source} に誤りがあります。npx yatris forms validate で確認してください。`, issues: result.errors } };
      continue;
    }
    const declaration = value as FormDeclaration;
    if (declaration.key !== key) {
      previews[key] = { source, problem: { message: `${source} の key は「${key}」である必要があります（現在は「${declaration.key}」）。`, issues: [{ path: '/key', code: 'filename_mismatch' }] } };
      continue;
    }
    previews[key] = {
      source,
      definition: await toPublicDefinition(declaration, { publicKey: `preview.${key}`, version: 1, endpoint: 'preview:submissions', turnstile: null }),
    };
  }
  return previews;
}

/**
 * Env for the forms decision: `.env` files (Vite's rules for the mode) under
 * real environment variables. A build reads `.env` and `.env.production`, so
 * YATRIS_FORMS_PREVIEW in `.env` stops a build too.
 */
export async function formsEnv(root: URL, mode: string): Promise<Record<string, string | undefined>> {
  try {
    const { loadEnv } = (await import('vite' as string)) as { loadEnv: (mode: string, dir: string, prefix: string) => Record<string, string> };
    return { ...loadEnv(mode, fileURLToPath(root), 'YATRIS_'), ...process.env };
  } catch {
    return { ...process.env };
  }
}
