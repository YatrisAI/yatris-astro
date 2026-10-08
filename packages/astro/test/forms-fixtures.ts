/**
 * Source of the shared contract fixtures in contracts/forms/v1/fixtures/.
 * Expectations are written by hand here; contract.test.ts checks the
 * JavaScript implementation against them and keeps the published JSON in
 * step (YATRIS_UPDATE_CONTRACT=1 rewrites it). The PHP implementation in
 * YatrisCMS must pass the same JSON.
 */

type Json = any;

export function form(fields: Json[], extra: Json = {}): Json {
  return {
    contractVersion: 1,
    key: 'contact',
    name: 'お問い合わせ',
    locale: 'ja',
    fields,
    submit: { label: '送信する' },
    success: { mode: 'message', message: 'お問い合わせを受け付けました。' },
    mail: {
      notification: { to: ['owner@example.jp'], subject: '【お問い合わせ】{{form.name}}', body: '{{submission.answers}}' },
      thankYou: { enabled: false },
    },
    ...extra,
  };
}

const text = (key: string, extra: Json = {}) => ({ key, type: 'text', label: key, required: false, ...extra });
const email = (key: string, extra: Json = {}) => ({ key, type: 'email', label: key, required: false, ...extra });
const radio = (key: string, values: string[], extra: Json = {}) => ({
  key,
  type: 'radio',
  label: key,
  required: false,
  options: values.map((value) => ({ value, label: value })),
  ...extra,
});
const eq = (field: string, value: Json) => ({ field, operator: 'eq', value });
const issue = (path: string, code: string) => ({ path, code });

export interface DeclarationFixture {
  name: string;
  declaration: Json;
  errors: { path: string; code: string }[];
  warnings?: { path: string; code: string }[];
}

