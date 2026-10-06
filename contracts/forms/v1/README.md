# Yatris contact-form contract, version 1

This directory is the shared contract for Yatris contact forms. Five things use it:

- the `@yatris/astro` renderer and CLI;
- the YatrisCMS internal builder;
- the YatrisCMS server validator and intake;
- the inbox;
- the mail formatter.

Product decisions behind it: YatrisCMS `YATRIS-CONTACT-FORMS-SPEC.md` and `YATRIS-CONTACT-FORMS-DECISIONS.md` (the decision record wins where the two conflict).

| File | What it is |
| --- | --- |
| `declaration.schema.json` | JSON Schema (draft 2020-12) for a form declaration. Generated; do not edit. |
| `messages.ja.json` | Japanese visitor messages for API and field error codes. Generated. |
| `examples/contact.json` | The spec §5.1 example. |
| `examples/full-coverage.json` | Uses every node type in the registry. |
| `fixtures/*.json` | Shared fixtures. Every implementation must pass all of them. Generated from `packages/astro/test/forms-fixtures.ts`, where the expectations are written by hand. |

The JavaScript reference implementation is `@yatris/astro/forms` (`packages/astro/src/forms/`). The JSON Schema is for editors and agents. **The validators are authoritative.** They add the semantic rules below that a JSON Schema cannot express.

To regenerate after changing the registry or the fixtures:

```sh
YATRIS_UPDATE_CONTRACT=1 npx vitest run packages/astro/src/forms
```

Adding a node type, an option or a rule is a contract change. It must update the registry, both validators, the renderer, the builder, the inbox and mail formatting, and these fixtures together.

## 1. Declaration

A declaration is one JSON object per form, stored at `src/forms/<key>.json` in the Website repository.

- Website identity comes from the pairing contract, never from the declaration.
- Top-level properties are listed in `declaration.schema.json`. Required: `contractVersion` (always `1`), `key`, `name`, `locale`, `fields`, `submit`, `success` and `mail`.
- `key` (form) matches `^[a-z][a-z0-9-]{0,63}$` and never changes.
- Every node has a `key` matching `^[a-z][a-z0-9_]{0,63}$`, unique across the whole form, groups included. Renaming a key is a removal plus an addition.
- `mail.notification.to` is an **initial value only**. Once the form exists in Yatris, Website Owners manage recipients in the dashboard and ordinary sync never overwrites them.

### Node types

| Type | Answer kind | Notes |
| --- | --- | --- |
| `text` | string | `preset`: `katakana` or `hiragana`. `validation.format`: `digits`, `alphanumeric` or `postal_code_jp` (not together with a preset). `characterCount`. |
| `textarea` | string | `rows`, `characterCount`, length limits. |
| `email` | string | |
| `tel` | string | Never a number; leading zeros and `+` are kept. |
| `url` | string | `validation.schemes`: `http` and/or `https`. |
| `number` | decimal | `validation.min`, `max`, `step` as JSON numbers or decimal strings. |
| `range` | decimal | `validation.min`, `max` and `step` are required. `showValue`. |
| `date` | date | `YYYY-MM-DD`. `validation.step` in days. |
| `time` | time | `HH:MM` or `HH:MM:SS`. `validation.step` in seconds (default 60). |
| `datetime` | datetime | Local wall-clock time in the Website's time zone, no offset. `step` in seconds (default 60). |
| `select`, `radio` | choice | `options` `{ value, label }`. `select` has an optional `prompt` that never counts as an answer. |
| `multiselect`, `checkboxes` | choices | `validation.minSelected` / `maxSelected`. Model "Other" as a conditional `text` field. |
| `checkbox` | boolean | Unchecked is a real `false`. Required means checked. |
| `acceptance` | boolean | `consentText` is required. `consentVersion` and `privacyPolicyPath` are optional. Cannot default to checked. |
| `file` | files | `validation.maxFiles` (≤5), `maxFileSize` (≤10 MiB), `accept` from `pdf`, `jpeg`, `png`, `webp`, `text`. |
| `hidden` | string | Declared, bounded, untrusted metadata. Never authorizes anything, selects a Website or chooses recipients. |
| `quiz` | quiz | `questions` `{ id, question, answers[] }`. At most one per form. Always required while active; takes no `required`. Answers never leave the server. |
| `heading`, `help`, `divider` | none | Display only. |
| `group` | none | `fields` holds child nodes. At most 3 levels deep. |
| `reflection` | none | Echoes the `source` field's answer. Disappears while the source is inactive. The source cannot be a `quiz` or `hidden` field. |

