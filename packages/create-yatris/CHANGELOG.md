# create-yatris

## 0.3.0

### Minor Changes

- 0fe2e42: `yatris schema sync` now also writes `src/generated/yatris-zod.ts` (YatrisCMS#307): a zod schema per Content Type, derived from the manifest's canonical schema and pinned in `.yatris/schema.lock.json` like Yatris's own generated files, so `yatris schema verify` catches a hand edit. Pass `yatrisSchemas['<slug>']` as the `schema` of `getYatrisList`, `getYatrisSingleton` or `getYatrisItem`. The new `repeater` field type becomes `z.array(z.object({ … }))` of its sub-fields with its `min_items` / `max_items` bounds (an optional repeater may also be empty); a list of strings is a repeater with one text sub-field. Locks written by earlier versions keep verifying; the file appears on the next sync.

### Patch Changes

- 27bc3f6: The managed AGENTS.md block documents CMS content reads and how a local build gets its Delivery key (the Yatris MCP tool `issue_delivery_key`) (YatrisCMS#307).
- 86ee2a0: `yatris schema verify` no longer reports `schema-lock-missing` for a `.yatris/schema.lock.json` that exists but has no revision synced yet (YatrisCMS#307). That case is now the warning `schema-lock-unsynced`, and `verify` exits 0 for it; `yatris schema status` says "no schema revision synced yet". Both, and a truly missing lock, name the next step: read `yatris://websites/{id}/schema` from the Yatris MCP, save it outside the repository and run `yatris schema sync --manifest <file>`. `yatris doctor` still treats the empty lock of a new site as normal. New sites get a `.env.example` for `YATRIS_DELIVERY_ENDPOINT` and `YATRIS_DELIVERY_API_KEY` that says where a local read key comes from.
- Updated dependencies [27bc3f6]
- Updated dependencies [0fe2e42]
- Updated dependencies [86ee2a0]
  - @yatris/astro@0.3.0

## 0.2.0

### Minor Changes

- 3211daa: A paired site's production build now enforces its schema contract (YatrisCMS#304). It reads `GET {yatris}/api/v1/sites/{id}/schema` and, when the Website is in revisioned schema mode, fails unless `.yatris/schema.lock.json` names the active revision and digest (or the pending one whose deployment precedes its activation) and the generated files verify against the lock. A build that cannot read Yatris fails too. Immediate-mode sites are not checked, and unpaired projects and `astro dev` make no request. Yatris lets a Website switch to revisioned mode only once its repository is on this release.

### Patch Changes

- Updated dependencies [3211daa]
- Updated dependencies [8419265]
- Updated dependencies [b116828]
  - @yatris/astro@0.2.0

## 0.1.1

### Patch Changes

- aff24da: Require Node.js 22.19.0 or later. The pinned Astro stack depends on undici 8, which needs it; sites built on 22.12–22.18 got an npm engine warning (found on the reference site's Cloudflare Pages build). `yatris update` checks the platform's `node` requirement before updating.
- Updated dependencies [aff24da]
  - @yatris/astro@0.1.1

## 0.1.0

### Minor Changes

- 6d5928e: Build-time Delivery API loader. `@yatris/astro/delivery` adds `getYatrisList`, `getYatrisSingleton`, `getYatrisItem` and `createDeliveryClient` for today's Delivery API: every page is fetched, only published items are read, an optional `schema` (for example from `astro/zod`) types and validates each item, empty lists fail unless `allowEmpty` is set, malformed or changing responses fail the build, transient failures retry, and the key is never printed. The integration loads `YATRIS_DELIVERY_*` from the site's ignored `.env` files. `yatris doctor` now fails direct Delivery API calls that bypass the loader.
- 981dc99: Document infrastructure and scaffold diagnostics. `@yatris/astro` adds the `yatris()` integration, `YatrisHead` and `YatrisBodyStart` components with the `YatrisPageMeta` contract (title, description, canonical, robots, social metadata, structured data, Search Console verification, and Google Tag Manager only when a container ID is configured), and fails the build when a `src/navigation.ts` destination was not built. `yatris doctor --stage=scaffold` checks the repository contract, lints `src/` and audits the build output (titles, language, canonical, duplicate or hand-written Google tags, runtime CDNs, leaked credentials). Generated sites use the components and get an `npm run doctor` script.
- f3c9550: Yatris MCP client configuration. Generated sites get a canonical `.yatris/mcp.json` descriptor plus credential-free Claude Code (`.mcp.json`) and Codex (`.codex/config.toml`) adapters derived from it, pointing at the platform's MCP URL (`https://app.yatris.jp/mcp/yatris`); people sign in with `claude mcp login yatris` / `codex mcp login yatris`. `yatris doctor` fails a missing descriptor, adapters that drift from it, and any credential in them. `AGENTS.md` tells agents to use only the Yatris MCP for live Yatris state.
- Pairing. `npx yatris connect` (and `create-yatris --pair`) pairs a repository with its Yatris Website using a single-use setup code typed at a prompt, so it never appears in shell history. It writes the site identity and the MCP configuration, never a key or token.
- 154cd62: Platform updater. `npm run yatris:update` moves a managed site to a newer approved Yatris platform release (a stable `@yatris/astro` version published by the release workflow on main, proven by npm provenance): the tested Astro, Tailwind and Alpine versions, the built-in skills in both agent locations, the managed block of `AGENTS.md` and the MCP configuration. It plans first (`--check`, `--dry-run`), needs confirmation for a major Astro or platform change, stops on locally edited managed files instead of overwriting them, runs `npm run doctor` and the site's tests, restores only the files it touched if anything fails (`--rollback` recovers an interrupted run), and never commits. New sites get `.yatris/platform.lock.json`, which `yatris doctor` now checks.
- 4382287: `npm create yatris <dir>` now creates a neutral managed Astro site: Astro with Tailwind CSS 4 and Alpine.js 3 configured the way `astro add` does, the base directory layout, a typed `src/navigation.ts`, a minimal accessible layout, `AGENTS.md`/`CLAUDE.md`, and the `tailwindcss-development` and `alpinejs-development` skills in both `.agents/skills/` and `.claude/skills/`. It initialises Git, installs pinned dependencies and runs the first build. `@yatris/astro` adds `defineNavigation` (`@yatris/astro/navigation`).
- 4a5c71d: `yatris schema status | sync --manifest=<file> | verify [--manifest=<file>]`: sites lock to an exact Yatris schema revision in `.yatris/schema.lock.json` and commit the Yatris-generated `src/generated/yatris-schema.ts`. `sync` writes only what an integrity-checked manifest from the Yatris MCP carries; `verify` is read-only. New sites start with an explicit empty lock, and `yatris doctor` fails a missing lock or a hand-edited generated file.

### Patch Changes

- 239f733: Reference-site findings (checkpoint 1): generated repositories start on `main` whatever the local Git default is, and the sign-in instructions now include the steps each client needs first (approving the project server in Claude Code, trusting the project in Codex).
- Updated dependencies [6d5928e]
- Updated dependencies [981dc99]
- Updated dependencies [f3c9550]
- Updated dependencies
- Updated dependencies
- Updated dependencies [154cd62]
- Updated dependencies [239f733]
- Updated dependencies [4382287]
- Updated dependencies [4a5c71d]
  - @yatris/astro@0.1.0
