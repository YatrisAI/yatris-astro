import { evaluateActivity, isEmptyValue, type AnswerValue } from './conditions.js';
import type { QuestionContext } from './context.js';
import { compareDecimal, onStep, toDecimal } from './decimal.js';
import { UPLOAD_KINDS, UPLOAD_LIMITS, type UploadKind } from './registry.js';
import {
  canonicalDatetime,
  canonicalTime,
  datetimeToSeconds,
  dateToDays,
  timeToSeconds,
  wallClockStatus,
} from './temporal.js';
import {
  isBlank,
  isEmail,
  isHiragana,
  isKatakana,
  isMultiline,
  isSingleLine,
  isTel,
  length,
  nfkc,
  normalizeNewlines,
  toHiragana,
  toKatakana,
  trim,
  urlScheme,
} from './text.js';
import { answerKind, flatten, isInput, type FormDeclaration, type FormNode } from './tree.js';

/**
 * Normalizes and validates one submission's answers against a declaration
 * (contract v1, README "Answers"). The renderer runs this before sending and
 * the server runs the PHP twin on receipt; the shared fixtures keep them equal.
 *
 * Each field reports at most one error code, the first rule it fails.
 */

export interface FileDescriptor {
  name: string;
  size: number;
  type: string;
}

export interface QuizAnswer {
  questionId: string;
  answer: string;
}

export interface SubmissionInput {
  /** The `answers` JSON object: every non-file input, keyed by field key. */
  answers: Record<string, unknown>;
  /** File descriptors per file field, in the order they were attached. */
  files?: Record<string, FileDescriptor[]>;
}

export interface ValidationOptions {
  /** The Website's IANA time zone, for date-time values. */
  timeZone?: string;
  /**
   * Whether quiz answers are checked. The server checks them; a renderer
   * working from a public definition has no answers to check against.
   */
  checkQuiz?: boolean;
  /** Read-only system inputs conditions may reference (README "Question context"). */
  context?: QuestionContext;
  /**
   * Their values, supplied by the consumer. Visitor answers can never set
   * them: an `answers` key with a dot is always `undeclared_field`.
   */
  contextValues?: Record<string, AnswerValue>;
}

export interface SubmissionResult {
  /** Normalized answers of active inputs, files and quizzes excluded. */
  answers: Record<string, string | string[] | boolean>;
  /** Accepted file descriptors of active file fields. */
  files: Record<string, FileDescriptor[]>;
  fieldErrors: Record<string, string>;
  formErrors: string[];
  active: string[];
  required: string[];
}

type Normalized = { value: AnswerValue; error?: string };

export function validateSubmission(declaration: FormDeclaration, input: SubmissionInput, options: ValidationOptions = {}): SubmissionResult {
  const entries = flatten(declaration.fields);
  const inputs = entries.filter((e) => isInput(e.node)).map((e) => e.node);
  const byKey = new Map(inputs.map((n) => [n.key, n]));
  const formErrors = new Set<string>();
  const raw = input.answers ?? {};
  const files = input.files ?? {};

  for (const key of Object.keys(raw)) {
    const node = byKey.get(key);
    if (!node || node.type === 'file') formErrors.add('undeclared_field');
  }
  for (const key of Object.keys(files)) {
    if (byKey.get(key)?.type !== 'file') formErrors.add('undeclared_field');
  }

  // 1. Normalize each value on its own. A value that fails its format counts
  //    as absent when conditions are evaluated.
  const normalized = new Map<string, Normalized>();
  for (const node of inputs) {
    normalized.set(node.key, node.type === 'file' ? normalizeFiles(node, files[node.key]) : normalize(node, raw[node.key], options));
  }
  const values: Record<string, AnswerValue> = {};
  for (const [key, n] of normalized) values[key] = n.error ? undefined : n.value;

  // 2. Activity and requiredness from the effective values.
  const { active, required } = evaluateActivity(declaration, values, { context: options.context, contextValues: options.contextValues });
  const activeSet = new Set(active);
  const requiredSet = new Set(required);

  // 3. Errors and output for active inputs only; inactive answers are dropped.
  const answers: SubmissionResult['answers'] = {};
  const acceptedFiles: SubmissionResult['files'] = {};
  const fieldErrors: Record<string, string> = {};
  let fileCount = 0;
  let fileBytes = 0;
  for (const node of inputs) {
    if (!activeSet.has(node.key)) continue;
    const { value, error } = normalized.get(node.key)!;
    if (error) {
      fieldErrors[node.key] = error;
      continue;
    }
    if (requiredSet.has(node.key) && isMissing(node, value)) {
      fieldErrors[node.key] = node.type === 'acceptance' ? 'must_accept' : 'required';
      continue;
    }
    if (node.type === 'quiz') {
      if (value !== undefined && options.checkQuiz) {
        const quizError = checkQuiz(node, raw[node.key] as QuizAnswer);
        if (quizError) fieldErrors[node.key] = quizError;
      }
      continue;
    }
    if (node.type === 'file') {
      const list = files[node.key] ?? [];
      if (list.length) acceptedFiles[node.key] = list;
      fileCount += list.length;
      fileBytes += list.reduce((sum, f) => sum + f.size, 0);
      continue;
    }
    if (!isEmptyValue(value)) answers[node.key] = value as string | string[] | boolean;
  }

  const limits = { ...UPLOAD_LIMITS, ...(declaration.uploads ?? {}) };
  if (fileCount > limits.maxFiles) formErrors.add('too_many_files_total');
  if (fileBytes > limits.maxTotalBytes) formErrors.add('payload_too_large_total');

  return { answers, files: acceptedFiles, fieldErrors, formErrors: [...formErrors].sort(), active, required };
}

