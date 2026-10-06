import { DECIMAL_PATTERN, toDecimal } from './decimal.js';
import { isMultiline, isSingleLine, length, LINE_PATTERN, MULTILINE_PATTERN } from './text.js';

/**
 * A small property-spec language. The registry describes every declaration
 * object with it once; the same description drives the shape validator here
 * and the published JSON Schema (json-schema.ts), so the two cannot drift.
 */
export type PropSpec =
  | { kind: 'string'; min?: number; max?: number; pattern?: string; text?: 'line' | 'multiline'; enum?: readonly string[] }
  | { kind: 'integer'; min?: number; max?: number }
  | { kind: 'decimal' }
  | { kind: 'boolean'; const?: boolean }
  | { kind: 'array'; items: PropSpec; min?: number; max?: number; unique?: boolean }
  | { kind: 'object'; props: Record<string, PropSpec>; required?: readonly string[] }
  | { kind: 'condition' }
  | { kind: 'nodes'; min?: number; max?: number };

export interface Issue {
  path: string;
  code: string;
}

export const CONDITION_OPERATORS = ['eq', 'neq', 'in', 'contains', 'isEmpty', 'isNotEmpty', 'gt', 'gte', 'lt', 'lte'] as const;
export type Operator = (typeof CONDITION_OPERATORS)[number];
export const MAX_CONDITION_DEPTH = 5;
export const MAX_CONDITION_BRANCHES = 20;
export const MAX_CONDITION_LIST = 50;

export function pointer(path: string, key: string | number): string {
  return `${path}/${String(key).replace(/~/g, '~0').replace(/\//g, '~1')}`;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A JSON number without a fractional part (PHP must accept 1.0 as well). */
export function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

export type NodeChecker = (value: unknown, path: string, issues: Issue[]) => void;

/** Checks a value against a spec. `nodes` defers to the registry-aware checker. */
export function checkShape(spec: PropSpec, value: unknown, path: string, issues: Issue[], nodes: NodeChecker): void {
  switch (spec.kind) {
    case 'string': {
      if (typeof value !== 'string') return void issues.push({ path, code: 'invalid_type' });
      if (spec.enum) {
        if (!spec.enum.includes(value)) issues.push({ path, code: 'invalid_enum' });
        return;
      }
      const n = length(value);
      if (spec.min !== undefined && n < spec.min) issues.push({ path, code: 'too_short' });
      if (spec.max !== undefined && n > spec.max) issues.push({ path, code: 'too_long' });
      const textOk = spec.text === 'line' ? isSingleLine(value) : spec.text === 'multiline' ? isMultiline(value) : true;
      if (!textOk || (spec.pattern !== undefined && !new RegExp(spec.pattern, 'u').test(value))) {
        issues.push({ path, code: 'pattern_mismatch' });
      }
      return;
    }
    case 'integer':
      if (!isInteger(value)) return void issues.push({ path, code: 'invalid_type' });
      if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
        issues.push({ path, code: 'out_of_range' });
      }
      return;
    case 'decimal':
      if (typeof value !== 'number' && typeof value !== 'string') return void issues.push({ path, code: 'invalid_type' });
      if (toDecimal(value) === null) issues.push({ path, code: 'invalid_decimal' });
      return;
    case 'boolean':
      if (typeof value !== 'boolean') return void issues.push({ path, code: 'invalid_type' });
      if (spec.const !== undefined && value !== spec.const) issues.push({ path, code: 'invalid_enum' });
      return;
    case 'array': {
      if (!Array.isArray(value)) return void issues.push({ path, code: 'invalid_type' });
      if (spec.min !== undefined && value.length < spec.min) issues.push({ path, code: 'too_short' });
      if (spec.max !== undefined && value.length > spec.max) issues.push({ path, code: 'too_long' });
      value.forEach((item, i) => checkShape(spec.items, item, pointer(path, i), issues, nodes));
      if (spec.unique && new Set(value.map((v) => JSON.stringify(v))).size !== value.length) {
        issues.push({ path, code: 'not_unique' });
      }
      return;
    }
    case 'object':
      return checkObject(spec.props, spec.required ?? [], value, path, issues, nodes);
    case 'condition':
      return checkConditionShape(value, path, issues, 1);
    case 'nodes': {
      if (!Array.isArray(value)) return void issues.push({ path, code: 'invalid_type' });
      if (spec.min !== undefined && value.length < spec.min) issues.push({ path, code: 'too_short' });
      if (spec.max !== undefined && value.length > spec.max) issues.push({ path, code: 'too_long' });
      value.forEach((item, i) => nodes(item, pointer(path, i), issues));
      return;
    }
  }
}

