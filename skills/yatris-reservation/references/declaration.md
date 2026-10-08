# The declaration: `src/reservations/<key>.json`

The authoritative contract is
`node_modules/@yatris/astro/contracts/reservations/v1/README.md` with
`setup.schema.json`. Questions follow the contact-form contract
(`contracts/forms/v1/README.md`). The validators are authoritative; if this
summary and the contract disagree, the contract wins.

## From the brief to the declaration

| Brief decision | Declaration |
| --- | --- |
| `setup.key` | `key`, equal to the file name; `^[a-z][a-z0-9-]{0,63}$`; immutable once the setup exists in Yatris |
| `setup.name` | `name` |
| — | `contractVersion: 1`, `locale: "ja"` (Japanese only in v1) |
| `mode.flow` | `time_slot` → `"mode": "time_slot"` (no `presentation`); `business_service` → `"mode": "business", "presentation": "service"`; `business_party` → `"mode": "business", "presentation": "party"` |
| `questions.*` | `questions`: forms nodes with the confirmed `required` |
| `questions.identity` | `identityFields` |
| `copy.confirmed`, `copy.pending` | `copy.confirmedMessage`, `copy.pendingMessage` |
| `success.redirect` | `success.redirectPath` when a thanks page was chosen; otherwise leave `success` out |
| Topics 2 to 5 and 7 | `operations` seed, only under the rule below |
| `theme.tokens`, `placement.route` | Not in the declaration: the page and `<ReservationEmbed>` (`embedding.md`) |
| `embed.origins` | Not in the declaration: Yatris staff register them |
| `calendar.wish`, `conferencing.wish`, `mail.source`, `copy.email_notes` | Not in the declaration: wishes and settings for Yatris |
| Recipients | Never. The Website Owner sets them in Yatris |

## Operations seed

`operations` holds the setup's starting operating values. Yatris uses it
**once**, when it creates the setup; afterwards the client changes hours,
closures, services, staff schedules and capacity in the Yatris dashboard, and
synchronization never compares or overwrites them. Editing the seed later
changes nothing live: tell the user to make daily changes in Yatris.

- **Include it only when the mode section's facts are all confirmed.** When
  `operations` is present the validator requires the mode's section
  (`/operations/appointment`, `/operations/services` or
  `/operations/party`), and every resource it names. That needs:
  - `time_slot`: `appointment.duration`, `hosts.list`, `hosts.strategy`;
  - `service`: `services.list`, `practitioners.list`,
    `services.requirements`;
  - `party`: `party.size_limits`, `party.duration`, `party.strategy`, and
    `party.tables` or `party.capacity`;
  - and, for every mode, `hours.weekly` and `locations.list` with their
    details.
  Otherwise **leave `operations` out**, record `operations.seed: "omitted"`
  and keep `operating_facts` in `pending`: staff enter the facts in Yatris
  from the brief.
- **Never put a synthetic, placeholder or guessed host, table, hour or
  address in the seed**, not even to make the preview look complete. The
  synthetic preview supplies its own clearly labelled data.
- `confirmationMode` only when `confirmation.mode` is confirmed. Without it
  the validator warns `confirmation_mode_missing`; that is expected while the
  choice is unresolved, and it blocks publication.
- Defaults the user confirmed or delegated may be written explicitly so the
  review shows the starting values. A value left out takes the Yatris default
  (contract §5: `Asia/Tokyo`, 15-minute slots, 90 days, 120 minutes lead,
  5-minute hold, 1440-minute approval window and cutoffs; reminder 1440).
- Keys are ASCII (`sato`, `cut`, `t1`, `office`): `^[a-z][a-z0-9_]{0,63}$`.
  Labels are the client's own words.
- A fixed online meeting URL is allowed in `locations[].meetingUrl`
  (`https://` only); Yatris shows it only to the booked visitor. If the URL
  carries a passcode (`pwd=` and the like), leave it out of the repository
  and have staff enter it in Yatris.

| Operating fact | Seed property |
| --- | --- |
| `hours.timezone` | `timezone` |
| `policy.slot_interval`, `policy.horizon`, `policy.lead_time`, `policy.hold` | `slotIntervalMinutes`, `bookingHorizonDays`, `minimumLeadMinutes`, `holdMinutes` |
| `confirmation.mode`, `confirmation.approval_window` | `confirmationMode`, `approvalWindowMinutes` (manual) |
| `cutoffs.cancel`, `cutoffs.reschedule`, `reminder.timing` | `cancelCutoffMinutes`, `rescheduleCutoffMinutes`, `reminderMinutesBefore` |
| `hours.weekly`, `hours.exceptions` | `venueHours.weekly`, `venueHours.exceptions` (closed days are `{ "date", "closed": true }`; special hours `{ "date", "hours": [...] }`) |
| `hours.resources` | `resources[].weeklyHours`, `resources[].exceptions` |
| `locations.list`, `locations.<key>.details` | `locations[]`: `type` `online` (`meetingUrl`), `in_person` (`address`) or `phone`; `instructions` on any |
| `hosts.list`, `hosts.strategy`, `hosts.visitor_choice`, `appointment.*` | `resources` of kind `host`; `appointment` (`durationMinutes`, buffers, `hostStrategy`, `hostResourceKeys`, `visitorChoosesHost`) |
| `services.*`, `practitioners.list` | `resources` of kind `practitioner`, `room`, `equipment`; `services` (`durationMinutes`, `variants`, `requirements`, `visitorChoosesPractitioner`) |
| `party.*` | `resources` of kind `table` (`seats`) or `pool` (`capacity`); `party` (`minSize`, `maxSize`, `durationMinutes`, `bufferAfterMinutes`, `strategy`, `tableResourceKeys`, `combinations`, `poolResourceKey`) |

