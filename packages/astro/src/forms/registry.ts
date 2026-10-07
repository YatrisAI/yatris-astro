import { DATE_PATTERN, DATETIME_PATTERN, TIME_PATTERN } from './temporal.js';
import { EMAIL_PATTERN, PATH_PATTERN } from './text.js';
import type { Operator, PropSpec } from './spec.js';

/**
 * The field registry (contract version 1): every node type a declaration may
 * use, its allowed properties and, for inputs, how its answer behaves.
 * Builder, renderer, server validator, inbox and mail formatter all cover
 * exactly this list. Adding a type is a versioned contract change.
 */

export const CONTRACT_VERSION = 1;

export const NODE_KEY_PATTERN = '^[a-z][a-z0-9_]{0,63}$';
export const FORM_KEY_PATTERN = '^[a-z][a-z0-9-]{0,63}$';
export const OPTION_VALUE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$';
export const CONSENT_VERSION_PATTERN = '^[A-Za-z0-9._-]{1,64}$';

export const MiB = 1024 * 1024;
export const UPLOAD_LIMITS = { maxFileSize: 10 * MiB, maxTotalBytes: 20 * MiB, maxFiles: 5 } as const;

/** Upload kinds on the initial platform allowlist: extensions and MIME types. */
export const UPLOAD_KINDS = {
  pdf: { extensions: ['pdf'], mime: ['application/pdf'] },
  jpeg: { extensions: ['jpg', 'jpeg'], mime: ['image/jpeg'] },
  png: { extensions: ['png'], mime: ['image/png'] },
  webp: { extensions: ['webp'], mime: ['image/webp'] },
  text: { extensions: ['txt'], mime: ['text/plain'] },
} as const;
export type UploadKind = keyof typeof UPLOAD_KINDS;

/** How an answer behaves in conditions, normalization and storage. */
export type AnswerKind = 'string' | 'choice' | 'choices' | 'decimal' | 'date' | 'time' | 'datetime' | 'boolean' | 'files' | 'quiz';

export const OPERATORS_BY_KIND: Record<AnswerKind, readonly Operator[]> = {
  string: ['eq', 'neq', 'in', 'contains', 'isEmpty', 'isNotEmpty'],
  choice: ['eq', 'neq', 'in', 'isEmpty', 'isNotEmpty'],
  choices: ['contains', 'isEmpty', 'isNotEmpty'],
  decimal: ['eq', 'neq', 'in', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  date: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  time: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  datetime: ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'isEmpty', 'isNotEmpty'],
  boolean: ['eq'],
  files: [],
  quiz: [],
};

const str = (min: number, max: number, text: 'line' | 'multiline' = 'line'): PropSpec => ({ kind: 'string', min, max, text });
const pattern = (p: string, max = 500): PropSpec => ({ kind: 'string', min: 1, max, pattern: p });
const oneOf = (...values: string[]): PropSpec => ({ kind: 'string', enum: values });
const int = (min: number, max: number): PropSpec => ({ kind: 'integer', min, max });
const bool: PropSpec = { kind: 'boolean' };
const decimal: PropSpec = { kind: 'decimal' };
const condition: PropSpec = { kind: 'condition' };
const object = (props: Record<string, PropSpec>, required: string[] = []): PropSpec => ({ kind: 'object', props, required });

export const KEY: PropSpec = pattern(NODE_KEY_PATTERN, 64);
export const LABEL = str(1, 200);
export const EMAIL: PropSpec = { kind: 'string', min: 3, max: 254, pattern: EMAIL_PATTERN };
export const PATH: PropSpec = pattern(PATH_PATTERN);
export const SUBJECT = str(1, 200);
export const BODY = str(1, 10000, 'multiline');

const OPTION_VALUE = pattern(OPTION_VALUE_PATTERN, 100);
const OPTIONS: PropSpec = { kind: 'array', min: 1, max: 200, items: object({ value: OPTION_VALUE, label: LABEL }, ['value', 'label']) };
const CHARACTER_COUNT = oneOf('used', 'remaining');

const common = {
  key: KEY,
  type: { kind: 'string', min: 1, max: 32 } as PropSpec,
  label: LABEL,
  help: str(1, 1000, 'multiline'),
  visibleWhen: condition,
  requiredWhen: condition,
  required: bool,
};
const display = { key: KEY, type: common.type, visibleWhen: condition };

export interface NodeType {
  category: 'input' | 'display';
  /** Answer behavior; inputs only. */
  answer?: AnswerKind;
  props: Record<string, PropSpec>;
  required: readonly string[];
}

