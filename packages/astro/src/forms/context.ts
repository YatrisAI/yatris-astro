import { toDecimal } from './decimal.js';
import type { AnswerKind } from './registry.js';
import { isPlainObject } from './spec.js';
import type { AnswerValue } from './conditions.js';

/**
 * Question context (contract v1, README "Question context"): read-only
 * system inputs a consumer supplies next to a node list, such as
 * `booking.service_key` for reservation questions. Conditions may compare
 * them like answers, but visitors can never set them, and they never take
 * part in cycles. Keys need a dot, so they never collide with node keys.
 */

export const CONTEXT_KEY_PATTERN = '^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]{0,63}$';
const CONTEXT_KEY = new RegExp(CONTEXT_KEY_PATTERN);

/** Answer kinds a context entry may have: every referenceable kind. */
export type ContextKind = Exclude<AnswerKind, 'files' | 'quiz'>;
export const CONTEXT_KINDS: readonly ContextKind[] = ['string', 'choice', 'choices', 'decimal', 'date', 'time', 'datetime', 'boolean'];

export interface ContextEntry {
  kind: ContextKind;
  /** Allowed values for `choice` and `choices`; when given, condition values must be among them. */
  options?: string[];
}

export type QuestionContext = Record<string, ContextEntry>;

/**
 * A context is consumer configuration, never visitor input, so a malformed
 * one is a programming error and throws a TypeError.
 */
export function assertContext(context: unknown): asserts context is QuestionContext {
  if (!isPlainObject(context)) throw new TypeError('Question context must be an object.');
  for (const [key, entry] of Object.entries(context)) {
    if (!CONTEXT_KEY.test(key)) throw new TypeError(`Question context key "${key}" must match ${CONTEXT_KEY_PATTERN}.`);
    if (!isPlainObject(entry)) throw new TypeError(`Question context entry "${key}" must be an object.`);
    for (const prop of Object.keys(entry)) {
      if (prop !== 'kind' && prop !== 'options') throw new TypeError(`Question context entry "${key}" has an unknown property "${prop}".`);
    }
    if (!CONTEXT_KINDS.includes(entry.kind as ContextKind)) throw new TypeError(`Question context entry "${key}" has an invalid kind.`);
    if (entry.options !== undefined) {
      if (entry.kind !== 'choice' && entry.kind !== 'choices') throw new TypeError(`Question context entry "${key}" takes options only for choice or choices.`);
      if (!Array.isArray(entry.options) || !entry.options.every((o) => typeof o === 'string')) {
        throw new TypeError(`Question context entry "${key}" options must be an array of strings.`);
      }
    }
  }
}

/** The context entry a condition field names, if any. */
export function contextEntry(context: QuestionContext, field: string): ContextEntry | undefined {
  return Object.hasOwn(context, field) ? context[field] : undefined;
}

/**
 * Coerces a supplied context value to its kind before comparison. Decimals
 * accept a decimal string or JSON number and become canonical; `choices`
 * needs an array of strings, `boolean` a Boolean and every other kind a
 * string. Anything else counts as absent.
 */
export function contextValue(kind: ContextKind, raw: unknown): AnswerValue {
  switch (kind) {
    case 'decimal':
      return toDecimal(raw) ?? undefined;
    case 'choices':
      return Array.isArray(raw) && raw.every((v) => typeof v === 'string') ? raw : undefined;
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;
    default:
      return typeof raw === 'string' ? raw : undefined;
  }
}
