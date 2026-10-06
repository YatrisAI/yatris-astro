import { normalize } from './answers.js';
import { compareDecimal, toDecimal } from './decimal.js';
import { DECLARATION, MAX_GROUP_DEPTH, MAX_NODES, nodeType, OPERATORS_BY_KIND, PLACEHOLDERS, UPLOAD_LIMITS, type AnswerKind } from './registry.js';
import { checkObject, isPlainObject, type Issue } from './spec.js';
import { datetimeToSeconds, dateToDays, timeToSeconds } from './temporal.js';
import { answerKind, flatten, isInput, type Entry, type FormDeclaration, type FormNode } from './tree.js';

/**
 * Validates a form declaration (contract v1). Two phases:
 *
 * 1. Shape: types, required and unknown properties, lengths, patterns.
 * 2. Semantics, only when the shape is valid: unique keys, references,
 *    operators, cycles, defaults, bounds, mail fields and placeholders.
 *
 * Issues are `{ path, code }` pairs (JSON Pointer), deduplicated. The PHP
 * validator must report the same set for every fixture.
 */

export interface DeclarationResult {
  valid: boolean;
  errors: Issue[];
  /** Non-blocking findings for authoring; publication may still require them resolved. */
  warnings: Issue[];
}

export function validateDeclaration(value: unknown): DeclarationResult {
  const shape: Issue[] = [];
  checkObject(DECLARATION.props, DECLARATION.required, value, '', shape, checkNode);
  if (shape.length) return { valid: false, errors: tidy(shape), warnings: [] };

  const declaration = value as FormDeclaration;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];
  const entries = flatten(declaration.fields);
  const byKey = new Map<string, Entry>();

  for (const entry of entries) {
    if (byKey.has(entry.node.key)) errors.push({ path: `${entry.path}/key`, code: 'duplicate_key' });
    else byKey.set(entry.node.key, entry);
  }
  if (entries.length > MAX_NODES) errors.push({ path: '/fields', code: 'too_many_nodes' });

  let quizzes = 0;
  for (const entry of entries) {
    const { node, path } = entry;
    if (node.type === 'group' && entry.groups.length + 1 > MAX_GROUP_DEPTH) errors.push({ path, code: 'group_too_deep' });
    if (node.type === 'quiz' && ++quizzes > 1) errors.push({ path, code: 'too_many_quiz' });
    checkNodeSemantics(declaration, node, path, errors);
    for (const prop of ['visibleWhen', 'requiredWhen'] as const) {
      if (node[prop] !== undefined) checkCondition(node[prop], `${path}/${prop}`, node.key, byKey, errors);
    }
    if (node.type === 'reflection') {
      const source = byKey.get(node.source)?.node;
      if (!source || !isInput(source) || source.type === 'quiz' || source.type === 'hidden') {
        errors.push({ path: `${path}/source`, code: 'reflection_source_invalid' });
      }
    }
  }

  errors.push(...findCycles(entries, byKey));
  checkMail(declaration, byKey, errors, warnings);
  checkSuccess(declaration, errors);

  const tidied = tidy(errors);
  return { valid: tidied.length === 0, errors: tidied, warnings: tidy(warnings) };
}

function checkNode(value: unknown, path: string, issues: Issue[]): void {
  if (!isPlainObject(value)) return void issues.push({ path, code: 'invalid_type' });
  if (!('type' in value)) return void issues.push({ path: `${path}/type`, code: 'required_property' });
  const type = nodeType(value.type);
  if (!type) return void issues.push({ path: `${path}/type`, code: 'unknown_node_type' });
  checkObject(type.props, type.required, value, path, issues, checkNode);
}

