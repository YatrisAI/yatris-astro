import type { AnswerValue } from '../forms/conditions.js';
import type { ReservationPublicDefinition } from '../reservations/public.js';
import type { Selection } from './types.js';

/**
 * The three booking flows and their selection rules (contract README
 * "Selection"), shared by the controller and the synthetic preview API so
 * both judge a selection exactly as the server does.
 *
 * Every flow has the same three steps: `select` (the mode's own choices with
 * the date and time together), `details` (contact details, questions and
 * the booking terms) and `outcome`.
 *
 * - `time_slot`: location, host → week grid of times
 * - `service` (`business` + `service`): service, variant, practitioner → week grid of times
 * - `party` (`business` + `party`): party size → 空席表 (a seven-day availability matrix)
 */

export type BookingFlow = 'time_slot' | 'service' | 'party';
export type BookingStep = 'select' | 'details' | 'outcome';
/**
 * The choice a selection must change: the service choices, the party size,
 * or `date` for the location and host (the controls beside the dates).
 */
export type SelectionProblem = 'service' | 'party' | 'date';

export const ALL_STEPS: readonly BookingStep[] = ['select', 'details', 'outcome'];

export type PublicService = NonNullable<ReservationPublicDefinition['services']>[number];

/** The flow a definition asks for, or null when this UI cannot draw it. */
export function flowOf(definition: Pick<ReservationPublicDefinition, 'setup'>): BookingFlow | null {
  const { mode, presentation } = definition.setup;
  if (mode === 'time_slot') return 'time_slot';
  if (mode === 'business' && (presentation === 'service' || presentation === 'party')) return presentation;
  return null;
}

/** The steps of a flow, in order: the same three for every flow. */
export function stepsOf(_flow: BookingFlow): BookingStep[] {
  return [...ALL_STEPS];
}

/** The service a selection names, if the definition has it. */
export function serviceOf(definition: ReservationPublicDefinition, selection: Selection): PublicService | null {
  return definition.services?.find((s) => s.key === selection.serviceKey) ?? null;
}

/** The scheduled duration of the selection in minutes, or null while it is not known yet. */
export function durationOf(definition: ReservationPublicDefinition, selection: Selection): number | null {
  const flow = flowOf(definition);
  if (flow === 'time_slot') return definition.appointment?.durationMinutes ?? null;
  if (flow === 'party') return definition.party?.durationMinutes ?? null;
  const service = serviceOf(definition, selection);
  if (!service) return null;
  if (!service.variants.length) return service.durationMinutes;
  return service.variants.find((v) => v.key === selection.variantKey)?.durationMinutes ?? null;
}

const has = (selection: Selection, key: keyof Selection) => selection[key] !== undefined;

/**
 * The choice that must change for the server to accept `selection`, or null
 * when it is complete and valid: `service` / `party` for the mode's own
 * choices, `date` for the location and host. Mirrors the server's
 * `validation_failed` + `invalid_selection` rules, so a rejected selection
 * points the visitor at the right control.
 */
export function selectionProblem(definition: ReservationPublicDefinition, selection: Selection): SelectionProblem | null {
  const flow = flowOf(definition);
  if (flow === 'service') {
    const service = serviceOf(definition, selection);
    if (!service || has(selection, 'hostKey') || has(selection, 'partySize')) return 'service';
    if (service.variants.length ? !service.variants.some((v) => v.key === selection.variantKey) : has(selection, 'variantKey')) return 'service';
    if (has(selection, 'practitionerKey') && !(service.visitorChoosesPractitioner && service.practitioners.some((p) => p.key === selection.practitionerKey))) return 'service';
  } else if (flow === 'party') {
    const party = definition.party;
    const size = selection.partySize;
    if (!party || typeof size !== 'number' || !Number.isInteger(size) || size < party.minSize || size > party.maxSize) return 'party';
    if (has(selection, 'hostKey') || has(selection, 'serviceKey') || has(selection, 'variantKey') || has(selection, 'practitionerKey')) return 'party';
  } else if (flow === 'time_slot') {
    if (has(selection, 'serviceKey') || has(selection, 'variantKey') || has(selection, 'practitionerKey') || has(selection, 'partySize')) return 'date';
    const appointment = definition.appointment;
    if (has(selection, 'hostKey') && !(appointment?.visitorChoosesHost && appointment.hosts.some((h) => h.key === selection.hostKey))) return 'date';
  } else return 'date';
  if (definition.locations.length ? !definition.locations.some((l) => l.key === selection.locationKey) : has(selection, 'locationKey')) return 'date';
  return null;
}

/**
 * The parts of `previous` that are still valid for `definition` (after a
 * reload): the single location is always chosen; anything that no longer
 * exists is dropped.
 */
export function keptSelection(definition: ReservationPublicDefinition, previous: Selection = {}): Selection {
  const out: Selection = {};
  if (definition.locations.length === 1) out.locationKey = definition.locations[0]!.key;
  else if (definition.locations.some((l) => l.key === previous.locationKey)) out.locationKey = previous.locationKey;
  const flow = flowOf(definition);
  if (flow === 'time_slot') {
    const appointment = definition.appointment;
    if (appointment?.visitorChoosesHost && appointment.hosts.some((h) => h.key === previous.hostKey)) out.hostKey = previous.hostKey;
  } else if (flow === 'service') {
    const service = serviceOf(definition, previous);
    if (service) {
      out.serviceKey = service.key;
      if (service.variants.some((v) => v.key === previous.variantKey)) out.variantKey = previous.variantKey;
      if (service.visitorChoosesPractitioner && service.practitioners.some((p) => p.key === previous.practitionerKey)) out.practitionerKey = previous.practitionerKey;
    }
  } else if (flow === 'party') {
    const party = definition.party;
    if (party && party.minSize === party.maxSize) out.partySize = party.minSize;
    else if (party && typeof previous.partySize === 'number' && Number.isInteger(previous.partySize) && previous.partySize >= party.minSize && previous.partySize <= party.maxSize) {
      out.partySize = previous.partySize;
    }
  }
  return out;
}

/**
 * The `booking.*` question-context values of a selection (README "Question
 * context"), as the server evaluates them: keys of the setup's mode only,
 * `booking.party_size` as a decimal string, `booking.starts_at` once a time
 * is held. A key the visitor left to the server (host, practitioner) is
 * absent, so a condition on it is empty in the browser.
 */
export function contextValuesOf(definition: ReservationPublicDefinition, selection: Selection, startsAt: string | null): Record<string, AnswerValue> {
  const values: Record<string, AnswerValue> = {};
  const flow = flowOf(definition);
  if (selection.locationKey !== undefined) values['booking.location_key'] = selection.locationKey;
  if (startsAt !== null) values['booking.starts_at'] = startsAt;
  if (flow === 'time_slot' && selection.hostKey !== undefined) values['booking.host_key'] = selection.hostKey;
  if (flow === 'service') {
    if (selection.serviceKey !== undefined) values['booking.service_key'] = selection.serviceKey;
    if (selection.variantKey !== undefined) values['booking.variant_key'] = selection.variantKey;
  }
  if (flow === 'party' && selection.partySize !== undefined) values['booking.party_size'] = String(selection.partySize);
  return values;
}
