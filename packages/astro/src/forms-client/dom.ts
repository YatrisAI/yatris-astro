/**
 * A tiny DOM builder for the renderer. Strings are appended as text nodes, so
 * every label, help text and reflected answer is escaped by construction;
 * nothing here ever assigns `innerHTML`.
 */

export type Attrs = Record<string, string | number | boolean | undefined | null>;
export type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

/** Adds or removes one token of a space-separated attribute such as aria-describedby. */
export function toggleToken(el: Element, attr: string, token: string, on: boolean): void {
  const tokens = new Set((el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean));
  if (on) tokens.add(token);
  else tokens.delete(token);
  if (tokens.size) el.setAttribute(attr, [...tokens].join(' '));
  else el.removeAttribute(attr);
}
