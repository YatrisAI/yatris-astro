import { normalize, type FileDescriptor } from '../forms/answers.js';
import { UPLOAD_KINDS, UPLOAD_LIMITS, type UploadKind } from '../forms/registry.js';
import { length, normalizeNewlines } from '../forms/text.js';
import type { FormNode } from '../forms/tree.js';
import { h, toggleToken, type Attrs } from './dom.js';
import type { ClassSlot } from './types.js';
import { acceptAttribute, displayValue, formatBytes, kindLabels, UI } from './ui.js';

/**
 * One rendered node. Inputs read and reset their raw answer; every view can
 * be shown or hidden as its activity changes. All text is set through text
 * nodes, never markup.
 */
export interface View {
  node: FormNode;
  /** The element shown or hidden with the node's activity; null for `hidden` inputs. */
  el: HTMLElement | null;
  input: boolean;
  /** The raw answer as the contract's `answers` object holds it; undefined when there is none. */
  read(): unknown;
  /** Attached files, in attach order (file fields only). */
  files(): File[];
  /** Empties the control and detaches files. */
  clear(): void;
  /** Puts back a previous answer after a definition change; false when part of it no longer fits. */
  restore(raw: unknown, files: File[]): boolean;
  setError(message: string | null): void;
  setRequired(required: boolean): void;
  focusTarget(): HTMLElement | null;
  /** Reflections: redraws from the current answers. */
  refresh?(valueOf: (key: string) => string): void;
}

export interface FieldEnv {
  id(key: string): string;
  cls(slot: ClassSlot | null, base: string): string;
  hidden: Record<string, string>;
  changed(key: string): void;
  blurred(key: string): void;
  random(): number;
}

const INPUT_TYPES: Record<string, string> = {
  text: 'text',
  email: 'email',
  tel: 'tel',
  url: 'url',
  number: 'number',
  date: 'date',
  time: 'time',
  datetime: 'datetime-local',
  quiz: 'text',
};

/** Builds views for `nodes` in document (pre-) order, appending their elements to `parent`. */
export function buildViews(nodes: FormNode[], env: FieldEnv, parent: HTMLElement, out: View[] = []): View[] {
  for (const node of nodes) {
    const view = buildView(node, env, out);
    if (view.el) parent.append(view.el);
  }
  return out;
}

function buildView(node: FormNode, env: FieldEnv, out: View[]): View {
  let view: View;
  switch (node.type) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'tel':
    case 'url':
    case 'number':
    case 'date':
    case 'time':
    case 'datetime':
      view = textView(node, env);
      break;
    case 'quiz':
      view = quizView(node, env);
      break;
    case 'range':
      view = rangeView(node, env);
      break;
    case 'select':
    case 'multiselect':
      view = selectView(node, env);
      break;
    case 'radio':
    case 'checkboxes':
      view = choicesView(node, env);
      break;
    case 'checkbox':
    case 'acceptance':
      view = booleanView(node, env);
      break;
    case 'file':
      view = fileView(node, env);
      break;
    case 'hidden':
      view = hiddenView(node, env);
      break;
    case 'group': {
      // Push the group before its children so `out` stays in document order.
      const el = node.label
        ? h('fieldset', { class: 'yf-group', 'data-yf-field': node.key, 'data-yf-type': 'group' }, h('legend', { class: 'yf-legend' }, node.label))
        : h('div', { class: 'yf-group', role: 'group', 'data-yf-field': node.key, 'data-yf-type': 'group' });
      view = displayView(node, el);
      out.push(view);
      buildViews(node.fields as FormNode[], env, el, out);
      return view;
    }
    case 'heading': {
      const level = Math.min(4, Math.max(2, Number(node.level ?? 2)));
      view = displayView(node, h(`h${level}` as 'h2', { class: 'yf-heading', 'data-yf-field': node.key, 'data-yf-type': 'heading' }, node.text));
      break;
    }
    case 'help':
      view = displayView(node, h('p', { class: 'yf-help-text', 'data-yf-field': node.key, 'data-yf-type': 'help' }, node.text));
      break;
    case 'divider':
      view = displayView(node, h('hr', { class: 'yf-divider', 'data-yf-field': node.key, 'data-yf-type': 'divider' }));
      break;
    case 'reflection':
      view = reflectionView(node);
      break;
    default:
      // Unreachable: definitions with unknown types are refused before rendering.
      throw new Error(`unsupported node type ${String(node.type)}`);
  }
  out.push(view);
  return view;
}

