import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { activityFixtures, contextFixtures, declarationFixtures, submissionFixtures } from '../../test/forms-fixtures.js';
import {
  API_ERRORS,
  canonicalJson,
  declarationJsonSchema,
  evaluateActivity,
  FIELD_ERRORS,
  FORM_ERRORS,
  NODE_TYPE_NAMES,
  requestHash,
  requiredCapabilities,
  toPublicDefinition,
  validateDeclaration,
  validateQuestions,
  validateSubmission,
  type FormDeclaration,
} from './index.js';
import { CONDITION_OPERATORS } from './spec.js';

const CONTRACT = join(dirname(fileURLToPath(import.meta.url)), '../../../../contracts/forms/v1');
const UPDATE = process.env.YATRIS_UPDATE_CONTRACT === '1';
const example = (name: string) => JSON.parse(readFileSync(join(CONTRACT, 'examples', name), 'utf8')) as FormDeclaration;
const key = (issues: { path: string; code: string }[]) => issues.map((i) => `${i.path} ${i.code}`).sort();

/** Published contract files must equal what the sources produce; YATRIS_UPDATE_CONTRACT=1 rewrites them. */
function published(relative: string, value: unknown) {
  const path = join(CONTRACT, relative);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }
  expect(existsSync(path), `${relative} is missing; run YATRIS_UPDATE_CONTRACT=1 npx vitest run contract`).toBe(true);
  expect(readFileSync(path, 'utf8'), `${relative} is stale; run YATRIS_UPDATE_CONTRACT=1 npx vitest run contract`).toBe(contents);
}

describe('declaration fixtures', () => {
  it.each(declarationFixtures.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    const result = validateDeclaration(fixture.declaration);
    expect(key(result.errors)).toEqual(key(fixture.errors));
    expect(key(result.warnings)).toEqual(key(fixture.warnings ?? []));
    expect(result.valid).toBe(fixture.errors.length === 0);
  });
});

describe('activity fixtures', () => {
  it.each(activityFixtures.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    expect(validateDeclaration(fixture.declaration).errors).toEqual([]);
    expect(evaluateActivity(fixture.declaration, fixture.values)).toEqual({ active: fixture.active, required: fixture.required });
  });
});

describe('submission fixtures', () => {
  it.each(submissionFixtures.map((f) => [f.name, f] as const))('%s', (_, fixture) => {
    expect(validateDeclaration(fixture.declaration).errors).toEqual([]);
    const result = validateSubmission(fixture.declaration, fixture.input, fixture.options);
    expect({ answers: result.answers, files: result.files, fieldErrors: result.fieldErrors, formErrors: result.formErrors }).toEqual({
      files: {},
      ...fixture.expected,
    });
  });
});

describe('question context fixtures', () => {
  it.each(contextFixtures.questions.map((f) => [f.name, f] as const))('questions: %s', (_, fixture) => {
    const result = validateQuestions(fixture.fields, { context: fixture.context });
    expect(result.errors).toEqual(fixture.errors);
    expect(result.warnings).toEqual([]);
    expect(result.valid).toBe(fixture.errors.length === 0);
  });

  it.each(contextFixtures.activity.map((f) => [f.name, f] as const))('activity: %s', (_, fixture) => {
    expect(validateQuestions(fixture.fields, { context: fixture.context }).errors).toEqual([]);
    const options = { context: fixture.context, contextValues: fixture.contextValues };
    expect(evaluateActivity({ fields: fixture.fields }, fixture.values, options)).toEqual({ active: fixture.active, required: fixture.required });
  });

  it('questions report the same node issues as a declaration with those fields', () => {
    const fields = (declarationFixtures.find((f) => f.name === 'condition references')!.declaration as FormDeclaration).fields;
    expect(validateQuestions(fields).errors).toEqual(validateDeclaration({ ...(declarationFixtures[0]!.declaration as FormDeclaration), fields }).errors);
  });

  it('unknown context keys evaluate to false and malformed contexts throw', () => {
    const fields = [{ key: 'a', type: 'text', label: 'a', required: false, visibleWhen: { field: 'booking.nope', operator: 'neq', value: 'x' } }] as never;
    expect(evaluateActivity({ fields }, {}, { context: {}, contextValues: { 'booking.nope': 'y' } }).active).toEqual([]);
    expect(() => validateQuestions(fields, { context: { service: { kind: 'choice' } } as never })).toThrow(TypeError);
    expect(() => validateQuestions(fields, { context: { 'booking.files': { kind: 'files' } } as never })).toThrow(TypeError);
    expect(() => evaluateActivity({ fields }, {}, { context: { 'booking.size': { kind: 'decimal', options: ['1'] } } as never })).toThrow(TypeError);
  });

  it('visitors can never supply context values', () => {
    const fields = [
      { key: 'name', type: 'text', label: 'name', required: false },
      { key: 'phone', type: 'tel', label: 'phone', required: false, requiredWhen: { field: 'booking.party_size', operator: 'gte', value: '6' } },
    ];
    const declaration = { ...(declarationFixtures[0]!.declaration as FormDeclaration), fields } as FormDeclaration;
    const context = { 'booking.party_size': { kind: 'decimal' as const } };
    const spoofed = validateSubmission(declaration, { answers: { name: '山田', 'booking.party_size': '8' } }, { context, contextValues: { 'booking.party_size': '2' } });
    expect(spoofed.formErrors).toEqual(['undeclared_field']);
    expect(spoofed.required).toEqual([]);
    const large = validateSubmission(declaration, { answers: { name: '山田' } }, { context, contextValues: { 'booking.party_size': '8' } });
    expect(large.fieldErrors).toEqual({ phone: 'required' });
    expect(large.required).toEqual(['phone']);
  });
});

