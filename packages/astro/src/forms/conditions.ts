import { compareDecimal, toDecimal } from './decimal.js';
import { assertContext, contextEntry, contextValue, type QuestionContext } from './context.js';
import type { AnswerKind } from './registry.js';
import { datetimeToSeconds, dateToDays, timeToSeconds } from './temporal.js';
import { answerKind, flatten, isInput, type Entry, type FormDeclaration, type FormNode } from './tree.js';

/**
 * Activity and conditional requiredness (contract v1, README "Conditions").
 *
 * A node is active when every enclosing group is active and its own
 * `visibleWhen` holds. A reflection is also inactive while its source is.
 * Comparisons read only *effective* values: an inactive field contributes no
 * answer, so a stale value from a hidden field can never activate another.
 */

/** A normalized answer: canonical strings, option lists, booleans. Absent is undefined. */
export type AnswerValue = string | string[] | boolean | undefined;

export interface Activity {
  /** Keys of active nodes (inputs and display), in document order. */
  active: string[];
  /** Keys of active inputs that are currently required, in document order. */
  required: string[];
}

export interface ActivityOptions {
  /** Read-only system inputs conditions may reference (README "Question context"). */
  context?: QuestionContext;
  /** Their values, supplied by the consumer and never by the visitor. Always active. */
  contextValues?: Record<string, AnswerValue>;
}

export function isEmptyValue(value: AnswerValue): boolean {
  return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

export function evaluateActivity(
  declaration: Pick<FormDeclaration, 'fields'>,
  values: Record<string, AnswerValue>,
  options: ActivityOptions = {},
): Activity {
  const context = options.context ?? {};
  assertContext(context);
  const contextValues = options.contextValues ?? {};
  const entries = flatten(declaration.fields);
  const byKey = new Map(entries.map((e) => [e.node.key, e]));
  const memo = new Map<string, boolean>();

  const isActive = (key: string): boolean => {
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    const entry = byKey.get(key);
    let active = !!entry;
    if (entry) {
      const parent = entry.groups.at(-1);
      active = (parent === undefined || isActive(parent)) && (entry.node.visibleWhen === undefined || holds(entry.node.visibleWhen));
      if (active && entry.node.type === 'reflection') active = isActive(entry.node.source);
    }
    memo.set(key, active);
    return active;
  };

  const effective = (key: string): AnswerValue => (isActive(key) ? values[key] : undefined);

  const holds = (condition: any): boolean => {
    if ('all' in condition) return condition.all.every(holds);
    if ('any' in condition) return condition.any.some(holds);
    if ('not' in condition) return !holds(condition.not);
    const system = contextEntry(context, condition.field);
    if (system) {
      const raw = Object.hasOwn(contextValues, condition.field) ? contextValues[condition.field] : undefined;
      return compare(system.kind, condition.operator, contextValue(system.kind, raw), condition.value);
    }
    const entry = byKey.get(condition.field);
    if (!entry) return false;
    return compare(answerKind(entry.node)!, condition.operator, effective(condition.field), condition.value);
  };

  const active = entries.filter((e) => isActive(e.node.key)).map((e) => e.node.key);
  const required = entries
    .filter((e) => isInput(e.node) && isActive(e.node.key) && isRequired(e, holds))
    .map((e) => e.node.key);
  return { active, required };
}

function isRequired(entry: Entry, holds: (c: any) => boolean): boolean {
  const node: FormNode = entry.node;
  if (node.type === 'quiz') return true;
  return node.required === true || (node.requiredWhen !== undefined && holds(node.requiredWhen));
}

/** Orders two non-empty values of a kind; null when they are not comparable. */
function order(kind: AnswerKind, a: string, b: unknown): number | null {
  if (kind === 'decimal') {
    const y = toDecimal(b);
    return y === null ? null : compareDecimal(a, y);
  }
  const toNumber = kind === 'date' ? dateToDays : kind === 'time' ? timeToSeconds : kind === 'datetime' ? datetimeToSeconds : null;
  if (!toNumber || typeof b !== 'string') return null;
  const x = toNumber(a);
  const y = toNumber(b);
  return x === null || y === null ? null : Math.sign(x - y);
}

function equals(kind: AnswerKind, value: AnswerValue, expected: unknown): boolean {
  if (isEmptyValue(value)) return false;
  if (kind === 'boolean') return value === expected;
  if (kind === 'string' || kind === 'choice') return value === expected;
  return order(kind, value as string, expected) === 0;
}

export function compare(kind: AnswerKind, operator: string, value: AnswerValue, expected: unknown): boolean {
  switch (operator) {
    case 'isEmpty':
      return isEmptyValue(value);
    case 'isNotEmpty':
      return !isEmptyValue(value);
    case 'eq':
      return equals(kind, value, expected);
    case 'neq':
      return !equals(kind, value, expected);
    case 'in':
      return Array.isArray(expected) && expected.some((e) => equals(kind, value, e));
    case 'contains':
      if (isEmptyValue(value)) return false;
      if (Array.isArray(value)) return value.includes(expected as string);
      return typeof value === 'string' && typeof expected === 'string' && value.includes(expected);
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (isEmptyValue(value) || typeof value !== 'string') return false;
      const o = order(kind, value, expected);
      if (o === null) return false;
      return operator === 'gt' ? o > 0 : operator === 'gte' ? o >= 0 : operator === 'lt' ? o < 0 : o <= 0;
    }
    default:
      return false;
  }
}
