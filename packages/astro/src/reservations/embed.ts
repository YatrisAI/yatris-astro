import { PATH_PATTERN } from '../forms/text.js';
import { SETUP_KEY_PATTERN } from './registry.js';

/**
 * The hosted booking page URL and the iframe messaging protocol v1 (README
 * "Embedding"). Browser-safe and dependency-free: the parent side
 * (`<ReservationEmbed>`) and the child side (the booking page on
 * book.yatris.jp) both use these definitions.
 */

export const DEFAULT_BOOKING_ORIGIN = 'https://book.yatris.jp';
/** A per-embed random id. */
export const INSTANCE_PATTERN = '^[A-Za-z0-9_-]{16,64}$';
/** The base64url alphabet the `theme` parameter uses (see theme.ts). */
const ENCODED_THEME_PATTERN = /^[A-Za-z0-9_-]{1,1023}$/;

export const BOOKING_MESSAGE_SOURCE = 'yatris-booking';
export const BOOKING_PROTOCOL_VERSION = 1;
export const BOOKING_MESSAGE_TYPES = ['ready', 'height', 'status', 'navigate'] as const;
export type BookingMessageType = (typeof BOOKING_MESSAGE_TYPES)[number];
export const BOOKING_STATUSES = ['loading', 'ready', 'unavailable', 'error', 'submitted'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];
/** The largest `height` a message may carry; the parent clamps further to its own maximum. */
export const MAX_MESSAGE_HEIGHT = 20000;
/** `navigate.path`: the forms path grammar, at most this many characters. */
export const MAX_NAVIGATE_PATH_LENGTH = 500;

interface Envelope {
  source: typeof BOOKING_MESSAGE_SOURCE;
  version: typeof BOOKING_PROTOCOL_VERSION;
  instance: string;
}

export type BookingMessage =
  | (Envelope & { type: 'ready' })
  | (Envelope & { type: 'height'; height: number })
  | (Envelope & { type: 'status'; status: BookingStatus })
  | (Envelope & { type: 'navigate'; path: string });

/** Payload keys per type: a message carries exactly the envelope plus these. */
const PAYLOAD_KEYS: Record<BookingMessageType, readonly string[]> = {
  ready: [],
  height: ['height'],
  status: ['status'],
  navigate: ['path'],
};

const isLoopback = (hostname: string) =>
  hostname === 'localhost' || hostname.endsWith('.localhost') || /^127(?:\.\d{1,3}){3}$/.test(hostname) || hostname === '[::1]';

/**
 * A booking origin: `https:` on any host, or `http:` on a loopback host
 * (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`) for local development.
 * Only an origin: no credentials, path, query or fragment. Returns the
 * serialized origin; throws a TypeError otherwise.
 */
export function parseBookingOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(`${JSON.stringify(value)} is not a URL; a booking origin looks like ${DEFAULT_BOOKING_ORIGIN}.`);
  }
  const bare = !url.username && !url.password && (url.pathname === '/' || url.pathname === '') && !url.search && !url.hash && !/[?#]/.test(value);
  if (!bare) throw new TypeError(`${JSON.stringify(value)} must be an origin only (scheme, host and port), such as ${DEFAULT_BOOKING_ORIGIN}.`);
  if (url.protocol === 'https:') return url.origin;
  if (url.protocol === 'http:' && isLoopback(url.hostname)) return url.origin;
  throw new TypeError(`${JSON.stringify(value)} must use https: (http: is accepted only for localhost and other loopback hosts).`);
}

export function isBookingOrigin(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    return parseBookingOrigin(value) === value;
  } catch {
    return false;
  }
}

/** A serialized `http:`/`https:` origin, as `location.origin` gives it. */
export function isWebOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && url.origin === value;
  } catch {
    return false;
  }
}

export interface BookingPageInput {
  /** A booking origin (parseBookingOrigin). */
  origin: string;
  /** The public numeric Website id. */
  websiteId: number;
  setupKey: string;
  /** An encoded theme (encodeTheme); omitted when absent or empty. */
  theme?: string | null;
}

export interface BookingEmbedInput extends BookingPageInput {
  instance: string;
  /** The embedding page's origin (`location.origin`). */
  parentOrigin: string;
}

function pageBase(input: BookingPageInput): string {
  const origin = parseBookingOrigin(input.origin);
  if (!Number.isSafeInteger(input.websiteId) || input.websiteId < 1) throw new TypeError('websiteId must be a positive integer.');
  if (typeof input.setupKey !== 'string' || !new RegExp(SETUP_KEY_PATTERN, 'u').test(input.setupKey)) throw new TypeError(`setupKey ${JSON.stringify(input.setupKey)} is not a setup key.`);
  if (input.theme !== undefined && input.theme !== null && input.theme !== '' && !ENCODED_THEME_PATTERN.test(input.theme)) throw new TypeError('theme must be an encoded theme (encodeTheme).');
  return `${origin}/book/${input.websiteId}/${input.setupKey}`;
}

