# Commands and exit codes

Run these from the site root. `npx yatris …` is the `@yatris/astro` CLI
installed with the site.

## Offline

| Command | What it does | Exit codes |
| --- | --- | --- |
| `npx yatris forms validate` | Checks every `src/forms/*.json` (not `*.brief.json`) against contract v1: shape, conditions, mail templates, and that the file name equals `key`. Offline; writes nothing. `--dir=<path>` checks another directory. | `0` all valid, or no declarations (warnings such as `recipients_missing` do not fail). `1` any error: each line is `<path> <code>`. |
| `npx astro dev --background` with `YATRIS_FORMS_PREVIEW=1` | Local preview of every declaration with a preview marker, a scenario switch and the request it would send. Sends nothing. Stop with `npx astro dev stop`. | — |
| `npm run build` | Production build. Refuses to run while `YATRIS_FORMS_PREVIEW` is set in the environment, `.env` or `.env.production`. Never reads `src/forms/`. | non-zero on failure |
| `npm run doctor` | Rebuilds, checks the repository contract, lints `src/`, audits the output, and checks forms: valid declarations, every `<YatrisForm form="x">` has `src/forms/x.json`, each redirect `success.redirectPath` has a page, the renderer supports every field. With pairing and `YATRIS_MCP_TOKEN` it also reads Yatris readiness; otherwise those checks print as `unverified`, which is not a pass. | `0` ok, `1` errors |

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

## Synchronization with Yatris

These need a paired site and a Yatris credential in the environment
(`YATRIS_MCP_TOKEN`, set by staff; never ask for it, print it or write it
anywhere). Without it they exit `5` and send nothing; report it as pending.

| Command | What it does | When you may run it |
| --- | --- | --- |
| `npx yatris forms plan` | Validates locally, then asks Yatris for a **read-only** comparison of each declaration with the last sync (`.yatris/forms.lock.json`) and the current Yatris draft and publication. Prints one operation per form (`create`, `update_draft`, `noop`, `accept_remote`, `remote_drift`, `conflict`, `adopt_required`, `invalid`) with changed paths. If applicable, writes `.yatris/forms.plan.json` (gitignored; never commit or move it into `public/`). `--json` for machine output. | Whenever the site is paired: it changes nothing in Yatris. Run it before editing a declaration that may already exist in Yatris. |
| `npx yatris forms apply --plan .yatris/forms.plan.json` | Saves the planned declarations as Yatris **drafts**, atomically, and updates `.yatris/forms.lock.json`. Refuses if any declaration changed since the plan. Never publishes: prints review URLs and "publication pending". | Only when the user or work order authorized saving to Yatris **and** allows writing `.yatris/forms.lock.json` (outside the usual `src/` boundary). Show the plan first. |
| `npx yatris forms pull [<key>]` | Writes the **published** Yatris definition into `src/forms/<key>.json` and records the baseline, only if the file is absent or unchanged since the last sync. A file that already equals Yatris only gets its baseline recorded. Never overwrites local edits. | When the work order allows writing `src/forms/` and `.yatris/forms.lock.json`. |
| `npx yatris forms pull --draft` | The same with the unpublished Yatris draft. | Staff operation: only when staff asked for it. |
| `npx yatris mail sync --env-file .env` | Staff helper that imports the customer's SMTP settings from the private env file as a pending profile. Never prints a value. | Never on your own initiative. See `secrets.md`. |

Exit codes (plan, apply, pull, mail sync):

| Code | Meaning | What to do |
| --- | --- | --- |
| `0` | Done; or the plan is applicable / there is nothing to do | Continue |
| `1` | Invalid input (declaration, argument, plan file) | Fix and re-run |
| `2` | Reconciliation required: drift, conflict, adoption, or pull refused to overwrite local edits | Follow the printed next step; see the drift scenario in `scenarios.md`. Never force it |
| `3` | Stale: the plan expired or declarations changed after it, or Yatris changed meanwhile | Run `plan` again and review it |
| `4` | Not paired | Report "pairing" as pending |
| `5` | No credential, or Yatris refused it | Report it; never look for a token |
| `69` | Yatris does not offer this yet | Report it as pending in Yatris; no retry loop |
| `75` | `backend_unavailable`: Yatris unreachable | Try once more later; never assume remote state |

`75` is not "no forms": when Yatris has no forms for the site, `pull` says so
and exits `0`.

## Never run

- Anything that publishes a form, sends test mail or changes mail settings
  on the user's behalf.
- Commands that print `.env` contents, or that put a secret on the command
  line.
- Edits to `.yatris/forms.lock.json` or `.yatris/project.json` by hand.
