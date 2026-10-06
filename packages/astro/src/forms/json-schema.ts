import { CONDITION_OPERATORS, LINE_PATTERN, MAX_CONDITION_BRANCHES, MAX_CONDITION_LIST, MULTILINE_PATTERN, type PropSpec } from './spec.js';
import { DECIMAL_PATTERN } from './decimal.js';
import { DECLARATION, NODE_TYPE_NAMES, NODE_TYPES, type NodeType } from './registry.js';

/**
 * Emits contracts/forms/v1/declaration.schema.json from the registry. The
 * schema serves editors and agents; the validator in declaration.ts is
 * authoritative and adds the semantic rules a JSON Schema cannot express.
 */

export const SCHEMA_ID = 'https://yatris.jp/schemas/forms/v1/declaration.schema.json';

type Json = Record<string, unknown>;

function emit(spec: PropSpec): Json {
  switch (spec.kind) {
    case 'string': {
      if (spec.enum) return { type: 'string', enum: [...spec.enum] };
      const out: Json = { type: 'string' };
      if (spec.min !== undefined) out.minLength = spec.min;
      if (spec.max !== undefined) out.maxLength = spec.max;
      const patterns = [spec.text === 'line' ? LINE_PATTERN : spec.text === 'multiline' ? MULTILINE_PATTERN : undefined, spec.pattern].filter(
        (p): p is string => p !== undefined,
      );
      if (patterns.length === 1) out.pattern = patterns[0];
      if (patterns.length === 2) out.allOf = patterns.map((pattern) => ({ pattern }));
      return out;
    }
    case 'integer': {
      const out: Json = { type: 'integer' };
      if (spec.min !== undefined) out.minimum = spec.min;
      if (spec.max !== undefined) out.maximum = spec.max;
      return out;
    }
    case 'decimal':
      return { $ref: '#/$defs/decimal' };
    case 'boolean':
      return spec.const === undefined ? { type: 'boolean' } : { const: spec.const };
    case 'array': {
      const out: Json = { type: 'array', items: emit(spec.items) };
      if (spec.min !== undefined) out.minItems = spec.min;
      if (spec.max !== undefined) out.maxItems = spec.max;
      if (spec.unique) out.uniqueItems = true;
      return out;
    }
    case 'object':
      return objectSchema(spec.props, spec.required ?? []);
    case 'condition':
      return { $ref: '#/$defs/condition' };
    case 'nodes': {
      const out: Json = { type: 'array', items: { $ref: '#/$defs/node' } };
      if (spec.min !== undefined) out.minItems = spec.min;
      if (spec.max !== undefined) out.maxItems = spec.max;
      return out;
    }
  }
}

function objectSchema(props: Record<string, PropSpec>, required: readonly string[], extra: Json = {}): Json {
  const properties: Json = {};
  for (const [key, spec] of Object.entries(props)) properties[key] = emit(spec);
  Object.assign(properties, extra);
  return { type: 'object', properties, ...(required.length ? { required: [...required] } : {}), additionalProperties: false };
}

function nodeSchema(name: string, type: NodeType): Json {
  return objectSchema(type.props, type.required, { type: { const: name } });
}

export function declarationJsonSchema(): Json {
  const nodeDefs: Json = {};
  for (const name of NODE_TYPE_NAMES) nodeDefs[`node_${name}`] = nodeSchema(name, NODE_TYPES[name]);
  const scalar = [{ type: 'string', maxLength: 500 }, { type: 'number' }, { type: 'boolean' }];
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SCHEMA_ID,
    title: 'Yatris contact form declaration (contract v1)',
    description:
      'Generated from the @yatris/astro forms registry; do not edit. Semantic rules (unique keys, references, operators, cycles, defaults, mail fields, placeholders) are enforced by the Yatris validators, not by this schema.',
    ...objectSchema(DECLARATION.props, DECLARATION.required),
    $defs: {
      decimal: { oneOf: [{ type: 'number' }, { type: 'string', pattern: DECIMAL_PATTERN }] },
      node: { oneOf: NODE_TYPE_NAMES.map((name) => ({ $ref: `#/$defs/node_${name}` })) },
      ...nodeDefs,
      condition: {
        oneOf: [
          ...(['all', 'any'] as const).map((k) => ({
            type: 'object',
            properties: { [k]: { type: 'array', items: { $ref: '#/$defs/condition' }, minItems: 1, maxItems: MAX_CONDITION_BRANCHES } },
            required: [k],
            additionalProperties: false,
          })),
          { type: 'object', properties: { not: { $ref: '#/$defs/condition' } }, required: ['not'], additionalProperties: false },
          {
            type: 'object',
            properties: {
              field: { type: 'string' },
              operator: { type: 'string', enum: [...CONDITION_OPERATORS] },
              value: {
                oneOf: [
                  ...scalar,
                  { type: 'array', minItems: 1, maxItems: MAX_CONDITION_LIST, items: { oneOf: [{ type: 'string', maxLength: 500 }, { type: 'number' }] } },
                ],
              },
            },
            required: ['field', 'operator'],
            additionalProperties: false,
          },
        ],
      },
    },
  };
}
