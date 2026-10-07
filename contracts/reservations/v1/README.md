# Yatris reservation contract, version 1

This directory is the shared contract for Yatris reservations. The repository declaration, the hosted booking UI on `book.yatris.jp`, the YatrisCMS validators and APIs, and the reservation agent skill all use it.

Product decisions behind it: YatrisCMS `YATRIS-RESERVATIONS-SPEC.md` and `YATRIS-RESERVATIONS-DECISIONS.md` (the decision record wins where the two conflict). Questions reuse the contact-form contract, [`contracts/forms/v1`](../../forms/v1/README.md) ("forms" below); this contract never forks it.

| File | What it is |
| --- | --- |
| `setup.schema.json` | JSON Schema (draft 2020-12) for a setup declaration. The operations object is `$defs.operations`. Generated; do not edit. |
| `messages.ja.json` | Japanese visitor messages and HTTP statuses for the API error codes (`apiErrors`). Generated. |
| `examples/consultation.json` | Time slot: online and in-person locations, two hosts, automatic confirmation. |
| `examples/salon.json` | Business, service: two practitioners and a room, variants, a sensitive allergy question with consent. |
| `examples/restaurant.json` | Business, party: tables with one combination, manual approval. |
| `fixtures/*.json` | Shared fixtures. Every implementation must pass all of them. Generated from `packages/astro/test/reservations-fixtures.ts`, where the expectations are written by hand. |

The JavaScript reference implementation is `@yatris/astro/reservations` (`packages/astro/src/reservations/`). The PHP twin is YatrisCMS `App\Support\Reservations\Contract`. The JSON Schema serves editors and agents. **The validators are authoritative.** They add the semantic rules below that a JSON Schema cannot express.

To regenerate after changing the registry or the fixtures:

```sh
YATRIS_UPDATE_CONTRACT=1 npx vitest run packages/astro/src/reservations
```

Adding a property, a code or a rule is a contract change. It must update the registry, both validators, the hosted UI and these fixtures together.

## 1. Setup declaration

A setup is one JSON object per reservation page, stored at `src/reservations/<key>.json` in the Website repository. It declares the structure, questions and presentation. Website identity comes from the pairing contract, never from the declaration. The declaration never holds recipients, SMTP settings, calendar identifiers or any other secret.

| Property | Rule | Required |
| --- | --- | --- |
| `$schema` | string, 1–500 | no |
| `contractVersion` | integer, exactly `1` | yes |
| `key` | `^[a-z][a-z0-9-]{0,63}$`. Immutable: renaming is a removal plus an addition. | yes |
| `name` | single-line, 1–200 | yes |
| `locale` | `ja`. Japanese only in v1; anything else is `invalid_enum`. | yes |
| `mode` | `time_slot` or `business` | yes |
| `presentation` | `party` or `service`. Required for `business`, not allowed for `time_slot` (§3). | no |
| `identityFields` | `{ name, email, phone? }`, each a question key (`^[a-z][a-z0-9_]{0,63}$`) | yes |
| `questions` | forms node list (every forms node type), 1–200 top-level nodes | yes |
| `copy` | `{ pendingMessage?, confirmedMessage? }`, multi-line, 1–2000 each | no |
| `success` | `{ redirectPath }` (forms path grammar); `redirectPath` is required inside it | no |
| `operations` | the operations seed (§2) | no |

- **Questions** are forms nodes. Every node rule of forms §1–§3 applies, including `sensitive: true` (forms "Sensitive questions"): consumers keep sensitive answers off mail, calendar events, ICS files, notifications, logs, analytics and agent access. Conditions may also reference the `booking.*` question context (§4).
- **Operations seed.** The repository may supply initial operational values. Yatris uses them **once**, when it creates the setup. Afterwards operations live only in Yatris as operations revisions; synchronization covers the setup definition only and never compares, overwrites or reports operations as drift. A seed is validated exactly as a live revision, with paths under `/operations`.

## 2. Operations

An operations object is the declaration seed and also the shape of every live operations revision in Yatris. Every top-level property is optional at shape level; the mode sections are required semantically (§3, rule 7). Unknown properties are rejected everywhere.

