/**
 * Yatris contact-form contract v1 (`@yatris/astro/forms`): the declaration
 * registry and validator, condition semantics, answer validation, the public
 * definition projection and the submission wire helpers. Dependency-free and
 * browser-safe; the renderer and the CLI build on it.
 *
 * Reference: contracts/forms/v1/README.md in this package.
 */

export {
  CONTRACT_VERSION,
  DISPLAY_TYPES,
  FORM_KEY_PATTERN,
  INPUT_TYPES,
  NODE_KEY_PATTERN,
  NODE_TYPE_NAMES,
  NODE_TYPES,
  OPERATORS_BY_KIND,
  PLACEHOLDERS,
  UPLOAD_KINDS,
  UPLOAD_LIMITS,
  type AnswerKind,
  type NodeTypeName,
  type UploadKind,
} from './registry.js';
export { validateDeclaration, type DeclarationResult } from './declaration.js';
export { compare, evaluateActivity, isEmptyValue, type Activity, type AnswerValue } from './conditions.js';
export {
  normalizeQuizAnswer,
  uploadKindAllowed,
  validateSubmission,
  type FileDescriptor,
  type QuizAnswer,
  type SubmissionInput,
  type SubmissionResult,
  type ValidationOptions,
} from './answers.js';
export {
  definitionDigest,
  HONEYPOT_FIELD,
  requiredCapabilities,
  toPublicDefinition,
  type PublicDefinition,
  type PublicDefinitionMeta,
} from './public.js';
export { canonicalJson, requestHash, sha256Hex, type HashedFilePart } from './hash.js';
export { API_ERRORS, FIELD_ERRORS, FORM_ERRORS, type ApiErrorCode } from './messages.js';
export { declarationJsonSchema, SCHEMA_ID } from './json-schema.js';
export type { Issue } from './spec.js';
export type { FormDeclaration, FormNode } from './tree.js';
