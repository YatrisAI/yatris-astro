/**
 * Item slug redirects (YatrisCMS#519). When an editor changes a published
 * item's slug, Yatris keeps the old one and Delivery lists it at
 * `/redirects` as `{ type, from, to }`. A site that routes a Content Type's
 * detail pages by slug names the route in `slugRoutes`, and the build writes
 * one 301 per old slug into Cloudflare Pages' `_redirects`, after the site's
 * own rules.
 */

export interface SlugRedirect {
  type: string;
  from: string;
  to: string;
}

/** Cloudflare Pages reads at most this many static redirects. */
export const MAX_STATIC_REDIRECTS = 2000;

const MARKER = '# Yatris: old item URLs, written at build time (YatrisCMS#519)';

/**
 * Checks `slugRoutes`: each route is a path starting and ending in `/`
 * with exactly one `[slug]`.
 */
export function assertSlugRoutes(routes: Record<string, string>): void {
  for (const [type, route] of Object.entries(routes)) {
    if (typeof route !== 'string' || !route.startsWith('/') || route.split('[slug]').length !== 2) {
      throw new Error(`@yatris/astro: slugRoutes.${type} must be a path with one [slug], for example "/${type}/[slug]/"; got ${JSON.stringify(route)}`);
    }
  }
}

/** The page of `slug` on `route`; the slug is percent-encoded as browsers send it. */
export function slugPath(route: string, slug: string): string {
  return route.replace('[slug]', encodeURIComponent(slug));
}

/**
 * One `_redirects` line per redirect of a routed type, and the types Yatris
 * has redirects for that no route names.
 */
export function redirectLines(redirects: SlugRedirect[], routes: Record<string, string>): { lines: string[]; unrouted: string[] } {
  const lines: string[] = [];
  const unrouted = new Set<string>();
  for (const redirect of redirects) {
    const route = routes[redirect.type];
    if (route === undefined) {
      unrouted.add(redirect.type);
      continue;
    }
    lines.push(`${slugPath(route, redirect.from)} ${slugPath(route, redirect.to)} 301`);
  }
  return { lines, unrouted: [...unrouted].sort() };
}

/**
 * The site's own `_redirects` (from `public/`), then the generated lines.
 * A generated line whose source the site already redirects is left out, so
 * the site's rule wins; a previous build's generated block is replaced.
 */
export function mergeRedirects(existing: string, lines: string[]): string {
  const own = existing.split(MARKER)[0].replace(/\s+$/, '');
  const sources = new Set(
    own
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('#'))
      .map((line) => line.split(/\s+/)[0]),
  );
  const generated = lines.filter((line) => !sources.has(line.split(' ')[0]));
  if (generated.length === 0) return own === '' ? '' : `${own}\n`;
  return `${own === '' ? '' : `${own}\n\n`}${MARKER}\n${generated.join('\n')}\n`;
}

/** Static redirect rules in a `_redirects` file (no `*` or `:placeholder` in the source). */
export function countStaticRules(content: string): number {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'))
    .filter((line) => !/[*:]/.test(line.split(/\s+/)[0])).length;
}
