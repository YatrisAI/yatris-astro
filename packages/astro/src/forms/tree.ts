import { nodeType, type NodeTypeName } from './registry.js';
import { pointer } from './spec.js';

/** A declaration node. Shapes are checked by the validator, not the type system. */
export type FormNode = { key: string; type: NodeTypeName } & Record<string, any>;

export interface FormDeclaration {
  contractVersion: 1;
  key: string;
  name: string;
  locale: 'ja' | 'en';
  fields: FormNode[];
  [property: string]: any;
}

export interface Entry {
  node: FormNode;
  /** JSON Pointer of the node within the declaration. */
  path: string;
  /** Enclosing group keys, outermost first. */
  groups: string[];
  /** Pre-order position; the "document order" the contract refers to. */
  order: number;
}

/** Every node in document (pre-) order, with its enclosing groups. */
export function flatten(fields: FormNode[]): Entry[] {
  const out: Entry[] = [];
  const walk = (nodes: FormNode[], path: string, groups: string[]) => {
    nodes.forEach((node, i) => {
      const at = pointer(path, i);
      out.push({ node, path: at, groups, order: out.length });
      if (node.type === 'group' && Array.isArray(node.fields)) walk(node.fields, pointer(at, 'fields'), [...groups, node.key]);
    });
  };
  walk(fields, '/fields', []);
  return out;
}

export function isInput(node: FormNode): boolean {
  return nodeType(node.type)?.category === 'input';
}

export function answerKind(node: FormNode) {
  return nodeType(node.type)?.answer;
}
