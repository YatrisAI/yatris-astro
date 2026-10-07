import { checkNode, validateQuestions } from '../forms/declaration.js';
import { checkObject, tidy, type Issue } from '../forms/spec.js';
import { flatten, type Entry } from '../forms/tree.js';
import { reservationContext } from './context.js';
import { checkOperations } from './operations.js';
import { SETUP } from './registry.js';
import type { ReservationResult, ReservationSetup } from './types.js';

/**
 * Validates a setup declaration (contract v1, README "Setup declaration").
 * Two phases, as forms: shape of the whole object (questions and operations
 * seed included), then, only when the shape is valid, the setup semantics,
 * the forms question rules with the mode's question context (paths re-rooted
 * from `/fields` to `/questions`), identity fields and the operations seed.
 */
export function validateSetup(value: unknown): ReservationResult {
  const shape: Issue[] = [];
  checkObject(SETUP.props, SETUP.required, value, '', shape, checkNode);
  if (shape.length) return { valid: false, errors: tidy(shape), warnings: [] };

  const setup = value as ReservationSetup;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  if (setup.mode === 'business' && setup.presentation === undefined) errors.push({ path: '/presentation', code: 'required_property' });
  if (setup.mode === 'time_slot' && setup.presentation !== undefined) errors.push({ path: '/presentation', code: 'presentation_not_allowed' });

  const context = reservationContext(setup, setup.operations ?? null);
  for (const issue of validateQuestions(setup.questions, { context }).errors) errors.push({ path: rerootQuestionPath(issue.path), code: issue.code });

  checkIdentityFields(setup, errors);

  if (setup.operations !== undefined) {
    const presentation = setup.mode === 'business' ? (setup.presentation ?? null) : null;
    checkOperations(setup.operations, setup.mode, presentation, '/operations', errors, warnings);
  }

  const tidied = tidy(errors);
  return { valid: tidied.length === 0, errors: tidied, warnings: tidy(warnings) };
}

/** `/fields...` (validateQuestions) to `/questions...` (the setup). */
export function rerootQuestionPath(path: string): string {
  return path === '/fields' || path.startsWith('/fields/') ? `/questions${path.slice('/fields'.length)}` : path;
}

/**
 * name: a `text` input, `required: true`, no visibleWhen/requiredWhen and no
 * ancestor group with visibleWhen. email: the same with an `email` input.
 * phone: any `tel` input. None may be `sensitive: true`. The first node with
 * a key wins (later duplicates are `duplicate_key`).
 */
function checkIdentityFields(setup: ReservationSetup, errors: Issue[]): void {
  const byKey = new Map<string, Entry>();
  for (const entry of flatten(setup.questions)) if (!byKey.has(entry.node.key)) byKey.set(entry.node.key, entry);

  const unconditional = (entry: Entry) =>
    entry.node.required === true &&
    entry.node.visibleWhen === undefined &&
    entry.node.requiredWhen === undefined &&
    entry.groups.every((group) => byKey.get(group)?.node.visibleWhen === undefined);

  const rules = [
    ['name', 'text', true],
    ['email', 'email', true],
    ['phone', 'tel', false],
  ] as const;
  for (const [role, type, mustBeUnconditional] of rules) {
    const key = setup.identityFields[role];
    if (key === undefined) continue;
    const entry = byKey.get(key);
    const ok = entry !== undefined && entry.node.type === type && entry.node.sensitive !== true && (!mustBeUnconditional || unconditional(entry));
    if (!ok) errors.push({ path: `/identityFields/${role}`, code: 'identity_field_invalid' });
  }
}
