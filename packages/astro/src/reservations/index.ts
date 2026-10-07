/**
 * Yatris reservation contract v1 (`@yatris/astro/reservations`): the setup
 * declaration and operations registry and validators, the question context
 * by mode, the public definition projection and the API error messages.
 * Questions reuse the forms contract (`@yatris/astro/forms`). Dependency-free
 * and browser-safe.
 *
 * Reference: contracts/reservations/v1/README.md in this package.
 */

export {
  DEFAULT_POLICIES,
  HOURS_TIME_PATTERN,
  LOCATION_TYPES,
  MODES,
  OPERATIONS,
  PRESENTATIONS,
  RESERVATION_CONTRACT_VERSION,
  RESOURCE_KINDS,
  SETUP,
  SETUP_KEY_PATTERN,
  WEEKDAYS,
  type ReservationMode,
  type ReservationPresentation,
  type ResourceKind,
} from './registry.js';
export { validateSetup } from './setup.js';
export { HTTPS_URL_PATTERN, isHttpsUrl, isValidTimezone, TIMEZONE_PATTERN, validateOperations, type OperationsOptions } from './operations.js';
export { reservationContext } from './context.js';
export {
  reservationDigest,
  reservationPublicContent,
  reservationPublicDefinition,
  type ReservationPolicies,
  type ReservationPublicContent,
  type ReservationPublicDefinition,
  type ReservationPublicMeta,
} from './public.js';
export { RESERVATION_API_ERRORS, type ReservationApiErrorCode } from './messages.js';
export { setupJsonSchema, SETUP_SCHEMA_ID } from './json-schema.js';
export type {
  HoursEntry,
  HoursException,
  ReservationLocation,
  ReservationOperations,
  ReservationResource,
  ReservationResult,
  ReservationService,
  ReservationSetup,
} from './types.js';
export type { Issue } from '../forms/spec.js';
export type { QuestionContext } from '../forms/context.js';
