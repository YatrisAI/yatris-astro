import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { validateDeclaration } from './forms/declaration.js';
import { INPUT_TYPES } from './forms/registry.js';
import { managedBlock } from './platform-lock.js';

/**
 * The canonical `yatris-contact-form` skill (YatrisCMS#381): its layout, the
 * examples it teaches, the interview brief shape and the root guidance that
 * points agents at it. create.test.ts and update.test.ts check delivery.
 */

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const skillDir = join(repo, 'skills/yatris-contact-form');
const read = (path: string) => readFileSync(join(skillDir, path), 'utf8').replace(/\r\n/g, '\n');
const jsonBlocks = (markdown: string): unknown[] => [...markdown.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => JSON.parse(m[1]));

function skillFiles(): string[] {
  return readdirSync(skillDir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(skillDir, join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
    .sort();
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = Record<string, Json> | boolean;

/**
 * A minimal JSON Schema (2020-12) evaluator for exactly the keywords the brief
 * schema uses. Any other keyword throws, so the schema cannot quietly rely on
 * something this test does not check.
 */
function schemaErrors(schema: Schema, value: Json, root: Record<string, Json>, path = ''): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: false`];
  const supported = ['$schema', 'title', 'description', '$defs', '$ref', 'type', 'const', 'enum', 'minLength', 'maxLength', 'pattern', 'items', 'uniqueItems', 'required', 'properties', 'additionalProperties', 'propertyNames', 'not', 'if', 'then', 'else'];
  for (const keyword of Object.keys(schema)) if (!supported.includes(keyword)) throw new Error(`unsupported keyword ${keyword}`);
  const errors: string[] = [];
  const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
  const isObject = (v: Json): v is { [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);

  if (typeof schema.$ref === 'string') {
    const target = schema.$ref.replace(/^#\//, '').split('/').reduce<Json>((node, part) => (node as Record<string, Json>)[part], root);
    errors.push(...schemaErrors(target as Schema, value, root, path));
  }
  if (schema.type !== undefined) {
    const types: Record<string, (v: Json) => boolean> = {
      object: isObject,
      array: Array.isArray,
      string: (v) => typeof v === 'string',
      integer: Number.isInteger,
      number: (v) => typeof v === 'number',
      boolean: (v) => typeof v === 'boolean',
      null: (v) => v === null,
    };
    if (!types[schema.type as string](value)) return [...errors, `${path}: type`];
  }
  if ('const' in schema && !same(schema.const, value)) errors.push(`${path}: const`);
  if (Array.isArray(schema.enum) && !schema.enum.some((option) => same(option, value))) errors.push(`${path}: enum`);
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) errors.push(`${path}: minLength`);
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) errors.push(`${path}: maxLength`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) errors.push(`${path}: pattern`);
  }
  if (Array.isArray(value)) {
    if (schema.items !== undefined) value.forEach((item, i) => errors.push(...schemaErrors(schema.items as Schema, item, root, `${path}/${i}`)));
    if (schema.uniqueItems === true && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push(`${path}: uniqueItems`);
  }
  if (isObject(value)) {
    const properties = (schema.properties ?? {}) as Record<string, Schema>;
    for (const key of (schema.required ?? []) as string[]) if (!(key in value)) errors.push(`${path}/${key}: required`);
    for (const [key, item] of Object.entries(value)) {
      if (schema.propertyNames !== undefined) errors.push(...schemaErrors(schema.propertyNames as Schema, key, root, `${path}/${key}#name`));
      if (key in properties) errors.push(...schemaErrors(properties[key], item, root, `${path}/${key}`));
      else if (schema.additionalProperties !== undefined) errors.push(...schemaErrors(schema.additionalProperties as Schema, item, root, `${path}/${key}`));
    }
  }
  if (schema.not !== undefined && schemaErrors(schema.not as Schema, value, root, path).length === 0) errors.push(`${path}: not`);
  if (schema.if !== undefined) {
    const branch = schemaErrors(schema.if as Schema, value, root, path).length === 0 ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...schemaErrors(branch as Schema, value, root, path));
  }
  return errors;
}

const briefSchema = JSON.parse(read('references/brief.schema.json')) as Record<string, Json>;
const briefErrors = (brief: Json) => schemaErrors(briefSchema, brief, briefSchema);
const exampleBrief = () => structuredClone(jsonBlocks(read('references/brief.md'))[0]) as { [key: string]: Json } & { decisions: Record<string, Record<string, Json>> };
const examples = () => jsonBlocks(read('references/examples.md')) as Array<Record<string, unknown> & { key: string; fields: Array<Record<string, unknown>> }>;