| Property | Rule |
| --- | --- |
| `timezone` | string, 1–64; a valid IANA zone (§3, rule 1) |
| `slotIntervalMinutes` | integer 5–120 that divides 1440 |
| `bookingHorizonDays` | integer 1–365 |
| `minimumLeadMinutes` | integer 0–43200 |
| `holdMinutes` | integer 1–30 |
| `confirmationMode` | `automatic` or `manual`. Never inferred: publication needs an explicit value. |
| `approvalWindowMinutes` | integer 15–10080 (used in manual mode) |
| `cancelCutoffMinutes`, `rescheduleCutoffMinutes` | integer 0–43200 |
| `reminderMinutesBefore` | integer 60–10080 (visitor reminder; never public) |
| `venueHours` | `{ weekly?: hours list, exceptions?: exception list }` |
| `locations` | 1–10 of `{ key, type, label, meetingUrl?, address?, instructions? }`; `type` is `online`, `in_person` or `phone`; `meetingUrl` string 1–2000, `address` multi-line 1–500, `instructions` multi-line 1–1000 |
| `resources` | 0–200 of `{ key, kind, label, capacity?, seats?, weeklyHours?, exceptions? }`; `kind` is `host`, `practitioner`, `room`, `equipment`, `table` or `pool`; `capacity` integer 1–10000; `seats` `{ min, max }` integers 1–500, both required |
| `appointment` | `{ durationMinutes, bufferBeforeMinutes?, bufferAfterMinutes?, hostStrategy, hostResourceKeys, visitorChoosesHost? }`; duration 5–480, buffers 0–240, `hostStrategy` `single` or `one_available`, 1–50 unique keys |
| `services` | 1–100 of `{ key, label, durationMinutes, bufferBeforeMinutes?, bufferAfterMinutes?, variants?, requirements, visitorChoosesPractitioner? }`; `variants` 1–20 of `{ key, label, durationMinutes }`; `requirements` 1–5 of `{ resourceKeys (1–50 unique keys), count (1–5) }` |
| `party` | `{ minSize, maxSize, durationMinutes, bufferAfterMinutes?, strategy, poolResourceKey?, tableResourceKeys?, combinations? }`; sizes 1–500, duration 15–720, `strategy` `pool` or `tables`, `tableResourceKeys` 1–200 unique keys, `combinations` 0–100 of `{ key, resourceKeys (2–4 unique keys), seats }` |

- **Keys** (locations, resources, services, variants, combinations and every reference) use the node key grammar `^[a-z][a-z0-9_]{0,63}$`. Labels are single-line, 1–200.
- **Hours list:** 0–50 of `{ day, start, end }`, all required. `day` is `monday` … `sunday`. Times match `^([01][0-9]|2[0-3]):[0-5][0-9]$` (`00:00`–`23:59`).
- **Exception list:** 0–366 of `{ date, closed?, hours? }`. `date` is `YYYY-MM-DD` (forms date pattern, then a real calendar date); `hours` is 1–10 of `{ start, end }`.

## 3. Validation

Value rules are forms §2 "Value rules": integers may be written `1.0`, lengths count code points, single-line and multi-line text rules, ECMAScript patterns with the `u` flag (PHP: PCRE `/u`).

Validation runs in two phases, exactly as forms. **Shape** covers the whole setup, questions and operations seed included, with the forms shape engine and codes: `invalid_type`, `required_property`, `unknown_property`, `too_short`, `too_long`, `pattern_mismatch`, `invalid_enum`, `out_of_range`, `not_unique`, `invalid_decimal`, `unknown_node_type`, `invalid_condition`, `condition_too_deep`. **If any shape issue exists, every semantic rule is skipped** (there are no warnings either).

Issues are `{ path, code }` with `path` a JSON Pointer (`""` is the root). Lists are **deduplicated and sorted by path, then code**, comparing strings by UTF-16 code unit (forms `tidy`; PHP `strcmp` on UTF-8 gives the same order for these ASCII paths and codes). Indices compare as strings, so `/x/10` sorts before `/x/2`. Fixtures list issues in exactly this order.