export const declarationFixtures: DeclarationFixture[] = [
  { name: 'minimal valid declaration', declaration: form([text('name', { required: true })]), errors: [] },
  {
    name: 'missing recipients is a warning, not an error',
    declaration: form([text('name')], {
      mail: { notification: { subject: 's', body: 'b' }, thankYou: { enabled: false } },
    }),
    errors: [],
    warnings: [issue('/mail/notification/to', 'recipients_missing')],
  },

  // Shape
  { name: 'not an object', declaration: 'contact', errors: [issue('', 'invalid_type')] },
  {
    name: 'missing required top-level property',
    declaration: (() => {
      const d = form([text('name')]);
      delete d.mail;
      return d;
    })(),
    errors: [issue('/mail', 'required_property')],
  },
  { name: 'unknown top-level property', declaration: form([text('name')], { theme: 'dark' }), errors: [issue('/theme', 'unknown_property')] },
  { name: 'unsupported contract version', declaration: form([text('name')], { contractVersion: 2 }), errors: [issue('/contractVersion', 'out_of_range')] },
  { name: 'form key grammar', declaration: form([text('name')], { key: 'Contact Form' }), errors: [issue('/key', 'pattern_mismatch')] },
  { name: 'empty field list', declaration: form([]), errors: [issue('/fields', 'too_short')] },
  { name: 'unknown node type', declaration: form([{ key: 'colour', type: 'color', label: 'c', required: false }]), errors: [issue('/fields/0/type', 'unknown_node_type')] },
  { name: 'node without type', declaration: form([{ key: 'name', label: 'n', required: false }]), errors: [issue('/fields/0/type', 'required_property')] },
  {
    name: 'requiredness must be explicit',
    declaration: form([{ key: 'name', type: 'text', label: 'n' }]),
    errors: [issue('/fields/0/required', 'required_property')],
  },
  { name: 'option not allowed for the type', declaration: form([email('mail', { rows: 3 })]), errors: [issue('/fields/0/rows', 'unknown_property')] },
  {
    name: 'label length and line rules',
    declaration: form([text('a', { label: 'あ'.repeat(201) }), text('b', { label: '一行目\n二行目' })]),
    errors: [issue('/fields/0/label', 'too_long'), issue('/fields/1/label', 'pattern_mismatch')],
  },
  { name: 'field key grammar', declaration: form([text('Name')]), errors: [issue('/fields/0/key', 'pattern_mismatch')] },
  {
    name: 'malformed conditions',
    declaration: form([
      radio('kind', ['a', 'b']),
      text('x', { visibleWhen: { field: 'kind' } }),
      text('y', { visibleWhen: { foo: 1 } }),
      text('z', { visibleWhen: { field: 'kind', operator: 'between', value: 'a' } }),
    ]),
    errors: [
      issue('/fields/1/visibleWhen/operator', 'required_property'),
      issue('/fields/2/visibleWhen', 'invalid_condition'),
      issue('/fields/3/visibleWhen/operator', 'invalid_enum'),
    ],
  },
  {
    name: 'mandatory consent cannot default to checked',
    declaration: form([{ key: 'consent', type: 'acceptance', label: '同意', required: true, consentText: '同意します。', default: true }]),
    errors: [issue('/fields/0/default', 'invalid_enum')],
  },
  {
    name: 'file size above the platform limit',
    declaration: form([{ key: 'doc', type: 'file', label: '資料', required: false, validation: { maxFileSize: 10485761 } }]),
    errors: [issue('/fields/0/validation/maxFileSize', 'out_of_range')],
  },
  { name: 'range needs explicit bounds', declaration: form([{ key: 'r', type: 'range', label: 'r', required: false }]), errors: [issue('/fields/0/validation', 'required_property')] },
  {
    name: 'quiz takes no requiredness',
    declaration: form([{ key: 'q', type: 'quiz', label: 'q', required: true, questions: [{ id: 'one', question: '1+1は?', answers: ['2'] }] }]),
    errors: [issue('/fields/0/required', 'unknown_property')],
  },
  {
    name: 'exponent decimals are rejected',
    declaration: form([{ key: 'n', type: 'number', label: 'n', required: false, validation: { max: '1e3' } }]),
    errors: [issue('/fields/0/validation/max', 'invalid_decimal')],
  },
  {
    name: 'nested group nodes are checked',
    declaration: form([{ key: 'g', type: 'group', fields: [{ key: 'c', type: 'color', label: 'c', required: false }] }]),
    errors: [issue('/fields/0/fields/0/type', 'unknown_node_type')],
  },
  {
    name: 'redirect path must be same-site and relative',
    declaration: form([text('name')], { success: { mode: 'redirect', redirectPath: '//evil.example/' } }),
    errors: [issue('/success/redirectPath', 'pattern_mismatch')],
  },
  {
    name: 'redirect path cannot be absolute',
    declaration: form([text('name')], { success: { mode: 'redirect', redirectPath: 'https://evil.example/' } }),
    errors: [issue('/success/redirectPath', 'pattern_mismatch')],
  },

  // Semantics
  { name: 'duplicate node keys', declaration: form([text('name'), text('name')]), errors: [issue('/fields/1/key', 'duplicate_key')] },
  {
    name: 'condition references',
    declaration: form([
      text('a', { visibleWhen: eq('missing', 'x') }),
      text('b', { visibleWhen: eq('b', 'x') }),
      { key: 'doc', type: 'file', label: 'doc', required: false },
      { key: 'title', type: 'heading', text: '見出し' },
      text('c', { visibleWhen: { field: 'doc', operator: 'isEmpty' } }),
      text('d', { visibleWhen: { field: 'title', operator: 'isEmpty' } }),
    ]),
    errors: [
      issue('/fields/0/visibleWhen/field', 'unknown_reference'),
      issue('/fields/1/visibleWhen/field', 'self_reference'),
      issue('/fields/4/visibleWhen/field', 'reference_not_allowed'),
      issue('/fields/5/visibleWhen/field', 'reference_not_allowed'),
    ],
  },
  {
    name: 'operators must suit the referenced type',
    declaration: form([text('t'), radio('r', ['a']), text('x', { visibleWhen: { field: 't', operator: 'gt', value: 'a' } }), text('y', { visibleWhen: { field: 'r', operator: 'contains', value: 'a' } })]),
    errors: [issue('/fields/2/visibleWhen/operator', 'invalid_operator'), issue('/fields/3/visibleWhen/operator', 'invalid_operator')],
  },
  {
    name: 'condition values must suit the referenced type',
    declaration: form([
      radio('r', ['a', 'b']),
      { key: 'agree', type: 'checkbox', label: 'agree', required: false },
      text('w', { visibleWhen: eq('r', 'c') }),
      text('x', { visibleWhen: { field: 'r', operator: 'isEmpty', value: 'a' } }),
      text('y', { visibleWhen: { field: 'r', operator: 'eq' } }),
      text('z', { visibleWhen: eq('agree', 'yes') }),
      text('v', { visibleWhen: { field: 'r', operator: 'in', value: ['a', 'z'] } }),
    ]),
    errors: [
      issue('/fields/2/visibleWhen/value', 'invalid_condition_value'),
      issue('/fields/3/visibleWhen/value', 'invalid_condition_value'),
      issue('/fields/4/visibleWhen/value', 'required_property'),
      issue('/fields/5/visibleWhen/value', 'invalid_condition_value'),
      issue('/fields/6/visibleWhen/value', 'invalid_condition_value'),
    ],
  },
  {
    name: 'paths inside all/any/not',
    declaration: form([
      radio('r', ['a']),
      text('x', { visibleWhen: { all: [{ any: [eq('r', 'a')] }, { not: eq('nope', 'a') }] } }),
    ]),
    errors: [issue('/fields/1/visibleWhen/all/1/not/field', 'unknown_reference')],
  },
  {
    name: 'visibility cycle between two fields',
    declaration: form([text('a', { visibleWhen: { field: 'b', operator: 'isNotEmpty' } }), text('b', { visibleWhen: { field: 'a', operator: 'isNotEmpty' } })]),
    errors: [issue('/fields/0/visibleWhen', 'condition_cycle')],
  },
  {
    name: 'group visibility cannot depend on its own child',
    declaration: form([{ key: 'g', type: 'group', visibleWhen: { field: 'c', operator: 'isNotEmpty' }, fields: [text('c')] }]),
    errors: [issue('/fields/0/visibleWhen', 'condition_cycle')],
  },
  {
    name: 'requiredWhen never forms a cycle',
    declaration: form([text('a', { requiredWhen: { field: 'b', operator: 'isNotEmpty' } }), text('b', { requiredWhen: { field: 'a', operator: 'isNotEmpty' } })]),
    errors: [],
  },
  {
    name: 'groups nest at most three deep',
    declaration: form([
      { key: 'g1', type: 'group', fields: [{ key: 'g2', type: 'group', fields: [{ key: 'g3', type: 'group', fields: [{ key: 'g4', type: 'group', fields: [text('leaf')] }] }] }] },
    ]),
    errors: [issue('/fields/0/fields/0/fields/0/fields/0', 'group_too_deep')],
  },
  {
    name: 'defaults must be valid answers',
    declaration: form([
      radio('r', ['a'], { default: 'b' }),
      { key: 'n', type: 'number', label: 'n', required: false, default: 1.25, validation: { step: 0.5 } },
      text('t', { default: 'abcdef', validation: { maxLength: 5 } }),
      { key: 'd', type: 'date', label: 'd', required: false, default: '2026-02-30' },
    ]),
    errors: [
      issue('/fields/0/default', 'invalid_default'),
      issue('/fields/1/default', 'invalid_default'),
      issue('/fields/2/default', 'invalid_default'),
      issue('/fields/3/default', 'invalid_default'),
    ],
  },
  {
    name: 'bounds and steps',
    declaration: form([
      text('t', { validation: { minLength: 10, maxLength: 5 } }),
      { key: 'n', type: 'number', label: 'n', required: false, validation: { step: 0 } },
      { key: 'd', type: 'date', label: 'd', required: false, validation: { min: '2026-13-01' } },
      { key: 'c', type: 'checkboxes', label: 'c', required: false, options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], validation: { minSelected: 3 } },
    ]),
    errors: [
      issue('/fields/0/validation', 'min_exceeds_max'),
      issue('/fields/1/validation/step', 'invalid_step'),
      issue('/fields/2/validation/min', 'invalid_date'),
      issue('/fields/3/validation/minSelected', 'exceeds_options'),
    ],
  },
  {
    name: 'kana preset and format are exclusive',
    declaration: form([text('kana', { preset: 'katakana', validation: { format: 'digits' } })]),
    errors: [issue('/fields/0/preset', 'preset_conflict')],
  },
  {
    name: 'duplicate option values',
    declaration: form([radio('r', ['a', 'a'])]),
    errors: [issue('/fields/0/options/1/value', 'duplicate_option')],
  },
  {
    name: 'one quiz with unique question ids',
    declaration: form([
      { key: 'q1', type: 'quiz', label: 'q', questions: [{ id: 'x', question: '?', answers: ['a'] }, { id: 'x', question: '?', answers: ['b'] }] },
      { key: 'q2', type: 'quiz', label: 'q', questions: [{ id: 'y', question: '?', answers: ['c'] }] },
    ]),
    errors: [issue('/fields/0/questions/1/id', 'duplicate_key'), issue('/fields/1', 'too_many_quiz')],
  },
  {
    name: 'reflection sources',
    declaration: form([
      { key: 'meta', type: 'hidden' },
      { key: 'r1', type: 'reflection', source: 'meta' },
      { key: 'r2', type: 'reflection', source: 'missing' },
    ]),
    errors: [issue('/fields/1/source', 'reflection_source_invalid'), issue('/fields/2/source', 'reflection_source_invalid')],
  },
  {
    name: 'mail fields and placeholders',
    declaration: form(
      [text('name'), email('mail'), { key: 'q', type: 'quiz', label: 'q', questions: [{ id: 'x', question: '?', answers: ['a'] }] }],
      {
        mail: {
          notification: {
            to: ['owner@example.jp'],
            replyToField: 'name',
            subject: '{{submission.answers}}',
            body: '{{foo}} {{field.missing}} {{field.q}}',
            attachmentFields: ['mail'],
          },
          thankYou: { enabled: true, subject: '{{form.name', body: '{{ field.name }} 様' },
        },
      },
    ),
    errors: [
      issue('/mail/notification/attachmentFields/0', 'invalid_mail_field'),
      issue('/mail/notification/body', 'invalid_placeholder_field'),
      issue('/mail/notification/body', 'unknown_placeholder'),
      issue('/mail/notification/replyToField', 'invalid_mail_field'),
      issue('/mail/notification/subject', 'placeholder_not_allowed'),
      issue('/mail/thankYou/subject', 'malformed_placeholder'),
      issue('/mail/thankYou/toField', 'required_property'),
    ],
  },
  {
    name: 'sensitive questions are allowed with the answers catch-all',
    declaration: form(
      [text('name', { required: true }), { key: 'health', type: 'textarea', label: '体調', required: false, sensitive: true }, email('mail', { sensitive: false })],
      {
        mail: {
          notification: { to: ['owner@example.jp'], subject: '{{form.name}}', body: '{{field.name}} 様\n{{submission.answers}}' },
          thankYou: { enabled: false },
        },
      },
    ),
    errors: [],
  },
  {
    name: 'sensitive fields cannot be mail placeholders',
    declaration: form([text('name'), { key: 'health', type: 'textarea', label: '体調', required: false, sensitive: true }], {
      mail: {
        notification: { to: ['owner@example.jp'], subject: '{{form.name}}', body: '{{field.name}}\n{{ field.health }}' },
        thankYou: { enabled: false },
      },
    }),
    errors: [issue('/mail/notification/body', 'sensitive_placeholder')],
  },
  {
    name: 'success message mode needs a message',
    declaration: form([text('name')], { success: { mode: 'message' } }),
    errors: [issue('/success/message', 'required_property')],
  },
  {
    name: 'file size above the form upload total',
    declaration: form([{ key: 'doc', type: 'file', label: 'doc', required: false, validation: { maxFileSize: 2097152 } }], { uploads: { maxTotalBytes: 1048576 } }),
    errors: [issue('/fields/0/validation/maxFileSize', 'upload_limit_exceeded')],
  },
];