interface Shell {
  id: string;
  el: HTMLElement;
  marker: HTMLElement;
  error: HTMLElement;
  /** Ids describing the control (help and similar), without the error. */
  describedBy: string[];
}

/** Wrapper, label (or legend), help and error slot shared by labelled inputs. */
function shell(node: FormNode, env: FieldEnv, group = false): Shell {
  const id = env.id(node.key);
  const el = h(group ? 'fieldset' : 'div', {
    class: env.cls('field', group ? 'yf-field yf-choice-group' : 'yf-field'),
    'data-yf-field': node.key,
    'data-yf-type': node.type,
  });
  const marker = h('span', { class: 'yf-required', hidden: true }, UI.required);
  el.append(
    group
      ? h('legend', { class: env.cls('label', 'yf-label'), id: `${id}-label` }, node.label, ' ', marker)
      : h('label', { class: env.cls('label', 'yf-label'), for: id, id: `${id}-label` }, node.label, ' ', marker),
  );
  const describedBy: string[] = [];
  if (node.help) {
    el.append(h('p', { class: env.cls('help', 'yf-help'), id: `${id}-help` }, node.help));
    describedBy.push(`${id}-help`);
  }
  const error = h('p', { class: env.cls('error', 'yf-error'), id: `${id}-error`, hidden: true });
  el.append(error);
  return { id, el, marker, error, describedBy };
}

/** Error and required-state handling for a set of controls. */
function feedback(s: Shell, controls: () => HTMLElement[], describe: HTMLElement[], requiredAttr = true) {
  for (const target of describe) if (s.describedBy.length) target.setAttribute('aria-describedby', s.describedBy.join(' '));
  return {
    setError(message: string | null) {
      s.error.textContent = message ?? '';
      s.error.hidden = !message;
      if (message) s.el.setAttribute('data-yf-state', 'invalid');
      else s.el.removeAttribute('data-yf-state');
      for (const c of controls()) {
        if (message) c.setAttribute('aria-invalid', 'true');
        else c.removeAttribute('aria-invalid');
      }
      for (const target of describe) toggleToken(target, 'aria-describedby', s.error.id, Boolean(message));
    },
    setRequired(required: boolean) {
      s.marker.hidden = !required;
      if (!requiredAttr) return;
      for (const c of controls()) {
        if (required) c.setAttribute('aria-required', 'true');
        else c.removeAttribute('aria-required');
      }
    },
  };
}

function textView(node: FormNode, env: FieldEnv): View {
  const s = shell(node, env);
  const v = (node.validation ?? {}) as Record<string, any>;
  const multiline = node.type === 'textarea';
  const common: Attrs = { class: env.cls('input', 'yf-input'), id: s.id, name: node.key, placeholder: node.placeholder, autocomplete: node.autocomplete };
  let control: HTMLInputElement | HTMLTextAreaElement;
  if (multiline) {
    control = h('textarea', { ...common, rows: node.rows });
  } else {
    const attrs: Attrs = { ...common, type: INPUT_TYPES[node.type] };
    if (node.type === 'text' && v.format === 'digits') attrs.inputmode = 'numeric';
    if (node.type === 'number' || node.type === 'date' || node.type === 'time' || node.type === 'datetime') {
      attrs.min = v.min;
      attrs.max = v.max;
      attrs.step = v.step ?? (node.type === 'number' ? 'any' : undefined);
    }
    control = h('input', attrs);
  }
  if (typeof node.default === 'string' || typeof node.default === 'number') control.value = String(node.default);

  let counter: HTMLElement | null = null;
  const updateCounter = () => {
    if (!counter) return;
    const used = length(normalizeNewlines(control.value));
    const max = typeof v.maxLength === 'number' ? v.maxLength : undefined;
    counter.textContent = node.characterCount === 'remaining' && max !== undefined ? UI.charactersRemaining(max - used) : UI.charactersUsed(used, max);
  };
  if (node.characterCount) {
    counter = h('p', { class: 'yf-counter', id: `${s.id}-counter` });
    s.describedBy.push(counter.id);
  }
  s.el.append(control);
  if (counter) s.el.append(counter);
  updateCounter();

  const fb = feedback(s, () => [control], [control]);
  control.addEventListener('input', () => {
    updateCounter();
    env.changed(node.key);
  });
  control.addEventListener('blur', () => {
    // Kana presets and formats show their normalized form once the visitor leaves the field.
    if (node.type === 'text' && (node.preset || v.format) && control.value !== '') {
      const n = normalize(node, control.value);
      if (!n.error && typeof n.value === 'string' && n.value !== '' && n.value !== control.value) {
        control.value = n.value;
        updateCounter();
        env.changed(node.key);
      }
    }
    env.blurred(node.key);
  });

  return {
    node,
    el: s.el,
    input: true,
    read() {
      // A number input that holds text the browser cannot parse reports "", which would read as empty.
      if (node.type === 'number' && (control as HTMLInputElement).validity?.badInput) return 'invalid';
      return control.value === '' ? undefined : control.value;
    },
    files: () => [],
    clear() {
      control.value = '';
      updateCounter();
    },
    restore(raw) {
      if (typeof raw !== 'string') return raw === undefined;
      control.value = raw;
      updateCounter();
      return true;
    },
    ...fb,
    focusTarget: () => control,
  };
}

