# Field registry (contract v1) in brief

The authoritative registry is `contracts/forms/v1/README.md` §1 and §4 in
`@yatris/astro` (`node_modules/@yatris/astro/contracts/forms/v1/`), with
`declaration.schema.json` for every allowed property. The validators are
authoritative; if this summary and the contract disagree, the contract wins.

## Declaration skeleton

Required top-level properties: `contractVersion` (always `1`), `key`, `name`,
`locale` (`ja` or `en`), `fields`, `submit`, `success`, `mail`.
Optional: `$schema`, `confirmStep`, `uploads`, `smtp`.

- **Form `key`**: `^[a-z][a-z0-9-]{0,63}$`, equal to the file name
  (`src/forms/contact.json` has `"key": "contact"`). It never changes once
  the form exists in Yatris.
- **Node `key`**: `^[a-z][a-z0-9_]{0,63}$`, unique across the whole form,
  groups and display nodes included. Renaming a key is a removal plus an
  addition (old inquiries keep the old key).
- **`required`** must be stated on every input except `hidden` and `quiz`.
  Write only the value the brief confirmed or delegated.
- Labels and other single-line texts: up to 200 characters, no control
  characters. `help` (up to 1000) may span lines.
- No property beyond the registry: unknown properties are errors.

## Inputs

| Plain-language need | Type | Key options |
| --- | --- | --- |
| Name, company, short answer | `text` | `autocomplete` (`name`, `organization`, `postal-code`, `address-level1`, `street-address`, …), `placeholder`, `default`, `characterCount`, `validation.minLength`/`maxLength` (default max 5000) |
| フリガナ / reading | `text` + `preset` | `preset: "katakana"` or `"hiragana"` converts and checks what is typed. Not together with `validation.format`. |
| Postal code, digits-only, alphanumeric code | `text` | `validation.format`: `postal_code_jp` (normalized to `123-4567`), `digits`, `alphanumeric` |
| Long message | `textarea` | `rows`, `characterCount` (`used`/`remaining`), `validation.maxLength` (default 20000) |
| Email address | `email` | `autocomplete: "email"`. Needed for a thank-you mail and for reply-to. |
| Phone number | `tel` | `autocomplete: "tel"`. Kept as text: leading zeros and `+` survive. |
| Website address | `url` | `validation.schemes` (`http`, `https`) |
| Quantity, amount | `number` | `validation.min`/`max`/`step` (decimals as numbers or strings) |
| Slider | `range` | `validation.min`, `max`, `step` all required; `showValue` |
| Date / time / date and time | `date` / `time` / `datetime` | `validation.min`/`max`/`step`; `datetime` is local time in the Website's time zone |
| One of a few choices | `radio` | `options: [{ value, label }]`; values `^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$` |
| One of many choices | `select` | `options`, `prompt` (never counts as an answer) |
| Several choices | `checkboxes` / `multiselect` | `options`, `validation.minSelected`/`maxSelected` |
| "Other" | a conditional `text` | `visibleWhen` the choice field `contains`/`eq` `"other"` |
| Single yes/no | `checkbox` | Unchecked is `false`; `required` means it must be checked |
| Consent | `acceptance` | `consentText` (required), `consentVersion`, `privacyPolicyPath`; never checked by default |
| Attachments | `file` | `validation.maxFiles` (≤ 5), `maxFileSize` (bytes, ≤ 10485760), `accept` from `pdf`, `jpeg`, `png`, `webp`, `text` |
| Page-supplied metadata (campaign, source page) | `hidden` | Filled by `<YatrisForm hidden={{ … }}>`; untrusted, never chooses recipients |
| Simple anti-spam question | `quiz` | `questions: [{ id, question, answers }]`, at most one per form, always required. Optional: Turnstile already protects every form. |

## Display nodes

`heading` (`text`, `level` 2–4), `help` (`text`), `divider`, `group`
(`label`, `fields`; at most 3 levels deep, may have `visibleWhen`),
`reflection` (`source`, `label`: echoes an earlier answer; not for `hidden`
or `quiz`). They hold no answer and take no `required`.

## Form-level options

- `submit`: `{ "label", "pendingLabel"? }`.
- `confirmStep`: `{ "enabled", "heading"?, "backLabel"?, "submitLabel"? }`,
  the 入力→確認→完了 flow. With it on, `submit.label` is the button that opens
  the confirmation screen and `confirmStep.submitLabel` sends.
- `success`: `{ "mode": "message", "message" }` or
  `{ "mode": "redirect", "redirectPath" }`. The path is same-site and starts
  with a single `/`; visitor input never changes it.
- `uploads`: `{ "maxFiles" ≤ 5, "maxTotalBytes" ≤ 20971520 }`; each file
  field's `maxFileSize` must fit within `maxTotalBytes`.
- `mail.notification`: `to` (initial recipients only, up to 10; leave out
  when unknown), `replyToField` (an `email` field), `subject`, `body`,
  `attachmentFields` (`file` fields).
- `mail.thankYou`: `enabled`; when `true`, `toField` (an `email` field),
  `subject` and `body` are required; `replyToAddress` is optional.
- `smtp`: optional, `{ "source": "website_profile" }`, meaning the form uses
  the Website's shared mail profile. It never holds SMTP settings.

## Mail templates

Plain text. Subjects up to 200 characters on one line, bodies up to 10000.
Placeholders: `{{form.name}}`, `{{website.name}}`,
`{{submission.reference}}`, `{{submission.date}}`, `{{submission.answers}}`
(bodies only) and `{{field.<key>}}` for any input except `quiz`. Anything
else is an error. Values are escaped when sent.

## Limits worth knowing

Up to 300 nodes in total and 200 at the top level, 200 options per choice
field, condition nesting 5 deep.
