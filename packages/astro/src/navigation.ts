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
  return items;
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