function quizView(node: FormNode, env: FieldEnv): View {
  const s = shell(node, env);
  const questions = (node.questions ?? []) as { id: string; question: string }[];
  const question = questions[Math.min(questions.length - 1, Math.floor(env.random() * questions.length))]!;
  const text = h('p', { class: 'yf-quiz-question', id: `${s.id}-question` }, question.question);
  s.describedBy.unshift(text.id);
  const control = h('input', { class: env.cls('input', 'yf-input'), id: s.id, name: node.key, type: 'text', autocomplete: 'off' });
  s.el.insertBefore(text, s.el.children[1] ?? null);
  s.el.append(control);
  const fb = feedback(s, () => [control], [control]);
  control.addEventListener('input', () => env.changed(node.key));
  control.addEventListener('blur', () => env.blurred(node.key));
  return {
    node,
    el: s.el,
    input: true,
    read: () => (control.value === '' ? undefined : { questionId: question.id, answer: control.value }),
    files: () => [],
    clear() {
      control.value = '';
    },
    restore: () => false,
    ...fb,
    focusTarget: () => control,
  };
}

function rangeView(node: FormNode, env: FieldEnv): View {
  const s = shell(node, env);
  const v = (node.validation ?? {}) as Record<string, any>;
  const hasDefault = node.default !== undefined;
  const initial = String(node.default ?? v.min);
  const control = h('input', { class: env.cls('input', 'yf-input yf-range'), id: s.id, name: node.key, type: 'range', min: v.min, max: v.max, step: v.step });
  control.value = initial;
  // Without a default, an untouched slider has no answer: it only sits at its minimum.
  let touched = false;
  const output = node.showValue ? h('output', { class: 'yf-range-value', for: s.id, id: `${s.id}-value` }) : null;
  const show = () => {
    if (output) output.textContent = touched || hasDefault ? control.value : UI.rangeUnset;
  };
  s.el.append(control);
  if (output) s.el.append(output);
  show();
  const fb = feedback(s, () => [control], [control]);
  control.addEventListener('input', () => {
    touched = true;
    show();
    env.changed(node.key);
  });
  control.addEventListener('blur', () => env.blurred(node.key));
  return {
    node,
    el: s.el,
    input: true,
    read: () => (touched || hasDefault ? control.value : undefined),
    files: () => [],
    clear() {
      touched = false;
      control.value = initial;
      show();
    },
    restore(raw) {
      if (raw === undefined) return true;
      control.value = String(raw);
      touched = true;
      show();
      return control.value === String(raw);
    },
    ...fb,
    focusTarget: () => control,
  };
}

function selectView(node: FormNode, env: FieldEnv): View {
  const s = shell(node, env);
  const multiple = node.type === 'multiselect';
  const options = node.options as { value: string; label: string }[];
  const control = h('select', { class: env.cls('input', 'yf-input yf-select'), id: s.id, name: node.key, multiple, size: multiple ? Math.min(options.length, 8) : undefined });
  // The prompt is never an answer: it is the empty value.
  if (!multiple) control.append(h('option', { value: '' }, node.prompt ?? UI.selectPrompt));
  for (const o of options) control.append(h('option', { value: o.value }, o.label));
  const set = (values: string[]) => {
    for (const option of Array.from(control.options)) option.selected = option.value !== '' && values.includes(option.value);
    if (!multiple && values.length === 0) control.value = '';
  };
  const initial = multiple ? (Array.isArray(node.default) ? node.default : []) : typeof node.default === 'string' ? [node.default] : [];
  set(initial);
  s.el.append(control);
  const fb = feedback(s, () => [control], [control]);
  control.addEventListener('change', () => env.changed(node.key));
  control.addEventListener('blur', () => env.blurred(node.key));
  const values = () => Array.from(control.options).filter((o) => o.selected && o.value !== '').map((o) => o.value);
  return {
    node,
    el: s.el,
    input: true,
    read() {
      if (multiple) return values();
      return control.value === '' ? undefined : control.value;
    },
    files: () => [],
    clear: () => set([]),
    restore(raw) {
      const wanted = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const kept = wanted.filter((x) => options.some((o) => o.value === x));
      set(kept);
      return kept.length === wanted.length;
    },
    ...fb,
    focusTarget: () => control,
  };
}

