import { toDecimal } from './decimal.js';
import { canonicalJson, sha256Hex } from './hash.js';
import { CONTRACT_VERSION, DECLARATION, nodeType, UPLOAD_LIMITS } from './registry.js';
import type { PropSpec } from './spec.js';
import { flatten, type FormDeclaration, type FormNode } from './tree.js';

/**
 * The public definition: what a renderer needs to draw and submit a form,
 * and nothing else (spec §5.2). Built by an explicit allowlist: registry
 * properties only, minus mail, SMTP and quiz answers. Yatris serves the PHP
 * twin of this projection; local preview builds it from the declaration.
 */

export const HONEYPOT_FIELD = 'hp_website';

export interface PublicDefinitionMeta {
  publicKey: string;
  version: number;
  endpoint: string;
  turnstile: { siteKey: string; action: string } | null;
}

export interface PublicDefinition {
  contractVersion: 1;
  form: { key: string; publicKey: string; name: string; locale: string; version: number; digest: string };
  capabilities: string[];
  fields: FormNode[];
  confirmStep?: Record<string, unknown>;
  submit: Record<string, unknown>;
  success: Record<string, unknown>;
  submission: {
    endpoint: string;
    turnstile: { siteKey: string; action: string } | null;
    honeypotField: string;
    uploads: { maxFiles: number; maxTotalBytes: number };
  };
}

/** The public body the digest covers, before meta is attached. */
export function publicContent(declaration: FormDeclaration) {
  const project = (key: string) => (declaration[key] === undefined ? undefined : projectValue(DECLARATION.props[key]!, declaration[key]));
  return {
    key: declaration.key,
    name: declaration.name,
    locale: declaration.locale,
    fields: declaration.fields.map(projectNode),
    confirmStep: project('confirmStep') as Record<string, unknown> | undefined,
    submit: project('submit') as Record<string, unknown>,
    success: project('success') as Record<string, unknown>,
    uploads: { ...UPLOAD_LIMITS, ...(declaration.uploads ?? {}) } as { maxFiles: number; maxTotalBytes: number },
  };
}

/** "sha256:<hex>" of the canonical JSON of the public content. */
export async function definitionDigest(declaration: FormDeclaration): Promise<string> {
  return `sha256:${await sha256Hex(canonicalJson(publicContent(declaration)))}`;
}

export async function toPublicDefinition(declaration: FormDeclaration, meta: PublicDefinitionMeta): Promise<PublicDefinition> {
  const content = publicContent(declaration);
  return {
    contractVersion: CONTRACT_VERSION,
    form: {
      key: content.key,
      publicKey: meta.publicKey,
      name: content.name,
      locale: content.locale,
      version: meta.version,
      digest: await definitionDigest(declaration),
    },
    capabilities: requiredCapabilities(declaration),
    fields: content.fields,
    ...(content.confirmStep ? { confirmStep: content.confirmStep } : {}),
    submit: content.submit,
    success: content.success,
    submission: { endpoint: meta.endpoint, turnstile: meta.turnstile, honeypotField: HONEYPOT_FIELD, uploads: content.uploads },
  };
}

/**
 * Renderer capabilities a definition needs. A renderer that lacks any of
 * them shows an unavailable state instead of a partial form.
 */
export function requiredCapabilities(declaration: FormDeclaration): string[] {
  const caps = new Set<string>();
  for (const { node } of flatten(declaration.fields)) {
    caps.add(`${nodeType(node.type)!.category === 'input' ? 'field' : 'display'}:${node.type}`);
    if (node.visibleWhen !== undefined || node.requiredWhen !== undefined) caps.add('conditions');
    if (node.type === 'file') caps.add('uploads');
    if (node.preset !== undefined) caps.add(`preset:${node.preset}`);
  }
  if (declaration.confirmStep?.enabled) caps.add('confirm_step');
  return [...caps].sort();
}

function projectNode(node: FormNode): FormNode {
  const type = nodeType(node.type)!;
  const out = projectValue({ kind: 'object', props: type.props }, node) as FormNode;
  if (node.type === 'quiz') {
    out.questions = (node.questions as { id: string; question: string }[]).map(({ id, question }) => ({ id, question }));
  }
  return out;
}

function projectValue(spec: PropSpec, value: unknown): unknown {
  switch (spec.kind) {
    case 'decimal':
      return toDecimal(value);
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (spec.props[key]) out[key] = projectValue(spec.props[key]!, item);
      }
      return out;
    }
    case 'array':
      return (value as unknown[]).map((item) => projectValue(spec.items, item));
    case 'nodes':
      return (value as FormNode[]).map(projectNode);
    default:
      return value;
  }
}
