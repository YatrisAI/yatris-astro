import { RESERVATION_API_ERRORS, type ReservationApiErrorCode } from '../reservations/messages.js';
import type { ReservationPublicDefinition } from '../reservations/public.js';
import type { ApiResult, BookingApi, BookingEndpoints, LiveBookingConfig } from './types.js';

/**
 * The live booking API client (contract README "Wire formats"). Every POST
 * carries the booking session in `X-Booking-Session`; endpoints come from the
 * definition (or the mount configuration) and must share the definition's
 * origin. Responses are reduced to `ApiResult`s with a contract error code.
 */

const TIMEOUT_MS = 15000;
export const ENDPOINT_KEYS = ['availability', 'holds', 'bookings', 'receipt'] as const;

export function liveApi(config: LiveBookingConfig, doFetch: typeof fetch, now: () => number): BookingApi & { endpoints(definition: ReservationPublicDefinition): BookingEndpoints | null } {
  let endpoints: BookingEndpoints | null = null;
  const origin = new URL(config.definitionUrl).origin;

  const request = async <T>(url: string, init: RequestInit): Promise<ApiResult<T>> => {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), TIMEOUT_MS) : null;
    let response: Response;
    try {
      response = await doFetch(url, { ...init, signal: controller?.signal });
    } catch {
      return { ok: false, code: 'network', status: 0, data: null, retryAfter: null };
    } finally {
      if (timer) clearTimeout(timer);
    }
    let data: Record<string, unknown> | null = null;
    try {
      data = (await response.json()) as Record<string, unknown>;
    } catch {
      data = null;
    }
    if (response.ok && data && typeof data === 'object' && data.status !== 'rejected') return { ok: true, data: data as T };
    return { ok: false, code: rejectionCode(response.status, data), status: response.status, data, retryAfter: retryAfterSeconds(response.headers.get('retry-after'), now()) };
  };

  const post = <T>(url: string, body: unknown) =>
    request<T>(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'X-Booking-Session': config.bookingSession, ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }) },
      body: body instanceof FormData ? body : JSON.stringify(body),
    });

  const need = (key: keyof BookingEndpoints): string => {
    if (!endpoints) throw new Error('booking endpoints are not known yet');
    return endpoints[key];
  };

  return {
    endpoints(definition) {
      endpoints = resolveEndpoints(config.endpoints ?? (definition.endpoints as Partial<BookingEndpoints>), origin);
      return endpoints;
    },
    definition: (revalidate) =>
      request<ReservationPublicDefinition>(config.definitionUrl, { headers: { accept: 'application/json' }, credentials: 'omit', cache: revalidate ? 'no-cache' : 'default' }),
    availability: (body) => post(need('availability'), body),
    hold: (body) => post(need('holds'), body),
    book: (body) => post(need('bookings'), body),
    receipt: (receipt) =>
      request(need('receipt'), { headers: { accept: 'application/json', authorization: `Bearer ${receipt}`, 'X-Booking-Session': config.bookingSession }, cache: 'no-store' }),
  };
}

/** The four endpoints as absolute URLs on `origin`, or null when any is missing or elsewhere. */
export function resolveEndpoints(value: Partial<BookingEndpoints> | null | undefined, origin: string): BookingEndpoints | null {
  if (!value || typeof value !== 'object') return null;
  const out: Partial<BookingEndpoints> = {};
  for (const key of ENDPOINT_KEYS) {
    const raw = value[key];
    if (typeof raw !== 'string') return null;
    try {
      const url = new URL(raw, origin);
      if (url.origin !== origin) return null;
      out[key] = url.href;
    } catch {
      return null;
    }
  }
  return out as BookingEndpoints;
}

/** The contract error code of a rejected response: from the body, else from the HTTP status. */
export function rejectionCode(status: number, data: Record<string, unknown> | null): ReservationApiErrorCode {
  if (data?.status === 'rejected' && typeof data.code === 'string' && Object.hasOwn(RESERVATION_API_ERRORS, data.code)) return data.code as ReservationApiErrorCode;
  if (status === 404 || status === 410) return 'setup_unavailable';
  if (status === 409) return 'version_changed';
  if (status === 413) return 'payload_too_large';
  if (status === 422) return 'validation_failed';
  if (status === 429) return 'rate_limited';
  return 'temporarily_unavailable';
}

export function retryAfterSeconds(header: string | null, now: number): number | null {
  if (!header) return null;
  const value = header.trim();
  if (/^\d+$/.test(value)) return Number(value);
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - now) / 1000));
}
