# Canonical skill pack

Single source of the first-party agent skills that generated sites receive in
both `.agents/skills/` (Codex) and `.claude/skills/` (Claude). Each
subdirectory is one skill. `create-yatris` copies them into both locations
byte-for-byte; edit them here only.

Frontmatter stays within the portable Agent Skills subset (`name`,
`description`).

The two generated copies are the thin client adapters: the same files, in
the directory each client discovers (Codex `.agents/skills/`, Claude Code
`.claude/skills/`). There is one implementation of each skill, here; the
platform lock records both copies and `yatris doctor` fails when they drift.
`yatris update` delivers new and changed skills, including whole new skill
directories with their `references/`, to existing sites.

| Skill | Purpose |
| --- | --- |
| `tailwindcss-development` | Tailwind CSS 4 styling rules |
| `alpinejs-development` | Alpine.js 3 interaction rules |
| `yatris-contact-form` | Contact and inquiry forms through Yatris: adaptive interview, resumable brief (`src/forms/<key>.brief.json`), declaration, `<YatrisForm>`, honest hand-off. Its `references/` are checked by `packages/astro/src/forms-skill.test.ts`. |

## Attribution

These skills are written by Yatris. Their rules were informed by reviewing:

- `tailwindcss-development`: Laravel Boost's Tailwind CSS 4 skill
  (https://github.com/laravel/boost, MIT).
- `alpinejs-development`: the Mindrally Alpine.js skill
  (https://github.com/Mindrally/skills).

No text is copied; Laravel- and Livewire-specific guidance is excluded.