### Setup semantics

| Code | Path and rule |
| --- | --- |
| `required_property` | `/presentation` when `mode` is `business` and it is missing. |
| `presentation_not_allowed` | `/presentation` when `mode` is `time_slot` and it is present. |
| forms node and condition codes | Every forms §2 and §3 rule on `questions`, run as forms `validateQuestions(questions, { context })` with the context of §4 (built from the seed when present, otherwise with options unknown). Every issue path is re-rooted from `/fields` to `/questions`: `/fields/2/visibleWhen/field` becomes `/questions/2/visibleWhen/field`. For example a `booking.*` key the mode does not have is `unknown_reference`; a service key missing from the seed is `invalid_condition_value`. |
| `identity_field_invalid` | `/identityFields/name` unless it names a `text` input with `required: true`, no `visibleWhen`, no `requiredWhen`, and no ancestor group (at any depth) with `visibleWhen`. `/identityFields/email`: the same with an `email` input. `/identityFields/phone`, when given: it must name a `tel` input, which may be optional and conditional. Any of them naming no question, or a question with `sensitive: true`, is also invalid. With duplicate question keys the first node in document order counts. |
| operations codes | When `operations` is present: every operations rule below with the setup's `mode` and `presentation`, paths under `/operations`. A `business` setup without `presentation` skips rule 7 only. |

### Operations semantics

Inputs: the operations object, `mode`, `presentation` (ignored for `time_slot`; `null` for `business` skips rule 7) and a path prefix (`/operations` in a declaration, `""` for a live revision). Every rule runs on whatever is present, including sections that rule 7 rejects for the mode.

