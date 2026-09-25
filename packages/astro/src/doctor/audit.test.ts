import { describe, expect, it } from 'vitest';
import { auditHtml } from './audit.js';
import { gtmAfterConsentSnippet, gtmHeadSnippet, gtmNoscript } from '../head.js';

const KEY = `alk_${'a1B2c3D4e5'.repeat(4)}`;

function page({ head = '<title>ホーム</title>', body = '', lang = ' lang="ja"' } = {}): string {
  return `<!doctype html><html${lang}><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;
}
const codes = (html: string, stage = 'scaffold' as const) => auditHtml('dist/index.html', html, stage).map((f) => `${f.severity}:${f.code}`);

describe('auditHtml', () => {
  it('passes a minimal scaffold page with only SEO warnings', () => {
    expect(codes(page())).toEqual(['warning:missing-description', 'warning:missing-canonical']);
  });

  it('fails a page with no title', () => {
    expect(codes(page({ head: '' }))).toContain('error:missing-title');
  });

  it('fails an empty title and multiple titles', () => {
    expect(codes(page({ head: '<title> </title>' }))).toContain('error:empty-title');
    expect(codes(page({ head: '<title>a</title><title>b</title>' }))).toContain('error:multiple-titles');
  });

  it('ignores a title inside an SVG in the body', () => {
    expect(codes(page({ body: '<svg><title>icon</title></svg>' }))).not.toContain('error:multiple-titles');
  });

  it('fails a document without a language', () => {
    expect(codes(page({ lang: '' }))).toContain('error:missing-lang');
  });

  it('does not ask a noindex page for a description or canonical', () => {
    expect(codes(page({ head: '<title>t</title><meta name="robots" content="noindex, nofollow">' }))).toEqual([]);
  });

  it('fails duplicate and relative canonicals', () => {
    const two = '<title>t</title><link rel="canonical" href="https://a.jp/"><link rel="canonical" href="https://a.jp/x">';
    expect(codes(page({ head: two }))).toContain('error:duplicate-canonical');
    expect(codes(page({ head: '<title>t</title><link rel="canonical" href="/x/">' }))).toContain('error:invalid-canonical');
  });

  it('fails a duplicate GTM installation', () => {
    const gtm = `<script>${gtmHeadSnippet('GTM-ABC1234')}</script>`;
    const html = page({ head: `<title>t</title>${gtm}${gtm}`, body: gtmNoscript('GTM-ABC1234') });

    expect(codes(html)).toContain('error:duplicate-gtm');
  });

  it('accepts one paired GTM installation and warns on a lone loader', () => {
    const gtm = `<script>${gtmHeadSnippet('GTM-ABC1234')}</script>`;

    expect(codes(page({ head: `<title>t</title>${gtm}`, body: gtmNoscript('GTM-ABC1234') }))).not.toContain('error:duplicate-gtm');
    expect(codes(page({ head: `<title>t</title>${gtm}` }))).toContain('warning:partial-gtm');
  });

  it('expects no noscript fallback when GTM waits for consent', () => {
    const gtm = `<script>${gtmAfterConsentSnippet(gtmHeadSnippet('GTM-ABC1234'))}</script>`;

    expect(codes(page({ head: `<title>t</title>${gtm}` })).filter((c) => c.includes('gtm'))).toEqual([]);
    expect(codes(page({ head: `<title>t</title>${gtm}`, body: gtmNoscript('GTM-ABC1234') }))).toContain('error:gtm-before-consent');
  });

  it('fails a direct gtag.js install', () => {
    const tag = '<script async src="https://www.googletagmanager.com/gtag/js?id=G-XXXX"></script>';
    expect(codes(page({ head: `<title>t</title>${tag}` }))).toContain('error:direct-gtag');
  });

  it('fails runtime CDN scripts', () => {
    const cdn = '<script src="https://cdn.jsdelivr.net/npm/alpinejs@3/dist/cdn.min.js" defer></script>';
    expect(codes(page({ head: `<title>t</title>${cdn}` }))).toContain('error:cdn-script');
  });

  it('fails a leaked Yatris key and redacts it', () => {
    const findings = auditHtml('dist/index.html', page({ body: `<p>${KEY}</p>` }), 'scaffold');
    const leak = findings.find((f) => f.code === 'credential-leak');

    expect(leak?.severity).toBe('error');
    expect(leak?.message).not.toContain(KEY);
  });

  it('ignores commented-out markup', () => {
    expect(codes(page({ head: '<title>t</title><!-- <title>old</title> -->' }))).not.toContain('error:multiple-titles');
  });
});
