---
name: tailwindcss-development
description: Styling rules for this Yatris-managed Astro site using Tailwind CSS 4. Use for page styling, responsive layout, component appearance, spacing, typography, state variants, design tokens, or any Tailwind request.
---

# Tailwind CSS 4 in a Yatris-managed Astro site

Tailwind is this site's styling vocabulary, not a design system. The site's
design decisions (tokens, components, breakpoints, dark mode) belong to the
site.

## Before you add styles

- Read `src/styles/global.css` and the existing layouts/components first.
  Reuse the tokens and patterns already there before inventing new ones.
- Keep the `@import "tailwindcss";` line and the base layout's import of
  `global.css`.

## Version 4 rules

- Configuration is CSS-first: design tokens go in an `@theme { … }` block in
  `src/styles/global.css`. Do not create `tailwind.config.js`/`.ts`.
- Tailwind runs through the official `@tailwindcss/vite` plugin in
  `astro.config.mjs`. Never add the legacy `@astrojs/tailwind` integration.
- Do not use utilities removed in v4 (for example `bg-opacity-*`,
  `text-opacity-*`, `flex-shrink-*`/`flex-grow-*`); use the v4 forms
  (`bg-black/50`, `shrink-*`, `grow-*`).

## Writing classes

- Mobile-first: base classes for small screens, then `sm:`, `md:`, `lg:`.
- Keep every class name complete and literal so Tailwind's source detection
  finds it. Never build classes from fragments such as `` `bg-${color}-500` ``;
  map values to full class names instead.
- Use arbitrary values (`w-[37px]`) deliberately, not as a substitute for a
  token that should exist in `@theme`.
- Group related utilities and avoid contradictory or duplicated classes on
  one element.
- When a visual pattern genuinely repeats, extract a site-owned Astro
  component in `src/components/`. There is no mandatory Yatris UI library.
- Preserve existing dark-mode behaviour when the site has it; never invent a
  dark-mode requirement.
- Scoped `<style>` or custom CSS is fine for complex visuals, animation or
  rich-text content where utilities would be unreadable.

## Done

`npm run build` succeeds, and the page is checked at small and large widths.
