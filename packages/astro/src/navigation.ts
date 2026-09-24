/**
 * One entry in a site's navigation. Sites own how navigation renders; this
 * type only fixes what an entry is, so tooling can check every destination.
 */
export interface NavigationItem {
  label: string;
  /** A root-relative path such as `/works/`, or an absolute `https:` URL. */
  href: string;
  children?: NavigationItem[];
}

/**
 * Declares a site's navigation in `src/navigation.ts`. Throws at build time on
 * an entry that cannot be a valid destination.
 */
export function defineNavigation(items: NavigationItem[]): NavigationItem[] {
  items.forEach((item, index) => check(item, `navigation[${index}]`));
  // Recorded for the integration's end-of-build check that every internal
  // destination was actually built (the build renders pages in-process).
  (globalThis as Record<symbol, unknown>)[NAVIGATION_REGISTRY] = items;
  return items;
}

export const NAVIGATION_REGISTRY = Symbol.for('yatris.navigation');

/** The navigation most recently declared in this process, if any. */
export function registeredNavigation(): NavigationItem[] | undefined {
  return (globalThis as Record<symbol, unknown>)[NAVIGATION_REGISTRY] as NavigationItem[] | undefined;
}

/**
 * Internal destinations that do not match a built page. `pages` are Astro's
 * built pathnames (`''` for the home page, `works/` for `/works/`).
 */
export function missingDestinations(items: NavigationItem[], pages: string[]): NavigationItem[] {
  const built = new Set(pages.map(normalize));
  const missing: NavigationItem[] = [];
  const visit = (item: NavigationItem) => {
    if (item.href.startsWith('/') && !built.has(normalize(new URL(item.href, 'https://x.invalid').pathname))) {
      missing.push(item);
    }
    item.children?.forEach(visit);
  };
  items.forEach(visit);
  return missing;
}

function normalize(path: string): string {
  return decodeURI(path).replace(/^\/+|\/+$/g, '').replace(/\/index(\.html)?$|^index(\.html)?$|\.html$/, '');
}

function check(item: NavigationItem, at: string): void {
  if (typeof item.label !== 'string' || item.label.trim() === '') {
    throw new Error(`${at}: label must be a non-empty string`);
  }
  if (!isDestination(item.href)) {
    throw new Error(`${at} (${item.label}): href must be a root-relative path or an https URL, got ${JSON.stringify(item.href)}`);
  }
  item.children?.forEach((child, index) => check(child, `${at}.children[${index}]`));
}

function isDestination(href: unknown): boolean {
  if (typeof href !== 'string') return false;
  if (href.startsWith('/') && !href.startsWith('//')) return true;
  try {
    return new URL(href).protocol === 'https:';
  } catch {
    return false;
  }
}
