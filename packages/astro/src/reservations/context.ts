import type { ContextEntry, QuestionContext } from '../forms/context.js';
import { modePresentation } from './operations.js';
import type { ReservationOperations, ReservationSetup } from './types.js';

/**
 * The question context of a setup (README "Question context"): the
 * read-only `booking.*` inputs its questions may reference, by mode. Choice
 * entries carry `options` only when operations are known (`null`: unknown);
 * options are deduplicated in first-appearance order.
 */
export function reservationContext(setup: Pick<ReservationSetup, 'mode' | 'presentation'>, operations: ReservationOperations | null): QuestionContext {
  const presentation = modePresentation(setup);
  const choice = (options: (ops: ReservationOperations) => string[]): ContextEntry =>
    operations === null ? { kind: 'choice' } : { kind: 'choice', options: [...new Set(options(operations))] };

  const context: QuestionContext = {
    'booking.location_key': choice((ops) => (ops.locations ?? []).map((l) => l.key)),
    'booking.starts_at': { kind: 'datetime' },
  };
  if (setup.mode === 'time_slot') {
    context['booking.host_key'] = choice((ops) => ops.appointment?.hostResourceKeys ?? []);
  } else if (presentation === 'service') {
    context['booking.service_key'] = choice((ops) => (ops.services ?? []).map((s) => s.key));
    context['booking.variant_key'] = choice((ops) => (ops.services ?? []).flatMap((s) => (s.variants ?? []).map((v) => v.key)));
  } else if (presentation === 'party') {
    context['booking.party_size'] = { kind: 'decimal' };
  }
  return context;
}