function checkNodeSemantics(declaration: FormDeclaration, node: FormNode, path: string, errors: Issue[]): void {
  const v = node.validation ?? {};
  const at = (suffix: string) => `${path}${suffix}`;

  if (Array.isArray(node.options)) {
    const seen = new Set<string>();
    node.options.forEach((o: { value: string }, i: number) => {
      if (seen.has(o.value)) errors.push({ path: at(`/options/${i}/value`), code: 'duplicate_option' });
      seen.add(o.value);
    });
  }
  if (node.type === 'quiz') {
    const seen = new Set<string>();
    node.questions.forEach((q: { id: string }, i: number) => {
      if (seen.has(q.id)) errors.push({ path: at(`/questions/${i}/id`), code: 'duplicate_key' });
      seen.add(q.id);
    });
  }

  switch (node.type) {
    case 'text':
      if (node.preset !== undefined && v.format !== undefined) errors.push({ path: at('/preset'), code: 'preset_conflict' });
    // falls through
    case 'textarea':
      if (v.minLength !== undefined && v.maxLength !== undefined && v.minLength > v.maxLength) {
        errors.push({ path: at('/validation'), code: 'min_exceeds_max' });
      }
      break;
    case 'number':
    case 'range':
      if (v.min !== undefined && v.max !== undefined && compareDecimal(toDecimal(v.min)!, toDecimal(v.max)!) > 0) {
        errors.push({ path: at('/validation'), code: 'min_exceeds_max' });
      }
      if (v.step !== undefined && compareDecimal(toDecimal(v.step)!, '0') <= 0) errors.push({ path: at('/validation/step'), code: 'invalid_step' });
      break;
    case 'date':
    case 'time':
    case 'datetime': {
      const parse = node.type === 'date' ? dateToDays : node.type === 'time' ? timeToSeconds : datetimeToSeconds;
      const min = v.min === undefined ? null : parse(v.min);
      const max = v.max === undefined ? null : parse(v.max);
      if (v.min !== undefined && min === null) errors.push({ path: at('/validation/min'), code: `invalid_${node.type}` });
      if (v.max !== undefined && max === null) errors.push({ path: at('/validation/max'), code: `invalid_${node.type}` });
      if (min !== null && max !== null && min > max) errors.push({ path: at('/validation'), code: 'min_exceeds_max' });
      break;
    }
    case 'multiselect':
    case 'checkboxes':
      if (v.minSelected !== undefined && v.maxSelected !== undefined && v.minSelected > v.maxSelected) {
        errors.push({ path: at('/validation'), code: 'min_exceeds_max' });
      }
      if (v.minSelected !== undefined && v.minSelected > node.options.length) {
        errors.push({ path: at('/validation/minSelected'), code: 'exceeds_options' });
      }
      break;
    case 'file': {
      const total = declaration.uploads?.maxTotalBytes ?? UPLOAD_LIMITS.maxTotalBytes;
      if (v.maxFileSize !== undefined && v.maxFileSize > total) errors.push({ path: at('/validation/maxFileSize'), code: 'upload_limit_exceeded' });
      break;
    }
  }

  if ('default' in node && node.type !== 'acceptance' && node.type !== 'checkbox' && normalize(node, node.default).error) {
    errors.push({ path: at('/default'), code: 'invalid_default' });
  }
}

function checkCondition(condition: any, path: string, ownKey: string, byKey: Map<string, Entry>, errors: Issue[]): void {
  for (const combinator of ['all', 'any'] as const) {
    if (combinator in condition) {
      condition[combinator].forEach((c: unknown, i: number) => checkCondition(c, `${path}/${combinator}/${i}`, ownKey, byKey, errors));
      return;
    }
  }
  if ('not' in condition) return checkCondition(condition.not, `${path}/not`, ownKey, byKey, errors);

  const target = byKey.get(condition.field)?.node;
  if (condition.field === ownKey) return void errors.push({ path: `${path}/field`, code: 'self_reference' });
  if (!target) return void errors.push({ path: `${path}/field`, code: 'unknown_reference' });
  const kind = answerKind(target);
  if (!kind || OPERATORS_BY_KIND[kind].length === 0) return void errors.push({ path: `${path}/field`, code: 'reference_not_allowed' });
  if (!OPERATORS_BY_KIND[kind].includes(condition.operator)) return void errors.push({ path: `${path}/operator`, code: 'invalid_operator' });

  const needsValue = condition.operator !== 'isEmpty' && condition.operator !== 'isNotEmpty';
  if (!needsValue) {
    if ('value' in condition) errors.push({ path: `${path}/value`, code: 'invalid_condition_value' });
    return;
  }
  if (!('value' in condition)) return void errors.push({ path: `${path}/value`, code: 'required_property' });
  if (!conditionValueOk(kind, target, condition.operator, condition.value)) {
    errors.push({ path: `${path}/value`, code: 'invalid_condition_value' });
  }
}