Every input except `hidden` and `quiz` must state `required` explicitly. Character counters are a field option (`characterCount`), not a node.

The form-level options are:

- `confirmStep: { enabled, heading?, backLabel?, submitLabel? }`, the 入力→確認→完了 flow;
- `submit`;
- `success` (`message` or `redirect`);
- `uploads: { maxFiles ≤ 5, maxTotalBytes ≤ 20 MiB }`.

## 2. Validation rules (both implementations)

### Value rules

- **Integers:** an integer is a JSON number with no fractional part. PHP must accept `1.0`.
- **String length** is counted in Unicode code points (`mb_strlen`).
- **Single-line text** (labels, subjects and so on) contains no C0 control character and no DEL. **Multi-line text** may contain tab, LF and CR only.
- **Decimals** match `^-?[0-9]+(\.[0-9]+)?$` with at most 30 digits. The canonical form has no leading zeros, no trailing fractional zeros and no `-0`. JSON numbers are converted through their shortest round-trip string; exponent notation is invalid.
- **Patterns** in this document and the schema are ECMAScript regexes with the `u` flag. Use PCRE `/u` in PHP; none of them depend on `\s` or `\w`.

### Shape and semantics

Validation runs in two phases.

**Shape** reports these codes:

| Code | Meaning |
| --- | --- |
| `invalid_type` | Wrong JSON type. |
| `required_property` | A required property is missing. |
| `unknown_property` | A property the type does not allow. |
| `too_short` / `too_long` | String length or array size out of bounds. |
| `pattern_mismatch` | Pattern or line rule failed. |
| `invalid_enum` | Value not in the allowed set. |
| `out_of_range` | Integer out of bounds. |
| `not_unique` | Duplicate array items. |
| `invalid_decimal` | Not a valid decimal. |
| `unknown_node_type` | Unknown `type`. |
| `invalid_condition` | A condition is malformed. |
| `condition_too_deep` | Nesting deeper than 5. |

A node with a missing or unknown `type` gets no further checks.

**If any shape issue exists, semantics are skipped.** Otherwise:

| Code | Path and rule |
| --- | --- |
| `duplicate_key` | `…/key` of the later node, or `…/questions/i/id`. |
| `too_many_nodes` | `/fields`: more than 300 nodes in total. |
| `group_too_deep` | The fourth-level group. |
| `too_many_quiz` | The second quiz. |
| `duplicate_option` | `…/options/i/value` of the later option. |
| `preset_conflict` | `…/preset` when a `validation.format` is also set. |
| `min_exceeds_max` | `…/validation`. |
| `invalid_step` | `…/validation/step` ≤ 0 (number, range). |
| `invalid_date` / `invalid_time` / `invalid_datetime` | `…/validation/min` or `max` is not a real value. |
| `exceeds_options` | `…/validation/minSelected` > number of options. |
| `upload_limit_exceeded` | `…/validation/maxFileSize` > the form's `uploads.maxTotalBytes` (default 20 MiB). |
| `invalid_default` | `…/default` fails §4 normalization for that field (required-ness ignored). Not applied to `checkbox` and `acceptance`. |
| `reflection_source_invalid` | `…/source`. |
| Condition codes | See §3. |
| `invalid_mail_field` | `replyToField` and `thankYou.toField` must name an `email` field; each `attachmentFields[i]` a `file` field. |
| `required_property` | `/mail/thankYou/toField`, `subject`, `body` when `enabled` is true; `/success/message` in message mode; `/success/redirectPath` in redirect mode. |
| Placeholder codes | See §5. |

Warnings never make a declaration invalid. Today there is one: `recipients_missing` at `/mail/notification/to`.