describe('the yatris-contact-form skill', () => {
  it('is one canonical skill: portable frontmatter, workflow in SKILL.md, every reference linked', () => {
    const skill = read('SKILL.md');
    const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)![1];
    const fields = Object.fromEntries(frontmatter.split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]));

    expect(Object.keys(fields)).toEqual(['name', 'description']);
    expect(fields.name).toBe('yatris-contact-form');
    expect(fields.description.length).toBeLessThanOrEqual(1024);

    const references = skillFiles().filter((file) => file.startsWith('references/'));
    expect(references).toEqual(
      expect.arrayContaining(['references/fields.md', 'references/examples.md', 'references/conditions.md', 'references/commands.md', 'references/errors.md', 'references/secrets.md', 'references/scenarios.md', 'references/interview.md', 'references/brief.md', 'references/brief.schema.json']),
    );
    const linked = new Set([...skill.matchAll(/\]\((references\/[^)]+)\)/g)].map((m) => m[1]));
    expect([...linked].sort()).toEqual(references);
    // SKILL.md is the workflow; detail lives in references (spec §14)
    expect(skill.split('\n').length).toBeLessThan(260);
  });

  it('covers every spec §14 interview topic and the decision-record additions', () => {
    const skill = read('SKILL.md');
    const interview = read('references/interview.md');
    for (const topic of ['Purpose and placement', 'Fields', 'Conditions', 'Files and consent', 'Client notification', 'Visitor email', 'Mail source', 'Submission result', 'Review']) {
      expect(skill).toContain(`| ${topic} |`);
      expect(interview).toMatch(new RegExp(`^## \\d\\. ${topic}$`, 'm'));
    }
    expect(skill).toContain('at most three questions');
    expect(interview).toContain('`form.confirm_step`'); // 入力→確認→完了 (decisions §3)
    expect(interview).toContain('`fields.kana_preset`'); // kana preset (decisions §3)
    expect(skill).toMatch(/only seeds a new form/); // recipients as initial value (decisions §6)
    const secrets = read('references/secrets.md');
    expect(secrets).toContain('Connections page'); // decisions §5
    expect(secrets).toContain('npx yatris mail sync --env-file .env');
    expect(secrets).toContain('Never ask for SMTP credentials in chat');
  });

  it('teaches synchronization: the drift scenario, every plan operation and the exit codes (YatrisCMS#392)', () => {
    const scenarios = read('references/scenarios.md');
    expect(scenarios).toContain('## I. Existing form changed in Yatris (drift)');
    for (const op of ['remote_drift', 'conflict', 'accept_remote', 'adopt_required', 'update_draft']) expect(scenarios).toContain(op);
    const commands = read('references/commands.md');
    for (const op of ['create', 'update_draft', 'noop', 'accept_remote', 'remote_drift', 'conflict', 'adopt_required', 'invalid']) expect(commands).toContain(`\`${op}\``);
    for (const code of ['0', '1', '2', '3', '4', '5', '69', '75']) expect(commands).toContain(`| \`${code}\` |`);
    expect(commands).toContain('`backend_unavailable`');
    expect(read('SKILL.md')).not.toMatch(/exit 69 and change nothing|not available yet/);
  });

  it('documents every decision id the example brief uses', () => {
    const interview = read('references/interview.md');
    for (const id of Object.keys(exampleBrief().decisions)) {
      const generic = id.replace(/^(fields|conditions)\.[a-z0-9_]+\.(required|options|validation)$/, '$1.<key>.$2');
      expect(interview.includes(`\`${id}\``) || interview.includes(`\`${generic}\``), id).toBe(true);
    }
  });

  it('teaches only valid declarations', () => {
    const declarations = examples();
    expect(declarations.length).toBeGreaterThanOrEqual(3);
    for (const declaration of declarations) {
      const result = validateDeclaration(declaration);
      expect(result.errors, declaration.key).toEqual([]);
      // The only expected warning is recipients left out while unresolved
      expect(result.warnings.every((w) => w.code === 'recipients_missing'), declaration.key).toBe(true);
    }
    expect(new Set(declarations.map((d) => d.key)).size).toBe(declarations.length);
    // The examples exercise the decision-record additions
    const all = JSON.stringify(declarations);
    expect(all).toContain('"preset":"katakana"');
    expect(declarations.some((d) => (d.confirmStep as { enabled?: boolean } | undefined)?.enabled === true)).toBe(true);
    expect(declarations.some((d) => !('to' in ((d.mail as { notification: object }).notification)))).toBe(true);
  });

  it('teaches only valid conditions', () => {
    const conditions = jsonBlocks(read('references/conditions.md'));
    const options = (...values: string[]) => values.map((value) => ({ value, label: value }));
    const host = {
      contractVersion: 1,
      key: 'conditions',
      name: 'conditions',
      locale: 'ja',
      submit: { label: '送信' },
      success: { mode: 'message', message: 'ok' },
      mail: { notification: { to: ['a@example.jp'], subject: 's', body: 'b' }, thankYou: { enabled: false } },
      fields: [
        { key: 'customer_type', type: 'radio', label: 'a', required: true, options: options('individual', 'business') },
        { key: 'services', type: 'checkboxes', label: 'b', required: true, options: options('design', 'other') },
        { key: 'contact_method', type: 'radio', label: 'c', required: true, options: options('email', 'phone') },
        { key: 'topic', type: 'select', label: 'd', required: true, options: options('repair', 'warranty', 'other') },
        { key: 'already_customer', type: 'checkbox', label: 'e', required: false },
      ],
    };
    expect(conditions.length).toBeGreaterThanOrEqual(4);
    for (const condition of conditions) {
      const declaration = { ...host, fields: [...host.fields, { key: 'target', type: 'text', label: 't', required: false, visibleWhen: condition }] };
      expect(validateDeclaration(declaration).errors, JSON.stringify(condition)).toEqual([]);
    }
  });

  it('never holds a credential', () => {
    for (const file of skillFiles()) {
      const text = read(file);
      expect(text, file).not.toMatch(/^YATRIS_SMTP_PASSWORD=\S/m);
      expect(text, file).not.toMatch(/alk_[A-Za-z0-9]{8,}|ghp_[A-Za-z0-9]{10,}|Bearer\s+[A-Za-z0-9._-]{10,}/);
    }
  });
});

