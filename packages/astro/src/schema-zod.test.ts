import { describe, expect, it } from 'vitest';
import { generateZodModule } from './schema-zod.js';

/** A canonical schema as Yatris serialises it: keys sorted, guidance left out. */
const canonical = JSON.stringify({
  content_types: [
    {
      fields: [
        { key: 'title', required: true, type: 'text' },
        {
          fields: [
            { key: 'question', required: true, type: 'text' },
            { key: 'answer', required: true, type: 'rich_text' },
            { key: 'service', required: false, type: 'reference', validations: { referenced_type: 'services' } },
          ],
          key: 'faqs',
          required: false,
          type: 'repeater',
          validations: { max_items: 3, min_items: 1 },
        },
        {
          fields: [
            { key: 'heading', required: true, type: 'text' },
            { key: 'photo', type: 'image' },
          ],
          key: 'steps',
          required: true,
          type: 'repeater',
          validations: { min_items: 2 },
        },
        { fields: [{ key: 'label', required: true, type: 'text' }], key: 'tags', type: 'repeater' },
        { key: 'tone', required: false, type: 'select', validations: { allowed_values: ['casual', 'formal'] } },
        { key: 'price', required: true, type: 'number' },
      ],
      schema_version: 3,
      slug: 'service-pages',
      status: 'active',
      structure: 'list',
    },
    { fields: [{ key: 'title', required: true, type: 'text' }], schema_version: 1, slug: '2026-news', status: 'active', structure: 'list' },
  ],
  contract: 1,
  website_id: 7,
});

/** Runs the module against a stand-in `z` that accepts any call, proving it is valid code. */
function evaluate(source: string): Record<string, unknown> {
  const anything: unknown = new Proxy(function () {}, { get: () => anything, apply: () => anything });
  const js = source
    .replace(/^import .*$/m, '')
    .replace(/^export /gm, '')
    .replace(/ as const/g, '');
  return new Function('z', `${js}\nreturn yatrisSchemas;`)(anything) as Record<string, unknown>;
}

describe('zod schemas from the canonical schema (YatrisCMS#307)', () => {
  const source = generateZodModule(canonical, 'schema_01abc');

  it('describes a repeater as a list of objects of its sub-fields, with its bounds', () => {
    expect(source).toContain(
      [
        '  "faqs": z.array(z.object({',
        '    "question": z.string(),',
        '    "answer": z.string(),',
        '    "service": yatrisReference.nullish(),',
        '  })).max(3).refine((items) => items.length === 0 || items.length >= 1, { message: "must contain at least 1 items" }).nullish(),',
      ].join('\n'),
    );
    // A required repeater holds its minimum outright
    expect(source).toContain('    "photo": yatrisImage.nullish(),\n  })).min(2),');
    // A list of strings is a repeater with one text field
    expect(source).toContain('  "tags": z.array(z.object({\n    "label": z.string(),\n  })).nullish(),');
  });

  it('maps the other field types and names every Content Type', () => {
    expect(source).toContain("import { z } from 'astro/zod';");
    expect(source).toContain('export const schemaRevision = "schema_01abc" as const;');
    expect(source).toContain('/** Content Type "service-pages" (list, schema v3). */\nexport const servicePagesSchema = z.object({\n  "title": z.string(),');
    expect(source).toContain('  "tone": z.enum(["casual", "formal"]).nullish(),');
    expect(source).toContain('  "price": z.number(),');
    // A slug starting with a digit still makes an identifier
    expect(source).toContain('export const type2026NewsSchema = z.object({');
    expect(source).toContain('export const yatrisSchemas = {\n  "service-pages": servicePagesSchema,\n  "2026-news": type2026NewsSchema,\n} as const;');
  });

  it('is valid code that exports every schema', () => {
    expect(Object.keys(evaluate(source))).toEqual(['service-pages', '2026-news']);
  });

  it('is the same bytes for the same revision, and empty when there are no types', () => {
    expect(generateZodModule(canonical, 'schema_01abc')).toBe(source);

    const empty = generateZodModule('{"content_types":[],"contract":1,"website_id":7}', 'schema_01abc');
    expect(empty).toContain('export const yatrisSchemas = {\n} as const;');
    expect(evaluate(empty)).toEqual({});
  });
});
