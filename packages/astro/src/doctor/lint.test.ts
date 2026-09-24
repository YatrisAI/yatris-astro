import { describe, expect, it } from 'vitest';
import { lintSource } from './lint.js';

const codes = (text: string) => lintSource('src/x.astro', text).map((f) => `${f.severity}:${f.code}`);

describe('lintSource', () => {
  it('accepts ordinary markup', () => {
    expect(codes('<div x-data="{ open: false }" class="p-4"><p x-text="label"></p></div>')).toEqual([]);
  });

  it('fails hand-written Google tags', () => {
    expect(codes("<script>gtag('config', 'G-XXXX')</script>")).toContain('error:direct-tag');
    expect(codes('<script src="https://www.googletagmanager.com/gtm.js?id=GTM-X"></script>')).toContain('error:direct-tag');
  });

  it('fails a Delivery credential exposed through a PUBLIC_ variable', () => {
    expect(codes('fetch(url, { headers: { key: import.meta.env.PUBLIC_YATRIS_DELIVERY_API_KEY } })')).toContain(
      'error:public-credential',
    );
  });

  it('fails direct Delivery API calls that bypass the loader', () => {
    expect(codes("await fetch(`${import.meta.env.YATRIS_DELIVERY_ENDPOINT}/items`)")).toContain('error:direct-delivery');
    expect(codes("fetch('https://api.yatris.jp/api/v1/delivery/7/items')")).toContain('error:direct-delivery');
    expect(codes("import { getYatrisList } from '@yatris/astro/delivery';")).toEqual([]);
  });

  it('fails CDN scripts', () => {
    expect(codes('<script src="https://unpkg.com/alpinejs" defer></script>')).toContain('error:cdn-script');
  });

  it('warns on x-html and dynamically built Tailwind classes', () => {
    expect(codes('<div x-html="body"></div>')).toContain('warning:x-html');
    expect(codes('<div class={`bg-${color}-500`}></div>')).toContain('warning:dynamic-class');
  });
});
