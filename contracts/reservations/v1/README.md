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
| `fixtures/*.json` | Shared fixtures. Every implementation must pass all of them. Generated from `packages/astro/test/reservations-fixtures.ts` and `reservations-theme-fixtures.ts`, where the expectations are written by hand. |

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

**Optional, additive fields** (a server may send them; a client must work without them, and treats an absent field as unknown):

| Field | Type | Meaning |
| --- | --- | --- |
| `days[].closed` | boolean | `true`: the venue has no opening hours that date (a regular closing day or a closed exception). `false`: it is open, so an empty `slots` means fully booked. |
| `days[].slots[].few` | boolean | `true`: few units remain for this slot (at or below a small server-chosen threshold). Only `true` is meaningful; omit it otherwise. |

```json
{ "date": "2026-11-03", "closed": false, "slots": [ { "start": "2026-11-03T18:00:00+09:00", "end": "2026-11-03T20:00:00+09:00", "few": true } ] }
```

Neither field reveals capacities, seat counts or resources. The booking UI's 空席表 (§12) shows `closed: true` as 「休」, `few` as △, and never infers either: without `closed`, an empty date is shown as outside the reception hours (–).

### `POST holds`

```json
{ "selection": { "locationKey": "office" }, "start": "2026-11-02T10:00:00+09:00", "replaceHoldToken": "<previous holdToken>" }
```

`start` must be a slot start currently offered for that selection. Holds are protected by rate limits, not Turnstile: the challenge belongs to the final submit only (owner decision 2026-10-08). A `turnstileToken` sent here is ignored. Acquiring a hold releases the visitor session's previous hold for the setup in the same transaction; `replaceHoldToken` names it explicitly. Response `201`:

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
| `turnstileToken` | When the definition has `turnstile`; verified server-side for the booking host and action. The final submit is the only challenged request. |
| `files[<fieldKey>][]` | One part per file, forms §6. |
| `hp_website` | Honeypot; must be empty. |

Idempotency is scoped to the Website, setup and operation, persisted and checked against a server-side request digest: a retry with the same key and request returns the same receipt and state (even after the hold expired); the same key with a different request is `idempotency_conflict` and creates nothing. Response `202`:

```json
{ "status": "accepted", "receipt": "<opaque>", "state": "pending_approval", "approvalDeadline": "2026-11-01T23:00:00+09:00", "success": { "mode": "message", "message": "<ja message>" } }
```

- `state` is `confirmed` (automatic and secured), `pending_approval` (manual) or `confirming` (accepted; final steps such as a calendar recheck are still running; poll `receipt`). `approvalDeadline` appears only with `pending_approval`.
- `success` is `{ "mode": "redirect", "path": <success.redirectPath> }` when the setup declares `success`, else `{ "mode": "message", "message": … }` with `copy.pendingMessage` or `copy.confirmedMessage` for the state, or a default Japanese message. The UI treats only a 2xx with `status: "accepted"` as success.
- `receipt` is a scoped receipt token for this visitor's booking only.
- `managementUrl` (optional) is the visitor's management page: an absolute URL on the booking origin, such as `https://book.yatris.jp/manage/<token>`. The outcome screen shows it as a link 「予約の確認・変更・キャンセル」 that opens in a new tab (`target="_blank"`, `rel="noopener noreferrer"`), never inside the iframe, with a note that it is also mailed and must be kept private. It keeps the booking manageable when mail fails. It is never part of a `postMessage`, and the UI ignores a value on any other origin.

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
| `theme.json` | `{ validate: [{ name, theme, errors, normalized, encoded }], decode: [{ name, encoded, errors, theme }] }` | Theme validation returns exactly `errors` and, when valid, the `normalized` theme; encoding a valid theme gives exactly `encoded`. Decoding `encoded` returns exactly `errors` and `theme` (§10). |

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
| `validateTheme(value)` → `{ valid, errors, theme }`, `encodeTheme(theme)`, `decodeTheme(text)` → same | Theme validator and codec (§10) |
| `THEME`, `THEME_COLOR_TOKENS`, `THEME_SPACINGS`, `THEME_COLOR_PATTERN`, `THEME_FONT_PATTERN`, `THEME_FONT_MAX_LENGTH`, `THEME_RADIUS_MAX`, `THEME_MAX_ENCODED_LENGTH` | Same constants |
| `bookingPageUrl(input)`, `bookingEmbedUrl(input)`, `parseBookingOrigin(value)`, `isBookingOrigin`, `isWebOrigin`, `newInstanceId()`, `DEFAULT_BOOKING_ORIGIN`, `INSTANCE_PATTERN` | URL rules (§11) |
| `validateBookingMessage(data, instance)`, `parseBookingMessage(event, { origin, frame, instance })`, `bookingMessage(instance, type, payload?)`, `isNavigatePath`, `BOOKING_MESSAGE_SOURCE`, `BOOKING_PROTOCOL_VERSION`, `BOOKING_MESSAGE_TYPES`, `BOOKING_STATUSES`, `MAX_MESSAGE_HEIGHT`, `MAX_NAVIGATE_PATH_LENGTH` | Messaging protocol (§11); the child builds messages it would pass |
| `isValidTimezone`, `TIMEZONE_PATTERN`, `isHttpsUrl`, `HTTPS_URL_PATTERN`, `HOURS_TIME_PATTERN`, `SETUP_KEY_PATTERN`, `DEFAULT_POLICIES`, `SETUP`, `OPERATIONS`, `MODES`, `PRESENTATIONS`, `RESOURCE_KINDS`, `LOCATION_TYPES`, `WEEKDAYS` | — |