/** Required means checked for Booleans and non-empty for everything else. */
function isMissing(node: FormNode, value: AnswerValue): boolean {
  return answerKind(node) === 'boolean' ? value !== true : isEmptyValue(value);
}

/** Normalizes one non-file value; also used to check declaration defaults. */
export function normalize(node: FormNode, raw: unknown, options: ValidationOptions = {}): Normalized {
  const kind = answerKind(node);
  if (kind === 'boolean') {
    if (raw === undefined || raw === null) return { value: false };
    return typeof raw === 'boolean' ? { value: raw } : { value: undefined, error: 'invalid_type' };
  }
  if (raw === undefined || raw === null) return { value: undefined };
  const v = node.validation ?? {};

  switch (node.type) {
    case 'text':
    case 'hidden': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      let value = trim(raw);
      if (!isSingleLine(value)) return invalid('invalid_format');
      if (value === '') return { value: '' };
      if (node.preset === 'katakana') {
        value = trim(toKatakana(value));
        if (!isKatakana(value)) return invalid('invalid_format');
      } else if (node.preset === 'hiragana') {
        value = trim(toHiragana(value));
        if (!isHiragana(value)) return invalid('invalid_format');
      } else if (v.format) {
        value = trim(nfkc(value));
        const formatted = applyFormat(v.format, value);
        if (formatted === null) return invalid('invalid_format');
        value = formatted;
      }
      return lengthCheck(value, v.minLength, v.maxLength ?? (node.type === 'hidden' ? 500 : 5000));
    }
    case 'textarea': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      const value = normalizeNewlines(raw);
      if (!isMultiline(value)) return invalid('invalid_format');
      if (isBlank(value)) return { value: '' };
      return lengthCheck(value, v.minLength, v.maxLength ?? 20000);
    }
    case 'email': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      const value = trim(nfkc(raw));
      if (value === '') return { value: '' };
      if (length(value) > (v.maxLength ?? 254)) return invalid('too_long');
      return isEmail(value) ? { value } : invalid('invalid_email');
    }
    case 'tel': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      const value = trim(nfkc(raw));
      if (value === '') return { value: '' };
      if (length(value) > (v.maxLength ?? 30)) return invalid('too_long');
      return isTel(value) ? { value } : invalid('invalid_tel');
    }
    case 'url': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      const value = trim(raw);
      if (value === '') return { value: '' };
      if (length(value) > (v.maxLength ?? 2000)) return invalid('too_long');
      const scheme = urlScheme(value);
      const schemes: string[] = v.schemes ?? ['http', 'https'];
      return scheme && schemes.includes(scheme) ? { value } : invalid('invalid_url');
    }
    case 'number':
    case 'range': {
      if (typeof raw !== 'string' && typeof raw !== 'number') return invalid('invalid_type');
      const text = typeof raw === 'string' ? trim(nfkc(raw)) : raw;
      if (text === '') return { value: '' };
      const value = toDecimal(text);
      if (value === null) return invalid('invalid_number');
      const min = v.min === undefined ? undefined : toDecimal(v.min)!;
      const max = v.max === undefined ? undefined : toDecimal(v.max)!;
      if (min !== undefined && compareDecimal(value, min) < 0) return invalid('below_min');
      if (max !== undefined && compareDecimal(value, max) > 0) return invalid('above_max');
      if (v.step !== undefined && !onStep(value, min ?? '0', toDecimal(v.step)!)) return invalid('step_mismatch');
      return { value };
    }
    case 'date': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      const value = trim(raw);
      if (value === '') return { value: '' };
      const days = dateToDays(value);
      if (days === null) return invalid('invalid_date');
      return boundsCheck(value, days, v, dateToDays, 1);
    }
    case 'time': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      const text = trim(raw);
      if (text === '') return { value: '' };
      const secs = timeToSeconds(text);
      if (secs === null) return invalid('invalid_time');
      return boundsCheck(canonicalTime(secs), secs, v, timeToSeconds, 60);
    }
    case 'datetime': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      const text = trim(raw);
      if (text === '') return { value: '' };
      const secs = datetimeToSeconds(text);
      if (secs === null) return invalid('invalid_datetime');
      const status = wallClockStatus(secs, options.timeZone ?? 'Asia/Tokyo');
      if (status !== 'unique') return invalid(`${status}_time`);
      return boundsCheck(canonicalDatetime(text), secs, v, datetimeToSeconds, 60);
    }
    case 'select':
    case 'radio': {
      if (typeof raw !== 'string') return invalid('invalid_type');
      if (raw === '') return { value: '' };
      return optionValues(node).includes(raw) ? { value: raw } : invalid('invalid_option');
    }
    case 'multiselect':
    case 'checkboxes': {
      if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) return invalid('invalid_type');
      const allowed = optionValues(node);
      if (new Set(raw).size !== raw.length || !raw.every((x) => allowed.includes(x))) return invalid('invalid_option');
      const value = allowed.filter((x) => raw.includes(x));
      if (value.length === 0) return { value };
      if (v.minSelected !== undefined && value.length < v.minSelected) return invalid('too_few');
      if (v.maxSelected !== undefined && value.length > v.maxSelected) return invalid('too_many');
      return { value };
    }
    case 'quiz': {
      if (typeof raw !== 'object' || Array.isArray(raw)) return invalid('invalid_type');
      const q = raw as Record<string, unknown>;
      if (Object.keys(q).some((k) => k !== 'questionId' && k !== 'answer') || typeof q.questionId !== 'string' || typeof q.answer !== 'string') {
        return invalid('invalid_type');
      }
      if (!(node.questions as { id: string }[]).some((x) => x.id === q.questionId)) return invalid('invalid_question');
      const answer = normalizeQuizAnswer(q.answer);
      return { value: answer === '' ? '' : answer };
    }
    default:
      return invalid('invalid_type');
  }
}

