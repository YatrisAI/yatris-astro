import type { FormNode } from '../forms/tree.js';
import type { Issue } from '../forms/spec.js';
import type { ReservationMode, ReservationPresentation, ResourceKind } from './registry.js';

/** Shapes are checked by the validators, not the type system; these types describe a valid value. */

export interface ReservationResult {
  valid: boolean;
  errors: Issue[];
  /** Non-blocking findings for authoring; publication may still require them resolved. */
  warnings: Issue[];
}

export interface HoursEntry {
  day: 'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday';
  start: string;
  end: string;
}

export interface HoursException {
  date: string;
  closed?: boolean;
  hours?: { start: string; end: string }[];
}

export interface Seats {
  min: number;
  max: number;
}

export interface ReservationLocation {
  key: string;
  type: 'online' | 'in_person' | 'phone';
  label: string;
  meetingUrl?: string;
  address?: string;
  instructions?: string;
}

export interface ReservationResource {
  key: string;
  kind: ResourceKind;
  label: string;
  capacity?: number;
  seats?: Seats;
  weeklyHours?: HoursEntry[];
  exceptions?: HoursException[];
}

export interface ReservationService {
  key: string;
  label: string;
  durationMinutes: number;
  bufferBeforeMinutes?: number;
  bufferAfterMinutes?: number;
  variants?: { key: string; label: string; durationMinutes: number }[];
  requirements: { resourceKeys: string[]; count: number }[];
  visitorChoosesPractitioner?: boolean;
}

export interface ReservationOperations {
  timezone?: string;
  slotIntervalMinutes?: number;
  bookingHorizonDays?: number;
  minimumLeadMinutes?: number;
  holdMinutes?: number;
  confirmationMode?: 'automatic' | 'manual';
  approvalWindowMinutes?: number;
  cancelCutoffMinutes?: number;
  rescheduleCutoffMinutes?: number;
  reminderMinutesBefore?: number;
  venueHours?: { weekly?: HoursEntry[]; exceptions?: HoursException[] };
  locations?: ReservationLocation[];
  resources?: ReservationResource[];
  appointment?: {
    durationMinutes: number;
    bufferBeforeMinutes?: number;
    bufferAfterMinutes?: number;
    hostStrategy: 'single' | 'one_available';
    hostResourceKeys: string[];
    visitorChoosesHost?: boolean;
  };
  services?: ReservationService[];
  party?: {
    minSize: number;
    maxSize: number;
    durationMinutes: number;
    bufferAfterMinutes?: number;
    strategy: 'pool' | 'tables';
    poolResourceKey?: string;
    tableResourceKeys?: string[];
    combinations?: { key: string; resourceKeys: string[]; seats: Seats }[];
  };
}

export interface ReservationSetup {
  $schema?: string;
  contractVersion: 1;
  key: string;
  name: string;
  locale: 'ja';
  mode: ReservationMode;
  presentation?: ReservationPresentation;
  identityFields: { name: string; email: string; phone?: string };
  questions: FormNode[];
  copy?: { pendingMessage?: string; confirmedMessage?: string };
  success?: { redirectPath: string };
  operations?: ReservationOperations;
}
