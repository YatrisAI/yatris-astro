/**
 * Document metadata for one page. Visible markup is the site's; this contract
 * covers only what belongs in `<head>`.
 */
export interface YatrisPageMeta {
  title: string;
  /** Required on indexable pages; `yatris doctor` enforces it from the design stage. */
  description?: string;
  /** Path used for the canonical URL; defaults to the page's own path. */
  canonicalPath?: string;
  type?: 'website' | 'article';
  image?: string;
  imageAlt?: string;
  noindex?: boolean;
  publishedAt?: string;
  modifiedAt?: string;
  structuredData?: Record<string, unknown>[];
}

/** Site-level settings the Yatris integration passes to its components. */
export interface YatrisRuntimeConfig {
  gtmContainerId: string | null;
  searchConsoleVerification: string | null;
}

export interface HeadContext {
  /** Astro's `site` (the production origin), when configured. */
  site: URL | undefined;
  pathname: string;
  config: YatrisRuntimeConfig;
}

export type HeadTag =
  | { tag: 'title'; text: string }
  | { tag: 'meta' | 'link'; attrs: Record<string, string> }
  | { tag: 'script'; attrs: Record<string, string>; html: string };

/** Every tag `YatrisHead` renders, in order. Throws on an unusable page title. */
export function headTags(page: YatrisPageMeta, ctx: HeadContext): HeadTag[] {
  const title = page.title?.trim();
  if (!title) {
    throw new Error(`YatrisHead: page.title is required (page ${ctx.pathname})`);
  }

  const tags: HeadTag[] = [
    { tag: 'meta', attrs: { charset: 'utf-8' } },
    { tag: 'meta', attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' } },
    { tag: 'title', text: title },
  ];
  const meta = (attrs: Record<string, string>) => tags.push({ tag: 'meta', attrs });

  const description = page.description?.trim();
  if (description) meta({ name: 'description', content: description });

  const canonical = ctx.site ? new URL(page.canonicalPath ?? ctx.pathname, ctx.site).href : undefined;
  if (canonical) tags.push({ tag: 'link', attrs: { rel: 'canonical', href: canonical } });

  if (page.noindex) meta({ name: 'robots', content: 'noindex, nofollow' });

  meta({ property: 'og:title', content: title });
  if (description) meta({ property: 'og:description', content: description });
  meta({ property: 'og:type', content: page.type ?? 'website' });
  if (canonical) meta({ property: 'og:url', content: canonical });
  const image = page.image && (ctx.site ? new URL(page.image, ctx.site).href : page.image);
  if (image) {
    meta({ property: 'og:image', content: image });
    if (page.imageAlt) meta({ property: 'og:image:alt', content: page.imageAlt });
  }
  meta({ name: 'twitter:card', content: image ? 'summary_large_image' : 'summary' });

  if (page.type === 'article') {
    if (page.publishedAt) meta({ property: 'article:published_time', content: page.publishedAt });
    if (page.modifiedAt) meta({ property: 'article:modified_time', content: page.modifiedAt });
  }

  if (ctx.config.searchConsoleVerification) {
    meta({ name: 'google-site-verification', content: ctx.config.searchConsoleVerification });
  }

  for (const data of page.structuredData ?? []) {
    tags.push({ tag: 'script', attrs: { type: 'application/ld+json' }, html: jsonForScript(data) });
  }

  if (ctx.config.gtmContainerId) {
    tags.push({ tag: 'script', attrs: {}, html: gtmHeadSnippet(ctx.config.gtmContainerId) });
  }

  return tags;
}

/** Google Tag Manager's head snippet for one container. */
export function gtmHeadSnippet(containerId: string): string {
  return (
    "(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});" +
    "var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;" +
    "j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);" +
    `})(window,document,'script','dataLayer',${JSON.stringify(containerId)});`
  );
}

/** Google Tag Manager's `<noscript>` fallback, rendered right after `<body>`. */
export function gtmNoscript(containerId: string): string {
  const src = `https://www.googletagmanager.com/ns.html?id=${encodeURIComponent(containerId)}`;
  return `<noscript><iframe src="${src}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`;
}

/** JSON safe to place inside a `<script>` element. */
function jsonForScript(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}