| # | Code | Path and rule |
| --- | --- | --- |
| 1 | `invalid_timezone` | `/timezone`: not a valid IANA zone. Valid means it matches `^(?:UTC\|[A-Z][A-Za-z_]*(?:/[A-Z][A-Za-z0-9_+-]*){1,2})$` **and** the runtime time-zone database accepts it (JS: `new Intl.DateTimeFormat('en-US', { timeZone })` does not throw; PHP: `new DateTimeZone($tz)` does not throw). The pattern alone rejects offsets (`+09:00`), abbreviations (`JST`), single-segment legacy names (`Japan`) and lower-case spellings; aliases such as `Asia/Calcutta` are accepted. |
| 1 | `invalid_slot_interval` | `/slotIntervalMinutes`: `1440 % value !== 0`, so the slot grid restarts identically every local midnight. |
| 2 | `duplicate_key` | `…/key` of the later item, within each list on its own: `locations`, `resources`, `services`, one service's `variants`, `party.combinations`. Variant keys may repeat across services. |
| 3 | `invalid_interval` | The hours entry (`…/weekly/i`, `…/weeklyHours/i`, `…/exceptions/i/hours/j`) when `start >= end`. Such an entry takes no part in overlap checks. |
| 3 | `overlapping_hours` | The later entry when it overlaps an earlier valid entry of the same `day` (weekly lists) or of the same exception: half-open, `a.start < b.end && b.start < a.end`; touching (`12:00` end, `12:00` start) is allowed. `HH:MM` strings compare correctly as strings. Reported once per entry. |
| 4 | `invalid_exception` | The exception entry when it has neither `closed: true` nor `hours`, or both. (`closed: false` with `hours` is valid; `closed: false` alone is not.) |
| 4 | `invalid_date` | `…/date` when the date is not a real calendar date (forms date rule, e.g. `2027-02-30`). |
| 4 | `duplicate_date` | The later exception entry with the same `date` within one list (venue and each resource are separate lists). |
| 5 | `location_field_not_allowed` | `…/meetingUrl` on a location whose `type` is not `online`; `…/address` on one whose `type` is not `in_person`. (`instructions` is allowed on every type.) |
| 5 | `invalid_url` | `…/meetingUrl` on an `online` location when it does not match `^https://[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*(?::[0-9]{1,5})?(?:[/?#][\x21-\x7E]*)?$`: lower-case `https://`, a DNS host of ASCII labels (no credentials, no IP literal, IDN as punycode), an optional port, then printable ASCII only (percent-encode anything else). |
| 6 | `required_property` | `/resources/i/capacity` on a `pool` without it; `/resources/i/seats` on a `table` without it. |
| 6 | `resource_field_not_allowed` | `capacity` on any kind but `pool`; `seats` on any kind but `table`. |
| 6 | `min_exceeds_max` | `/resources/i/seats` when `seats.min > seats.max` (checked whenever `seats` is present). |
| 7 | `required_property` | The mode section when missing: `/appointment` for `time_slot`, `/services` for `business` + `service`, `/party` for `business` + `party`. A live revision is always complete; the same rule applies. |
| 7 | `section_not_allowed` | `/appointment`, `/services` or `/party` when present but not the mode's section. |
| 8 | `unknown_resource` | The referencing pointer (`…/hostResourceKeys/i`, `…/requirements/j/resourceKeys/k`, `/party/poolResourceKey`, `/party/tableResourceKeys/i`, `/party/combinations/i/resourceKeys/k`) when no resource has that key. With duplicate resource keys the first resource counts. |
| 8 | `resource_kind_mismatch` | The same pointers when the resource has the wrong kind: host keys need `host`; requirement keys need `practitioner`, `room` or `equipment`; `poolResourceKey` needs `pool`; table keys and combination keys need `table`. |
| 9 | `single_host_count` | `/appointment/hostResourceKeys` when `hostStrategy` is `single` and there is not exactly one key. |
| 9 | `host_choice_not_allowed` | `/appointment/visitorChoosesHost` when it is `true` with `hostStrategy: single`. |
| 10 | `count_exceeds_resources` | `/services/i/requirements/j/count` when `count` exceeds the number of `resourceKeys`. |
| 11 | `min_exceeds_max` | `/party` when `minSize > maxSize`; `/party/combinations/i/seats` when a combination's `seats.min > seats.max`. |
| 11 | `required_property` | `/party/poolResourceKey` for `strategy: pool` without it; `/party/tableResourceKeys` for `strategy: tables` without it. |
| 11 | `party_field_not_allowed` | `/party/tableResourceKeys` and `/party/combinations` with `strategy: pool`; `/party/poolResourceKey` with `strategy: tables`. |
| 11 | `combination_table_not_listed` | `/party/combinations/i/resourceKeys/k` when `tableResourceKeys` is present and does not contain that key (in addition to any rule 8 issue on the same pointer). |

**Warnings** never make a value invalid. There is one: `confirmation_mode_missing` at `<prefix>/confirmationMode` when the operations object (seed or revision) has no `confirmationMode`; publication needs an explicit choice. Recipients are never part of a declaration or an operations object, so no recipient warning exists.

## 4. Question context

`reservationContext(setup, operations | null)` builds the forms question context (forms §3 "Question context") that the setup's questions are validated and evaluated with. Keys by mode:

| Key | Kind | Options when operations are known | Modes |
| --- | --- | --- | --- |
| `booking.location_key` | `choice` | `locations[].key` | all |
| `booking.starts_at` | `datetime` | none | all |
| `booking.host_key` | `choice` | `appointment.hostResourceKeys` | `time_slot` |
| `booking.service_key` | `choice` | `services[].key` | `business` + `service` |
| `booking.variant_key` | `choice` | every variant key across services | `business` + `service` |
| `booking.party_size` | `decimal` | none | `business` + `party` |

- Entries appear in this order. With `operations` `null`, choice entries have no `options` (any string is accepted). With operations, `options` lists the keys in first-appearance order, deduplicated, and is `[]` when the list or section is absent. `time_slot` ignores `presentation`; `business` without `presentation` has only the first two keys.
- **Values** at evaluation time come from the selected booking, never from visitor answers. `booking.starts_at` is the local date-time `YYYY-MM-DDTHH:MM:SS` in the venue timezone; `booking.party_size` is the party size as a decimal string.
- A seed-less setup is validated with options unknown, but publication (and the public definition, §5) validates the questions against the context of the **live** operations: a condition on a removed service is then `invalid_condition_value` and blocks publication.