Issues are `{ path, code }` with `path` a JSON Pointer (`""` is the root). Implementations report a deduplicated **set**; order does not matter.

## 3. Conditions

`visibleWhen` and `requiredWhen` take an expression tree:

```json
{ "all": [ ... ] } | { "any": [ ... ] } | { "not": { ... } } | { "field": "<key>", "operator": "<op>", "value": ... }
```

- `all`/`any` take 1–20 items. Nesting depth is at most 5. `in` lists hold 1–50 values.
- A comparison referencing a nonexistent key reports `unknown_reference`, and one referencing its own node reports `self_reference`, both at `…/field`.
- Comparisons may reference inputs only, and never `file` or `quiz` (`reference_not_allowed` at `…/field`).
- Operators by answer kind (otherwise `invalid_operator` at `…/operator`):

| Kind | Operators |
| --- | --- |
| string | `eq neq in contains isEmpty isNotEmpty` |
| choice | `eq neq in isEmpty isNotEmpty` |
| choices | `contains isEmpty isNotEmpty` |
| decimal | `eq neq in gt gte lt lte isEmpty isNotEmpty` |
| date, time, datetime | `eq neq gt gte lt lte isEmpty isNotEmpty` |
| boolean | `eq` |

- Value rules (`invalid_condition_value` at `…/value`, or `required_property` when a needed value is missing):
  - `isEmpty`/`isNotEmpty` take no value.
  - choice values must be option values.
  - decimals must be valid decimals.
  - temporal values must be real values.
  - boolean `eq` takes `true`/`false`.
  - `contains` takes a non-empty string, which must be an option value for choices.

### Activity (renderer and server)

1. A node is **active** when its enclosing group is active (if any) and its `visibleWhen` (if any) holds. A reflection is also inactive while its source is inactive.
2. Comparisons read **effective values**. An inactive field, or a value that failed its own normalization, has no value. This is why a stale answer from a hidden field cannot activate anything.
3. A value is empty when it is absent, `""` or `[]`. `false` and `"0"` are values.
4. Each operator, given the effective value:

| Operator | Result |
| --- | --- |
| `eq` | False when empty. Decimals compare numerically; times and date-times by seconds; dates by day. |
| `neq` | `not eq`, so true when empty. |
| `in` | True when any listed value would satisfy `eq`. |
| `contains` | Array membership for choices, substring for strings. False when empty. |
| `gt`, `gte`, `lt`, `lte` | False when empty. |

5. Active inputs are **required** when `required` is true, or when `requiredWhen` holds. An active `quiz` is always required.
6. `requiredWhen` does not affect activity.
7. **Cycles:** a node depends on its enclosing group, on every field its `visibleWhen` references, and (for a reflection) on its source. Each strongly connected component with more than one node is one `condition_cycle` error, reported at `…/visibleWhen` of the component's first node in document (pre-) order that has a `visibleWhen`.

The `activity.json` fixtures hold normalized values and the expected `active` and `required` key lists, in document order.

## 4. Answers

The browser posts an `answers` JSON object holding every non-file input it has a value for, keyed by field key. File fields arrive as multipart parts (§6). Normalization runs per field first. Activity is then computed from the normalized values. Errors and output cover active inputs only, and inactive answers are dropped silently.

**Trim** removes leading and trailing Unicode White_Space, exactly this set:

```
U+0009–U+000D, U+0020, U+0085, U+00A0, U+1680, U+2000–U+200A, U+2028, U+2029, U+202F, U+205F, U+3000, U+FEFF
```

Do not use PHP `trim()` or JS `String#trim()`, which differ from this set.

Per type, in rule order (each field reports **one** code, the first rule it fails):