/** The direct booking page: `{origin}/book/{websiteId}/{setupKey}[?theme=…]`. */
export function bookingPageUrl(input: BookingPageInput): string {
  const base = pageBase(input);
  return input.theme ? `${base}?theme=${input.theme}` : base;
}

/** The iframe URL: the page URL with `embed=1&instance=…&parentOrigin=…[&theme=…]`. */
export function bookingEmbedUrl(input: BookingEmbedInput): string {
  const base = pageBase(input);
  if (typeof input.instance !== 'string' || !new RegExp(INSTANCE_PATTERN).test(input.instance)) throw new TypeError('instance must match INSTANCE_PATTERN.');
  if (!isWebOrigin(input.parentOrigin)) throw new TypeError('parentOrigin must be a serialized http(s) origin.');
  const theme = input.theme ? `&theme=${input.theme}` : '';
  return `${base}?embed=1&instance=${input.instance}&parentOrigin=${encodeURIComponent(input.parentOrigin)}${theme}`;
}

/** A fresh instance id: 22 base64url characters from 16 random bytes. */
export function newInstanceId(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

/** Whether `path` may be the target of a `navigate` message. */
export function isNavigatePath(path: unknown): path is string {
  if (typeof path !== 'string' || [...path].length > MAX_NAVIGATE_PATH_LENGTH) return false;
  return new RegExp(PATH_PATTERN, 'u').test(path);
}

const isPlain = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/**
 * Validates message data for one instance: the exact envelope, a known type
 * and exactly that type's payload. Returns a fresh copy, or null for anything
 * else (unknown type, extra or missing keys, wrong values).
 */
export function validateBookingMessage(data: unknown, instance: string): BookingMessage | null {
  if (!isPlain(data)) return null;
  if (data.source !== BOOKING_MESSAGE_SOURCE || data.version !== BOOKING_PROTOCOL_VERSION) return null;
  if (typeof data.instance !== 'string' || data.instance !== instance || !new RegExp(INSTANCE_PATTERN).test(instance)) return null;
  const type = data.type as BookingMessageType;
  if (typeof type !== 'string' || !Object.hasOwn(PAYLOAD_KEYS, type)) return null;
  const allowed = new Set(['source', 'version', 'instance', 'type', ...PAYLOAD_KEYS[type]]);
  const keys = Object.keys(data);
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) return null;
  const envelope: Envelope = { source: BOOKING_MESSAGE_SOURCE, version: BOOKING_PROTOCOL_VERSION, instance };
  switch (type) {
    case 'ready':
      return { ...envelope, type };
    case 'height': {
      const height = data.height;
      if (typeof height !== 'number' || !Number.isInteger(height) || height < 1 || height > MAX_MESSAGE_HEIGHT) return null;
      return { ...envelope, type, height };
    }
    case 'status': {
      const status = data.status as BookingStatus;
      if (typeof status !== 'string' || !(BOOKING_STATUSES as readonly string[]).includes(status)) return null;
      return { ...envelope, type, status };
    }
    case 'navigate':
      return isNavigatePath(data.path) ? { ...envelope, type, path: data.path } : null;
  }
}

export interface BookingMessageExpectation {
  /** The configured booking origin; compared exactly with `event.origin`. */
  origin: string;
  /** The embed's iframe; `event.source` must be its `contentWindow`. */
  frame: { contentWindow: unknown };
  instance: string;
}

/**
 * The parent-side check of a `message` event: exact `event.origin`,
 * `event.source === frame.contentWindow`, then validateBookingMessage.
 * Returns the message, or null to drop the event silently.
 */
export function parseBookingMessage(event: { origin: unknown; source: unknown; data: unknown }, expected: BookingMessageExpectation): BookingMessage | null {
  if (typeof event.origin !== 'string' || event.origin !== expected.origin) return null;
  const frame = expected.frame?.contentWindow;
  if (frame === null || frame === undefined || event.source !== frame) return null;
  return validateBookingMessage(event.data, expected.instance);
}

type Payload<T extends BookingMessageType> = Omit<Extract<BookingMessage, { type: T }>, keyof Envelope | 'type'>;

/**
 * Builds a message for the child to post (`parent.postMessage(message,
 * parentOrigin)`, never `"*"`). Throws a TypeError when it would not pass
 * validateBookingMessage.
 */
export function bookingMessage<T extends BookingMessageType>(instance: string, type: T, ...payload: Payload<T> extends Record<string, never> ? [] : [Payload<T>]): BookingMessage {
  const message = { source: BOOKING_MESSAGE_SOURCE, version: BOOKING_PROTOCOL_VERSION, instance, type, ...(payload[0] ?? {}) };
  const valid = validateBookingMessage(message, instance);
  if (!valid) throw new TypeError(`Invalid booking message ${JSON.stringify(message)}.`);
  return valid;
}