## 5. Public definition

`GET <definition URL>` on the booking host returns what the hosted UI needs to draw a setup and book it, and nothing else. `reservationPublicDefinition(setup, operations, meta)` builds it (PHP: `ReservationPublicDefinition::definition`). It throws unless the setup and the operations validate without errors, the questions validate against the question context of these operations (§4), and `operations.confirmationMode` is set: a public definition exists only for a publishable setup.

```json
{
  "contractVersion": 1,
  "setup": { "key", "name", "locale", "mode", "presentation"?, "version", "operationsRevision", "digest" },
  "questions": [ "<forms public projection of each node>" ],
  "identityFields": { "name", "email", "phone"? },
  "copy": { "pendingMessage"?, "confirmedMessage"? },
  "success": { "redirectPath" } | null,
  "policies": { "timezone", "slotIntervalMinutes", "bookingHorizonDays", "minimumLeadMinutes", "holdMinutes", "confirmationMode", "approvalWindowMinutes"?, "cancelCutoffMinutes", "rescheduleCutoffMinutes" },
  "locations": [ { "key", "type", "label" } ],
  "appointment"?: { "durationMinutes", "visitorChoosesHost", "hosts": [ { "key", "label" } ] },
  "services"?: [ { "key", "label", "durationMinutes", "variants": [ { "key", "label", "durationMinutes" } ], "visitorChoosesPractitioner", "practitioners": [ { "key", "label" } ] } ],
  "party"?: { "minSize", "maxSize", "durationMinutes" },
  "turnstile": { "siteKey", "action" } | null,
  "endpoints": { "<name>": "<absolute URL>" }
}
```

- `setup.presentation` appears for `business` only. `version` and `operationsRevision` come from `meta` (the published setup version and the live operations revision); `turnstile` and `endpoints` are copied from `meta` as given.
- `questions` is exactly the forms public projection of `fields` (registry properties only, decimals as canonical strings, quiz answers dropped). The `sensitive` marker stays visible so the UI can say so.
- `identityFields` and `copy` are copied as declared (`copy` is `{}` when absent). `success` is `null` when absent.
- `locations` is `[]` when the operations have none. Exactly one of `appointment` (`time_slot`), `services` (`service`) or `party` (`party`) appears.
- `appointment.visitorChoosesHost` defaults to `false`; `hosts` lists `hostResourceKeys` in order with their resource labels when it is `true`, else `[]`.
- `services[].variants` is `[]` without variants; `visitorChoosesPractitioner` defaults to `false`; `practitioners` is, when it is `true`, every resource key of the service's requirements in order of first appearance, deduplicated, keeping only `practitioner` kinds, with labels; else `[]`.
- **Policy defaults** when the operations omit a value: `timezone` `Asia/Tokyo`, `slotIntervalMinutes` 15, `bookingHorizonDays` 90, `minimumLeadMinutes` 120, `holdMinutes` 5, `cancelCutoffMinutes` 1440, `rescheduleCutoffMinutes` 1440. `approvalWindowMinutes` (default 1440) appears only when `confirmationMode` is `manual`. Yatris's own non-public default for `reminderMinutesBefore` is 1440.
- **Never exposed:** `meetingUrl`, `address`, `instructions`, resource kinds, hours, exceptions, capacities and seats, table and combination data, buffers, requirements, `hostStrategy`, `reminderMinutesBefore`, venue hours, recipients, SMTP or calendar data, drafts, other visitors' bookings, sensitive answers and quiz answers. Meeting details reach only the booked visitor (confirmation mail and management page).

`digest` is `"sha256:" + hex(sha256(canonical JSON of the public content))`, where the public content is the definition **without** `setup.version`, `setup.operationsRevision`, `setup.digest`, `turnstile` and `endpoints` (it keeps `contractVersion`). Canonical JSON is forms §6: keys sorted by UTF-16 code unit, no whitespace, integers only, `JSON.stringify` escaping (PHP `JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_LINE_TERMINATORS`). `reservationDigest(setup, operations)` (PHP `ReservationPublicDefinition::digest`) returns it. `fixtures/public.json` holds the expected definitions.

