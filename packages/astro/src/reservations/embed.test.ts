import { describe, expect, it } from 'vitest';
import {
  BOOKING_MESSAGE_TYPES,
  BOOKING_STATUSES,
  bookingEmbedUrl,
  bookingMessage,
  bookingPageUrl,
  DEFAULT_BOOKING_ORIGIN,
  encodeTheme,
  INSTANCE_PATTERN,
  isBookingOrigin,
  newInstanceId,
  parseBookingMessage,
  parseBookingOrigin,
  validateBookingMessage,
} from './index.js';

const INSTANCE = 'abcDEF0123456789_-xy';
const ORIGIN = 'https://book.yatris.jp';
const frame = { contentWindow: { name: 'booking frame' } };
const msg = (extra: Record<string, unknown>) => ({ source: 'yatris-booking', version: 1, instance: INSTANCE, ...extra });
const event = (data: unknown, overrides: Partial<{ origin: unknown; source: unknown }> = {}) => ({ origin: ORIGIN, source: frame.contentWindow, data, ...overrides });
const parse = (data: unknown, overrides: Partial<{ origin: unknown; source: unknown }> = {}) => parseBookingMessage(event(data, overrides), { origin: ORIGIN, frame, instance: INSTANCE });

describe('booking origin', () => {
  it('accepts https anywhere and http only on loopback hosts', () => {
    expect(parseBookingOrigin('https://book.yatris.jp')).toBe('https://book.yatris.jp');
    expect(parseBookingOrigin('https://book.yatris.jp/')).toBe('https://book.yatris.jp');
    expect(parseBookingOrigin('https://staging.example.com:8443')).toBe('https://staging.example.com:8443');
    for (const local of ['http://localhost:8000', 'http://book.localhost', 'http://127.0.0.1:8080', 'http://[::1]:3000']) expect(parseBookingOrigin(local)).toBe(local);
    expect(DEFAULT_BOOKING_ORIGIN).toBe('https://book.yatris.jp');
  });

  it('rejects other schemes, remote http, paths, queries, fragments and credentials', () => {
    for (const bad of ['http://book.yatris.jp', 'http://192.168.1.10', 'ftp://book.yatris.jp', 'javascript:alert(1)', 'https://book.yatris.jp/book', 'https://book.yatris.jp?x=1', 'https://book.yatris.jp#x', 'https://user:pw@book.yatris.jp', 'book.yatris.jp', '']) {
      expect(() => parseBookingOrigin(bad), bad).toThrow(TypeError);
      expect(isBookingOrigin(bad)).toBe(false);
    }
    expect(isBookingOrigin('https://book.yatris.jp/')).toBe(false); // not serialized exactly
  });
});

describe('booking URLs', () => {
  const theme = encodeTheme({ primary: '#4F46E5', radius: 8 });

  it('builds the iframe URL in the documented order', () => {
    expect(bookingEmbedUrl({ origin: ORIGIN, websiteId: 42, setupKey: 'consultation', instance: INSTANCE, parentOrigin: 'https://www.example.jp', theme })).toBe(
      `https://book.yatris.jp/book/42/consultation?embed=1&instance=${INSTANCE}&parentOrigin=https%3A%2F%2Fwww.example.jp&theme=${theme}`,
    );
  });

  it('omits the theme without tokens', () => {
    expect(bookingEmbedUrl({ origin: ORIGIN, websiteId: 42, setupKey: 'consultation', instance: INSTANCE, parentOrigin: 'http://localhost:4321' })).toBe(
      `https://book.yatris.jp/book/42/consultation?embed=1&instance=${INSTANCE}&parentOrigin=http%3A%2F%2Flocalhost%3A4321`,
    );
    expect(bookingEmbedUrl({ origin: ORIGIN, websiteId: 42, setupKey: 'consultation', instance: INSTANCE, parentOrigin: 'http://localhost:4321', theme: '' })).not.toContain('theme=');
  });

  it('builds the direct page without embed, instance and parentOrigin', () => {
    expect(bookingPageUrl({ origin: ORIGIN, websiteId: 42, setupKey: 'consultation' })).toBe('https://book.yatris.jp/book/42/consultation');
    expect(bookingPageUrl({ origin: 'http://localhost:8000', websiteId: 7, setupKey: 'salon-cut', theme })).toBe(`http://localhost:8000/book/7/salon-cut?theme=${theme}`);
  });

  it('refuses anything outside the public identifiers', () => {
    const base = { origin: ORIGIN, websiteId: 42, setupKey: 'consultation', instance: INSTANCE, parentOrigin: 'https://www.example.jp' };
    expect(() => bookingEmbedUrl({ ...base, origin: 'http://evil.example' })).toThrow(TypeError);
    expect(() => bookingEmbedUrl({ ...base, websiteId: 0 })).toThrow(TypeError);
    expect(() => bookingEmbedUrl({ ...base, websiteId: 1.5 })).toThrow(TypeError);
    expect(() => bookingEmbedUrl({ ...base, setupKey: '../admin' })).toThrow(TypeError);
    expect(() => bookingEmbedUrl({ ...base, instance: 'short' })).toThrow(TypeError);
    expect(() => bookingEmbedUrl({ ...base, parentOrigin: 'https://www.example.jp/page' })).toThrow(TypeError);
    expect(() => bookingEmbedUrl({ ...base, parentOrigin: 'null' })).toThrow(TypeError);
    expect(() => bookingEmbedUrl({ ...base, theme: 'not base64url!' })).toThrow(TypeError);
  });

  it('makes random instance ids that match the pattern', () => {
    const ids = new Set(Array.from({ length: 20 }, newInstanceId));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(id).toMatch(new RegExp(INSTANCE_PATTERN));
  });
});

