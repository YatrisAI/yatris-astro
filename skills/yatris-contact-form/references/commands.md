# Commands and exit codes

Run these from the site root. `npx yatris …` is the `@yatris/astro` CLI
installed with the site.

## Available now

| Command | What it does | Exit codes |
| --- | --- | --- |
| `npx yatris forms validate` | Checks every `src/forms/*.json` (not `*.brief.json`) against contract v1: shape, conditions, mail templates, and that the file name equals `key`. Offline; writes nothing. `--dir=<path>` checks another directory. | `0` all valid, or no declarations (warnings such as `recipients_missing` do not fail). `1` any error: each line is `<path> <code>`. |
| `npx astro dev --background` with `YATRIS_FORMS_PREVIEW=1` | Local preview of every declaration with a preview marker, a scenario switch and the request it would send. Sends nothing. Stop with `npx astro dev stop`. | — |
| `npm run build` | Production build. Refuses to run while `YATRIS_FORMS_PREVIEW` is set in the environment, `.env` or `.env.production`. Never reads `src/forms/`. | non-zero on failure |
| `npm run doctor` | Rebuilds, checks the repository contract, lints `src/` and audits the output. It does not check forms yet: run `forms validate` yourself and check the thanks page route exists. | `0` ok, `1` errors |

Preview setup: give the dev server `YATRIS_FORMS_PREVIEW=1`, either in its
environment (`YATRIS_FORMS_PREVIEW=1 npx astro dev --background`; PowerShell:
`$env:YATRIS_FORMS_PREVIEW = '1'` first) or in `.env.development.local`
(ignored by Git, never read by builds). Restart the dev server after
changing it. Any value other than `1`, `true`, `0`, `false` or empty is an
error.

How a mounted `<YatrisForm>` behaves:

| Situation | Mode | The visitor sees |
| --- | --- | --- |
| `astro dev` with preview on | `preview` | The local declaration, marked as a preview |
| Paired site (`websiteId` in `.yatris/project.json`) | `live` | The **published** Yatris form, fetched at runtime; unavailable state until Yatris has published it |
| Unpaired, preview off | `unconfigured` | The unavailable state; no request |

## Not available in this release

| Command | Today | When it ships |
| --- | --- | --- |
| `npx yatris forms plan` | Exits `69`: synchronization is not available; nothing compared, written or sent. | Read-only comparison of local, last-synced and current Yatris state, with drift and conflicts. |
| `npx yatris forms apply --plan <file>` | Exits `69`, as above. | Applies an unchanged reviewed plan to a Yatris **draft** (`draft_saved` with a review URL). Never publishes. |
| `npx yatris forms pull` | Exits `69`, as above. | Pulls the published definition into the repository without discarding local edits. |
| `npx yatris mail sync --env-file .env` | Unknown command (exit `1`). | Staff-run helper that imports the customer's SMTP settings from a private env file into Yatris. See `secrets.md`. |

Exit `69` is the sysexits `EX_UNAVAILABLE` code: the command exists but its
service does not yet. Treat it as "pending in Yatris", report it, and carry
on with the offline work. Never retry in a loop, never fake the result, and
never replace the step with another mechanism.

Until synchronization ships, Yatris staff import a declaration through the
internal form builder, which uses the same validator and never blindly
replaces an existing form or draft.

## Never run

- Anything that publishes a form, sends test mail or changes mail settings
  on the user's behalf.
- Commands that print `.env` contents, or that put a secret on the command
  line.
- Edits to `.yatris/forms.lock.json` or `.yatris/project.json` by hand.