function conditionValueOk(kind: AnswerKind, target: FormNode, operator: string, value: unknown): boolean {
  if (operator === 'in') return Array.isArray(value) && value.every((v) => scalarOk(kind, target, v));
  if (Array.isArray(value)) return false;
  if (operator === 'contains') {
    if (kind === 'choices') return typeof value === 'string' && optionValues(target).includes(value);
    return typeof value === 'string' && value !== '';
  }
  return scalarOk(kind, target, value);
}

function scalarOk(kind: AnswerKind, target: FormNode, value: unknown): boolean {
  switch (kind) {
    case 'string':
      return typeof value === 'string';
    case 'choice':
      return typeof value === 'string' && optionValues(target).includes(value);
    case 'decimal':
      return toDecimal(value) !== null;
    case 'date':
      return typeof value === 'string' && dateToDays(value) !== null;
    case 'time':
      return typeof value === 'string' && timeToSeconds(value) !== null;
    case 'datetime':
      return typeof value === 'string' && datetimeToSeconds(value) !== null;
    case 'boolean':
      return typeof value === 'boolean';
    default:
      return false;
  }
}

function optionValues(node: FormNode): string[] {
  return (node.options ?? []).map((o: { value: string }) => o.value);
}

function references(condition: any, out: string[] = []): string[] {
  if ('all' in condition) condition.all.forEach((c: unknown) => references(c, out));
  else if ('any' in condition) condition.any.forEach((c: unknown) => references(c, out));
  else if ('not' in condition) references(condition.not, out);
  else out.push(condition.field);
  return out;
}

/**
 * Activity dependencies: a node depends on its enclosing group, on every
 * field its `visibleWhen` reads and, for a reflection, on its source.
 * (`requiredWhen` never affects activity, so it cannot form a cycle.)
 * One error per strongly connected component, reported at the
 * `visibleWhen` of its first node in document order.
 */
function findCycles(entries: Entry[], byKey: Map<string, Entry>): Issue[] {
  const edges = new Map<string, string[]>();
  for (const { node, groups } of entries) {
    const deps: string[] = [];
    if (groups.length) deps.push(groups.at(-1)!);
    if (node.visibleWhen) deps.push(...references(node.visibleWhen).filter((k) => k !== node.key && byKey.has(k)));
    if (node.type === 'reflection' && byKey.has(node.source)) deps.push(node.source);
    edges.set(node.key, deps);
  }

  // Tarjan's algorithm, iterating keys in document order.
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components: string[][] = [];
  const visit = (key: string) => {
    indices.set(key, index);
    low.set(key, index++);
    stack.push(key);
    onStack.add(key);
    for (const dep of edges.get(key) ?? []) {
      if (!indices.has(dep)) {
        visit(dep);
        low.set(key, Math.min(low.get(key)!, low.get(dep)!));
      } else if (onStack.has(dep)) {
        low.set(key, Math.min(low.get(key)!, indices.get(dep)!));
      }
    }
    if (low.get(key) === indices.get(key)) {
      const component: string[] = [];
      let k: string;
      do {
        k = stack.pop()!;
        onStack.delete(k);
        component.push(k);
      } while (k !== key);
      components.push(component);
    }
  };
  for (const key of byKey.keys()) if (!indices.has(key)) visit(key);

  return components
    .filter((c) => c.length > 1)
    .map((c) => {
      const first = c.map((k) => byKey.get(k)!).filter((e) => e.node.visibleWhen).sort((a, b) => a.order - b.order)[0]!;
      return { path: `${first.path}/visibleWhen`, code: 'condition_cycle' };
    });
}