function choicesView(node: FormNode, env: FieldEnv): View {
  const s = shell(node, env, true);
  const radio = node.type === 'radio';
  const options = node.options as { value: string; label: string }[];
  const list = h('div', { class: 'yf-choices' });
  const inputs = options.map((o, i) => {
    const input = h('input', { class: env.cls('input', 'yf-choice-input'), id: `${s.id}-${i}`, type: radio ? 'radio' : 'checkbox', name: radio ? s.id : node.key, value: o.value });
    list.append(h('label', { class: env.cls('choice', 'yf-choice') }, input, h('span', { class: 'yf-choice-label' }, o.label)));
    input.addEventListener('change', () => env.changed(node.key));
    input.addEventListener('blur', () => env.blurred(node.key));
    return input;
  });
  const set = (values: string[]) => inputs.forEach((input) => (input.checked = values.includes(input.value)));
  set(radio ? (typeof node.default === 'string' ? [node.default] : []) : Array.isArray(node.default) ? node.default : []);
  s.el.append(list);
  // The fieldset carries the description; each control carries its own state.
  const fb = feedback(s, () => inputs, [s.el], false);
  const checked = () => inputs.filter((i) => i.checked).map((i) => i.value);
  return {
    node,
    el: s.el,
    input: true,
    read() {
      if (radio) return checked()[0];
      return checked();
    },
    files: () => [],
    clear: () => set([]),
    restore(raw) {
      const wanted = raw === undefined ? [] : Array.isArray(raw) ? raw.map(String) : [String(raw)];
      const kept = wanted.filter((x) => options.some((o) => o.value === x));
      set(kept);
      return kept.length === wanted.length;
    },
    ...fb,
    focusTarget: () => inputs.find((i) => i.checked) ?? inputs[0] ?? null,
  };
}

function booleanView(node: FormNode, env: FieldEnv): View {
  const id = env.id(node.key);
  const acceptance = node.type === 'acceptance';
  const el = h('div', { class: env.cls('field', acceptance ? 'yf-field yf-acceptance' : 'yf-field'), 'data-yf-field': node.key, 'data-yf-type': node.type });
  const marker = h('span', { class: 'yf-required', hidden: true }, UI.required);
  const control = h('input', { class: env.cls('input', 'yf-choice-input'), id, name: node.key, type: 'checkbox' });
  control.checked = node.default === true && !acceptance;
  const describedBy: string[] = [];
  if (acceptance) {
    el.append(h('p', { class: 'yf-consent', id: `${id}-consent` }, node.consentText));
    describedBy.push(`${id}-consent`);
  }
  el.append(h('label', { class: env.cls('choice', 'yf-choice'), for: id, id: `${id}-label` }, control, h('span', { class: 'yf-choice-label' }, node.label), ' ', marker));
  if (acceptance && typeof node.privacyPolicyPath === 'string' && isSafePath(node.privacyPolicyPath)) {
    el.append(h('p', { class: 'yf-policy' }, h('a', { href: node.privacyPolicyPath, target: '_blank', rel: 'noopener' }, UI.policyLink)));
  }
  if (node.help) {
    el.append(h('p', { class: env.cls('help', 'yf-help'), id: `${id}-help` }, node.help));
    describedBy.push(`${id}-help`);
  }
  const error = h('p', { class: env.cls('error', 'yf-error'), id: `${id}-error`, hidden: true });
  el.append(error);
  const fb = feedback({ id, el, marker, error, describedBy }, () => [control], [control]);
  control.addEventListener('change', () => env.changed(node.key));
  control.addEventListener('blur', () => env.blurred(node.key));
  return {
    node,
    el,
    input: true,
    read: () => control.checked,
    files: () => [],
    clear() {
      control.checked = false;
    },
    restore(raw) {
      control.checked = raw === true;
      return true;
    },
    ...fb,
    focusTarget: () => control,
  };
}

