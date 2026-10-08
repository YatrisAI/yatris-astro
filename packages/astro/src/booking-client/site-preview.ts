import { BookingController } from './controller.js';
import type { PreviewBookingConfig } from './types.js';

/**
 * The `<ReservationEmbed>` preview mounter (`@yatris/astro/booking/preview`),
 * for `astro dev` with YATRIS_RESERVATIONS_PREVIEW=1 only. It runs the booking
 * flow in the page itself against synthetic data. Production builds resolve
 * `virtual:yatris/reservations-preview` to null, so neither this module nor
 * the booking UI reaches `dist/`.
 */
export function mountPreview(root: HTMLElement, config: PreviewBookingConfig): BookingController {
  return new BookingController(root, config);
}

export default { mountPreview };