describe('the interview brief (src/forms/<key>.brief.json)', () => {
  it('the documented example matches brief.schema.json', () => {
    expect(briefErrors(exampleBrief())).toEqual([]);
  });

  it('accepts a brief in progress with unresolved decisions and no pending list', () => {
    expect(
      briefErrors({
        briefVersion: 1,
        form: 'estimate',
        stage: 'interviewing',
        decisions: {
          'purpose.summary': { topic: 'purpose_placement', status: 'confirmed', summary: 'Estimate requests.', value: 'estimate', source: 'user' },
          'fields.tel.required': { topic: 'fields', status: 'unresolved', summary: 'Is the phone number required?', recommendation: false },
        },
      }),
    ).toEqual([]);
  });

  const mutations: Array<[string, (brief: ReturnType<typeof exampleBrief>) => void, string]> = [
    ['an unresolved decision with a value', (b) => (b.decisions['notification.recipients'].value = ['a@example.jp']), '/decisions/notification.recipients: not'],
    ['a confirmed decision without a value', (b) => delete b.decisions['fields.name.required'].value, '/decisions/fields.name.required/value: required'],
    ['a delegated decision without a source', (b) => delete b.decisions['purpose.key'].source, '/decisions/purpose.key/source: required'],
    ['an unknown status', (b) => (b.decisions['success.mode'].status = 'assumed'), '/decisions/success.mode/status: enum'],
    ['an unknown topic', (b) => (b.decisions['success.mode'].topic = 'design'), '/decisions/success.mode/topic: enum'],
    ['a decision id that is not dotted lowercase', (b) => (b.decisions['Fields.Name'] = b.decisions['fields.name.required']), '/decisions/Fields.Name#name: pattern'],
    ['an extra decision property', (b) => (b.decisions['success.mode'].password = 'x'), '/decisions/success.mode/password: false'],
    ['an extra top-level property', (b) => (b.smtp = { host: 'smtp.example.jp' }), '/smtp: false'],
    ['a form key that is not a form key', (b) => (b.form = 'Contact Form'), '/form: pattern'],
    ['another brief version', (b) => (b.briefVersion = 2), '/briefVersion: const'],
    ['an unknown stage', (b) => (b.stage = 'published'), '/stage: enum'],
    ['an unknown pending item', (b) => (b.pending = ['deploy']), '/pending/0: enum'],
    ['a missing decisions map', (b) => delete (b as Record<string, unknown>).decisions, '/decisions: required'],
  ];
  it.each(mutations)('rejects %s', (_name, mutate, expected) => {
    const brief = exampleBrief();
    mutate(brief);
    expect(briefErrors(brief)).toContain(expected);
  });

  it('records explicit requiredness for every input of the declaration it produced', () => {
    const brief = exampleBrief();
    const declaration = examples().find((d) => d.key === brief.form)!;
    const inputs = declaration.fields.filter((f) => (INPUT_TYPES as string[]).includes(f.type as string) && !['hidden', 'quiz'].includes(f.type as string));

    expect(inputs.length).toBeGreaterThan(0);
    for (const field of inputs) {
      const decision = brief.decisions[`fields.${field.key as string}.required`];
      expect(decision, field.key as string).toBeDefined();
      expect(['confirmed', 'delegated']).toContain(decision.status);
      expect(decision.value).toBe(field.required);
    }
    // Unresolved recipients stay out of the declaration (decisions §6)
    expect(brief.decisions['notification.recipients'].status).toBe('unresolved');
    expect((declaration.mail as { notification: object }).notification).not.toHaveProperty('to');
  });
});

describe('root agent guidance', () => {
  it('the managed AGENTS.md block sends contact forms to Yatris and forbids stopgaps', () => {
    const block = managedBlock(readFileSync(join(repo, 'template/AGENTS.md'), 'utf8'))!;
    expect(block).toContain('**Contact and inquiry forms always use Yatris**');
    expect(block).toContain('<YatrisForm form="<key>" />');
    expect(block).toContain('`src/forms/<key>.json`');
    expect(block).toContain('`yatris-contact-form`');
    for (const forbidden of ['Cloudflare Function', '`mailto:` form', 'third-party form service', 'SMTP sender', 'Not even as a\n  stopgap']) {
      expect(block).toContain(forbidden);
    }
  });
});