| Type | Rules |
| --- | --- |
| `text`, `hidden` | 1. String, else `invalid_type`. 2. Trim. 3. Single-line, else `invalid_format`. 4. `""` is empty. 5. Then:<br>• `katakana`: NFKC, hiragana → katakana, trim, only `[ァ-ヺー・ ]`, else `invalid_format`.<br>• `hiragana`: NFKC, katakana → hiragana, trim, only `[ぁ-ゖー・ ]`, else `invalid_format`.<br>• `format`: NFKC, trim, then `digits` `^[0-9]+$` / `alphanumeric` `^[A-Za-z0-9]+$` / `postal_code_jp` `^([0-9]{3})-?([0-9]{4})$`, output `123-4567`.<br>Otherwise the text is kept as typed (no NFKC). 6. Length: `too_short`, `too_long` (defaults: 5000; `hidden` 500). |
| `textarea` | String. CRLF/CR → LF. Multi-line rule (`invalid_format`). Blank (only White_Space) is empty. Length (default max 20000). The content is not trimmed. |
| `email` | String. NFKC. Trim. `too_long` (default 254). The pattern in `text.ts` `EMAIL_PATTERN` (ASCII, ≤254), else `invalid_email`. |
| `tel` | String. NFKC. Trim. `too_long` (default 30). `^\+?[0-9()\- ]*[0-9][0-9()\- ]*$`, else `invalid_tel`. |
| `url` | String. Trim. `too_long` (default 2000). Absolute `http(s)` URL with a host, optional port, no credentials, with the scheme in `schemes`, else `invalid_url`. |
| `number`, `range` | String or number, else `invalid_type`. Strings get NFKC and trim. Decimal, else `invalid_number`. `below_min`, `above_max`, then `step_mismatch`, where `(value − (min ?? 0))` must be an exact multiple of `step`. Output is canonical. |
| `date` | String. Trim. Real calendar date (years 0001–9999), else `invalid_date`. `below_min`, `above_max`. Step in days from `min`, or from 1970-01-01. |
| `time` | String. Trim. Valid time, else `invalid_time`. Bounds. Step from `min`, or from 00:00. Output `HH:MM` when the seconds are 0, else `HH:MM:SS`. |
| `datetime` | String. Trim. Valid, else `invalid_datetime`. Then the Website time zone: `nonexistent_time` (DST gap) or `ambiguous_time` (DST overlap). Bounds. Step from `min`, or from 1970-01-01T00:00. Same output rule as `time`. |
| `select`, `radio` | String, else `invalid_type`. `""` is empty. Must be an option value, else `invalid_option`. |
| `multiselect`, `checkboxes` | Array of strings, else `invalid_type`. Duplicates or non-options give `invalid_option`. Output is in declaration option order. `[]` is empty. Then `too_few`, `too_many`. |
| `checkbox`, `acceptance` | Absent or `null` is `false`. A non-Boolean is `invalid_type`. |
| `quiz` | `{ questionId, answer }` strings only, else `invalid_type`. Unknown id gives `invalid_question`. The answer is compared after NFKC, trim and lower-casing; the server checks it (`quiz_incorrect`). Never stored or mailed. |
| `file` | See §6. Codes: `invalid_type`, `too_many_files`, `file_too_large`, `file_type_not_allowed`. |

After normalization, a required active input with an empty value reports `required`. An unchecked `acceptance` reports `must_accept`.

Form-level errors (sorted):

- `undeclared_field`: an `answers` key that is not a non-file input, or a file part for a non-file key;
- `too_many_files_total`;
- `payload_too_large_total`. Totals count accepted files of active file fields only.

Output: answers of active inputs that are not empty, with Booleans always present, excluding files and quizzes. Accepted file descriptors are reported per active file field.

## 5. Mail templates

Subjects (single line, ≤200) and bodies (≤10000) are plain text. Placeholders are `{{name}}`, with optional spaces inside the braces:

- `form.name`, `website.name`, `submission.reference`, `submission.date`, `submission.answers`;
- `field.<key>` for any input except `quiz`.

| Code | When |
| --- | --- |
| `placeholder_not_allowed` | `submission.answers` in a subject. |
| `invalid_placeholder_field` | `field.<key>` with an unknown key or a disallowed field. |
| `unknown_placeholder` | Any other name. |
| `malformed_placeholder` | A leftover `{{` or `}}`. |

Values are escaped when rendered and never reach headers unescaped. `submission.answers` lists active answers with their labels. In thank-you mail it leaves out `hidden` fields.

## 6. Public definition and submission wire format

### Public keys

