import type { Issue } from '../forms/spec.js';
import type { ReservationApiErrorCode } from '../reservations/messages.js';
import type { ReservationPublicDefinition } from '../reservations/public.js';
import type { ReservationTheme } from '../reservations/theme.js';
import type { HoursEntry, HoursException } from '../reservations/types.js';

/**
 * What `mountBooking(root, config, options)` takes. A live mount (the hosted
 * booking page on book.yatris.jp) talks to the booking API; a preview mount
 * (`astro dev` with YATRIS_RESERVATIONS_PREVIEW=1) answers every request
 * itself from synthetic data and never touches the network.
 */
export type BookingConfig = LiveBookingConfig | PreviewBookingConfig;

interface BookingConfigBase {
  /** The setup key, e.g. "consultation". */
  setupKey: string;
  /** Validated theme tokens (README "Theme"), applied as CSS custom properties. Invalid tokens are ignored. */
  theme?: ReservationTheme | null;
}

export interface BookingEndpoints {
  availability: string;
  holds: string;
  bookings: string;
  receipt: string;
}

export interface LiveBookingConfig extends BookingConfigBase {
  mode: 'live';
  /** `https://book.yatris.jp/api/public/websites/{websiteId}/reservations/{setupKey}` */
  definitionUrl: string;
  /** Overrides the definition's `endpoints`. Every URL must share the definition URL's origin. */
  endpoints?: BookingEndpoints | null;
  /** The ephemeral booking session, sent as `X-Booking-Session` on every POST. */
  bookingSession: string;
  /** Overrides the definition's `turnstile`. */
  turnstile?: { siteKey: string; action: string } | null;
  /** Present when the page runs inside `<ReservationEmbed>`'s iframe. */
  embed?: { instance: string; parentOrigin: string } | null;
  /**
   * The Website's public origin (e.g. `https://www.example.jp`). Relative
   * privacy-policy links of consent questions open on it rather than on the
   * booking origin. Default: the embed's `parentOrigin`.
   */
  siteOrigin?: string | null;
}

export interface PreviewBookingConfig extends BookingConfigBase {
  mode: 'preview';
  /** The local declaration file, for the preview marker. */
  source: string;
  /** The synthetic public definition built from the local declaration. */
  definition?: ReservationPublicDefinition;
  /** Opening hours the synthetic availability is generated from. */
  synthetic?: { weeklyHours: HoursEntry[]; exceptions?: HoursException[] };
  /** Why no preview could be built: a missing, invalid or unsupported declaration. */
  problem?: { message: string; issues: Issue[] };
}

export interface Slot {
  start: string;
  end: string;
}

export interface AvailabilityResponse {
  timezone: string;
  operationsRevision: number;
  days: { date: string; slots: Slot[] }[];
}

export interface HoldResponse {
  holdToken: string;
  expiresAt: string;
  start: string;
  end: string;
  hostLabel?: string;
  practitionerLabel?: string;
}

export type BookingState = 'confirmed' | 'pending_approval' | 'confirming';

export interface AcceptedResponse {
  status: 'accepted';
  receipt: string;
  state: BookingState;
  approvalDeadline?: string;
  success: { mode: 'message'; message: string } | { mode: 'redirect'; path: string };
  /** The visitor's management page on the booking origin (never posted to the parent). */
  managementUrl?: string;
}

export interface ReceiptResponse {
  receipt: string;
  state: 'confirming' | 'confirmed' | 'pending_approval' | 'rejected' | 'expired' | 'cancelled';
}

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ReservationApiErrorCode | 'network'; status: number; data: Record<string, unknown> | null; retryAfter: number | null };

/** The booking API as the controller sees it; live and preview implement it. */
export interface BookingApi {
  definition(revalidate: boolean): Promise<ApiResult<ReservationPublicDefinition>>;
  availability(body: { from: string; to: string; selection: Selection }): Promise<ApiResult<AvailabilityResponse>>;
  hold(body: { selection: Selection; start: string; turnstileToken?: string; replaceHoldToken?: string }): Promise<ApiResult<HoldResponse>>;
  book(body: FormData): Promise<ApiResult<AcceptedResponse>>;
  receipt(receipt: string): Promise<ApiResult<ReceiptResponse>>;
}

/** The `selection` of availability and holds (contract README "Selection"). */
export interface Selection {
  locationKey?: string;
  /** `time_slot`, when the visitor chose a host. */
  hostKey?: string;
  /** `service`: the one service of the booking. */
  serviceKey?: string;
  /** `service`: required when the service has variants. */
  variantKey?: string;
  /** `service`, when the visitor chose a practitioner; absent for 「指定しない」. */
  practitionerKey?: string;
  /** `party`: an integer from `party.minSize` to `party.maxSize`. */
  partySize?: number;
}