describe('protocol messages', () => {
  it('accepts exactly the four v1 messages', () => {
    expect(parse(msg({ type: 'ready' }))).toEqual(msg({ type: 'ready' }));
    expect(parse(msg({ type: 'height', height: 1 }))).toEqual(msg({ type: 'height', height: 1 }));
    expect(parse(msg({ type: 'height', height: 20000 }))).toEqual(msg({ type: 'height', height: 20000 }));
    for (const status of BOOKING_STATUSES) expect(parse(msg({ type: 'status', status }))).toEqual(msg({ type: 'status', status }));
    expect(parse(msg({ type: 'navigate', path: '/thanks/?from=booking#done' }))).toEqual(msg({ type: 'navigate', path: '/thanks/?from=booking#done' }));
    expect(BOOKING_MESSAGE_TYPES).toEqual(['ready', 'height', 'status', 'navigate']);
  });

  it('drops events from another origin or another window', () => {
    const data = msg({ type: 'ready' });
    expect(parse(data, { origin: 'https://evil.example' })).toBeNull();
    expect(parse(data, { origin: 'https://book.yatris.jp:443' })).toBeNull();
    expect(parse(data, { origin: 'http://book.yatris.jp' })).toBeNull();
    expect(parse(data, { origin: null })).toBeNull();
    expect(parse(data, { source: {} })).toBeNull();
    expect(parse(data, { source: null })).toBeNull();
    expect(parseBookingMessage(event(data, { source: null }), { origin: ORIGIN, frame: { contentWindow: null }, instance: INSTANCE })).toBeNull();
  });

  it('drops a wrong envelope', () => {
    expect(parse(null)).toBeNull();
    expect(parse('ready')).toBeNull();
    expect(parse([msg({ type: 'ready' })])).toBeNull();
    expect(parse(msg({ type: 'ready', source: 'yatris-forms' }))).toBeNull();
    expect(parse(msg({ type: 'ready', version: 2 }))).toBeNull();
    expect(parse(msg({ type: 'ready', version: '1' }))).toBeNull();
    expect(parse(msg({ type: 'ready', instance: 'zzzzzzzzzzzzzzzzzzzz' }))).toBeNull();
    const { instance: _i, ...noInstance } = msg({ type: 'ready' });
    expect(parse(noInstance)).toBeNull();
    expect(parseBookingMessage(event(msg({ type: 'ready', instance: 'short' })), { origin: ORIGIN, frame, instance: 'short' })).toBeNull();
  });

  it('drops unknown types, extra keys and missing payloads', () => {
    expect(parse(msg({ type: 'resize', height: 10 }))).toBeNull();
    expect(parse(msg({ type: 'toString' }))).toBeNull();
    expect(parse(msg({ type: 'ready', extra: true }))).toBeNull();
    expect(parse(msg({ type: 'height' }))).toBeNull();
    expect(parse(msg({ type: 'height', height: 100, width: 100 }))).toBeNull();
    expect(parse(msg({ type: 'status', status: 'submitted', bookingId: 'b-1' }))).toBeNull();
    expect(parse(msg({ type: 'navigate', path: '/thanks/', email: 'a@example.jp' }))).toBeNull();
  });

  it('drops out-of-range heights', () => {
    for (const height of [0, -1, 20001, 1.5, '100', Number.NaN, Number.POSITIVE_INFINITY, null]) expect(parse(msg({ type: 'height', height })), String(height)).toBeNull();
  });

  it('drops unknown statuses', () => {
    for (const status of ['confirmed', 'READY', '', null, 1]) expect(parse(msg({ type: 'status', status })), String(status)).toBeNull();
  });

  it('drops unsafe navigation targets', () => {
    for (const path of ['https://evil.example/', '//evil.example/x', '/\\evil.example', 'javascript:alert(1)', 'thanks', '', '/thanks\n', `/${'a'.repeat(500)}`, '/お礼', 42]) {
      expect(parse(msg({ type: 'navigate', path })), String(path)).toBeNull();
    }
  });

  it('builds child messages that the parent accepts, and refuses invalid ones', () => {
    expect(bookingMessage(INSTANCE, 'ready')).toEqual(msg({ type: 'ready' }));
    expect(bookingMessage(INSTANCE, 'height', { height: 640 })).toEqual(msg({ type: 'height', height: 640 }));
    expect(validateBookingMessage(bookingMessage(INSTANCE, 'status', { status: 'submitted' }), INSTANCE)).not.toBeNull();
    expect(() => bookingMessage(INSTANCE, 'height', { height: 0 })).toThrow(TypeError);
    expect(() => bookingMessage(INSTANCE, 'navigate', { path: 'https://evil.example' })).toThrow(TypeError);
    expect(() => bookingMessage('short', 'ready')).toThrow(TypeError);
  });
});