`validateOperations` and `reservationContext` throw a `TypeError` for a `mode` outside `time_slot` / `business` or a `presentation` outside `party` / `service` / `null`: options are consumer configuration, not visitor input.

## 10. Theme

A Website themes its embedded booking page with a small set of validated tokens. There is no arbitrary CSS, no script and no font URL. The booking page also has a Yatris default theme; tokens override it for one embed.

The theme is a JSON object. Every key is optional; unknown keys are `unknown_property`.

| Key | Rule |
| --- | --- |
| `primary`, `onPrimary`, `background`, `surface`, `text`, `mutedText`, `border`, `error`, `focus` | `#RRGGBB` (`^#[0-9A-Fa-f]{6}$`), normalized to lowercase. No short form, no alpha, no names. |
| `font`, `headingFont` | `sans` or `serif` (`THEME_FONTS`). Default `sans`. |
| `fontFamily`, `headingFontFamily` | A font stack, 1–200 code points, matching `THEME_FONT_PATTERN` (below). Still valid for existing configurations; **the booking UI ignores them**. |
| `spacing` | `compact`, `comfortable` or `spacious` |
| `radius` | integer 0–24 (CSS pixels) |

**Fonts.** The booking UI always uses Noto, which the booking host serves (Noto Sans JP and Noto Serif JP, weights 400/500/700, with `unicode-range` subsets). `font` sets the body text and `headingFont` the headings and setup name:

| Value | Stack |
| --- | --- |
| `sans` | `"Noto Sans JP", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic", Meiryo, sans-serif` |
| `serif` | `"Noto Serif JP", "Hiragino Mincho ProN", "Yu Mincho", serif` |

The client only sets `font-family`; it loads no font. In the synthetic preview on a site, the same stacks fall back to the system's Japanese fonts unless the site already loads Noto.

**Font stacks.** Comma-separated family names. Each item may have spaces around it and is either bare, or wrapped in straight double quotes. A name starts with a letter of any script (`\p{L}`), a combining mark (`\p{M}`), an ASCII digit or a hyphen, then continues with those characters or spaces. Nothing else can appear, so `url(`, semicolons, braces, backslashes, angle brackets, single quotes and quotes inside a name are all rejected:

```text
^ITEM(?:,ITEM)*$
ITEM = (?: *"[\p{L}\p{M}0-9-][\p{L}\p{M}0-9 -]*" *| *[\p{L}\p{M}0-9-][\p{L}\p{M}0-9 -]*)
```

The pattern runs with Unicode semantics (JavaScript `u`, PHP `/u`). Stacks are used as given; they are not normalized.

**Issues** use the forms shape codes: `invalid_type` (not an object; a wrong value type), `unknown_property`, `invalid_enum`, `pattern_mismatch`, `out_of_range`, `too_short` (an empty font stack, together with `pattern_mismatch`) and `too_long`. Issues are sorted by path, then code, as forms `tidy`.

**Normalized theme.** Colours lowercase, keys sorted by UTF-16 code unit. `validateTheme(value)` returns `{ valid, errors, theme }`, `theme` being the normalized theme or `null`.

