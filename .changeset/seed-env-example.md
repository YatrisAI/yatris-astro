---
'create-yatris': patch
'@yatris/astro': patch
---

`yatris update` adds `.env.example` to a site that has none (YatrisCMS#329), from the release's template, so existing sites get the file the managed AGENTS.md block points agents at. It never replaces an existing `.env.example` and does not record it in `.yatris/platform.lock.json`: the file is the site's own once it exists. When Git would ignore the new file (an older `.gitignore` ignoring `.env.*` without `!.env.example`) or would not ignore `.env`, the update appends the missing rule to `.gitignore`. `--dry-run` lists both.