export function checkObject(
  props: Record<string, PropSpec>,
  required: readonly string[],
  value: unknown,
  path: string,
  issues: Issue[],
  nodes: NodeChecker,
): void {
  if (!isPlainObject(value)) return void issues.push({ path, code: 'invalid_type' });
  for (const key of required) {
    if (!(key in value)) issues.push({ path: pointer(path, key), code: 'required_property' });
  }
  for (const [key, item] of Object.entries(value)) {
    const spec = props[key];
    if (!spec) issues.push({ path: pointer(path, key), code: 'unknown_property' });
    else checkShape(spec, item, pointer(path, key), issues, nodes);
  }
}

function checkConditionShape(value: unknown, path: string, issues: Issue[], depth: number): void {
  if (!isPlainObject(value)) return void issues.push({ path, code: 'invalid_type' });
  if (depth > MAX_CONDITION_DEPTH) return void issues.push({ path, code: 'condition_too_deep' });
  const keys = Object.keys(value);
  const combinator = keys.find((k) => k === 'all' || k === 'any' || k === 'not');
  if (combinator) {
    for (const k of keys) if (k !== combinator) issues.push({ path: pointer(path, k), code: 'unknown_property' });
    const inner = value[combinator];
    const at = pointer(path, combinator);
    if (combinator === 'not') return checkConditionShape(inner, at, issues, depth + 1);
    if (!Array.isArray(inner)) return void issues.push({ path: at, code: 'invalid_type' });
    if (inner.length < 1) issues.push({ path: at, code: 'too_short' });
    if (inner.length > MAX_CONDITION_BRANCHES) issues.push({ path: at, code: 'too_long' });
    inner.forEach((c, i) => checkConditionShape(c, pointer(at, i), issues, depth + 1));
    return;
  }
  if (!('field' in value)) return void issues.push({ path, code: 'invalid_condition' });
  for (const k of keys) {
    if (k !== 'field' && k !== 'operator' && k !== 'value') issues.push({ path: pointer(path, k), code: 'unknown_property' });
  }
  if (typeof value.field !== 'string') issues.push({ path: pointer(path, 'field'), code: 'invalid_type' });
  if (!('operator' in value)) issues.push({ path: pointer(path, 'operator'), code: 'required_property' });
  else if (!CONDITION_OPERATORS.includes(value.operator as Operator)) issues.push({ path: pointer(path, 'operator'), code: 'invalid_enum' });
  if ('value' in value) checkConditionValueShape(value.value, pointer(path, 'value'), issues);
}

function checkConditionValueShape(value: unknown, path: string, issues: Issue[]): void {
  const scalar = (v: unknown) => typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && length(v) <= 500);
  if (Array.isArray(value)) {
    if (value.length < 1 || value.length > MAX_CONDITION_LIST) issues.push({ path, code: value.length < 1 ? 'too_short' : 'too_long' });
    if (!value.every((v) => typeof v !== 'boolean' && scalar(v))) issues.push({ path, code: 'invalid_type' });
    return;
  }
  if (!scalar(value)) issues.push({ path, code: 'invalid_type' });
}

export { DECIMAL_PATTERN, LINE_PATTERN, MULTILINE_PATTERN };