**Encoding.** The `theme` query parameter is base64url without padding (RFC 4648 §5) of the UTF-8 canonical JSON (forms §6) of the normalized theme. PHP: `rtrim(strtr(base64_encode($json), '+/', '-_'), '=')`, with `$json` encoded as forms canonical JSON. The encoded string is at most **1023** characters (`THEME_MAX_ENCODED_LENGTH`); a theme that would be longer is invalid, `too_long` at path `""`. `encodeTheme(theme)` throws a `TypeError` for an invalid theme. Embeds omit the parameter when the theme has no tokens.

**Decoding** (`decodeTheme(text)`, the booking page side): a non-string is `invalid_type`; longer than 1023 characters is `too_long`; anything that is not base64url (`[A-Za-z0-9_-]+`, no padding, length not ≡ 1 mod 4) of strict UTF-8 JSON is `invalid_encoding`, all at path `""`. The JSON need not be canonical. The decoded value is then validated as above. The booking page ignores an invalid theme entirely (it never applies part of one) and renders its default theme.

The booking UI applies the colour tokens as CSS custom properties on its root (`--yb-primary`, `--yb-on-primary`, `--yb-background`, `--yb-surface`, `--yb-text`, `--yb-muted-text`, `--yb-border`, `--yb-error`, `--yb-focus`), `--yb-radius` in `px`, `data-yb-spacing`, `data-yb-font` and `data-yb-heading-font`, and marks a mount with any token `data-yb-themed`. Every colour of the UI is a token or derived from tokens (`color-mix()`), so one `primary` gives a coherent palette. `background` paints only the direct page; an embedded page (and the preview) is transparent. Contrast is the author's responsibility (the yatris-reservation skill checks it); the contract validates syntax only.

## 11. Embedding: URLs and the messaging protocol

### URLs

| URL | Form |
| --- | --- |
| Direct page (fallback link) | `{bookingOrigin}/book/{websiteId}/{setupKey}[?theme={encoded}]` |
| Iframe | `{bookingOrigin}/book/{websiteId}/{setupKey}?embed=1&instance={instance}&parentOrigin={encodeURIComponent(parentOrigin)}[&theme={encoded}]` |

- `bookingOrigin` is `https://book.yatris.jp`. For local development the Astro integration reads `YATRIS_BOOKING_ORIGIN`, which must be an origin only (no path, query, fragment or credentials) using `https:`, or `http:` on a loopback host (`localhost`, `*.localhost`, `127.x.x.x`, `[::1]`). Anything else fails the build.
- `websiteId` is the public numeric Website id (as in forms public keys). `setupKey` uses `SETUP_KEY_PATTERN`.
- `instance` is a random id per embed and per load, `^[A-Za-z0-9_-]{16,64}$` (`newInstanceId()`: 22 characters from 16 random bytes). A retry creates a new one.
- `parentOrigin` is the embedding page's serialized origin (`location.origin`). The booking page must check it against the Website's registered embedding origins (and its `frame-ancestors` list) before posting anything, and use it as the exact `targetOrigin`.
- The URL carries only these public values. No Delivery, MCP, OAuth or SMTP credential, no visitor data.

The iframe is `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"`: it can open new tabs (the management link) but cannot navigate the top window; redirects go through `navigate`. It has the `<ReservationEmbed title>` as its accessible title.

### Messages, protocol version 1

Messages go from the booking page (child) to the embedding page (parent) only. **The parent sends no messages in v1.** Every message is a plain object with exactly the envelope keys plus the payload keys of its type:

```json
{ "source": "yatris-booking", "version": 1, "instance": "<instance>", "type": "<type>", "...payload" }
```

| `type` | Payload | When | Parent action |
| --- | --- | --- | --- |
| `ready` | none | Once, after the booking UI has rendered its first step | Ends the loading state |
| `height` | `height`: integer 1–20000 (CSS pixels) | Whenever the content height changes | Sets the iframe height, clamped to its own maximum (10000) |
| `status` | `status`: `loading`, `ready`, `unavailable`, `error` or `submitted` | Lifecycle changes | `loading`/`ready`: state; `unavailable`: replaces the iframe with the unavailable message; `error` (the page cannot load or continue): replaces it with a retry; `submitted`: marks the embed (`data-yr-submitted`) |
| `navigate` | `path`: a same-site path matching the forms path grammar (`PATH_PATTERN`), at most 500 code points | After an accepted booking whose setup declares `success.redirectPath` | Navigates its own window to the path |

