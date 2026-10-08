# Error handling

## `yatris forms validate` errors

Each error line is `<JSON pointer> <code>`. Fix the declaration, not the
validator, and re-run until it exits 0. Full list: contract README §2, §3, §5.

| Code | Usual cause | Fix |
| --- | --- | --- |
| `invalid_json` | Trailing comma, comment, unescaped quote | Make it plain JSON |
| `filename_mismatch` | `key` differs from the file name | Rename the file or fix `key` (never change the key of a form Yatris already has) |
| `required_property` | Missing `required` on an input, missing `consentText`, `options`, `thankYou.subject`… | Add it, with the value the brief records; if the brief has none, ask |
| `unknown_property` | A property the type does not allow (`placeholder` on `radio`, `maxlength` instead of `validation.maxLength`) | Remove or rename it (see `fields.md`) |
| `unknown_node_type` | A type outside the registry (`password`, `address`, `zip`) | Use a registry type; a postal code is `text` with `validation.format: "postal_code_jp"` |
| `duplicate_key` | Two nodes share a key | Rename one |
| `pattern_mismatch` | Bad key, option value, path or a control character in a label | Keys `^[a-z][a-z0-9_]*$`, option values ASCII, paths start with one `/` |
| `invalid_default` | A default that fails the field's own rules | Fix or remove the default |
| `preset_conflict` | `preset` together with `validation.format` | Keep one |
| `upload_limit_exceeded` | `maxFileSize` larger than `uploads.maxTotalBytes` | Lower it |
| `invalid_mail_field` | `replyToField`, `thankYou.toField` not an `email` field, or `attachmentFields` not a `file` field | Point it at the right field |
| `invalid_placeholder_field`, `unknown_placeholder`, `placeholder_not_allowed`, `malformed_placeholder` | Bad `{{…}}` in mail text | Use only the placeholders in `fields.md`; `{{submission.answers}}` only in bodies |
| `sensitive_placeholder` | `{{field.<key>}}` names a field marked `sensitive: true` | Remove the placeholder; sensitive answers never go into mail |
| Condition codes | See `conditions.md` | — |

Warning `recipients_missing` at `/mail/notification/to`: expected while the
recipients are unresolved. It is not an error; keep it and report the
recipients as pending.

## Preview problems

- The preview shows validation issues instead of a form: run
  `npx yatris forms validate` and fix the file.
- The preview says `src/forms/<key>.json がありません`: the `form` prop does
  not match a declaration key.
- The page shows the unavailable state under `astro dev`: preview is off
  (`YATRIS_FORMS_PREVIEW` was not set when the dev server started; set it
  and restart the dev server).
- `astro build` fails mentioning `YATRIS_FORMS_PREVIEW`: it is set in `.env`
  or the build's environment. Remove it there; set it only for the dev
  server.

Use the preview's scenario switch to check how the site's design handles
each outcome: accepted (message or redirect), `validation_failed`,
`verification_failed`, `form_version_changed`, `idempotency_conflict`,
`payload_too_large`, `rate_limited`, `temporarily_unavailable`,
`form_unavailable` and a network failure. The renderer already handles them;
your job is that they look right in the site's design.

## Yatris unavailable or not ready

The backend may be missing, unreachable or not yet supporting a step. In
every case:

1. Keep working offline: interview, brief, declaration, validate, mount,
   style, preview, build, doctor.
2. Never emulate a success: no fake receipts, no "sent" messages, no local
   handler that pretends to accept submissions.
3. Never fall back to another mechanism (Cloudflare Function, `mailto:`,
   third-party service, own SMTP code), even temporarily.
4. Record what is blocked in the brief's `pending` and in your report.

| Signal | Meaning | Report as |
| --- | --- | --- |
| `yatris forms plan/apply/pull` exit 69 | This Yatris does not offer form synchronization yet | "Yatris staff import and publish the form in the builder." |
| exit 75 (`backend_unavailable`) | Yatris could not be reached | "Synchronization pending: Yatris was unreachable." Never treat it as "no forms". |
| exit 5 | No `YATRIS_MCP_TOKEN`, or it was refused | "Synchronization pending: needs a staff credential." Never search for a token. |
| exit 4 | The site is not paired | "Pairing" pending. |
| exit 2 / 3 | Drift, conflict, or a stale plan | Reconcile (`scenarios.md`, scenario I) or plan again. Never force. |
| `yatris mail sync` exit 69 | This Yatris cannot import mail profiles yet | "Customer SMTP: the Website Owner enters it on the Connections page (メールの連携)." |
| Live page shows the unavailable state | Site unpaired, or the form is not published in Yatris yet | "Pairing" or "Staff publication" pending. Not a bug to work around. |
| The Yatris MCP is not connected or has no form tools | Remote state cannot be read | Say so; never guess whether the form exists in Yatris. |
| A live form shows a retry button | The definition request failed (network or Yatris down) | Temporary outage; the renderer retries on request. Do not add a fallback. |