const input = (answer: AnswerKind, props: Record<string, PropSpec>, required = ['key', 'type', 'label', 'required']): NodeType => ({
  category: 'input',
  answer,
  props: { ...common, ...props },
  required,
});

export const NODE_TYPES = {
  text: input('string', {
    placeholder: LABEL,
    default: str(0, 5000),
    autocomplete: oneOf('off', 'name', 'family-name', 'given-name', 'organization', 'organization-title', 'postal-code', 'address-level1', 'address-level2', 'street-address', 'address-line1', 'address-line2', 'country-name'),
    preset: oneOf('katakana', 'hiragana'),
    characterCount: CHARACTER_COUNT,
    validation: object({ minLength: int(0, 5000), maxLength: int(1, 5000), format: oneOf('digits', 'alphanumeric', 'postal_code_jp') }),
  }),
  textarea: input('string', {
    placeholder: LABEL,
    default: str(0, 20000, 'multiline'),
    rows: int(1, 30),
    characterCount: CHARACTER_COUNT,
    validation: object({ minLength: int(0, 20000), maxLength: int(1, 20000) }),
  }),
  email: input('string', {
    placeholder: LABEL,
    default: str(0, 254),
    autocomplete: oneOf('off', 'email'),
    validation: object({ maxLength: int(3, 254) }),
  }),
  tel: input('string', {
    placeholder: LABEL,
    default: str(0, 30),
    autocomplete: oneOf('off', 'tel', 'tel-national'),
    validation: object({ maxLength: int(1, 30) }),
  }),
  url: input('string', {
    placeholder: LABEL,
    default: str(0, 2000),
    autocomplete: oneOf('off', 'url'),
    validation: object({ maxLength: int(1, 2000), schemes: { kind: 'array', min: 1, max: 2, unique: true, items: oneOf('http', 'https') } }),
  }),
  number: input('decimal', {
    placeholder: LABEL,
    default: decimal,
    validation: object({ min: decimal, max: decimal, step: decimal }),
  }),
  range: input(
    'decimal',
    {
      default: decimal,
      showValue: bool,
      validation: object({ min: decimal, max: decimal, step: decimal }, ['min', 'max', 'step']),
    },
    ['key', 'type', 'label', 'required', 'validation'],
  ),
  date: input('date', {
    default: pattern(DATE_PATTERN, 10),
    validation: object({ min: pattern(DATE_PATTERN, 10), max: pattern(DATE_PATTERN, 10), step: int(1, 366) }),
  }),
  time: input('time', {
    default: pattern(TIME_PATTERN, 8),
    validation: object({ min: pattern(TIME_PATTERN, 8), max: pattern(TIME_PATTERN, 8), step: int(1, 86400) }),
  }),
  datetime: input('datetime', {
    default: pattern(DATETIME_PATTERN, 19),
    validation: object({ min: pattern(DATETIME_PATTERN, 19), max: pattern(DATETIME_PATTERN, 19), step: int(1, 86400) }),
  }),
  select: input('choice', { options: OPTIONS, prompt: LABEL, default: OPTION_VALUE }, ['key', 'type', 'label', 'required', 'options']),
  multiselect: input(
    'choices',
    {
      options: OPTIONS,
      default: { kind: 'array', max: 200, unique: true, items: OPTION_VALUE },
      validation: object({ minSelected: int(0, 200), maxSelected: int(1, 200) }),
    },
    ['key', 'type', 'label', 'required', 'options'],
  ),
  radio: input('choice', { options: OPTIONS, default: OPTION_VALUE }, ['key', 'type', 'label', 'required', 'options']),
  checkbox: input('boolean', { default: bool }),
  checkboxes: input(
    'choices',
    {
      options: OPTIONS,
      default: { kind: 'array', max: 200, unique: true, items: OPTION_VALUE },
      validation: object({ minSelected: int(0, 200), maxSelected: int(1, 200) }),
    },
    ['key', 'type', 'label', 'required', 'options'],
  ),
  acceptance: input(
    'boolean',
    {
      consentText: str(1, 5000, 'multiline'),
      consentVersion: pattern(CONSENT_VERSION_PATTERN, 64),
      privacyPolicyPath: PATH,
      default: { kind: 'boolean', const: false },
    },
    ['key', 'type', 'label', 'required', 'consentText'],
  ),
  file: input('files', {
    validation: object({
      maxFiles: int(1, UPLOAD_LIMITS.maxFiles),
      maxFileSize: int(1, UPLOAD_LIMITS.maxFileSize),
      accept: { kind: 'array', min: 1, max: 5, unique: true, items: oneOf(...Object.keys(UPLOAD_KINDS)) },
    }),
  }),
  hidden: input('string', { default: str(0, 500), validation: object({ maxLength: int(1, 500) }) }, ['key', 'type']),
  // An active quiz is always required, so it takes neither `required` nor `requiredWhen`.
  quiz: {
    category: 'input',
    answer: 'quiz',
    props: {
      key: common.key,
      type: common.type,
      label: common.label,
      help: common.help,
      visibleWhen: condition,
      questions: {
        kind: 'array',
        min: 1,
        max: 20,
        items: object(
          { id: KEY, question: str(1, 500), answers: { kind: 'array', min: 1, max: 20, items: str(1, 200) } },
          ['id', 'question', 'answers'],
        ),
      },
    },
    required: ['key', 'type', 'label', 'questions'],
  },
  heading: { category: 'display', props: { ...display, text: LABEL, level: int(2, 4) }, required: ['key', 'type', 'text'] },
  help: { category: 'display', props: { ...display, text: str(1, 2000, 'multiline') }, required: ['key', 'type', 'text'] },
  divider: { category: 'display', props: { ...display }, required: ['key', 'type'] },
  group: {
    category: 'display',
    props: { ...display, label: LABEL, fields: { kind: 'nodes', min: 1, max: 100 } },
    required: ['key', 'type', 'fields'],
  },
  reflection: { category: 'display', props: { ...display, source: KEY, label: LABEL }, required: ['key', 'type', 'source'] },
} satisfies Record<string, NodeType>;

