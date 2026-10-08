# create-yatris

## 0.7.1

### Patch Changes

- Updated dependencies [eee93d0]
  - @yatris/astro@0.7.1

## 0.7.0

### Patch Changes

- Updated dependencies [110be00]
  - @yatris/astro@0.7.0

## 0.6.0

### Minor Changes

- 8cd9589: Add the built-in `yatris-reservation` skill (YatrisCMS#422). One canonical, mode-aware skill covers time-slot appointments (hosts), business service bookings (practitioners and rooms) and business party bookings (tables or a seat pool). Agents run an adaptive interview of at most three questions a round that asks only the questions of the setup's mode (booking mode, durations and resources, hours and exceptions, confirmation policy, locations with Calendar and conferencing recorded as wishes for later phases, questions with name and email identity fields and `sensitive` clinic questions behind an unselected consent, a purpose notice and staff review, cutoffs and copy, theme and embedding through `<ReservationEmbed>` and its theme tokens), and record it in a resumable `src/reservations/<key>.brief.json` whose decisions are `confirmed`, `delegated` or `unresolved`. The brief schema (`references/brief.schema.json`) makes business facts (hosts, hours, capacity, durations, locations, the confirmation choice) impossible to delegate, labels delegated defaults with `proposedDefault: true` and rejects email addresses, so recipients stay with the Website Owner in Yatris. The skill writes the declaration with the operations seed only when every operating fact of the mode is confirmed, never uses synthetic data in it, lists the readiness blockers before live publication, says plainly that preview availability is synthetic and never asks for SMTP, OAuth or provider credentials. The managed `AGENTS.md` block now says reservations always use Yatris, with no third-party booking widgets or custom booking backends. New sites get the skill from `create-yatris`, existing sites get it and the guidance from `yatris update`, and `yatris doctor` treats it as built in. The `yatris-contact-form` skill now documents the forms `sensitive` question marker.
- 82341e3: Add `yatris reservations plan | apply | pull | status` (YatrisCMS#432): synchronization of reservation setup definitions (`src/reservations/<key>.json`, not `*.brief.json`) with Yatris drafts through the Product MCP tools `plan_reservation_setups`, `apply_reservation_setups`, `list_reservation_setups`, `get_reservation_setup` and `get_reservation_setup_readiness`. It follows the contact-form sync exactly: local validation with `validateSetup` before anything is sent, a read-only plan against the baseline in `.yatris/reservations.lock.json` and the current Yatris draft and publication (builder edits included), drift and conflicts reported and never merged, an expiring plan file (`.yatris/reservations.plan.json`), atomic draft-only apply with an idempotency key, a pull that refuses to overwrite unsynchronized local work, and the forms exit codes. Sync covers setup definitions only: the `operations` seed is sent with each declaration and used by Yatris only when apply creates the setup; afterwards daily operations live in Yatris, their edits are shown as an informational live revision and never as drift or conflicts, routine sync never overwrites them, and `pull` never writes or removes an `operations` section. Omitting a file never deletes a setup. `status` shows readiness and the redacted live operations, labelled as live values and never as the seed. New sites ignore the reservations plan file through the template's `.gitignore`, and `yatris update` adds the rule to existing sites. The `yatris-reservation` skill now describes the plan → review → apply hand-off.

### Patch Changes

- Updated dependencies [5fe3ca6]
- Updated dependencies [b33d150]
- Updated dependencies [0ab863d]
- Updated dependencies [8cd9589]
- Updated dependencies [2076f0e]
- Updated dependencies [82341e3]
  - @yatris/astro@0.6.0

## 0.5.1

### Patch Changes

- Updated dependencies [bcd7f4e]
  - @yatris/astro@0.5.1

## 0.5.0

### Minor Changes

- 40b1a61: Add the built-in `yatris-contact-form` skill (YatrisCMS#381). Agents building or changing a contact or inquiry form run a short adaptive interview (purpose and placement, fields with explicitly confirmed requiredness, conditions, files and consent, client notification, visitor email, mail source, submission result, review; at most three questions a round), record it in a resumable `src/forms/<key>.brief.json` whose decisions are `confirmed`, `delegated` or `unresolved` (shape in the skill's `references/brief.schema.json`), then write the declaration, mount `<YatrisForm>`, validate, preview and report the Yatris import, publication and mail steps still pending. The skill never asks for SMTP credentials and explains both provisioning routes: the Website Owner on the dashboard's Connections page, or staff with the env-file helper. References cover the field registry, examples, condition grammar, commands and exit codes, error handling, secrets and scenarios. The managed `AGENTS.md` block now says contact forms always use Yatris and forbids Cloudflare Functions, `mailto:` forms, third-party form services and self-written SMTP senders, even as stopgaps. New sites get the skill from `create-yatris`; existing sites get it, and the new guidance, from `yatris update`. `yatris doctor` treats it as a built-in skill.

### Patch Changes

- Updated dependencies [40b1a61]
- Updated dependencies [39345f2]
- Updated dependencies [1dbd213]
- Updated dependencies [5188f20]
  - @yatris/astro@0.5.0

## 0.4.0

### Minor Changes

- 66bf88e: Generated zod schemas keep image `variants` (YatrisCMS#329). `src/generated/yatris-zod.ts` now declares the resized copies Delivery serves on a library image (`variants: { width, height, url, webp_url }[]`, optional), which the previous schema let zod strip, so a page can build `srcset` from them without re-declaring the image fields. `.yatris/schema.lock.json` records the zod generator version it was synced with (`zodGenerator`), and `yatris schema verify --manifest` checks the file against that version: a lock synced by 0.3.0 has no version, counts as version 1 and keeps verifying, as do the build-time schema check and `yatris doctor`. Such a site gets the warning `schema-zod-outdated` until it runs `yatris schema sync --manifest <file>` again, which regenerates the file with `variants` and records version 2.

### Patch Changes

- 66bf88e: `yatris update` adds `.env.example` to a site that has none (YatrisCMS#329), from the release's template, so existing sites get the file the managed AGENTS.md block points agents at. It never replaces an existing `.env.example` and does not record it in `.yatris/platform.lock.json`: the file is the site's own once it exists. When Git would ignore the new file (an older `.gitignore` ignoring `.env.*` without `!.env.example`) or would not ignore `.env`, the update appends the missing rule to `.gitignore`. `--dry-run` lists both.
- Updated dependencies [66bf88e]
- Updated dependencies [66bf88e]
  - @yatris/astro@0.4.0

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
