# Canonical skill pack

Single source of the first-party agent skills that generated sites receive in
both `.agents/skills/` (Codex) and `.claude/skills/` (Claude). Each
subdirectory is one skill. `create-yatris` copies them into both locations
byte-for-byte; edit them here only.

Frontmatter stays within the portable Agent Skills subset (`name`,
`description`).

## Attribution

These skills are written by Yatris. Their rules were informed by reviewing:

- `tailwindcss-development`: Laravel Boost's Tailwind CSS 4 skill
  (https://github.com/laravel/boost, MIT).
- `alpinejs-development`: the Mindrally Alpine.js skill
  (https://github.com/Mindrally/skills).

No text is copied; Laravel- and Livewire-specific guidance is excluded.