**Parent validation** (`parseBookingMessage(event, { origin, frame, instance })`): `event.origin` equals the configured booking origin exactly; `event.source` is the iframe's `contentWindow`; the data is a plain object; `source` is `"yatris-booking"`; `version` is the number `1`; `instance` equals this embed's instance; `type` is one of the four; the keys are exactly the envelope plus that type's payload; the payload passes the rules above. Anything else (another origin or window, an unknown type, a missing or extra key, a wrong value) is dropped silently.

**Child rules** (`bookingMessage(instance, type, payload?)` builds and checks one): post with `parent.postMessage(message, parentOrigin)`, never `"*"`, and only when `embed=1`, a valid `instance` and a registered `parentOrigin` came with the URL. Post `status: loading` first, `ready` and `status: ready` after the first render, `height` on every size change (deduplicated), `status: unavailable` for an unknown, unpublished or disabled setup or an unsupported definition, `status: error` when the definition cannot load, `status: submitted` after an accepted booking, then `navigate` when the outcome is a redirect. **Messages never contain** answers, email addresses, names, receipt or hold tokens, the booking session, the management URL, dates or any other booking detail. Unknown future fields are not added to v1 messages; a new field or type is protocol version 2.

## 12. Astro component, booking UI and CLI

### `<ReservationEmbed>`

```astro
---
import ReservationEmbed from '@yatris/astro/ReservationEmbed.astro';
---
<ReservationEmbed setupKey="consultation" />
<ReservationEmbed setupKey="consultation" title="無料相談のご予約" theme={{ primary: '#4f46e5', onPrimary: '#ffffff', radius: 8, fontFamily: '"Noto Sans JP", sans-serif' }} class="my-embed" />
```

| Prop | Meaning |
| --- | --- |
| `setupKey` | The setup key (`src/reservations/<key>.json`). Required. |
| `theme` | Theme tokens (§10). Validated at build time; an invalid theme fails the build with its paths and codes. |
| `title` | The iframe title, single line, 1–200 characters. Default 「ご予約」. |
| `class`, `id` | On the embed element. |

Modes, decided at build time by the integration:

| Mode | When | Embed |
| --- | --- | --- |
| `live` | A paired project (`.yatris/project.json` has `websiteId`) | Iframe (§11) with loading 「予約画面を読み込んでいます…」, unavailable 「現在、オンライン予約はご利用いただけません。」 and retry 「再読み込み」 states; the direct link 「予約ページを新しいタブで開く」 is always visible; a `<noscript>` note. If `ready` does not arrive within 20 seconds, the retry state shows. |
| `preview` | `astro dev` **and** `YATRIS_RESERVATIONS_PREVIEW=1` | The booking UI in the page itself, on synthetic data (below) |
| `unconfigured` | Anything else (an unpaired project) | The unavailable message only; no iframe, no request, never a fake booking |

The page ships the embed element, a JSON configuration (mode, setup key, title, booking origin, Website id, encoded theme, direct URL) and a small parent script (`@yatris/astro/reservations/embed`). It holds no credential of any kind. Default styles: `components/ReservationEmbed.css`, every rule inside `:where()` (`yr-embed`, `yr-frame`, `yr-iframe`, `yr-status`, `yr-retry`, `yr-fallback`, `yr-fallback-link`, `yr-noscript`; `data-yr-state` is `loading`, `ready`, `unavailable` or `error`; `--yr-min-height`). A site with a Content-Security-Policy must allow the booking origin in `frame-src`.

### Synthetic preview

Set `YATRIS_RESERVATIONS_PREVIEW=1` for `astro dev` only, for example in `.env.development.local`. Each embed then runs the booking UI against `src/reservations/<setupKey>.json`:

- The definition is the §5 public projection of the declaration with **synthetic operations**: the declaration's own seed where it has one, with every host and practitioner relabelled 「架空の担当者A（サンプル）」, 「架空の担当者B（サンプル）」…, or a fixed sample for the mode: 30 minutes with two sample hosts (`time_slot`), one 60-minute 「サンプルメニュー（架空）」 with two sample practitioners the visitor may choose (`service`), or parties of 1–6 for 90 minutes (`party`). Confirmation is automatic unless the seed chooses. Meeting URLs, addresses, instructions, tables and capacities never reach the page.
- Availability is generated in the browser from the seed's first host's or venue's weekly hours and exceptions (else weekdays 10:00–12:00 and 13:00–17:00), on the slot grid, after the lead time and within the horizon, with some slots shown as taken. Each slot lasts the selection's duration (the variant's, the service's or the dining duration) and fits inside one opening range, so a dinner never runs past closing. Selections are judged as the server judges them (`validation_failed` with `invalid_selection`).
- A prominent marker reads 「プレビュー：サンプルの空き状況です（実際の予約はできません）」, names the declaration file, and shows the request a live page would have sent, with the answers of `sensitive` questions (and their files) replaced by 「（要配慮情報のため表示しません）」 there and in the console. Holds and the booking are answered locally; nothing is sent anywhere, and a redirect outcome is described instead of followed.
- An invalid or missing declaration shows its problem instead of a flow. Every mode previews: `time_slot`, `business` + `service` and `business` + `party`.

`astro build` **refuses** `YATRIS_RESERVATIONS_PREVIEW` (set in the environment or in `.env`/`.env.production`) with an error. A build never reads `src/reservations/` and resolves the preview module to `null`, so no declaration content, synthetic data, booking UI or preview code reaches `dist/`, and nothing synthetic reaches Yatris.

### Booking UI (`@yatris/astro/booking/client`)

The framework-free booking flow, shared by the hosted page on the booking origin and the preview. `mountBooking(root, config, options)` returns a `BookingController`.

```ts
type BookingConfig =
  | {
      mode: 'live';
      setupKey: string;
      definitionUrl: string; // https://book.yatris.jp/api/public/websites/{websiteId}/reservations/{setupKey}
      endpoints?: { availability: string; holds: string; bookings: string; receipt: string } | null; // default: the definition's
      bookingSession: string; // sent as X-Booking-Session on every POST (and the receipt GET)
      turnstile?: { siteKey: string; action: string } | null; // default: the definition's
      embed?: { instance: string; parentOrigin: string } | null; // from the iframe URL, after checking parentOrigin
      siteOrigin?: string | null; // the Website's public origin, for consent privacy links; default: embed.parentOrigin
      theme?: ReservationTheme | null; // decoded and validated (§10)
    }
  | {
      mode: 'preview';
      setupKey: string;
      source: string; // e.g. src/reservations/consultation.json
      definition?: ReservationPublicDefinition;
      synthetic?: { weeklyHours: HoursEntry[]; exceptions?: HoursException[] };
      problem?: { message: string; issues: Issue[] };
      theme?: ReservationTheme | null;
    };
// options: { fetch?, now?, navigate?, turnstile?, parent?, visitorTimeZone?, measureHeight?, receiptPollMs?, random? }
```

Every flow has three steps, shown as a progress bar (① 日時を選択 → ② 情報を入力 → ③ 完了; for parties ① 日時を選ぶ → ② お客様情報 → ③ 予約完了) inside a card with a duration chip (「所要時間」, for parties 「ご利用時間」) and the setup name (`data-yb-step`: `select`, `details`, `outcome`). A single location is an information line under the name, never a chooser. The direct page paints `background` around the card; an embedded page and the preview draw no background and no card (`data-yb-frame`: `page` or `embed`).

- **Select.** The mode's choices sit above the slot picker and refresh it when changed: the location (radio cards, only with several `locations`; `selection.locationKey`), and the host when `visitorChoosesHost` (`time_slot`). Hosts and practitioners are a grid of radio cards with an initial, 「指定しない（おまかせ）」 first and chosen (it leaves `hostKey` / `practitionerKey` absent); past eight people, a filter field and 「すべて表示（N名）」. The date and time are chosen together:
  - `time_slot` and `service`: a five-day **week grid** when the mount is at least 640px wide (day headers 「9 金」, hour labels on both sides, only the hours the visible slots use, each slot a filled button 「14:00 - 14:30」 at its time, empty days hatched, 「前へ」 / 「次へ」 beside the month); in a narrower mount the same five days as a strip of day buttons and the chosen day's times as a list. Arrow keys move between slots (one tab stop); each slot is labelled 「10月9日（金）14:00〜14:30を選択」.
  - `party`: the seven-day **空席表**. Days are columns (weekday over the date; 土 in `focus`, 日 in `error`; a `closed` day grey with 「休」; today highlighted), times are rows (on the hour bold), and each cell is ○ 予約可 or △ 残りわずか (`few`) as a button, × 満席 or – 受付時間外・定休日. Without a slot, a cell is × between the day's first and last slot or on a day with `closed: false`, and – otherwise (nothing is invented). 「‹ 前の7日」 / 「次の7日 ›」, a 「日付から探す」 date input, a legend and 「当日のご予約は◯時間前まで承ります。」 from `minimumLeadMinutes`. Cells are labelled 「10月9日（金）18:00 2名 予約可」.
  - Availability comes from `POST availability` in windows of up to 14 days, fetched only for days not yet known; a different `operationsRevision` reloads the definition. Loading shows skeletons. Times are in the display time zone with the zone named (a globe icon); a switch offers the venue zone and the visitor's when they differ; it changes labels only, and the UI always sends the server's own `start` string. Choosing a time acquires a hold (`POST holds` with `turnstileToken` and `replaceHoldToken` for the previous hold).
