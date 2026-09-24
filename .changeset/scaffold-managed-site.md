---
'create-yatris': minor
'@yatris/astro': minor
---

`npm create yatris <dir>` now creates a neutral managed Astro site: Astro with Tailwind CSS 4 and Alpine.js 3 configured the way `astro add` does, the base directory layout, a typed `src/navigation.ts`, a minimal accessible layout, `AGENTS.md`/`CLAUDE.md`, and the `tailwindcss-development` and `alpinejs-development` skills in both `.agents/skills/` and `.claude/skills/`. It initialises Git, installs pinned dependencies and runs the first build. `@yatris/astro` adds `defineNavigation` (`@yatris/astro/navigation`).