export interface ActivityFixture {
  name: string;
  declaration: Json;
  values: Record<string, Json>;
  active: string[];
  required: string[];
}

const company = form([
  radio('customer_type', ['individual', 'business'], { required: true }),
  text('company', { required: true, visibleWhen: eq('customer_type', 'business') }),
  text('department', { visibleWhen: { field: 'company', operator: 'isNotEmpty' } }),
]);

export const activityFixtures: ActivityFixture[] = [
  {
    name: 'visibleWhen eq activates a required field',
    declaration: company,
    values: { customer_type: 'business', company: 'ヤトリス' },
    active: ['customer_type', 'company', 'department'],
    required: ['customer_type', 'company'],
  },
  {
    name: 'an inactive field cannot activate another with its stale value',
    declaration: company,
    values: { customer_type: 'individual', company: 'ヤトリス' },
    active: ['customer_type'],
    required: ['customer_type'],
  },
  {
    name: 'neq holds when the source has no answer',
    declaration: form([radio('r', ['a', 'b']), text('x', { visibleWhen: { field: 'r', operator: 'neq', value: 'a' } })]),
    values: {},
    active: ['r', 'x'],
    required: [],
  },
  {
    name: 'groups gate their descendants',
    declaration: form([
      { key: 'agree', type: 'checkbox', label: 'agree', required: false },
      {
        key: 'outer',
        type: 'group',
        visibleWhen: eq('agree', true),
        fields: [text('a', { required: true }), { key: 'inner', type: 'group', fields: [text('b')] }, { key: 'note', type: 'help', text: '補足' }],
      },
    ]),
    values: { agree: false, a: 'x', b: 'y' },
    active: ['agree'],
    required: [],
  },
  {
    name: 'groups open with their condition',
    declaration: form([
      { key: 'agree', type: 'checkbox', label: 'agree', required: false },
      { key: 'outer', type: 'group', visibleWhen: eq('agree', true), fields: [text('a', { required: true }), { key: 'inner', type: 'group', fields: [text('b')] }] },
    ]),
    values: { agree: true },
    active: ['agree', 'outer', 'a', 'inner', 'b'],
    required: ['a'],
  },
  {
    name: 'requiredWhen makes an optional active field required',
    declaration: form([radio('method', ['mail', 'phone']), { key: 'phone', type: 'tel', label: 'phone', required: false, requiredWhen: eq('method', 'phone') }]),
    values: { method: 'phone' },
    active: ['method', 'phone'],
    required: ['phone'],
  },
  {
    name: 'decimal comparisons are numeric',
    declaration: form([
      { key: 'n', type: 'number', label: 'n', required: false },
      text('big', { visibleWhen: { field: 'n', operator: 'gt', value: 10 } }),
      text('listed', { visibleWhen: { field: 'n', operator: 'in', value: ['10.5', 3] } }),
    ]),
    values: { n: '10.5' },
    active: ['n', 'big', 'listed'],
    required: [],
  },
  {
    name: 'temporal comparisons and choice lists',
    declaration: form([
      { key: 'd', type: 'date', label: 'd', required: false },
      { key: 't', type: 'time', label: 't', required: false },
      { key: 'c', type: 'checkboxes', label: 'c', required: false, options: [{ value: 'a', label: 'A' }, { value: 'other', label: 'その他' }] },
      text('late', { visibleWhen: { field: 'd', operator: 'gte', value: '2026-10-01' } }),
      text('morning', { visibleWhen: { field: 't', operator: 'lt', value: '12:00:00' } }),
      text('other_text', { visibleWhen: { field: 'c', operator: 'contains', value: 'other' } }),
      text('none', { visibleWhen: { field: 'c', operator: 'isEmpty' } }),
    ]),
    values: { d: '2026-10-07', t: '09:30', c: ['other'] },
    active: ['d', 't', 'c', 'late', 'morning', 'other_text'],
    required: [],
  },
  {
    name: 'reflection follows its source',
    declaration: form([radio('r', ['a', 'b']), text('x', { visibleWhen: eq('r', 'a') }), { key: 'echo', type: 'reflection', source: 'x' }]),
    values: { r: 'b', x: 'stale' },
    active: ['r'],
    required: [],
  },
  {
    name: 'hidden metadata is active unless a condition deactivates it',
    declaration: form([{ key: 'source', type: 'hidden', required: true }, { key: 'gated', type: 'hidden', visibleWhen: eq('source', 'lp') }]),
    values: { source: 'top' },
    active: ['source'],
    required: ['source'],
  },
  {
    name: 'all, any and not',
    declaration: form([
      radio('a', ['x', 'y']),
      radio('b', ['x', 'y']),
      text('t', { visibleWhen: { all: [eq('a', 'x'), { any: [eq('b', 'x'), { not: { field: 'b', operator: 'isNotEmpty' } }] }] } }),
    ]),
    values: { a: 'x' },
    active: ['a', 'b', 't'],
    required: [],
  },
];

