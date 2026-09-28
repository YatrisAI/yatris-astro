import { describe, expect, it } from 'vitest';
import { sha256 } from './schema.js';
import { generateZodModule, ZOD_GENERATOR } from './schema-zod.js';

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

describe('image variants and generator versions (YatrisCMS#329)', () => {
  it('declares the resized variants Delivery serves, so zod keeps them', () => {
    const source = generateZodModule(canonical, 'schema_01abc');

    expect(ZOD_GENERATOR).toBe(2);
    expect(source).toContain(
      'export const yatrisImageVariant = z.object({ width: z.number(), height: z.number(), url: z.string(), webp_url: z.string().nullable() });',
    );
    expect(source).toContain('mime: z.string(), variants: z.array(yatrisImageVariant).optional() }),');
    // The variant schema is declared before the image schema that uses it
    expect(source.indexOf('const yatrisImageVariant')).toBeLessThan(source.indexOf('const yatrisImage ='));
    expect(Object.keys(evaluate(source))).toEqual(['service-pages', '2026-news']);
  });

  it('still writes version 1 byte for byte, as @yatris/astro 0.3.0 did, for the locks that pinned it', () => {
    const v1 = generateZodModule(canonical, 'schema_01abc', 1);

    // The hash of 0.3.0's output for this fixture, computed with its generator
    expect(sha256(v1)).toBe('sha256:8f0b308eaaa2b0c9e9c80c591c291c6148fc0e816c668240b9f910987fd93b0e');
    expect(v1).not.toContain('variants');
    expect(() => generateZodModule(canonical, 'schema_01abc', 3)).toThrow('Unknown zod generator version 3');
  });

  it('parses a Delivery image with its variants intact', () => {
    // No Content Types: the module is then only the shared schemas the stand-in `z` covers
    const noTypes = '{"content_types":[],"contract":1,"website_id":7}';
    const image = {
      asset_id: 12,
      url: 'https://media.example/2/public/abc.jpg',
      webp_url: 'https://media.example/2/public/abc-w1600.webp',
      alt: '施工例',
      width: 2400,
      height: 1600,
      mime: 'image/jpeg',
      variants: [
        { width: 480, height: 320, url: 'https://media.example/2/public/abc-w480.jpg', webp_url: 'https://media.example/2/public/abc-w480.webp' },
        { width: 960, height: 640, url: 'https://media.example/2/public/abc-w960.jpg', webp_url: null },
        { width: 1600, height: 1067, url: 'https://media.example/2/public/abc-w1600.jpg', webp_url: 'https://media.example/2/public/abc-w1600.webp' },
      ],
    };
    const { yatrisImage } = evaluateWith(generateZodModule(noTypes, 'schema_01abc'), stripZ, 'yatrisImage') as { yatrisImage: Parser };
    const { yatrisImage: v1Image } = evaluateWith(generateZodModule(noTypes, 'schema_01abc', 1), stripZ, 'yatrisImage') as { yatrisImage: Parser };

    expect(yatrisImage.parse(image)).toEqual(image);
    // An image without variants, and a legacy URL string, still parse
    const { variants: _, ...plain } = image;
    expect(yatrisImage.parse(plain)).toEqual(plain);
    expect(yatrisImage.parse('/img/legacy.jpg')).toBe('/img/legacy.jpg');
    expect(() => yatrisImage.parse({ ...image, variants: [{ width: 480 }] })).toThrow();
    // Version 1 is what stripped them
    expect(v1Image.parse(image)).toEqual(plain);
  });
});

interface Parser {
  parse(value: unknown): unknown;
}

/** Runs a generated module with the given `z` and returns the named export. */
function evaluateWith(source: string, z: unknown, name: string): Record<string, unknown> {
  const js = source
    .replace(/^import .*$/m, '')
    .replace(/^export /gm, '')
    .replace(/ as const/g, '');
  return new Function('z', `${js}\nreturn { ${name} };`)(z) as Record<string, unknown>;
}

/**
 * A stand-in for the part of zod the image schema uses, with zod's default
 * object behaviour: keys an object does not declare are stripped.
 */
const stripZ = (() => {
  type Schema = Parser & { optional(): Schema; nullable(): Schema; nullish(): Schema };
  const fail = (why: string): never => {
    throw new Error(why);
  };
  const schema = (parse: (value: unknown) => unknown): Schema => ({
    parse,
    optional: () => schema((value) => (value === undefined ? undefined : parse(value))),
    nullable: () => schema((value) => (value === null ? null : parse(value))),
    nullish: () => schema((value) => (value === null || value === undefined ? value : parse(value))),
  });
  const primitive = (type: string) => schema((value) => (typeof value === type ? value : fail(`expected ${type}`)));
  return {
    string: () => primitive('string'),
    number: () => primitive('number'),
    boolean: () => primitive('boolean'),
    array: (item: Schema) => schema((value) => (Array.isArray(value) ? value.map((entry) => item.parse(entry)) : fail('expected an array'))),
    object: (shape: Record<string, Schema>) =>
      schema((value) => {
        if (typeof value !== 'object' || value === null) return fail('expected an object');
        const out: Record<string, unknown> = {};
        for (const [key, member] of Object.entries(shape)) {
          const parsed = member.parse((value as Record<string, unknown>)[key]);
          if (parsed !== undefined) out[key] = parsed;
        }
        return out;
      }),
    union: (options: Schema[]) =>
      schema((value) => {
        for (const option of options) {
          try {
            return option.parse(value);
          } catch {
            // try the next option
          }
        }
        return fail('no union member matched');
      }),
  };
})();