## 6. Time, intervals and daylight saving

These rules bind the availability engine, holds and bookings (spec §5.1).

- **Half-open intervals.** Every interval is `[start, end)`. An allocation ending at 12:00 can precede one starting at 12:00 unless buffers extend it. The scheduled interval is `[start, start + duration)`; the occupied interval of each resource is `[start − bufferBefore, end + bufferAfter)`. Yatris stores scheduled and occupied start/end separately and computes occupied intervals on the server only.
- **Venue timezone.** Weekly hours, exceptions, the slot grid, the horizon and the `booking.starts_at` context value use `operations.timezone` (default `Asia/Tokyo`), never the server timezone. Dated occurrences are converted to UTC for storage and comparison. Timezone and locale are independent.
- **Slot grid.** Slots start at local times that are multiples of `slotIntervalMinutes` after local midnight (the interval divides 1440). Durations and buffers need not be multiples of it.
- **Hours.** Weekly entries are local wall-clock ranges within one day (`00:00`–`23:59`; overnight ranges are not expressible in v1). A dated exception replaces that date's weekly hours (`closed: true` closes the whole date). Resource hours and exceptions further restrict venue hours.
- **Daylight saving.** Nonexistent local times (spring-forward gap) are never offered. Repeated local times (fall-back overlap) are distinct instants and are distinguished by their UTC offset; both may be offered. All-day calendar events use their calendar's timezone and exclusive end date. Every timestamp on the wire is ISO 8601 with an explicit offset (`2026-11-03T10:00:00+09:00`); a time without an offset is rejected.
- **Lead time and horizon.** A slot is offered only when `start ≥ now + minimumLeadMinutes` and its local date is no later than the venue-local today plus `bookingHorizonDays`.
- **Concurrency.** PostgreSQL enforces allocation correctness inside one transaction (spec §5.3): browsing reserves nothing; a hold reserves the complete bundle; final submit converts a valid hold atomically.

## 7. Wire formats

The booking host is `book.yatris.jp`. The definition URL is `https://book.yatris.jp/api/public/websites/{websiteId}/reservations/{setupKey}`; the hosted page is `https://book.yatris.jp/book/{websiteId}/{setupKey}`. Every other endpoint is taken from the definition's `endpoints` object, never constructed by the client:

| `endpoints` key | Operation |
| --- | --- |
| `availability` | `POST`: selectable times |
| `holds` | `POST`: acquire or replace a hold |
| `bookings` | `POST`: submit a booking |
| `receipt` | `GET`: acceptance status |

Requests and responses are JSON (`bookings` is multipart). All mutations are idempotent or protected as described, and none depends on client-side disabling.

### Selection

Availability and holds take a `selection` object; unknown properties and keys not in the definition are `validation_failed`.

| Property | When |
| --- | --- |
| `locationKey` | A `locations[].key`. Required when `locations` is not empty. |
| `hostKey` | `time_slot` only, and only when `visitorChoosesHost`; optional (absent: any available host). |
| `serviceKey` | `service` only; required. |
| `variantKey` | `service` only; required when the service has variants, else not allowed. |
| `practitionerKey` | `service` only, and only when the service's `visitorChoosesPractitioner`; optional; one of its `practitioners`. |
| `partySize` | `party` only; required; an integer from `minSize` to `maxSize`. |

### `POST availability`

```json
{ "from": "2026-11-02", "to": "2026-11-08", "selection": { "locationKey": "office" } }
```

`from` and `to` are venue-local dates, `from ≤ to`, at most 30 days apart (31 days inclusive), both within today … today + `bookingHorizonDays`. Response `200`:

```json
{
  "timezone": "Asia/Tokyo",
  "operationsRevision": 7,
  "days": [ { "date": "2026-11-02", "slots": [ { "start": "2026-11-02T10:00:00+09:00", "end": "2026-11-02T11:00:00+09:00" } ] } ]
}
```

