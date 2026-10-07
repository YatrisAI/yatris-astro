import { emit, formsSchemaDefs, objectSchema } from '../forms/json-schema.js';
import { OPERATIONS, SETUP } from './registry.js';

/**
 * Emits contracts/reservations/v1/setup.schema.json from the registry. The
 * operations object is `$defs.operations` (a live operations revision has
 * the same shape); questions use the forms node definitions. The validators
 * are authoritative and add the semantic rules a JSON Schema cannot express.
 */

export const SETUP_SCHEMA_ID = 'https://yatris.jp/schemas/reservations/v1/setup.schema.json';

type Json = Record<string, unknown>;

export function setupJsonSchema(): Json {
  const { operations: _operations, ...props } = SETUP.props;
  const setup = objectSchema(props, SETUP.required) as { properties: Json };
  setup.properties.operations = { $ref: '#/$defs/operations' };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: SETUP_SCHEMA_ID,
    title: 'Yatris reservation setup declaration (contract v1)',
    description:
      'Generated from the @yatris/astro reservations registry; do not edit. Semantic rules (presentation by mode, identity fields, question references, timezone, slot grid, unique keys, hours, resource references and kinds, mode sections) are enforced by the Yatris validators, not by this schema.',
    ...setup,
    $defs: {
      operations: emit({ kind: 'object', props: OPERATIONS.props, required: OPERATIONS.required }),
      ...formsSchemaDefs(),
    },
  };
}