export interface SubmissionFixture {
  name: string;
  declaration: Json;
  input: { answers: Record<string, Json>; files?: Record<string, Json[]> };
  options?: { timeZone?: string; checkQuiz?: boolean };
  expected: {
    answers: Record<string, Json>;
    files?: Record<string, Json[]>;
    fieldErrors: Record<string, string>;
    formErrors: string[];
  };
}

const file = (name: string, size: number, type: string) => ({ name, size, type });

export const submissionFixtures: SubmissionFixture[] = [
  {
    name: 'normalization of text-like values',
    declaration: form([
      text('name'),
      { key: 'message', type: 'textarea', label: 'm', required: false },
      email('mail'),
      { key: 'tel', type: 'tel', label: 'tel', required: false },
      { key: 'n', type: 'number', label: 'n', required: false },
    ]),
    input: { answers: { name: '　山田 太郎 ', message: '一行目\r\n二行目\r三行目', mail: 'ｔａｒｏ＠ｅｘａｍｐｌｅ．ｊｐ', tel: '０３－１２３４－５６７８', n: '００７.５０' } },
    expected: {
      answers: { name: '山田 太郎', message: '一行目\n二行目\n三行目', mail: 'taro@example.jp', tel: '03-1234-5678', n: '7.5' },
      fieldErrors: {},
      formErrors: [],
    },
  },
  {
    name: 'kana presets and formats',
    declaration: form([
      text('kana', { preset: 'katakana' }),
      text('hira', { preset: 'hiragana' }),
      text('bad', { preset: 'katakana' }),
      text('zip', { validation: { format: 'postal_code_jp' } }),
      text('digits', { validation: { format: 'digits' } }),
    ]),
    input: { answers: { kana: 'やまだ　ﾀﾛｳ', hira: 'ヤマダ', bad: 'Yamada', zip: '１２３４５６７', digits: '12a' } },
    expected: {
      answers: { kana: 'ヤマダ タロウ', hira: 'やまだ', zip: '123-4567' },
      fieldErrors: { bad: 'invalid_format', digits: 'invalid_format' },
      formErrors: [],
    },
  },
  {
    name: 'required rules by type',
    declaration: form([
      text('name', { required: true }),
      { key: 'message', type: 'textarea', label: 'm', required: true },
      { key: 'agree', type: 'checkbox', label: 'a', required: true },
      { key: 'consent', type: 'acceptance', label: 'c', required: true, consentText: '同意します。' },
      { key: 'n', type: 'number', label: 'n', required: true, validation: { min: 0 } },
    ]),
    input: { answers: { name: '   ', message: ' \n\t ', agree: false, n: 0 } },
    expected: {
      answers: { n: '0' },
      fieldErrors: { name: 'required', message: 'required', agree: 'required', consent: 'must_accept' },
      formErrors: [],
    },
  },
  {
    name: 'inactive answers are dropped without validation',
    declaration: company,
    input: { answers: { customer_type: 'individual', company: 'x'.repeat(6000), department: '営業' } },
    expected: { answers: { customer_type: 'individual' }, fieldErrors: {}, formErrors: [] },
  },
  {
    name: 'undeclared answers are rejected',
    declaration: form([text('name'), { key: 'doc', type: 'file', label: 'd', required: false }]),
    input: { answers: { name: 'a', extra: 'b', doc: 'c' }, files: { name: [] } },
    expected: { answers: { name: 'a' }, fieldErrors: {}, formErrors: ['undeclared_field'] },
  },
  {
    name: 'type mismatches',
    declaration: form([
      { key: 'n', type: 'number', label: 'n', required: false },
      { key: 'm', type: 'multiselect', label: 'm', required: false, options: [{ value: 'a', label: 'A' }] },
      { key: 'c', type: 'checkbox', label: 'c', required: false },
    ]),
    input: { answers: { n: true, m: 'a', c: 'true' } },
    expected: { answers: {}, fieldErrors: { n: 'invalid_type', m: 'invalid_type', c: 'invalid_type' }, formErrors: [] },
  },
  {
    name: 'choices are checked and ordered',
    declaration: form([
      { key: 's', type: 'select', label: 's', required: false, options: [{ value: 'a', label: 'A' }], prompt: '選択してください' },
      {
        key: 'm',
        type: 'multiselect',
        label: 'm',
        required: false,
        options: ['a', 'b', 'c'].map((value) => ({ value, label: value })),
        validation: { minSelected: 2, maxSelected: 2 },
      },
      { key: 'dup', type: 'checkboxes', label: 'd', required: false, options: [{ value: 'a', label: 'A' }] },
      { key: 'few', type: 'checkboxes', label: 'f', required: false, options: ['a', 'b'].map((value) => ({ value, label: value })), validation: { minSelected: 2 } },
      { key: 'empty', type: 'select', label: 'e', required: false, options: [{ value: 'a', label: 'A' }] },
    ]),
    input: { answers: { s: 'z', m: ['c', 'a'], dup: ['a', 'a'], few: ['b'], empty: '' } },
    expected: { answers: { m: ['a', 'c'] }, fieldErrors: { s: 'invalid_option', dup: 'invalid_option', few: 'too_few' }, formErrors: [] },
  },
  {
    name: 'number bounds and decimal steps',
    declaration: form(
      ['high', 'off', 'low', 'ok', 'zero'].map((key) => ({
        key,
        type: 'number',
        label: key,
        required: false,
        validation: key === 'zero' ? { min: 0, step: 1 } : { min: 1, max: 10, step: 0.5 },
      })),
    ),
    input: { answers: { high: '10.5', off: '1.25', low: '0', ok: 9.5, zero: '0' } },
    expected: { answers: { ok: '9.5', zero: '0' }, fieldErrors: { high: 'above_max', off: 'step_mismatch', low: 'below_min' }, formErrors: [] },
  },
  {
    name: 'calendar dates and steps',
    declaration: form([
      { key: 'a', type: 'date', label: 'a', required: false },
      { key: 'b', type: 'date', label: 'b', required: false },
      { key: 'weekly', type: 'date', label: 'w', required: false, validation: { min: '2026-10-05', step: 7 } },
      { key: 'weekly_bad', type: 'date', label: 'w', required: false, validation: { min: '2026-10-05', step: 7 } },
    ]),
    input: { answers: { a: '2026-02-29', b: '2028-02-29', weekly: '2026-10-19', weekly_bad: '2026-10-20' } },
    expected: { answers: { b: '2028-02-29', weekly: '2026-10-19' }, fieldErrors: { a: 'invalid_date', weekly_bad: 'step_mismatch' }, formErrors: [] },
  },
  {
    name: 'times are canonical and stepped',
    declaration: form([
      { key: 'a', type: 'time', label: 'a', required: false },
      { key: 'b', type: 'time', label: 'b', required: false },
      { key: 'c', type: 'time', label: 'c', required: false, validation: { step: 1 } },
      { key: 'd', type: 'time', label: 'd', required: false, validation: { min: '09:00', max: '18:00' } },
    ]),
    input: { answers: { a: '09:00:00', b: '09:00:30', c: '09:00:30', d: '18:30' } },
    expected: { answers: { a: '09:00', c: '09:00:30' }, fieldErrors: { b: 'step_mismatch', d: 'above_max' }, formErrors: [] },
  },
  {
    name: 'date-times in a zone with daylight saving',
    declaration: form([
      { key: 'gap', type: 'datetime', label: 'g', required: false },
      { key: 'overlap', type: 'datetime', label: 'o', required: false },
      { key: 'fine', type: 'datetime', label: 'f', required: false },
    ]),
    input: { answers: { gap: '2026-03-08T02:30', overlap: '2026-11-01T01:30', fine: '2026-07-01T10:00:00' } },
    options: { timeZone: 'America/New_York' },
    expected: { answers: { fine: '2026-07-01T10:00' }, fieldErrors: { gap: 'nonexistent_time', overlap: 'ambiguous_time' }, formErrors: [] },
  },
  {
    name: 'date-times in Tokyo are always unique',
    declaration: form([{ key: 'at', type: 'datetime', label: 'at', required: false }]),
    input: { answers: { at: '2026-03-08T02:30' } },
    options: { timeZone: 'Asia/Tokyo' },
    expected: { answers: { at: '2026-03-08T02:30' }, fieldErrors: {}, formErrors: [] },
  },
  {
    name: 'file rules per field and per submission',
    declaration: form([
      { key: 'many', type: 'file', label: 'm', required: false, validation: { maxFiles: 1 } },
      { key: 'big', type: 'file', label: 'b', required: false, validation: { maxFileSize: 1000 } },
      { key: 'kind', type: 'file', label: 'k', required: false, validation: { accept: ['pdf'] } },
      { key: 'ok', type: 'file', label: 'o', required: false, validation: { maxFiles: 5 } },
      { key: 'more', type: 'file', label: 'x', required: false, validation: { maxFiles: 2 } },
    ]),
    input: {
      answers: {},
      files: {
        many: [file('a.pdf', 10, 'application/pdf'), file('b.pdf', 10, 'application/pdf')],
        big: [file('a.png', 1001, 'image/png')],
        kind: [file('a.pdf', 10, 'image/png')],
        ok: [file('1.JPG', 10, 'image/jpeg'), file('2.png', 10, 'image/png'), file('3.webp', 10, 'image/webp'), file('4.txt', 10, 'text/plain; charset=utf-8')],
        more: [file('5.pdf', 10, 'application/pdf'), file('6.pdf', 10, 'application/pdf')],
      },
    },
    expected: {
      answers: {},
      files: {
        ok: [file('1.JPG', 10, 'image/jpeg'), file('2.png', 10, 'image/png'), file('3.webp', 10, 'image/webp'), file('4.txt', 10, 'text/plain; charset=utf-8')],
        more: [file('5.pdf', 10, 'application/pdf'), file('6.pdf', 10, 'application/pdf')],
      },
      fieldErrors: { many: 'too_many_files', big: 'file_too_large', kind: 'file_type_not_allowed' },
      formErrors: ['too_many_files_total'],
    },
  },
  {
    name: 'files of an inactive field are detached',
    declaration: form([
      { key: 'attach', type: 'checkbox', label: 'a', required: false },
      { key: 'doc', type: 'file', label: 'd', required: true, visibleWhen: eq('attach', true) },
    ]),
    input: { answers: { attach: false }, files: { doc: [file('a.exe', 99999999, 'application/x-msdownload')] } },
    expected: { answers: { attach: false }, fieldErrors: {}, formErrors: [] },
  },
  ...(
    [
      ['a width- and case-insensitive correct answer', { questionId: 'abc', answer: ' ａｂｃ ' }, {}],
      ['a wrong answer', { questionId: 'abc', answer: 'abd' }, { q: 'quiz_incorrect' }],
      ['an unknown question', { questionId: 'zzz', answer: 'abc' }, { q: 'invalid_question' }],
      ['no answer', undefined, { q: 'required' }],
    ] as const
  ).map(([label, answer, fieldErrors]) => ({
    name: `quiz: ${label} (quiz answers are never stored)`,
    declaration: form([text('name'), { key: 'q', type: 'quiz', label: '確認', questions: [{ id: 'abc', question: 'アルファベットの最初の3文字は?', answers: ['ABC'] }] }]),
    input: { answers: answer === undefined ? { name: '山田' } : { name: '山田', q: answer } },
    options: { checkQuiz: true },
    expected: { answers: { name: '山田' }, fieldErrors: fieldErrors as Record<string, string>, formErrors: [] },
  })),
  {
    name: 'hidden metadata and single-line text',
    declaration: form([{ key: 'source', type: 'hidden' }, { key: 'bad', type: 'hidden' }, text('line')]),
    input: { answers: { source: 'lp-2026', bad: 'a\u0007b', line: 'a\nb' } },
    expected: { answers: { source: 'lp-2026' }, fieldErrors: { bad: 'invalid_format', line: 'invalid_format' }, formErrors: [] },
  },
  {
    name: 'urls',
    declaration: form([
      ...['js', 'creds', 'idn', 'plain'].map((key) => ({ key, type: 'url', label: key, required: false })),
      { key: 'secure', type: 'url', label: 's', required: false, validation: { schemes: ['https'] } },
    ]),
    input: { answers: { js: 'javascript:alert(1)', creds: 'https://user:pw@example.jp/', idn: 'http://例え.jp/パス', plain: 'https://example.jp:8443/a?b=c#d', secure: 'http://example.jp/' } },
    expected: {
      answers: { idn: 'http://例え.jp/パス', plain: 'https://example.jp:8443/a?b=c#d' },
      fieldErrors: { js: 'invalid_url', creds: 'invalid_url', secure: 'invalid_url' },
      formErrors: [],
    },
  },
  {
    name: 'unchecked optional checkbox is a real false',
    declaration: form([{ key: 'newsletter', type: 'checkbox', label: 'n', required: false }]),
    input: { answers: {} },
    expected: { answers: { newsletter: false }, fieldErrors: {}, formErrors: [] },
  },
];