## Questions

Questions are contact-form nodes: the same types, keys, labels,
requiredness, conditions, file fields and limits. The installed
`yatris-contact-form` skill summarizes them (`references/fields.md`,
`references/conditions.md`); the forms contract is authoritative. A
reservation declaration has no mail templates: Yatris owns the booking
emails.

- **Requiredness** is stated on every input and only as the brief confirmed
  or delegated it. An unresolved requiredness is never written as optional.
- **Identity:** `identityFields.name` names a `text` input and
  `identityFields.email` an `email` input, both `required: true`, with no
  `visibleWhen` or `requiredWhen` and not inside a conditional group, and
  neither `sensitive`. `identityFields.phone` is optional and must name a
  `tel` input, which may be optional or conditional. Never guess which
  question holds the email.
- **Booking inputs are not questions.** Service, variant, party size, host,
  location and start time come from the booking itself. Never add a question
  for them; use them in conditions instead:

  | Context key | Modes | Values |
  | --- | --- | --- |
  | `booking.location_key` | all | `locations[].key` |
  | `booking.starts_at` | all | local `YYYY-MM-DDTHH:MM:SS` |
  | `booking.host_key` | time_slot | `appointment.hostResourceKeys` |
  | `booking.service_key`, `booking.variant_key` | service | service and variant keys |
  | `booking.party_size` | party | a decimal string: `{ "field": "booking.party_size", "operator": "gte", "value": "6" }` |

  A key outside the mode is `unknown_reference`; a value not in the seed is
  `invalid_condition_value`.
- **Sensitive questions** (decision §12). Mark every answer that is health
  information, or similarly private, with `sensitive: true`. Yatris then keeps
  it, and the files of a sensitive `file` question, out of every email,
  calendar event, ICS file, Slack or LINE alert, log, analytics and agent
  access; only the client's authorised staff see it in Yatris. Rules:
  - ask only what the service needs; never a detailed medical history, and
    never present the booking page as a medical record;
  - clinic or treatment intake (symptoms, conditions, medication,
    treatment-related allergies) needs an **explicit, unselected consent**:
    an `acceptance` question (never pre-checked) with the approved
    `consentText`, a `consentVersion` and `privacyPolicyPath` when the
    privacy page exists, next to the sensitive questions (a group with the
    same condition works well);
  - a **purpose notice** in the sensitive question's `help`, saying why it is
    asked and who sees it;
  - **staff review before publication**: add `staff_review` to `pending`;
  - a sensitive question can never be an identity field.
- **Not available:** payments, coupons, a second service in the same
  booking, a phone-only booking.

## Validation

Run from the site root until it exits 0:

```sh
npx yatris reservations validate
```

If the installed `@yatris/astro` does not have it (`npx yatris --help` does
not list `reservations`), use the contract validator directly and say so in
your report:

```sh
node --input-type=module -e "import { validateSetup } from '@yatris/astro/reservations'; import { readFileSync } from 'node:fs'; const r = validateSetup(JSON.parse(readFileSync('src/reservations/<key>.json', 'utf8'))); console.log(JSON.stringify(r, null, 2)); process.exit(r.valid ? 0 : 1);"
```

That validator does not compare `key` with the file name; check it yourself.
Each issue is `{ path, code }` with a JSON Pointer. Fix the declaration, not
the validator. Common codes:

| Code | Usual cause | Fix |
| --- | --- | --- |
| `required_property` at `/presentation` | A `business` setup without `service` or `party` | Add it from `mode.flow` |
| `presentation_not_allowed` | `presentation` on a `time_slot` setup | Remove it |
| `required_property` at `/operations/appointment`, `/services`, `/party` | A seed without the mode section | Complete the section from confirmed facts, or leave `operations` out |
| `section_not_allowed` | A section of another mode | Remove it |
| `identity_field_invalid` | The name or email question is optional, conditional, sensitive, of the wrong type or missing | Fix the question or the mapping |
| `unknown_resource`, `resource_kind_mismatch` | A host, practitioner, table or pool key not in `resources`, or of the wrong kind | Add the confirmed resource or fix the key |
| `single_host_count`, `host_choice_not_allowed` | `hostStrategy: single` with several hosts or with visitor choice | Match the confirmed strategy |
| `overlapping_hours`, `invalid_interval` | Overlapping or reversed hour ranges | Split lunch breaks into two ranges; `start` before `end` |
| `invalid_exception`, `duplicate_date` | An exception with both or neither of `closed` and `hours`, or a date twice | One entry per date |
| `invalid_timezone`, `invalid_slot_interval` | `JST`, `+09:00`; an interval that does not divide 1440 | `Asia/Tokyo`; 5, 10, 15, 20, 30, 60… |
| `location_field_not_allowed`, `invalid_url` | `address` on an online location, `meetingUrl` not `https://` | Put each detail on its own location type |
| `unknown_reference`, `invalid_condition_value` | A `booking.*` key of another mode, or a value not in the seed | Use the mode's context keys and seeded keys |
| Forms node codes (`unknown_property`, `duplicate_key`, `pattern_mismatch`, condition codes) | Under `/questions/…`: the same causes as in a contact form | The `yatris-contact-form` skill's `references/errors.md` |

Warning `confirmation_mode_missing` at `/operations/confirmationMode`:
expected while `confirmation.mode` is unresolved; report it as a readiness
blocker.
