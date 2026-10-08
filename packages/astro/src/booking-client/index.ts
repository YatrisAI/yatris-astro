/**
 * The Yatris booking flow UI (`@yatris/astro/booking/client`): framework-free
 * TypeScript shared by the hosted booking page on book.yatris.jp and the
 * synthetic preview under `astro dev`. Styles: components/YatrisBooking.css
 * (yb-*) with the forms field styles (components/YatrisForm.css, yf-*).
 *
 * Reference: contracts/reservations/v1/README.md "Booking UI".
 */

import { BookingController, type BookingOptions } from './controller.js';
import type { BookingConfig } from './types.js';

export { applyTheme, BookingController, cutoffNotice, newIdempotencyKey, PREVIEW_MARKER_ID, type BookingOptions } from './controller.js';
export { rejectionCode, resolveEndpoints, retryAfterSeconds } from './api.js';
export { contextValuesOf, durationOf, flowOf, keptSelection, selectionProblem, stepsOf, type BookingFlow, type BookingStep, type SelectionProblem } from './flow.js';
export { cellState, matrixRows, placeSlots, type CellState, type PlacedSlot } from './picker.js';
export { previewApi, redactedBooking, sensitiveKeys, SYNTHETIC_WEEKLY_HOURS, syntheticClosed, syntheticSlots, type PreviewApi } from './preview-api.js';
export { UI as BOOKING_UI } from './ui.js';
export type {
  AcceptedResponse,
  ApiResult,
  AvailabilityDay,
  AvailabilityResponse,
  BookingApi,
  BookingConfig,
  BookingEndpoints,
  BookingState,
  HoldResponse,
  LiveBookingConfig,
  PreviewBookingConfig,
  ReceiptResponse,
  Selection,
  Slot,
} from './types.js';

/** Mounts the booking flow into `root` (its children are replaced). */
export function mountBooking(root: HTMLElement, config: BookingConfig, options: BookingOptions = {}): BookingController {
  return new BookingController(root, config, options);
}
