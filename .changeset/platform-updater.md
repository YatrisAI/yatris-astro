---
'create-yatris': minor
'@yatris/astro': minor
---

Platform updater. `npm run yatris:update` moves a managed site to a newer Yatris platform release (stable `@yatris/astro` versions on npm): the tested Astro, Tailwind and Alpine versions, the built-in skills in both agent locations, the managed block of `AGENTS.md` and the MCP configuration. It plans first (`--check`, `--dry-run`), needs confirmation for a major Astro or platform change, stops on locally edited managed files instead of overwriting them, runs `npm run doctor` and the site's tests, restores only the files it touched if anything fails (`--rollback` recovers an interrupted run), and never commits. New sites get `.yatris/platform.lock.json`, which `yatris doctor` now checks.
