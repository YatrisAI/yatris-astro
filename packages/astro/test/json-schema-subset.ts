/**
 * A minimal JSON Schema (2020-12) evaluator for exactly the keywords the
 * skill brief schemas use (yatris-contact-form, yatris-reservation). Any
 * other keyword throws, so a schema cannot quietly rely on something these
 * tests do not check. Returns `<pointer>: <keyword>` strings; property-name
 * failures are `<pointer>#name: <keyword>`.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type Schema = Record<string, Json> | boolean;

const SUPPORTED = [
  '$schema',
  'title',
  'description',
  '$defs',
  '$ref',
  'type',
  'const',
  'enum',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'items',
  'contains',
  'uniqueItems',
  'required',
  'properties',
  'additionalProperties',
  'propertyNames',
  'allOf',
  'anyOf',
  'not',
  'if',
  'then',
  'else',
];

export function schemaErrors(schema: Schema, value: Json, root: Record<string, Json>, path = ''): string[] {
  if (schema === true) return [];
  if (schema === false) return [`${path}: false`];
  for (const keyword of Object.keys(schema)) if (!SUPPORTED.includes(keyword)) throw new Error(`unsupported keyword ${keyword}`);
  const errors: string[] = [];
  const same = (a: Json, b: Json) => JSON.stringify(a) === JSON.stringify(b);
  const isObject = (v: Json): v is { [key: string]: Json } => typeof v === 'object' && v !== null && !Array.isArray(v);
  const passes = (sub: Json) => schemaErrors(sub as Schema, value, root, path).length === 0;

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
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${path}: minimum`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${path}: maximum`);
  }
  if (Array.isArray(value)) {
    if (schema.items !== undefined) value.forEach((item, i) => errors.push(...schemaErrors(schema.items as Schema, item, root, `${path}/${i}`)));
    if (schema.contains !== undefined && !value.some((item, i) => schemaErrors(schema.contains as Schema, item, root, `${path}/${i}`).length === 0)) errors.push(`${path}: contains`);
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
  if (Array.isArray(schema.allOf)) for (const sub of schema.allOf) errors.push(...schemaErrors(sub as Schema, value, root, path));
  if (Array.isArray(schema.anyOf) && !schema.anyOf.some(passes)) errors.push(`${path}: anyOf`);
  if (schema.not !== undefined && passes(schema.not)) errors.push(`${path}: not`);
  if (schema.if !== undefined) {
    const branch = passes(schema.if) ? schema.then : schema.else;
    if (branch !== undefined) errors.push(...schemaErrors(branch as Schema, value, root, path));
  }
  return [...new Set(errors)];
}
