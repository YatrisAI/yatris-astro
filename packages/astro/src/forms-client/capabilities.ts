/**
 * The capabilities this renderer implements (contract README §6). Written
 * out by hand on purpose: a capability is listed only once the renderer
 * really draws and submits it, so adding a type to the registry does not
 * silently claim support. A definition that needs anything else gets the
 * unavailable state, never a partial form.
 */
export const SUPPORTED_CAPABILITIES: readonly string[] = Object.freeze([
  'field:text',
  'field:textarea',
  'field:email',
  'field:tel',
  'field:url',
  'field:number',
  'field:range',
  'field:date',
  'field:time',
  'field:datetime',
  'field:select',
  'field:multiselect',
  'field:radio',
  'field:checkbox',
  'field:checkboxes',
  'field:acceptance',
  'field:file',
  'field:hidden',
  'field:quiz',
  'display:heading',
  'display:help',
  'display:divider',
  'display:group',
  'display:reflection',
  'conditions',
  'uploads',
  'preset:katakana',
  'preset:hiragana',
  'confirm_step',
]);

/** The contract versions this renderer reads. */
export const SUPPORTED_CONTRACT_VERSIONS: readonly number[] = Object.freeze([1]);

/** Capabilities a definition lists that this renderer lacks (empty when it can render it). */
export function missingCapabilities(required: readonly string[]): string[] {
  const supported = new Set(SUPPORTED_CAPABILITIES);
  return required.filter((c) => !supported.has(c));
}