export interface QuestionsFixture {
  name: string;
  fields: Json;
  context: Record<string, Json>;
  errors: { path: string; code: string }[];
}

export interface ContextActivityFixture {
  name: string;
  fields: Json[];
  context: Record<string, Json>;
  contextValues: Record<string, Json>;
  values: Record<string, Json>;
  active: string[];
  required: string[];
}

/** Read-only booking context, as reservations supply it next to their questions. */
const booking = {
  'booking.service_key': { kind: 'choice', options: ['cut', 'color', 'perm'] },
  'booking.extras': { kind: 'choices', options: ['shampoo', 'treatment'] },
  'booking.party_size': { kind: 'decimal' },
  'booking.starts_at': { kind: 'datetime' },
  'booking.first_visit': { kind: 'boolean' },
  'booking.staff_name': { kind: 'string' },
};
const service = (value: Json) => eq('booking.service_key', value);
const partyAtLeast = (value: Json) => ({ field: 'booking.party_size', operator: 'gte', value });
const tel = (key: string, extra: Json = {}) => ({ key, type: 'tel', label: key, required: false, ...extra });
const health = (extra: Json = {}) => ({ key: 'health', type: 'textarea', label: '体調', required: false, sensitive: true, ...extra });

export const contextFixtures: { questions: QuestionsFixture[]; activity: ContextActivityFixture[] } = {
  questions: [
    {
      name: 'choice and choices context references',
      fields: [
        text('colour_history', { visibleWhen: service('color') }),
        text('scalp', { visibleWhen: { field: 'booking.extras', operator: 'contains', value: 'treatment' } }),
        text('listed', { visibleWhen: { field: 'booking.service_key', operator: 'in', value: ['cut', 'perm'] } }),
        text('staff', { visibleWhen: { field: 'booking.staff_name', operator: 'isNotEmpty' } }),
      ],
      context: booking,
      errors: [],
    },
    {
      name: 'context values must be context options',
      fields: [
        text('a', { visibleWhen: service('massage') }),
        text('b', { visibleWhen: { field: 'booking.service_key', operator: 'in', value: ['cut', 'nail'] } }),
        text('c', { visibleWhen: { field: 'booking.extras', operator: 'contains', value: 'massage' } }),
      ],
      context: booking,
      errors: [
        issue('/fields/0/visibleWhen/value', 'invalid_condition_value'),
        issue('/fields/1/visibleWhen/value', 'invalid_condition_value'),
        issue('/fields/2/visibleWhen/value', 'invalid_condition_value'),
      ],
    },
    {
      name: 'an unknown context key',
      fields: [text('a', { visibleWhen: eq('booking.staff_key', 'x') })],
      context: booking,
      errors: [issue('/fields/0/visibleWhen/field', 'unknown_reference')],
    },
    {
      name: 'a dotted reference with an empty context',
      fields: [text('a', { visibleWhen: service('cut') })],
      context: {},
      errors: [issue('/fields/0/visibleWhen/field', 'unknown_reference')],
    },
    {
      name: 'operators must suit the context kind',
      fields: [
        text('a', { visibleWhen: { field: 'booking.service_key', operator: 'contains', value: 'cut' } }),
        text('b', { visibleWhen: { field: 'booking.first_visit', operator: 'neq', value: true } }),
        text('c', { visibleWhen: { field: 'booking.starts_at', operator: 'in', value: ['2026-10-10T10:00'] } }),
      ],
      context: booking,
      errors: [
        issue('/fields/0/visibleWhen/operator', 'invalid_operator'),
        issue('/fields/1/visibleWhen/operator', 'invalid_operator'),
        issue('/fields/2/visibleWhen/operator', 'invalid_operator'),
      ],
    },
    {
      name: 'decimal, temporal and boolean context values',
      fields: [
        text('a', { visibleWhen: partyAtLeast('6') }),
        text('b', { visibleWhen: partyAtLeast(6) }),
        text('c', { visibleWhen: partyAtLeast('six') }),
        text('d', { visibleWhen: { field: 'booking.starts_at', operator: 'gte', value: '2026-10-10T18:00' } }),
        text('e', { visibleWhen: { field: 'booking.starts_at', operator: 'lt', value: '2026-10-10' } }),
        text('f', { visibleWhen: eq('booking.first_visit', true) }),
        text('g', { visibleWhen: eq('booking.first_visit', 'yes') }),
        text('h', { visibleWhen: { field: 'booking.party_size', operator: 'isEmpty', value: '0' } }),
      ],
      context: booking,
      errors: [
        issue('/fields/2/visibleWhen/value', 'invalid_condition_value'),
        issue('/fields/4/visibleWhen/value', 'invalid_condition_value'),
        issue('/fields/6/visibleWhen/value', 'invalid_condition_value'),
        issue('/fields/7/visibleWhen/value', 'invalid_condition_value'),
      ],
    },
    {
      name: 'a context reference inside requiredWhen',
      fields: [tel('phone', { requiredWhen: partyAtLeast('6') })],
      context: booking,
      errors: [],
    },
    {
      name: 'a context reference inside a nested group visibleWhen',
      fields: [
        {
          key: 'details',
          type: 'group',
          fields: [{ key: 'perm_details', type: 'group', visibleWhen: { not: service('cut') }, fields: [text('curl', { required: true })] }],
        },
      ],
      context: booking,
      errors: [],
    },
    {
      name: 'context references inside all/any/not keep their paths',
      fields: [text('a', { visibleWhen: { all: [{ any: [service('cut')] }, { not: { field: 'booking.service_key', operator: 'gt', value: 'cut' } }] } })],
      context: booking,
      errors: [issue('/fields/0/visibleWhen/all/1/not/operator', 'invalid_operator')],
    },
    {
      name: 'a sensitive field with a normal condition',
      fields: [health({ visibleWhen: service('color') }), text('follow_up', { visibleWhen: { field: 'health', operator: 'isNotEmpty' } })],
      context: booking,
      errors: [],
    },
    {
      name: 'quiz takes no sensitive marker',
      fields: [text('name'), { key: 'q', type: 'quiz', label: 'q', sensitive: true, questions: [{ id: 'x', question: '?', answers: ['a'] }] }],
      context: booking,
      errors: [issue('/fields/1/sensitive', 'unknown_property')],
    },
    {
      name: 'node rules still apply to questions',
      fields: [text('a', { visibleWhen: eq('a', 'x') }), text('a'), radio('r', ['x', 'x']), { key: 'echo', type: 'reflection', source: 'missing' }],
      context: booking,
      errors: [
        issue('/fields/0/visibleWhen/field', 'self_reference'),
        issue('/fields/1/key', 'duplicate_key'),
        issue('/fields/2/options/1/value', 'duplicate_option'),
        issue('/fields/3/source', 'reflection_source_invalid'),
      ],
    },
    {
      name: 'visibility cycles are still found and context never joins them',
      fields: [
        text('a', { visibleWhen: { all: [service('cut'), { field: 'b', operator: 'isNotEmpty' }] } }),
        text('b', { visibleWhen: { field: 'a', operator: 'isNotEmpty' } }),
      ],
      context: booking,
      errors: [issue('/fields/0/visibleWhen', 'condition_cycle')],
    },
    { name: 'an empty question list', fields: [], context: booking, errors: [issue('/fields', 'too_short')] },
    { name: 'questions must be a list', fields: { key: 'a' }, context: booking, errors: [issue('/fields', 'invalid_type')] },
  ],
  activity: [
    {
      name: 'visibleWhen on a context choice: active',
      fields: [text('length', { visibleWhen: service('cut') })],
      context: booking,
      contextValues: { 'booking.service_key': 'cut' },
      values: { length: 'short' },
      active: ['length'],
      required: [],
    },
    {
      name: 'visibleWhen on a context choice: inactive',
      fields: [text('length', { visibleWhen: service('cut') })],
      context: booking,
      contextValues: { 'booking.service_key': 'color' },
      values: { length: 'short' },
      active: [],
      required: [],
    },
    {
      name: 'requiredWhen on a context decimal: required',
      fields: [tel('phone', { requiredWhen: partyAtLeast('6') })],
      context: booking,
      contextValues: { 'booking.party_size': '8' },
      values: {},
      active: ['phone'],
      required: ['phone'],
    },
    {
      name: 'requiredWhen on a context decimal: optional',
      fields: [tel('phone', { requiredWhen: partyAtLeast('6') })],
      context: booking,
      contextValues: { 'booking.party_size': '4' },
      values: {},
      active: ['phone'],
      required: [],
    },
    {
      name: 'context decimals are canonicalized before comparison',
      fields: [tel('phone', { requiredWhen: partyAtLeast('6') }), text('exact', { visibleWhen: eq('booking.party_size', 6) })],
      context: booking,
      contextValues: { 'booking.party_size': '06.0' },
      values: {},
      active: ['phone', 'exact'],
      required: ['phone'],
    },
    {
      name: 'a group gated by context hides its children',
      fields: [
        text('name', { required: true }),
        {
          key: 'colour',
          type: 'group',
          visibleWhen: service('color'),
          fields: [text('history', { required: true }), { key: 'note', type: 'help', text: '補足' }, { key: 'echo', type: 'reflection', source: 'history' }],
        },
      ],
      context: booking,
      contextValues: { 'booking.service_key': 'cut' },
      values: { name: '山田', history: 'stale' },
      active: ['name'],
      required: ['name'],
    },
    {
      name: 'a context key missing from contextValues is empty',
      fields: [
        text('a', { visibleWhen: { field: 'booking.service_key', operator: 'isEmpty' } }),
        text('b', { visibleWhen: { field: 'booking.service_key', operator: 'neq', value: 'cut' } }),
        text('c', { visibleWhen: service('cut') }),
        text('d', { visibleWhen: partyAtLeast('1') }),
      ],
      context: booking,
      contextValues: {},
      values: {},
      active: ['a', 'b'],
      required: [],
    },
    {
      name: 'answers never stand in for context values',
      fields: [text('length', { visibleWhen: service('cut') })],
      context: booking,
      contextValues: { 'booking.service_key': 'color' },
      values: { 'booking.service_key': 'cut', length: 'short' },
      active: [],
      required: [],
    },
    {
      name: 'choices, boolean, datetime and string context values',
      fields: [
        text('scalp', { visibleWhen: { field: 'booking.extras', operator: 'contains', value: 'treatment' } }),
        text('welcome', { visibleWhen: eq('booking.first_visit', true) }),
        text('late', { visibleWhen: { field: 'booking.starts_at', operator: 'gte', value: '2026-10-10T18:00' } }),
        text('staff', { visibleWhen: { field: 'booking.staff_name', operator: 'contains', value: '佐藤' } }),
      ],
      context: booking,
      contextValues: { 'booking.extras': ['shampoo', 'treatment'], 'booking.first_visit': false, 'booking.starts_at': '2026-10-10T18:30', 'booking.staff_name': '佐藤 花子' },
      values: {},
      active: ['scalp', 'late', 'staff'],
      required: [],
    },
    {
      name: 'a context value of the wrong type is empty',
      fields: [
        text('a', { visibleWhen: eq('booking.first_visit', true) }),
        text('b', { visibleWhen: { field: 'booking.party_size', operator: 'isEmpty' } }),
        text('c', { visibleWhen: { field: 'booking.service_key', operator: 'isEmpty' } }),
      ],
      context: booking,
      contextValues: { 'booking.first_visit': 'true', 'booking.party_size': 'six', 'booking.service_key': ['cut'] },
      values: {},
      active: ['b', 'c'],
      required: [],
    },
    {
      name: 'a sensitive field follows context like any other',
      fields: [health({ requiredWhen: service('color') }), text('follow_up', { visibleWhen: { field: 'health', operator: 'isNotEmpty' } })],
      context: booking,
      contextValues: { 'booking.service_key': 'color' },
      values: { health: '頭皮が敏感です' },
      active: ['health', 'follow_up'],
      required: ['health'],
    },
  ],
};