describe('examples', () => {
  it.each(['contact.json', 'full-coverage.json'])('%s is valid', (name) => {
    expect(validateDeclaration(example(name))).toEqual({ valid: true, errors: [], warnings: [] });
  });

  it('the full-coverage example uses every node type in the registry', () => {
    const used = new Set<string>();
    const walk = (nodes: { type: string; fields?: unknown[] }[]) =>
      nodes.forEach((n) => {
        used.add(n.type);
        if (n.fields) walk(n.fields as never);
      });
    walk(example('full-coverage.json').fields);
    expect([...used].sort()).toEqual([...NODE_TYPE_NAMES].sort());
  });
});

describe('public definition', () => {
  const meta = {
    publicKey: 'frm_01HZXJ8Q0EXAMPLE',
    version: 3,
    endpoint: 'https://api.yatris.jp/api/v1/forms/frm_01HZXJ8Q0EXAMPLE/submissions',
    turnstile: { siteKey: '1x00000000000000000000AA', action: 'contact' },
  };

  it('carries no mail configuration, recipients, SMTP data or quiz answers', async () => {
    const definition = await toPublicDefinition(example('full-coverage.json'), meta);
    const json = JSON.stringify(definition);
    expect(definition).not.toHaveProperty('mail');
    expect(definition).not.toHaveProperty('smtp');
    expect(json).not.toContain('contact@example.jp');
    expect(json).not.toContain('富士山');
    expect(json).toContain('日本一高い山は?');
    expect(json).not.toContain('$schema');
  });

  it('turns decimals into canonical strings', async () => {
    const definition = await toPublicDefinition(example('full-coverage.json'), meta);
    const business = definition.fields.find((n) => n.key === 'business')!;
    const budget = (business.fields as { key: string }[]).find((n) => n.key === 'budget');
    expect(budget).toMatchObject({ default: '50', validation: { min: '0', max: '500', step: '10' } });
  });

  it('lists the renderer capabilities a declaration needs', () => {
    expect(requiredCapabilities(example('contact.json'))).toEqual([
      'conditions',
      'field:acceptance',
      'field:email',
      'field:radio',
      'field:text',
      'field:textarea',
    ]);
    expect(requiredCapabilities(example('full-coverage.json'))).toContain('confirm_step');
    expect(requiredCapabilities(example('full-coverage.json'))).toContain('preset:katakana');
    expect(requiredCapabilities(example('full-coverage.json'))).toContain('uploads');
  });

  it('publishes projection fixtures with stable digests', async () => {
    const cases = await Promise.all(
      ['contact.json', 'full-coverage.json'].map(async (name) => ({
        name,
        declaration: example(name),
        meta,
        expected: await toPublicDefinition(example(name), meta),
      })),
    );
    expect(cases[0]!.expected.form.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    published('fixtures/public.json', cases);
  });
});

describe('submission wire format', () => {
  it('fingerprints the exact answers bytes and every file part in order', async () => {
    const answersJson = '{"name":"山田","message":"よろしくお願いします。"}';
    const files = [
      { field: 'attachments', sha256: 'a'.repeat(64), size: 1024 },
      { field: 'attachments', sha256: 'b'.repeat(64), size: 2048 },
    ];
    const hash = await requestHash('frm_01HZXJ8Q0EXAMPLE', 3, answersJson, files);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(await requestHash('frm_01HZXJ8Q0EXAMPLE', 3, answersJson, files.toReversed())).not.toBe(hash);
    expect(await requestHash('frm_01HZXJ8Q0EXAMPLE', 3, answersJson.replace('山田', '田中'), files)).not.toBe(hash);
    published('fixtures/request-hash.json', [
      { publicKey: 'frm_01HZXJ8Q0EXAMPLE', version: 3, answersJson, files, expected: hash },
      { publicKey: 'frm_01HZXJ8Q0EXAMPLE', version: 3, answersJson: '{}', files: [], expected: await requestHash('frm_01HZXJ8Q0EXAMPLE', 3, '{}', []) },
    ]);
  });

  it('encodes canonical JSON with sorted keys and integers only', () => {
    expect(canonicalJson({ b: 1, a: ['x', { d: true, c: null }], e: '日本/語' })).toBe('{"a":["x",{"c":null,"d":true}],"b":1,"e":"日本/語"}');
    expect(() => canonicalJson({ n: 0.5 })).toThrow();
  });
});

describe('published contract files', () => {
  it('declaration.schema.json matches the registry', () => {
    const schema = declarationJsonSchema() as { $defs: Record<string, unknown> };
    for (const name of NODE_TYPE_NAMES) expect(schema.$defs).toHaveProperty(`node_${name}`);
    expect(JSON.stringify(schema.$defs.condition)).toContain(JSON.stringify([...CONDITION_OPERATORS]));
    published('declaration.schema.json', schema);
  });

  it('messages.ja.json matches the renderer messages', () => {
    published('messages.ja.json', { apiErrors: API_ERRORS, fieldErrors: FIELD_ERRORS, formErrors: FORM_ERRORS });
  });

  it('fixture files match their sources', () => {
    published('fixtures/declarations.json', declarationFixtures.map((f) => ({ warnings: [], ...f })));
    published('fixtures/activity.json', activityFixtures);
    published('fixtures/context.json', contextFixtures);
    published('fixtures/submissions.json', submissionFixtures.map((f) => ({ options: {}, ...f, expected: { files: {}, ...f.expected } })));
  });
});
