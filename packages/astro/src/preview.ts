import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Preview builds (YatrisCMS#310 slice 4). Yatris starts a Cloudflare Pages
 * build of the dedicated `yatris-preview` branch so staff and clients can see
 * an unpublished draft (or an AI proposal) on the real site before approving
 * it. In that build, and only there, the Delivery client overlays the draft
 * items on top of the published content, every page is marked noindex, and
 * the output carries an `X-Robots-Tag: noindex, nofollow` header.
 *
 * ## When a build is a preview build
 *
 * Both must hold:
 *
 * 1. `YATRIS_PREVIEW_URL` and `YATRIS_PREVIEW_KEY` are set. Yatris installs
 *    them on the Pages project's **Preview** environment only; the Production
 *    environment never has them.
 * 2. `CF_PAGES_BRANCH` (set by Cloudflare Pages on every build) is exactly
 *    `yatris-preview`.
 *
 * Cloudflare applies Preview variables to every non-production branch, so the
 * variables alone would also reach agent pull-request builds; those branches
 * fail rule 2 and build from published content as usual. The production
 * branch can never be `yatris-preview` (Yatris refuses to start previews for
 * such a project), so a production build never enters preview mode, even if
 * the variables leak into the Production environment. A local build is never
 * a preview build unless someone sets `CF_PAGES_BRANCH=yatris-preview` by hand.
 */

/** The only branch whose builds may render drafts. */
export const PREVIEW_BRANCH = 'yatris-preview';

export const PREVIEW_ENV = ['YATRIS_PREVIEW_URL', 'YATRIS_PREVIEW_KEY'] as const;

/** The robots directive every preview page and response carries. */
export const PREVIEW_ROBOTS = 'noindex, nofollow';

export type PreviewBuild =
  | { active: true; lookupUrl: string; key: string; deploymentUrl: string | null }
  | { active: false; reason: string | null };

type Env = Record<string, string | undefined>;

/** Whether this build is a preview build, and where its drafts come from. */
export function previewBuild(env: Env = process.env): PreviewBuild {
  const lookupUrl = env.YATRIS_PREVIEW_URL?.trim() ?? '';
  const key = env.YATRIS_PREVIEW_KEY?.trim() ?? '';
  const branch = env.CF_PAGES_BRANCH?.trim() ?? '';

  if (lookupUrl === '' && key === '') return { active: false, reason: null };
  if (branch !== PREVIEW_BRANCH) {
    return {
      active: false,
      reason: `YATRIS_PREVIEW_URL is set but this build is for branch "${branch || '(none)'}", not "${PREVIEW_BRANCH}"; building published content only.`,
    };
  }
  if (lookupUrl === '' || key === '') {
    throw new Error(`@yatris/astro: a ${PREVIEW_BRANCH} build needs both YATRIS_PREVIEW_URL and YATRIS_PREVIEW_KEY; one of them is missing.`);
  }
  return { active: true, lookupUrl: requireHttps(lookupUrl, 'YATRIS_PREVIEW_URL'), key, deploymentUrl: env.CF_PAGES_URL?.trim() || null };
}

/**
 * The draft items a preview build renders, shaped like Delivery items.
 *
 * Two requests: the stable lookup URL (authenticated by the per-site preview
 * key) names this deployment's preview set and answers with a short-lived
 * signed overlay URL; the overlay URL returns the items. Any failure throws:
 * a preview that silently shows published content would be approved as if it
 * showed the draft.
 */
export async function fetchPreviewOverlay(
  preview: Extract<PreviewBuild, { active: true }>,
  doFetch: typeof fetch = fetch,
): Promise<unknown[]> {
  const lookup = new URL(preview.lookupUrl);
  if (preview.deploymentUrl) lookup.searchParams.set('deployment', preview.deploymentUrl);

  const pointer = await getJson(doFetch, lookup.toString(), { Authorization: `Bearer ${preview.key}` }, 'the preview lookup');
  const overlayUrl = isRecord(pointer) && isRecord(pointer.data) ? pointer.data.overlay_url : undefined;
  if (typeof overlayUrl !== 'string') {
    throw new Error('@yatris/astro: the preview lookup answered without an overlay_url.');
  }

  const overlay = await getJson(doFetch, requireHttps(overlayUrl, 'the preview overlay URL'), {}, 'the preview overlay');
  if (!isRecord(overlay) || !Array.isArray(overlay.data)) {
    throw new Error('@yatris/astro: the preview overlay is malformed (expected { data: [] }).');
  }
  return overlay.data;
}

/**
 * Adds `X-Robots-Tag: noindex, nofollow` for every path to `dist/_headers`,
 * keeping whatever the site already declares there. Cloudflare Pages applies
 * every matching rule, so an appended `/*` block adds the header without
 * disturbing the site's own rules.
 */
export function writePreviewHeaders(dir: URL): void {
  const path = join(fileURLToPath(dir), '_headers');
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : '';
  if (/^\s+X-Robots-Tag:\s*noindex, nofollow\s*$/im.test(existing)) return;

  const block = `/*\n  X-Robots-Tag: ${PREVIEW_ROBOTS}\n`;
  const separator = existing === '' ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  writeFileSync(path, `${existing}${separator}${block}`);
}

async function getJson(doFetch: typeof fetch, url: string, headers: Record<string, string>, what: string): Promise<unknown> {
  let response: Response;
  try {
    response = await doFetch(url, { headers: { Accept: 'application/json', ...headers } });
  } catch (error) {
    throw new Error(`@yatris/astro: could not reach ${what} (${(error as Error).message}).`);
  }
  if (response.status === 404) {
    throw new Error(`@yatris/astro: ${what} found no preview for this deployment; start the preview again from Yatris.`);
  }
  if (response.status === 401 || response.status === 403) {
    throw new Error(`@yatris/astro: ${what} was refused (HTTP ${response.status}); the preview key or link is invalid or expired.`);
  }
  if (!response.ok) throw new Error(`@yatris/astro: ${what} answered HTTP ${response.status}.`);
  try {
    return await response.json();
  } catch {
    throw new Error(`@yatris/astro: ${what} returned a body that is not JSON.`);
  }
}

function requireHttps(value: string, what: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`@yatris/astro: ${what} is not a URL.`);
  }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(local && url.protocol === 'http:')) {
    throw new Error(`@yatris/astro: ${what} must use https.`);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