`days` lists every date from `from` to `to` in order (`slots: []` when none); slots are ordered by start and `end` is the scheduled end (no buffers). Availability never returns external event titles, owners or resource identities. A different `operationsRevision` from the definition's means the UI must reload the definition.

### `POST holds`

```json
{ "selection": { "locationKey": "office" }, "start": "2026-11-02T10:00:00+09:00", "turnstileToken": "<token>", "replaceHoldToken": "<previous holdToken>" }
```

`start` must be a slot start currently offered for that selection. Turnstile is verified server-side for the booking host and action. Acquiring a hold releases the visitor session's previous hold for the setup in the same transaction; `replaceHoldToken` names it explicitly. Response `201`:

```json
{ "holdToken": "<random>", "expiresAt": "2026-11-01T15:05:00+09:00", "start": "…", "end": "…", "hostLabel": "佐藤" }
```

The token is random, expires after `holdMinutes` on the server and is bound to the setup, the selection, the visitor session and the setup version and operations revision. It cannot be extended. `hostLabel` (time slot) and `practitionerLabel` (service) appear only when the definition lets the visitor choose that resource, naming the chosen or assigned one.

### `POST bookings`

`multipart/form-data` parts:

| Part | Content |
| --- | --- |
| `holdToken` | From `POST holds`. |
| `answers` | JSON object, forms §4 answers format. Normalized and validated with the setup's question context values for the held selection; visitors can never set `booking.*` keys. |
| `setupVersion` | `setup.version` the visitor saw. |
| `operationsRevision` | `setup.operationsRevision` the visitor saw. |
| `idempotencyKey` | 16–128 chars of `[A-Za-z0-9_-]` (forms). One per deliberate submission, reused on retry. |
| `turnstileToken` | When the definition has `turnstile`; verified server-side (spec §10: holds and final submit are both protected). |
| `files[<fieldKey>][]` | One part per file, forms §6. |
| `hp_website` | Honeypot; must be empty. |

Idempotency is scoped to the Website, setup and operation, persisted and checked against a server-side request digest: a retry with the same key and request returns the same receipt and state (even after the hold expired); the same key with a different request is `idempotency_conflict` and creates nothing. Response `202`:

```json
{ "status": "accepted", "receipt": "<opaque>", "state": "pending_approval", "approvalDeadline": "2026-11-01T23:00:00+09:00", "success": { "mode": "message", "message": "<ja message>" } }
```

- `state` is `confirmed` (automatic and secured), `pending_approval` (manual) or `confirming` (accepted; final steps such as a calendar recheck are still running; poll `receipt`). `approvalDeadline` appears only with `pending_approval`.
- `success` is `{ "mode": "redirect", "path": <success.redirectPath> }` when the setup declares `success`, else `{ "mode": "message", "message": … }` with `copy.pendingMessage` or `copy.confirmedMessage` for the state, or a default Japanese message. The UI treats only a 2xx with `status: "accepted"` as success.
- `receipt` is a scoped receipt token for this visitor's booking only.

### `GET receipt`

`GET <endpoints.receipt>` with `Authorization: Bearer <receipt>` returns `200 { "receipt", "state" }`, where `state` is one of `confirming`, `confirmed`, `pending_approval`, `rejected`, `expired` (approval window closed) or `cancelled`. It returns nothing about the booking beyond that.

### Management

Visitors manage a booking on a Yatris-hosted page reached by the management link in their mail. Cancel and reschedule are `POST` requests from that page with the booking-host management session (host-only cookie) and a CSRF token, rate-limited. Cutoffs come from `cancelCutoffMinutes` / `rescheduleCutoffMinutes` (`deadline_passed`). Rescheduling takes a new hold; in manual mode it is a change request and the original booking stays valid until the replacement is approved and secured.

### Errors

```json
{ "status": "rejected", "code": "<code>", "message": "<ja message>", "fieldErrors": { "<key>": "<code>" }, "formErrors": ["<code>"] }
```

`fieldErrors` and `formErrors` appear for `validation_failed` only (forms §4 codes; selection or window problems are `formErrors` `invalid_selection` / `invalid_window`). `message` is the stable sentence in `messages.ja.json` `apiErrors`, used by both sides. Never a raw provider error or credential.