function fileView(node: FormNode, env: FieldEnv): View {
  const s = shell(node, env);
  s.el.classList.add('yf-file');
  const v = (node.validation ?? {}) as Record<string, any>;
  const kinds = (v.accept ?? Object.keys(UPLOAD_KINDS)) as UploadKind[];
  const maxFiles = Number(v.maxFiles ?? 1);
  const maxSize = Number(v.maxFileSize ?? UPLOAD_LIMITS.maxFileSize);
  const limits = h('p', { class: env.cls('help', 'yf-help yf-file-limits'), id: `${s.id}-limits` }, UI.fileLimits(kindLabels(kinds), formatBytes(maxSize), maxFiles));
  s.describedBy.push(limits.id);
  const control = h('input', { class: env.cls('input', 'yf-input yf-file-input'), id: s.id, name: node.key, type: 'file', accept: acceptAttribute(kinds), multiple: maxFiles > 1 });
  const list = h('ul', { class: 'yf-file-list', 'aria-live': 'polite' });
  let files: File[] = [];

  const draw = () => {
    list.replaceChildren(
      ...files.map((file, index) => {
        const remove = h('button', { type: 'button', class: 'yf-file-remove', 'aria-label': UI.fileRemoveLabel(file.name) }, UI.fileRemove);
        remove.addEventListener('click', () => {
          files = files.filter((_, i) => i !== index);
          draw();
          const buttons = list.querySelectorAll<HTMLButtonElement>('.yf-file-remove');
          (buttons[Math.min(index, buttons.length - 1)] ?? control).focus();
          env.changed(node.key);
        });
        return h('li', { class: 'yf-file-item' }, h('span', { class: 'yf-file-name' }, file.name), ' ', h('span', { class: 'yf-file-size' }, `（${formatBytes(file.size)}）`), ' ', remove);
      }),
    );
    s.el.toggleAttribute('data-yf-has-files', files.length > 0);
  };

  control.addEventListener('change', () => {
    const picked = Array.from(control.files ?? []);
    // Several-file fields add to the list, so a visitor can attach from different folders.
    files = maxFiles > 1 ? [...files, ...picked] : picked.slice(0, 1);
    control.value = '';
    draw();
    env.changed(node.key);
    // Choosing files is deliberate: say at once when one is too large, of the wrong type or too many.
    env.blurred(node.key);
  });

  s.el.insertBefore(limits, s.error);
  s.el.append(control, list);
  const fb = feedback(s, () => [control], [control]);
  return {
    node,
    el: s.el,
    input: true,
    read: () => undefined,
    files: () => files,
    clear() {
      files = [];
      control.value = '';
      draw();
    },
    restore(_raw, previous) {
      files = [...previous];
      draw();
      return true;
    },
    ...fb,
    focusTarget: () => control,
  };
}

/**
 * Declared metadata. Its value comes from `<YatrisForm hidden={…}>` or the
 * declared default. It stays across activity changes (there is no visitor
 * input to clear) but is only sent while the field is active.
 */
function hiddenView(node: FormNode, env: FieldEnv): View {
  const value = Object.hasOwn(env.hidden, node.key) ? env.hidden[node.key]! : typeof node.default === 'string' ? node.default : '';
  return {
    node,
    el: null,
    input: true,
    read: () => (value === '' ? undefined : value),
    files: () => [],
    clear() {},
    restore: () => true,
    setError() {},
    setRequired() {},
    focusTarget: () => null,
  };
}

function displayView(node: FormNode, el: HTMLElement): View {
  return {
    node,
    el,
    input: false,
    read: () => undefined,
    files: () => [],
    clear() {},
    restore: () => true,
    setError() {},
    setRequired() {},
    focusTarget: () => null,
  };
}

function reflectionView(node: FormNode): View {
  const value = h('p', { class: 'yf-reflection-value' });
  const el = h('div', { class: 'yf-reflection', 'data-yf-field': node.key, 'data-yf-type': 'reflection' }, node.label ? h('p', { class: 'yf-reflection-label' }, node.label) : null, value);
  return {
    ...displayView(node, el),
    refresh(valueOf) {
      value.textContent = valueOf(node.source) || UI.empty;
    },
  };
}

/** A same-site path: one leading slash, no scheme, no backslash, no control characters. */
export function isSafePath(path: string): boolean {
  return /^\/(?![/\\])[A-Za-z0-9\-._~!$&'()*+,;=:@%/?#]*$/.test(path);
}

export function describeFile(file: File): FileDescriptor {
  return { name: file.name, size: file.size, type: file.type };
}

export { displayValue };