export type NodeTypeName = keyof typeof NODE_TYPES;
export const NODE_TYPE_NAMES = Object.keys(NODE_TYPES) as NodeTypeName[];
export const INPUT_TYPES = NODE_TYPE_NAMES.filter((t) => NODE_TYPES[t].category === 'input');
export const DISPLAY_TYPES = NODE_TYPE_NAMES.filter((t) => NODE_TYPES[t].category === 'display');

export function nodeType(name: unknown): NodeType | undefined {
  return typeof name === 'string' && Object.hasOwn(NODE_TYPES, name) ? (NODE_TYPES as Record<string, NodeType>)[name] : undefined;
}

export const MAX_GROUP_DEPTH = 3;
export const MAX_NODES = 300;

/** Top-level declaration properties. */
export const DECLARATION: { props: Record<string, PropSpec>; required: readonly string[] } = {
  props: {
    $schema: { kind: 'string', min: 1, max: 500 },
    contractVersion: int(CONTRACT_VERSION, CONTRACT_VERSION),
    key: pattern(FORM_KEY_PATTERN, 64),
    name: LABEL,
    locale: oneOf('ja', 'en'),
    fields: { kind: 'nodes', min: 1, max: 200 },
    confirmStep: object({ enabled: bool, heading: LABEL, backLabel: LABEL, submitLabel: LABEL }, ['enabled']),
    submit: object({ label: LABEL, pendingLabel: LABEL }, ['label']),
    success: object({ mode: oneOf('message', 'redirect'), message: str(1, 2000, 'multiline'), redirectPath: PATH }, ['mode']),
    mail: object(
      {
        notification: object(
          {
            to: { kind: 'array', max: 10, unique: true, items: EMAIL },
            replyToField: KEY,
            subject: SUBJECT,
            body: BODY,
            attachmentFields: { kind: 'array', max: 10, unique: true, items: KEY },
          },
          ['subject', 'body'],
        ),
        thankYou: object({ enabled: bool, toField: KEY, subject: SUBJECT, body: BODY, replyToAddress: EMAIL }, ['enabled']),
      },
      ['notification', 'thankYou'],
    ),
    uploads: object({ maxFiles: int(1, UPLOAD_LIMITS.maxFiles), maxTotalBytes: int(1, UPLOAD_LIMITS.maxTotalBytes) }),
    smtp: object({ source: oneOf('website_profile') }, ['source']),
  },
  required: ['contractVersion', 'key', 'name', 'locale', 'fields', 'submit', 'success', 'mail'],
};

/** Mail template placeholders other than `field.<key>`. */
export const PLACEHOLDERS = ['form.name', 'website.name', 'submission.reference', 'submission.date', 'submission.answers'] as const;