| Code | Status | When |
| --- | --- | --- |
| `validation_failed` | 422 | Answers, selection, window or parts are invalid. |
| `version_changed` | 409 | `setupVersion` or `operationsRevision` is not current (malformed counts as changed). Compatible answers are kept; availability is recalculated. |
| `hold_expired` | 409 | The hold token expired, was replaced or is unknown. |
| `slot_unavailable` | 409 | The selected start is no longer available. |
| `approval_window_closed` | 409 | No usable approval window remains before the appointment (manual mode). |
| `deadline_passed` | 409 | A cancel or reschedule cutoff has passed. |
| `calendar_unavailable` | 503 | External calendar availability cannot be checked. |
| `rate_limited` | 429 | Per-visitor or per-Website limits. |
| `verification_failed` | 403 | Turnstile, honeypot or management session/CSRF verification failed. |
| `temporarily_unavailable` | 503 | Any other temporary failure; nothing was created. |
| `setup_unavailable` | 404 | Unknown, unpublished or disabled setup. |
| `idempotency_conflict` | 409 | Same idempotency key, different request. |
| `payload_too_large` | 413 | Request or upload limits exceeded. |

## 8. Consuming the fixtures from PHP

YatrisCMS vendors this directory at a pinned `@yatris/astro` version, records its SHA-256 digests, and runs every fixture through the PHP twin. Read the fixtures as data; never execute them. PHP consumers decoding with `json_decode(..., true)` cannot tell an empty list `[]` from an empty object `{}`, so the fixtures never use `[]` where an object is expected (non-object cases use a string); an empty `{}` is treated as an object.

| File | Entries | Check |
| --- | --- | --- |
| `setups.json` | `{ name, setup, errors, warnings }` | `SetupValidator::validate(setup)` returns exactly `errors` and `warnings`, in order. |
| `operations.json` | `{ name, mode, presentation, operations, errors, warnings }` | `OperationsValidator::validate(operations, mode, presentation, '')` (live-revision form, prefix `""`), exactly, in order. |
| `context.json` | `{ name, setup, operations, expected }` | `ReservationContext::for(setup, operations)` equals `expected` (`operations` may be `null`). |
| `public.json` | `{ name, setup, operations, meta, expected }` | `ReservationPublicDefinition::definition(setup, operations, meta)` equals `expected`, digest included. |

## 9. Package exports (`@yatris/astro/reservations`)

These names are frozen for contract v1.

| TypeScript | PHP twin |
| --- | --- |
| `RESERVATION_CONTRACT_VERSION` | — |
| `validateSetup(value)` → `{ valid, errors, warnings }` | `SetupValidator::validate` |
| `validateOperations(value, { mode, presentation?, pathPrefix? })` → same | `OperationsValidator::validate($ops, $mode, $presentation, $prefix = '')` |
| `reservationContext(setup, operations \| null)` | `ReservationContext::for($setup, $ops)` |
| `reservationPublicDefinition(setup, operations, meta)` (async) | `ReservationPublicDefinition::definition($setup, $ops, $meta)` |
| `reservationDigest(setup, operations)` (async), `reservationPublicContent(setup, operations)` | `ReservationPublicDefinition::digest` |
| `RESERVATION_API_ERRORS` | `Messages::API_ERRORS` |
| `setupJsonSchema()`, `SETUP_SCHEMA_ID` | — |
| `isValidTimezone`, `TIMEZONE_PATTERN`, `isHttpsUrl`, `HTTPS_URL_PATTERN`, `HOURS_TIME_PATTERN`, `SETUP_KEY_PATTERN`, `DEFAULT_POLICIES`, `SETUP`, `OPERATIONS`, `MODES`, `PRESENTATIONS`, `RESOURCE_KINDS`, `LOCATION_TYPES`, `WEEKDAYS` | — |

`validateOperations` and `reservationContext` throw a `TypeError` for a `mode` outside `time_slot` / `business` or a `presentation` outside `party` / `service` / `null`: options are consumer configuration, not visitor input.