function checkMail(declaration: FormDeclaration, byKey: Map<string, Entry>, errors: Issue[], warnings: Issue[]): void {
  const { notification, thankYou } = declaration.mail;
  const isType = (key: string, type: string) => byKey.get(key)?.node.type === type;

  if (notification.replyToField !== undefined && !isType(notification.replyToField, 'email')) {
    errors.push({ path: '/mail/notification/replyToField', code: 'invalid_mail_field' });
  }
  (notification.attachmentFields ?? []).forEach((key: string, i: number) => {
    if (!isType(key, 'file')) errors.push({ path: `/mail/notification/attachmentFields/${i}`, code: 'invalid_mail_field' });
  });
  if (!notification.to?.length) warnings.push({ path: '/mail/notification/to', code: 'recipients_missing' });

  if (thankYou.enabled) {
    for (const prop of ['toField', 'subject', 'body']) {
      if (thankYou[prop] === undefined) errors.push({ path: `/mail/thankYou/${prop}`, code: 'required_property' });
    }
  }
  if (thankYou.toField !== undefined && !isType(thankYou.toField, 'email')) {
    errors.push({ path: '/mail/thankYou/toField', code: 'invalid_mail_field' });
  }

  const templates: [string, string | undefined, boolean][] = [
    ['/mail/notification/subject', notification.subject, true],
    ['/mail/notification/body', notification.body, false],
    ['/mail/thankYou/subject', thankYou.subject, true],
    ['/mail/thankYou/body', thankYou.body, false],
  ];
  for (const [path, text, subject] of templates) {
    if (text !== undefined) for (const code of placeholderIssues(text, subject, byKey)) errors.push({ path, code });
  }
}

const PLACEHOLDER = /\{\{ *([^{}]*?) *\}\}/g;

/** Placeholder problems in one template; see README "Mail templates". */
export function placeholderIssues(text: string, subject: boolean, byKey: Map<string, Entry>): string[] {
  const codes = new Set<string>();
  for (const [, name] of text.matchAll(PLACEHOLDER)) {
    if ((PLACEHOLDERS as readonly string[]).includes(name!)) {
      if (subject && name === 'submission.answers') codes.add('placeholder_not_allowed');
    } else if (name!.startsWith('field.')) {
      const node = byKey.get(name!.slice('field.'.length))?.node;
      if (!node || !isInput(node) || node.type === 'quiz') codes.add('invalid_placeholder_field');
    } else {
      codes.add('unknown_placeholder');
    }
  }
  const rest = text.replace(PLACEHOLDER, '');
  if (rest.includes('{{') || rest.includes('}}')) codes.add('malformed_placeholder');
  return [...codes];
}

function checkSuccess(declaration: FormDeclaration, errors: Issue[]): void {
  const success = declaration.success;
  if (success.mode === 'message' && success.message === undefined) errors.push({ path: '/success/message', code: 'required_property' });
  if (success.mode === 'redirect' && success.redirectPath === undefined) errors.push({ path: '/success/redirectPath', code: 'required_property' });
}

/** Deduplicated and sorted by path, then code. */
function tidy(issues: Issue[]): Issue[] {
  const seen = new Map<string, Issue>();
  for (const issue of issues) seen.set(`${issue.path}\u0000${issue.code}`, issue);
  return [...seen.values()].sort((a, b) => (a.path === b.path ? cmp(a.code, b.code) : cmp(a.path, b.path)));
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