/** Quiz answers compare after NFKC, trimming and lower-casing. */
export function normalizeQuizAnswer(value: string): string {
  return trim(nfkc(value)).toLowerCase();
}

function checkQuiz(node: FormNode, answer: QuizAnswer): string | undefined {
  const question = (node.questions as { id: string; answers: string[] }[]).find((x) => x.id === answer.questionId)!;
  const given = normalizeQuizAnswer(answer.answer);
  return question.answers.some((a) => normalizeQuizAnswer(a) === given) ? undefined : 'quiz_incorrect';
}

function normalizeFiles(node: FormNode, list: FileDescriptor[] | undefined): Normalized {
  if (list === undefined) return { value: [] };
  if (!Array.isArray(list)) return invalid('invalid_type');
  if (!list.every((f) => typeof f?.name === 'string' && Number.isInteger(f.size) && f.size >= 0 && typeof f.type === 'string')) {
    return invalid('invalid_type');
  }
  const v = node.validation ?? {};
  if (list.length > (v.maxFiles ?? 1)) return invalid('too_many_files');
  for (const file of list) {
    if (file.size > (v.maxFileSize ?? UPLOAD_LIMITS.maxFileSize)) return invalid('file_too_large');
    if (!uploadKindAllowed(file, v.accept ?? (Object.keys(UPLOAD_KINDS) as UploadKind[]))) return invalid('file_type_not_allowed');
  }
  return { value: list.map((f) => f.name) };
}

/** Extension and declared MIME type must both belong to one allowed kind. */
export function uploadKindAllowed(file: FileDescriptor, accept: readonly UploadKind[]): boolean {
  const ext = file.name.includes('.') ? file.name.split('.').pop()!.toLowerCase() : '';
  const mime = file.type.toLowerCase().split(';')[0]!.trim();
  return accept.some((kind) => {
    const k = UPLOAD_KINDS[kind];
    return (k.extensions as readonly string[]).includes(ext) && (k.mime as readonly string[]).includes(mime);
  });
}

function optionValues(node: FormNode): string[] {
  return (node.options as { value: string }[]).map((o) => o.value);
}

function applyFormat(format: string, value: string): string | null {
  switch (format) {
    case 'digits':
      return /^[0-9]+$/.test(value) ? value : null;
    case 'alphanumeric':
      return /^[A-Za-z0-9]+$/.test(value) ? value : null;
    case 'postal_code_jp': {
      const m = /^([0-9]{3})-?([0-9]{4})$/.exec(value);
      return m ? `${m[1]}-${m[2]}` : null;
    }
    default:
      return null;
  }
}

function lengthCheck(value: string, min: number | undefined, max: number): Normalized {
  const n = length(value);
  if (min !== undefined && n < min) return invalid('too_short');
  if (n > max) return invalid('too_long');
  return { value };
}

/**
 * Bounds and step for dates (days), times and date-times (seconds). The step
 * base is `min` when set, otherwise 1970-01-01 / midnight, as in HTML.
 */
function boundsCheck(
  canonical: string,
  position: number,
  v: { min?: string; max?: string; step?: number },
  parse: (s: string) => number | null,
  defaultStep: number,
): Normalized {
  const min = v.min === undefined ? null : parse(v.min);
  const max = v.max === undefined ? null : parse(v.max);
  if (min !== null && position < min) return invalid('below_min');
  if (max !== null && position > max) return invalid('above_max');
  if ((position - (min ?? 0)) % (v.step ?? defaultStep) !== 0) return invalid('step_mismatch');
  return { value: canonical };
}

function invalid(error: string): Normalized {
  return { value: undefined, error };
}
