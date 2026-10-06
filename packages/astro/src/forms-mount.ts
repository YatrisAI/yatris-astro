import type { FormsRuntime } from './forms-config.js';
import { CLASS_SLOTS, type ClassSlot, type MountConfig } from './forms-client/types.js';
import { FORM_KEY_PATTERN, NODE_KEY_PATTERN } from './forms/registry.js';

export type { FormsRuntime } from './forms-config.js';
export type { MountConfig } from './forms-client/types.js';

/**
 * What `<YatrisForm>` renders for one mount (`@yatris/astro/forms/mount`):
 * the configuration written into the page. Server-side only; pure, so the
 * component and the tests share it.
 */

export interface YatrisFormProps {
  /** The form key, e.g. "contact" (the declaration `src/forms/contact.json`). */
  form: string;
  /** Values for declared `hidden` fields, e.g. `{ source: 'lp-a' }`. Undeclared keys are ignored. */
  hidden?: Record<string, string>;
  /** Extra classes per element, e.g. `{ submit: 'btn btn-primary' }`. */
  classes?: Partial<Record<ClassSlot, string>>;
}

export function formMountConfig(runtime: FormsRuntime, props: YatrisFormProps): MountConfig {
  const form = props.form;
  if (typeof form !== 'string' || !new RegExp(FORM_KEY_PATTERN, 'u').test(form)) {
    throw new Error(`<YatrisForm form=${JSON.stringify(form)}>: form must be a form key (${FORM_KEY_PATTERN}), such as "contact".`);
  }
  const base = { form, timeZone: runtime.timeZone, ...checkHidden(form, props.hidden), ...checkClasses(form, props.classes) };
  switch (runtime.mode) {
    case 'live': {
      const publicKey = `${runtime.websiteId}.${form}`;
      return { ...base, mode: 'live', publicKey, definitionUrl: `${runtime.origin}/api/v1/forms/${publicKey}` };
    }
    case 'preview': {
      const entry = runtime.previews[form];
      if (!entry) {
        return { ...base, mode: 'preview', source: `src/forms/${form}.json`, problem: { message: `src/forms/${form}.json がありません。プレビューするフォームの宣言を作成してください。`, issues: [] } };
      }
      return { ...base, mode: 'preview', source: entry.source, ...(entry.definition ? { definition: entry.definition } : {}), ...(entry.problem ? { problem: entry.problem } : {}) };
    }
    default:
      return { ...base, mode: 'unconfigured', reason: runtime.reason };
  }
}

function checkHidden(form: string, hidden: unknown): { hidden?: Record<string, string> } {
  if (hidden === undefined) return {};
  if (!hidden || typeof hidden !== 'object' || Array.isArray(hidden)) throw new Error(`<YatrisForm form="${form}">: hidden must be an object of strings.`);
  const key = new RegExp(NODE_KEY_PATTERN, 'u');
  for (const [name, value] of Object.entries(hidden)) {
    if (!key.test(name)) throw new Error(`<YatrisForm form="${form}">: hidden key ${JSON.stringify(name)} is not a field key.`);
    if (typeof value !== 'string' || [...value].length > 500) throw new Error(`<YatrisForm form="${form}">: hidden.${name} must be a string of at most 500 characters.`);
  }
  return { hidden: { ...(hidden as Record<string, string>) } };
}

function checkClasses(form: string, classes: unknown): { classes?: Partial<Record<ClassSlot, string>> } {
  if (classes === undefined) return {};
  if (!classes || typeof classes !== 'object' || Array.isArray(classes)) throw new Error(`<YatrisForm form="${form}">: classes must be an object.`);
  for (const [slot, value] of Object.entries(classes)) {
    if (!(CLASS_SLOTS as readonly string[]).includes(slot)) throw new Error(`<YatrisForm form="${form}">: classes.${slot} is not one of ${CLASS_SLOTS.join(', ')}.`);
    if (typeof value !== 'string' || value.length > 500) throw new Error(`<YatrisForm form="${form}">: classes.${slot} must be a string.`);
  }
  return { classes: { ...(classes as Partial<Record<ClassSlot, string>>) } };
}

/** JSON safe to place inside `<script type="application/json">`: no `<`, `>`, `&` or line separators. */
export function serializeMountConfig(config: MountConfig): string {
  return JSON.stringify(config)
    .replaceAll('<', '\\u003c')
    .replaceAll('>', '\\u003e')
    .replaceAll('&', '\\u0026')
    .replaceAll(' ', '\\u2028')
    .replaceAll(' ', '\\u2029');
}
