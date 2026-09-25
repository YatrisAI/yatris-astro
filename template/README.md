# Yatris-managed website

Created with `create-yatris`. Built with Astro, Tailwind CSS 4 and Alpine.js 3.

```sh
npm ci          # install the locked dependencies
npm run dev     # local development server
npm run build   # production build into dist/
```

## Platform updates

```sh
npm run yatris:update:check            # is a newer Yatris platform release out?
npm run yatris:update -- --dry-run     # what would change (writes nothing)
npm run yatris:update                  # update, verify, and leave a diff to review
```

The update moves Astro, Tailwind, Alpine and `@yatris/astro` together to
versions Yatris has tested, refreshes the Yatris-managed files (the built-in
skills, the managed block of `AGENTS.md` and the MCP configuration) and runs
`npm run doctor`. It never touches your pages, components, styles or own
skills, stops if you edited a managed file, restores what it changed if
verification fails, and never commits.

Agent and developer conventions are in [AGENTS.md](AGENTS.md).