- **Details.** A summary box with the held date, time and zone (also the venue zone when another is shown), the party size and dining duration or the service, and 「日時を選び直す」; the hold countdown (on expiry the UI returns to the picker with fresh availability); the questions, drawn by the forms field renderer and validated with `validateSubmission` using `reservationContext` (operations unknown) and the held selection's values (`booking.location_key`, `booking.starts_at` venue-local, `booking.host_key` when the visitor chose one). A single-choice question with at most six options renders as radio cards. Errors are shown inline and summarized with links, and focus moves to the first invalid field. Above the submit button: the duration, location, host or practitioner label from the hold, the confirmation policy (automatic: 「送信すると予約が確定します。」; manual: a request that is not yet confirmed, with the approval window), and, when the start is inside `cancelCutoffMinutes` and/or `rescheduleCutoffMinutes`, that online cancellation and/or changes will not be possible. The button reads 「予約を確定する」, or 「予約をリクエストする」 for manual confirmation. A Turnstile widget when the definition has one (a fresh token for the hold and for the booking).
- **Submit.** `POST bookings` (multipart, §7) with one idempotency key per deliberate attempt, reused on a retry of the same answers and hold (network, `rate_limited`, `verification_failed`, `temporarily_unavailable`, `calendar_unavailable`). `hold_expired`, `slot_unavailable` and `approval_window_closed` return to the picker with fresh availability; `version_changed` reloads the definition, keeps compatible choices and answers and restarts at the select step; `validation_failed` shows the field errors.
- **Outcome.** A success panel: 「予約が確定しました」 (`confirmed`), 「予約リクエストを受け付けました（まだ確定していません）」 with the approval deadline (`pending_approval`), or 「予約を受け付けました（確定の処理中です）」 while `confirming` (the receipt is polled); the date and time, the success message, and the management link when `managementUrl` is present (§7). A redirect outcome posts `navigate` when embedded, or calls `location.assign` on the direct page, only after acceptance. Answers are cleared.

Mode details:

- **Service** (`presentation: service`): one service per booking, as cards with their duration (with variants, their range); when it has variants the visitor must choose one, each variant a card with its own duration (`selection.variantKey`). With `visitorChoosesPractitioner`, the practitioner cards above; the details step shows the hold's `practitionerLabel`. Conditions see `booking.service_key` and `booking.variant_key`.
- **Party** (`presentation: party`): 「ご利用人数」 pills from `minSize` (two people chosen until the visitor picks another), the first eight sizes as pills and the rest in a 「○名以上」 select, sent as `selection.partySize`. Tables and pools are never shown. Conditions see `booking.party_size` as a decimal string.
- **Rejected selection.** `validation_failed` with `formErrors` `invalid_selection` from availability, holds or bookings drops the hold, returns to the select step with a Japanese notice naming the choice the client's own check of §7 "Selection" names (the service, the party size, or the location or host), and waits: the picker offers a reload and any change of choice asks again. A selection change releases the held time locally and names it as `replaceHoldToken` on the next hold.
- **Consent.** Questions marked `sensitive` render as ordinary questions; an `acceptance` question renders unselected with its consent text and its privacy link. A link given as a site path opens on `siteOrigin` (else the embed's `parentOrigin`), never on the booking origin. Sensitive answers appear only in the visitor's own form and the `bookings` request; never in messages, logs, the page's other text or the preview log.

Focus moves to each step heading, every control is a native element reachable by keyboard (radio groups move with the arrow keys), targets are at least 44px high, errors and status changes are announced (`role="alert"`, `role="status"`), and the layout works from 360px. Japanese text breaks strictly (`line-break: strict`), headings by phrase, and dates, times and 「○名」 never inside. Styles: `components/YatrisBooking.css` (`yb-*`, every colour a theme token or derived from one) with `components/YatrisForm.css` for the fields (`yf-*`). YatrisCMS vendors `dist/booking-client/*.js`, `dist/forms/*.js`, `dist/forms-client/*.js`, `dist/reservations/*.js` and both stylesheets.

`booking.host_key` is known on the client only when the visitor chose the host; when Yatris assigns one, conditions on it are evaluated as empty in the browser, and the server's evaluation is authoritative.

### CLI

| Command | Behaviour |
| --- | --- |
| `yatris reservations validate [<path>…]` | Runs `validateSetup` on each declaration file, or every `*.json` (not `*.brief.json`) in each directory; default `src/reservations/`. Checks that the file name matches `key`, prints `path code` per error and warnings. Offline. Exits 0 when every declaration is valid (or there are none), 1 otherwise. |
| `yatris reservations plan`, `apply`, `pull`, `status` | Synchronization of setup definitions with Yatris drafts; see below. |

### Synchronization

Setup definitions synchronize exactly like contact forms (forms contract §9: the same Product MCP client, credential, plan and lock rules, drift matrix and exit codes), with these differences (decisions §5):

| Command | Behaviour |
| --- | --- |
| `yatris reservations plan [--json] [--out=<file>]` | Validates every `src/reservations/*.json` (not `*.brief.json`) with `validateSetup` first (invalid: exit 1, nothing sent), then calls `plan_reservation_setups` `{ website, setups: [{ key, declaration, baseline: { digest, draft_revision, published_version } \| null }] }`. Read-only in Yatris. The plan file (default `.yatris/reservations.plan.json`, gitignored; never under `public/`, `src/`, `dist/` or `.astro/`) holds the Website, plan token and expiry, operations and each declaration's path and SHA-256. Each operation may carry `live_operations_revision`, printed as information only. |
| `yatris reservations apply --plan=<file> [--json]` | Refuses an expired or non-applicable plan, a plan not written by `reservations plan`, and any declaration added, removed or changed since the plan, seed included (exit 3, nothing sent). Otherwise one `apply_reservation_setups` `{ website, plan_token, setups: [{ key, declaration }], idempotency_key }` call (`reservations-apply-<uuid>`, reused on a transport retry). Yatris saves **drafts** atomically and never publishes, connects accounts, approves bookings or provisions secrets. Updates the lock. |
| `yatris reservations pull [<key>…] [--draft] [--json]` | `list_reservation_setups` `{ website }`, then `get_reservation_setup` `{ website, key, state }` per setup. Writes the definition to `src/reservations/<key>.json` only when the file is absent or its definition is unchanged since its baseline; any other file is refused and left untouched (exit 2). A file whose definition already equals the remote one only advances the baseline. |
| `yatris reservations status <key> [--json]` | `get_reservation_setup_readiness` `{ website, key }`: readiness items and the current live operations (redacted, meeting URLs as `meetingUrlSet`), labelled as live values from Yatris, never as the seed. Read-only. |

- **Setup definitions only.** Yatris digests cover the declaration without `$schema` and without `operations`. The `operations` seed is sent with each declaration, and Yatris uses it only when apply **creates** the setup. Afterwards daily operations live only in Yatris: editing them there is neither drift nor a conflict, editing or removing the seed changes nothing live, and routine sync never overwrites operations.
- **Pull never writes operations.** It writes the remote definition (which contains neither `$schema` nor `operations`; any it contained would be dropped), keeps the local file's own `$schema` and `operations` exactly as they are, and writes neither into a new file.
- **No deletion.** Only local declarations are sent, and there is no delete operation: omitting or removing a file never archives or deletes a setup or its bookings.
- **Invalid operations** carry setup-specific issues: `/mode mode_immutable` (a mode or presentation change of an existing setup: a different mode is a replacement setup under a new key), `setup_archived` and `/key key_mismatch`.

**Lock** `.yatris/reservations.lock.json`, committed, written only by `apply` and `pull`: `{ contractVersion: 1, websiteId, setups: { <key>: { state, digest, draft_revision, published_version, definition_sha256 } } }`. As for forms, except that `definition_sha256` hashes the local setup definition (canonical JSON without `$schema` and `operations`) rather than the file, so a seed edit after creation never blocks a pull. Never edit it by hand; a work order that runs `apply` or `pull` must name it as an exact extra path.