A form's public key is `"<websiteId>.<formKey>"`, for example `42.contact`: the paired Website's id from `.yatris/project.json` and the declaration `key`. Both are identifiers, not secrets; nothing about a submission is authorized by knowing them. The definition URL is `<Yatris origin>/api/v1/forms/<publicKey>`, where the origin is that of the project's recorded `deliveryEndpoint` (`<origin>/api/v1/delivery/<id>`), or `YATRIS_URL` when set. The submission endpoint is whatever the definition's `submission.endpoint` says; the renderer refuses one on a different origin from the definition URL.

### `GET /api/v1/forms/{publicKey}`

The public definition contains:

- `contractVersion`;
- `form` (`key`, `publicKey`, `name`, `locale`, `version`, `digest`);
- `capabilities`;
- `fields`;
- `confirmStep`, `submit`, `success`;
- `submission` (`endpoint`, `turnstile` `{ siteKey, action }` or null, `honeypotField`, `uploads`).

The projection is an **allowlist**: registry properties only, with decimals as canonical strings and quiz questions without `answers`. It never includes `mail`, `smtp`, recipients, staff notes or drafts. `fixtures/public.json` holds the expected projections.

`digest` is `"sha256:" + hex(sha256(canonical JSON of { key, name, locale, fields, confirmStep?, submit, success, uploads }))`. Canonical JSON:

- object keys are sorted by UTF-16 code unit;
- there is no whitespace;
- numbers are integers only;
- strings are escaped as `JSON.stringify` does. PHP needs `JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS`.

`capabilities` is the sorted set of:

- `field:<type>` for each input type used;
- `display:<type>` for each display type used;
- `conditions` if any `visibleWhen` or `requiredWhen` exists;
- `uploads` if any `file` field exists;
- `preset:<name>` for each kana preset used;
- `confirm_step` if `confirmStep.enabled` is true.

A renderer that lacks a listed capability shows an unavailable state, never a partial form.

### `POST /api/v1/forms/{publicKey}/submissions`

The request is `multipart/form-data` with these parts:

| Part | Content |
| --- | --- |
| `version` | Published version number the visitor saw. |
| `answers` | JSON object (§4). |
| `files[<fieldKey>][]` | One part per file, repeated, in attach order. The trailing `[]` is required: PHP keeps every repeated part only when the name ends in `[]`. |
| `idempotencyKey` | 16–128 chars of `[A-Za-z0-9_-]`. One per deliberate submission, reused on retry. |
| `turnstileToken` | When the definition has `turnstile`. |
| `hp_website` | Honeypot; must be empty. |

The idempotency fingerprint is computed by the server (`requestHash` in `hash.ts`; `fixtures/request-hash.json`):

```
sha256hex( "yatris-form-submission-v1\n" + publicKey + "\n" + version + "\n"
         + sha256hex(answers part bytes) + "\n"
         + for each files[<fieldKey>][] part in order: fieldKey + ":" + sha256hex(file bytes) + ":" + size + "\n" )
```

`fieldKey` in the fingerprint is the bare key from the part name `files[<fieldKey>][]`, without the brackets.

A retry must resend the same `answers` bytes; the renderer keeps the serialized string.

Accepted (HTTP `202`):

```json
{ "status": "accepted", "receipt": "<opaque>", "success": { "mode": "redirect", "path": "/contact/thanks/" } }
{ "status": "accepted", "receipt": "<opaque>", "success": { "mode": "message", "message": "<ja message>" } }
```

`success` mirrors the published definition's `success`. The renderer treats only a 2xx response whose body has `status: "accepted"` as success, and always takes the redirect destination from the definition it rendered, never from the response.

Rejected:

```json
{ "status": "rejected", "code": "<api error code>", "message": "<ja message>", "fieldErrors": { "<key>": "<code>" }, "formErrors": ["<code>"] }
```

`fieldErrors` and `formErrors` appear for `validation_failed` only. API error codes and statuses are in `messages.ja.json`:

