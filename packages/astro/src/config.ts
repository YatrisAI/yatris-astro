import type { YatrisRuntimeConfig } from './head.js';

/** Options for the Yatris Astro integration. */
export interface YatrisOptions {
  /** Public Google Tag Manager container ID (`GTM-…`). Omit until measurement setup. */
  gtmContainerId?: string;
  /** Search Console HTML-tag verification token, only for URL-prefix properties. */
  searchConsoleVerification?: string;
  /**
   * The detail page of each Content Type routed by item slug, for example
   * `{ works: '/works/[slug]/' }` (YatrisCMS#519). A production build writes
   * a 301 from every old slug of an item to its current page into
   * `_redirects`, after the site's own rules in `public/_redirects`.
   */
  slugRoutes?: Record<string, string>;
}

const GTM_ID = /^GTM-[A-Z0-9]{4,12}$/;

export function resolveConfig(options: YatrisOptions = {}): YatrisRuntimeConfig {
  const gtm = options.gtmContainerId?.trim() || null;
  if (gtm !== null && !GTM_ID.test(gtm)) {
    throw new Error(`@yatris/astro: gtmContainerId must look like GTM-XXXXXXX, got ${JSON.stringify(gtm)}`);
  }
  return {
    gtmContainerId: gtm,
    searchConsoleVerification: options.searchConsoleVerification?.trim() || null,
    consentMode: null,
  };
}
