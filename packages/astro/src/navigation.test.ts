import { describe, expect, it } from 'vitest';
import { defineNavigation } from './navigation.js';

describe('defineNavigation', () => {
  it('returns valid entries unchanged', () => {
    const items = [
      { label: 'ホーム', href: '/' },
      { label: '実績紹介', href: '/works/', children: [{ label: '事例', href: '/works/example/' }] },
      { label: '採用', href: 'https://example.com/careers' },
    ];

    expect(defineNavigation(items)).toBe(items);
  });

  it.each([
    ['a relative path', 'works/'],
    ['a protocol-relative URL', '//example.com/'],
    ['an http URL', 'http://example.com/'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['an empty string', ''],
  ])('rejects %s', (_, href) => {
    expect(() => defineNavigation([{ label: 'X', href }])).toThrow('href must be a root-relative path or an https URL');
  });

  it('rejects an empty label', () => {
    expect(() => defineNavigation([{ label: ' ', href: '/' }])).toThrow('navigation[0]: label must be a non-empty string');
  });

  it('names the nested entry that is invalid', () => {
    expect(() =>
      defineNavigation([{ label: 'A', href: '/a/', children: [{ label: 'B', href: 'b/' }] }]),
    ).toThrow('navigation[0].children[0] (B)');
  });
});