| Code | Status |
| --- | --- |
| `form_unavailable` | 404/410 |
| `form_version_changed` | 409 |
| `idempotency_conflict` | 409 |
| `validation_failed` | 422 |
| `verification_failed` | 422 |
| `payload_too_large` | 413 |
| `rate_limited` | 429 |
| `temporarily_unavailable` | 503 |

A malformed or superseded `version` is `form_version_changed`; it never falls back to the latest version.

## 7. Consuming the fixtures from PHP

YatrisCMS vendors this directory at a pinned `@yatris/astro` version and records its SHA-256 digests. A test fails when the vendored copy drifts from the recorded digests, and the parity tests run every fixture through the PHP validator, evaluator, normalizer, projection and request hash. Read the fixtures as data; never execute them.

## 8. Astro renderer and CLI (`@yatris/astro`)

These names are frozen for contract v1; agents and the skill may teach them.

### Placing a form

```astro
---
import YatrisForm from '@yatris/astro/YatrisForm.astro';
---
<YatrisForm form="contact" />
<YatrisForm form="contact" hidden={{ source: 'lp-a' }} classes={{ submit: 'btn btn-primary' }} class="my-form" />
```

| Prop | Meaning |
| --- | --- |
| `form` | The form key (`src/forms/<key>.json`). Required. |
| `hidden` | Values for declared `hidden` fields only. Other keys are ignored (with a console warning). At most 500 characters each. |
| `classes` | Extra classes per element: `root`, `form`, `field`, `label`, `input`, `choice`, `help`, `error`, `actions`, `submit`, `success`. |
| `class`, `id` | On the mount element. |

