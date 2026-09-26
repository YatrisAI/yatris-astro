import { GTM_CONSENT_LOADER } from '../head.js';
import { findCredentials, type Finding, type Stage } from './findings.js';

const CDN_SCRIPT = /<script\b[^>]*\bsrc=["']?(?:https?:)?\/\/(?:cdn\.jsdelivr\.net|unpkg\.com|cdnjs\.cloudflare\.com|esm\.sh|cdn\.skypack\.dev|ga\.jspm\.io)[^"'\s>]*/gi;

/**
 * Audits one built HTML document. SEO metadata that a site only needs once it
 * is designed (description, canonical) is a warning at the scaffold stage.
 */
export function auditHtml(file: string, rawHtml: string, stage: Stage): Finding[] {
  const html = rawHtml.replace(/<!--[\s\S]*?-->/g, '');
  const findings: Finding[] = [];
  const add = (severity: Finding['severity'], code: string, message: string) =>
    findings.push({ severity, code, message, file });
  const seoSeverity = stage === 'scaffold' ? 'warning' : 'error';

  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(html)?.[1] ?? '';
  const titles = [...head.matchAll(/<title\b[^>]*>([\s\S]*?)<\/title>/gi)].map((m) => m[1].trim());
  if (titles.length === 0) add('error', 'missing-title', 'page has no <title>');
  else if (titles.length > 1) add('error', 'multiple-titles', `page has ${titles.length} <title> elements`);
  else if (titles[0] === '') add('error', 'empty-title', 'page title is empty');

  if (!/<html\b[^>]*\blang=["']?[^"'\s>]+/i.test(html)) add('error', 'missing-lang', '<html> has no lang attribute');

  const robots = attr(findTags(head, 'meta', 'name', 'robots')[0], 'content') ?? '';
  const indexable = !/noindex/i.test(robots);

  const description = findTags(head, 'meta', 'name', 'description');
  if (indexable && !description.some((tag) => (attr(tag, 'content') ?? '').trim() !== '')) {
    add(seoSeverity, 'missing-description', 'indexable page has no meta description');
  }

  const canonicals = findTags(head, 'link', 'rel', 'canonical');
  if (canonicals.length > 1) add('error', 'duplicate-canonical', `page has ${canonicals.length} canonical links`);
  for (const tag of canonicals) {
    if (!/^https?:\/\//.test(attr(tag, 'href') ?? '')) add('error', 'invalid-canonical', 'canonical URL is not absolute');
  }
  if (indexable && canonicals.length === 0) {
    add(seoSeverity, 'missing-canonical', 'indexable page has no canonical URL (set `site` in astro.config.mjs)');
  }

  const gtmLoaders = count(html, /googletagmanager\.com\/gtm\.js/g);
  const gtmNoscripts = count(html, /googletagmanager\.com\/ns\.html/g);
  // A consent-required site loads GTM only after consent, with no fallback
  const afterConsent = html.includes(GTM_CONSENT_LOADER);
  if (gtmLoaders > 1 || gtmNoscripts > 1) {
    add('error', 'duplicate-gtm', `Google Tag Manager is installed more than once (${gtmLoaders} loaders, ${gtmNoscripts} noscript fallbacks)`);
  } else if (afterConsent) {
    if (gtmNoscripts > 0) add('error', 'gtm-before-consent', 'the site requires consent, but a GTM noscript fallback loads GTM without it; remove it');
  } else if (gtmLoaders !== gtmNoscripts) {
    add('warning', 'partial-gtm', 'Google Tag Manager head and body snippets do not pair up; use YatrisHead and YatrisBodyStart');
  }
  if (/googletagmanager\.com\/gtag\/js/.test(html)) {
    add('error', 'direct-gtag', 'page loads gtag.js directly; GA4 must be configured inside Google Tag Manager');
  }

  for (const match of html.matchAll(CDN_SCRIPT)) {
    add('error', 'cdn-script', `script loaded from a runtime CDN: ${match[0].replace(/^[\s\S]*src=["']?/, '')}`);
  }

  return [...findings, ...findCredentials(file, rawHtml)];
}

function findTags(html: string, tag: string, key: string, value: string): string[] {
  return [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'gi'))]
    .map((m) => m[0])
    .filter((t) => (attr(t, key) ?? '').toLowerCase() === value);
}

function attr(tag: string | undefined, name: string): string | undefined {
  if (!tag) return undefined;
  const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}
