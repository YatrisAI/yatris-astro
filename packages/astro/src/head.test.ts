import { describe, expect, it } from 'vitest';
import { gtmNoscript, headTags, type HeadContext } from './head.js';

const none = { gtmContainerId: null, searchConsoleVerification: null };
const ctx = (over: Partial<HeadContext> = {}): HeadContext => ({
  site: new URL('https://www.example.co.jp'),
  pathname: '/works/',
  config: none,
  ...over,
});
const find = (tags: ReturnType<typeof headTags>, key: string, value: string) =>
  tags.find((t) => 'attrs' in t && t.attrs[key] === value);

describe('headTags', () => {
  it('renders the essentials in order', () => {
    const tags = headTags({ title: '実績紹介', description: '当社の実績です。' }, ctx());

    expect(tags.slice(0, 3)).toEqual([
      { tag: 'meta', attrs: { charset: 'utf-8' } },
      { tag: 'meta', attrs: { name: 'viewport', content: 'width=device-width, initial-scale=1' } },
      { tag: 'title', text: '実績紹介' },
    ]);
    expect(find(tags, 'name', 'description')).toMatchObject({ attrs: { content: '当社の実績です。' } });
    expect(find(tags, 'rel', 'canonical')).toMatchObject({ attrs: { href: 'https://www.example.co.jp/works/' } });
  });

  it('refuses an empty title', () => {
    expect(() => headTags({ title: '  ' }, ctx())).toThrow('page.title is required (page /works/)');
  });

  it('omits canonical and og:url without a configured site', () => {
    const tags = headTags({ title: 'T' }, ctx({ site: undefined }));

    expect(find(tags, 'rel', 'canonical')).toBeUndefined();
    expect(find(tags, 'property', 'og:url')).toBeUndefined();
  });

  it('honours canonicalPath, noindex and absolute social images', () => {
    const tags = headTags({ title: 'T', canonicalPath: '/works/a/', noindex: true, image: '/og.png', imageAlt: 'alt' }, ctx());

    expect(find(tags, 'rel', 'canonical')).toMatchObject({ attrs: { href: 'https://www.example.co.jp/works/a/' } });
    expect(find(tags, 'name', 'robots')).toMatchObject({ attrs: { content: 'noindex, nofollow' } });
    expect(find(tags, 'property', 'og:image')).toMatchObject({ attrs: { content: 'https://www.example.co.jp/og.png' } });
    expect(find(tags, 'name', 'twitter:card')).toMatchObject({ attrs: { content: 'summary_large_image' } });
  });

  it('adds article dates only to articles', () => {
    const page = { title: 'T', publishedAt: '2026-09-01T00:00:00+09:00' };

    expect(find(headTags(page, ctx()), 'property', 'article:published_time')).toBeUndefined();
    expect(find(headTags({ ...page, type: 'article' }, ctx()), 'property', 'article:published_time')).toBeDefined();
  });

  it('escapes structured data so it cannot close its script element', () => {
    const tags = headTags({ title: 'T', structuredData: [{ name: '</script><script>alert(1)</script>' }] }, ctx());
    const script = tags.find((t) => t.tag === 'script');

    expect(script).toMatchObject({ attrs: { type: 'application/ld+json' } });
    expect(script && 'html' in script && script.html).not.toContain('</script>');
  });

  it('renders no Google markup when nothing is configured', () => {
    const tags = headTags({ title: 'T' }, ctx());

    expect(JSON.stringify(tags)).not.toContain('googletagmanager');
    expect(find(tags, 'name', 'google-site-verification')).toBeUndefined();
  });

  it('renders exactly one GTM loader and the verification tag when configured', () => {
    const tags = headTags({ title: 'T' }, ctx({ config: { gtmContainerId: 'GTM-ABC1234', searchConsoleVerification: 'tok' } }));

    expect(JSON.stringify(tags).match(/googletagmanager\.com\/gtm\.js/g)).toHaveLength(1);
    expect(JSON.stringify(tags)).toContain('GTM-ABC1234');
    expect(find(tags, 'name', 'google-site-verification')).toMatchObject({ attrs: { content: 'tok' } });
  });
});

describe('gtmNoscript', () => {
  it('points the fallback iframe at the container', () => {
    expect(gtmNoscript('GTM-ABC1234')).toContain('https://www.googletagmanager.com/ns.html?id=GTM-ABC1234');
  });
});