The page ships a mount element, a JSON configuration (mode, public key, definition URL, time zone) and the bundled renderer (`@yatris/astro/forms/client`, vanilla TypeScript). On load the renderer fetches the published definition (normal HTTP caching, so Yatris's ETag applies), checks `contractVersion` and `capabilities` against `SUPPORTED_CAPABILITIES`, and renders. A definition it cannot fully draw gets the unavailable state, never a partial form. A failed load shows a retry button; a missing form (404/410) does not. Without JavaScript a `<noscript>` explanation shows. The renderer runs conditions with `evaluateActivity` semantics and validates with `validateSubmission` before sending, then submits as §6 describes. It redirects only after an `accepted` response, and only to the definition's `success.redirectPath`. Turnstile loads from `https://challenges.cloudflare.com` only when the definition has `submission.turnstile`; a site with a Content-Security-Policy must allow that origin and the Yatris origin.

Modes, decided at build time by the integration:

| Mode | When | Mount |
| --- | --- | --- |
| `live` | A paired project (`.yatris/project.json` has `websiteId`) | Fetches `<origin>/api/v1/forms/<websiteId>.<key>` |
| `preview` | `astro dev` **and** `YATRIS_FORMS_PREVIEW=1` | Renders the public projection of `src/forms/<key>.json` |
| `unconfigured` | Anything else (an unpaired project) | Unavailable state; no request |

### Local preview

Set `YATRIS_FORMS_PREVIEW=1` for `astro dev` only, for example in `.env.development.local` (builds never read it). The integration converts each `src/forms/*.json` with `toPublicDefinition`, so mail settings, recipients and quiz answers never reach the browser even in preview. A preview form shows a visible marker naming its source file, a scenario switch (accepted/redirect as declared, `validation_failed`, `verification_failed`, `form_version_changed`, `idempotency_conflict`, `payload_too_large`, `rate_limited`, `temporarily_unavailable`, `form_unavailable`, network failure) and the request it would have sent. It sends nothing. An invalid declaration shows its validation issues instead of a form.

`astro build` **refuses** `YATRIS_FORMS_PREVIEW` (set in the environment or in `.env`/`.env.production`) with an error. A build never reads `src/forms/` and resolves the preview module to `null`, so no declaration content and no preview code reach `dist/`. No configuration gap ever falls back to preview.

### Styling contract

Classes (stable; `data-*` attributes carry state):

| Class | Element |
| --- | --- |
| `yf-root` | The mount. `data-yf-state`: `loading`, `ready`, `confirm`, `done`, `unavailable`. `data-yf-step`, `data-yf-mode`, `data-yf-pending`, `data-yf-preview`. Gets `yf-pending` while sending. |
| `yf-form`, `yf-section` | The input step and its field list. |
| `yf-field` | Each input wrapper (`fieldset` for radio and checkboxes, with `yf-choice-group`). `data-yf-field` (key), `data-yf-type` (type), `data-yf-state="invalid"`, `data-yf-changed="true"` after a version change. |
| `yf-label`, `yf-required`, `yf-help`, `yf-error` | Label or legend, its 必須 marker, help text, the field's error. |
| `yf-input` | Text-like inputs, `select`, `textarea`, range and file inputs. |
| `yf-choices`, `yf-choice`, `yf-choice-input`, `yf-choice-label` | Choice lists, each `label`, its input and text. |
| `yf-counter`, `yf-range-value` | Character counter; the range's shown value (`output`). |
| `yf-consent`, `yf-policy` | Acceptance consent text and privacy-policy link. |
| `yf-file`, `yf-file-limits`, `yf-file-list`, `yf-file-item`, `yf-file-name`, `yf-file-size`, `yf-file-remove` | File fields and the attached-file list. |
| `yf-quiz-question` | The quiz question. |
| `yf-heading`, `yf-help-text`, `yf-divider`, `yf-group`, `yf-legend`, `yf-reflection`, `yf-reflection-label`, `yf-reflection-value` | Display nodes. Headings render as `h2`–`h4` from `level` (default 2). |
| `yf-error-summary`, `yf-error-summary-title`, `yf-form-error`, `yf-changed-note` | Error summary with links, form-level messages, changed-field note. |
| `yf-actions`, `yf-submit`, `yf-back`, `yf-turnstile` | Buttons and the Turnstile slot. |
| `yf-steps`, `yf-step` | 入力→確認→完了 indicator (`aria-current="step"`). |
| `yf-confirm`, `yf-confirm-heading`, `yf-confirm-intro`, `yf-confirm-list`, `yf-confirm-row` | The confirmation step. |
| `yf-status`, `yf-success`, `yf-success-message`, `yf-unavailable`, `yf-unavailable-message`, `yf-retry`, `yf-loading`, `yf-noscript` | Status, success, unavailable, loading and no-JavaScript states. |
| `yf-preview-marker` | The preview marker (dev only). |

The default stylesheet (`components/YatrisForm.css`) puts every rule inside `:where()`, so it has zero specificity and any site rule wins. There is no reset and no palette: colours derive from `currentColor` unless these custom properties are set on `.yf-root` or an ancestor: `--yf-gap`, `--yf-radius`, `--yf-border`, `--yf-control-bg`, `--yf-focus`, `--yf-error`, `--yf-muted`.

### Behaviour details

- Inactive nodes are hidden; inactive inputs lose their value and error, and file fields detach their files. A field that becomes active again starts empty. Declared `hidden` metadata keeps its value but is sent only while active.
- An untouched `range` without a `default` has no answer.
- Kana presets and `validation.format` show the normalized value when the visitor leaves the field.
- Field errors show on leaving a field (except "required"), as soon as files are chosen, and on submit. Submit shows an error summary with links and focuses the first invalid control.
- One `idempotencyKey` (`crypto.randomUUID`) per deliberate submission. A retry after a network failure, `temporarily_unavailable`, `rate_limited` or `verification_failed` with unchanged answers reuses the key and the exact `answers` string. Any other rejection, or changed answers, makes a new one.
- `form_version_changed` reloads the definition (revalidating), keeps answers that still fit the same key and type, asks again for changed consent and the quiz, marks changed fields and waits for the visitor. It never resubmits.
- After `accepted` the form state is cleared before the success message or the redirect, so going back never shows or resends answers.

### CLI

| Command | Behaviour |
| --- | --- |
| `yatris forms validate [--dir=src/forms]` | Runs `validateDeclaration` on every `*.json` (not `*.brief.json`), checks the file name matches `key`, prints `path code` findings and warnings. Offline. Exits 1 on any error. |
| `yatris forms plan`, `apply`, `pull` | Synchronization with Yatris is not available yet. They say so, touch nothing and exit 69 (`EX_UNAVAILABLE`). |
