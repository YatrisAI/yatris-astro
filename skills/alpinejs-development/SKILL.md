---
name: alpinejs-development
description: Client-side interaction rules for this Yatris-managed Astro site using Alpine.js 3. Use whenever adding or changing interactive behaviour such as menus, dialogs, disclosures, tabs, filters or form enhancements.
---

# Alpine.js 3 in a Yatris-managed Astro site

## Choose the lightest tool

- Use native HTML first: `<details>`/`<summary>` for disclosure, `<dialog>`
  for modals, plain links and forms. Reach for Alpine only when the interface
  needs reactive state that HTML cannot express.
- Do not add React, Vue or another hydrated framework unless a documented
  requirement needs it.

## Structure

- Keep `x-data` scopes small and next to the markup they control.
- Move reusable or non-trivial behaviour into a named `Alpine.data()`
  component registered in `src/scripts/alpine.ts`. Use `Alpine.store()` only
  for state that is genuinely shared across the page.
- Keep inline expressions short; avoid imperative DOM manipulation.
- Choose `x-show` (keeps the element and its state) or `x-if` (creates and
  destroys it) for the behaviour you need, not by habit.
- Add `x-cloak` to elements that must stay hidden until Alpine starts; the
  site's `global.css` already defines the rule.

## Accessibility

Every interactive component must work with the keyboard:

- Correct focus order, visible focus, and focus moved into and back out of
  dialogs and menus.
- Escape closes overlays.
- Keep `aria-expanded`, `aria-controls`, `aria-selected` and similar state in
  sync with Alpine state (for example `x-bind:aria-expanded="open"`).

## Security

- Render untrusted or CMS-provided text with `x-text`. Never pass it to
  `x-html` unless it has gone through the site's approved sanitiser.
- Never put a Yatris Delivery key in browser code, and never fetch protected
  Yatris content from Alpine. Content is fetched at build time.

## Dependencies

Install Alpine plugins as pinned npm dependencies and register them in
`src/scripts/alpine.ts`. Never add a CDN `<script>`.

## Done

`npm run build` succeeds, and the behaviour is checked in the browser, with
the keyboard, in both `npm run dev` and `npm run preview`. If the site uses
Astro client-side navigation, check the behaviour again after navigating.
