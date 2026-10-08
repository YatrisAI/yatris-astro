# The interview brief: `src/reservations/<key>.brief.json`

The brief is the durable, committed record of a reservation-setup interview.
It lets any later session, another agent or Yatris staff continue without
asking again, and it keeps unresolved business facts visibly apart from
suggested defaults. The shape is `brief.schema.json` in this directory
(version 1).

Validation and preview skip `*.brief.json` files, and a build never reads
`src/reservations/`, so nothing in a brief reaches the website.

## Shape

```text
{
  "briefVersion": 1,                     always 1
  "setup": "<key>",                      the setup key; matches the file name
  "stage": "interviewing" | "reviewed" | "implemented",
  "updated": "YYYY-MM-DD",               optional
  "decisions": { "<id>": Decision, ... },
  "pending": [ ... ]                     optional: the readiness blockers left
}

Decision {
  "topic": "booking_mode" | "durations_resources" | "hours_exceptions"
         | "confirmation_policy" | "locations_conferencing"
         | "questions_recipients" | "cutoffs_copy" | "theme_embedding"
         | "review",
  "status": "confirmed" | "delegated" | "unresolved",
  "summary": "<one plain sentence: the decision, or the open question>",
  "value": <any JSON>,                   required unless unresolved; forbidden when unresolved
  "source": "user" | "repository" | "yatris",   required unless unresolved
  "recommendation": <any JSON>,          optional: what you proposed
  "proposedDefault": true | false,       true when the value or recommendation is a Yatris default
  "note": "<text>"                       optional
}
```

- **Decision ids** are the ids in `interview.md` (`hosts.list`,
  `confirmation.mode`, `questions.email.required`, …): lowercase,
  dot-separated, question keys as written in the declaration. Only ids of
  the setup's mode appear.
- **`confirmed`**: the user answered (`source: "user"`), or an existing
  declaration or Yatris state settles it (`"repository"`, `"yatris"`).
  Text on the site's pages is not a source for operating facts.
- **`delegated`**: the user let you choose (「おまかせします」); `value` is
  the recommendation you presented and `source` is `"user"`. For a
  `default` decision, add `"proposedDefault": true`. The schema rejects a
  delegated default without it.
- **`unresolved`**: no value yet. Keep a `recommendation` if you made one.
- **Facts cannot be delegated.** The schema accepts only `confirmed` or
  `unresolved` for `mode`-section facts, hours, locations, schedule
  maintenance, embedding origins and `confirmation.mode`.
- **`pending`** names the readiness blockers outside the repository:
  `pairing`, `operating_facts`, `recipient_setup`, `yatris_import`,
  `staff_review`, `staff_publication`, `embedding_origins`, `mail_setup`,
  `provider_integration`, `privacy_page` (`readiness.md`).

## Rules

- Write it after every interview round, not only at the end.
- **Never** put an email address (recipients included), an SMTP setting,
  password, OAuth token, API key, meeting passcode, booking record or
  visitor data in it. The schema rejects email addresses in decisions.
- On resume, read it first. Skip every `confirmed` and `delegated` decision
  and continue with the unresolved ones in topic order. Re-open a decision
  only when the user changes it or a fact it relied on changed (for
  example, the mode changed, so host decisions no longer apply); then update
  it and say why.
- When the brief and the declaration disagree, ask the user which is
  current; do not silently trust either. When Yatris shows newer operations
  (the client changed hours in the dashboard), Yatris is current: the brief
  records what the setup started with, not today's schedule.
- Delete nothing when the setup is done: the brief stays as the record of
  what was agreed.

## Example

A time-slot consultation, implemented while the hosts, their hours and the
office address are still unknown. The confirmed duration, locations and
policies wait in the brief; the declaration (example 1 in `examples.md`) has
no `operations` seed yet, so Yatris staff enter the operating facts when they
are known.

```json
{
  "briefVersion": 1,
  "setup": "free-consultation",
  "stage": "implemented",
  "updated": "2026-10-07",
  "decisions": {
    "setup.purpose": { "topic": "booking_mode", "status": "confirmed", "summary": "Prospective clients book a free first consultation.", "value": "free_consultation", "source": "user" },
    "mode.flow": { "topic": "booking_mode", "status": "confirmed", "summary": "An appointment with an available advisor.", "value": "time_slot", "source": "user" },
    "setup.key": { "topic": "booking_mode", "status": "delegated", "summary": "Setup key.", "value": "free-consultation", "source": "user" },
    "setup.name": { "topic": "booking_mode", "status": "confirmed", "summary": "Name shown to visitors.", "value": "無料相談（30分）", "source": "user" },
    "placement.existing": { "topic": "booking_mode", "status": "confirmed", "summary": "Consultations were arranged through the contact form; no booking tool exists.", "value": "contact_form_only", "source": "repository" },
    "appointment.duration": { "topic": "durations_resources", "status": "confirmed", "summary": "One consultation takes 30 minutes.", "value": 30, "source": "user" },
    "hosts.list": { "topic": "durations_resources", "status": "unresolved", "summary": "Who can be booked? The client will name the advisors." },
    "hosts.strategy": { "topic": "durations_resources", "status": "unresolved", "summary": "One fixed advisor, or any available advisor?" },
    "appointment.buffers": { "topic": "durations_resources", "status": "delegated", "summary": "15 minutes after each consultation, the proposed default.", "value": { "before": 0, "after": 15 }, "source": "user", "recommendation": { "before": 0, "after": 15 }, "proposedDefault": true },
    "hours.weekly": { "topic": "hours_exceptions", "status": "unresolved", "summary": "Bookable hours per advisor, lunch breaks. Not the published phone hours." },
    "hours.exceptions": { "topic": "hours_exceptions", "status": "unresolved", "summary": "Closures and holidays." },
    "hours.timezone": { "topic": "hours_exceptions", "status": "delegated", "summary": "Japan time.", "value": "Asia/Tokyo", "source": "user", "proposedDefault": true },
    "policy.slot_interval": { "topic": "hours_exceptions", "status": "delegated", "summary": "Start times every 15 minutes.", "value": 15, "source": "user", "proposedDefault": true },
    "policy.horizon": { "topic": "hours_exceptions", "status": "delegated", "summary": "Bookable up to 90 days ahead.", "value": 90, "source": "user", "proposedDefault": true },
    "policy.lead_time": { "topic": "hours_exceptions", "status": "confirmed", "summary": "At least one day ahead, so the advisor can prepare.", "value": 1440, "source": "user", "recommendation": 120, "note": "The 2-hour default was offered; the client chose one day." },
    "confirmation.mode": { "topic": "confirmation_policy", "status": "confirmed", "summary": "Bookings are confirmed automatically, once real schedules are kept in Yatris.", "value": "automatic", "source": "user" },
    "locations.list": { "topic": "locations_conferencing", "status": "confirmed", "summary": "Online and in-person consultations; no phone consultations.", "value": ["online", "office"], "source": "user" },
    "locations.online.details": { "topic": "locations_conferencing", "status": "unresolved", "summary": "The fixed meeting URL or the joining instructions." },
    "locations.office.details": { "topic": "locations_conferencing", "status": "unresolved", "summary": "The exact office address and access notes." },
    "calendar.maintenance": { "topic": "locations_conferencing", "status": "unresolved", "summary": "Who keeps the Yatris schedule current, and who enters appointments already arranged by contact form or LINE?", "recommendation": "staff_bookings" },
    "calendar.wish": { "topic": "locations_conferencing", "status": "confirmed", "summary": "They would like Google Calendar later; Yatris-only until that phase.", "value": "google_calendar_later", "source": "user" },
    "conferencing.wish": { "topic": "locations_conferencing", "status": "confirmed", "summary": "No automatic meeting links; a fixed URL is fine.", "value": "none", "source": "user" },
    "questions.list": { "topic": "questions_recipients", "status": "confirmed", "summary": "Questions in order.", "value": ["name", "email", "phone", "topic", "topic_detail"], "source": "user" },
    "questions.name.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "お名前 is required.", "value": true, "source": "user" },
    "questions.email.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "メールアドレス is required.", "value": true, "source": "user" },
    "questions.phone.required": { "topic": "questions_recipients", "status": "delegated", "summary": "電話番号 is optional, but required for an in-person consultation.", "value": false, "source": "user", "recommendation": false },
    "questions.topic.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "ご相談内容 is required.", "value": true, "source": "user" },
    "questions.topic_detail.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "Details are optional, required when the topic is その他.", "value": false, "source": "user" },
    "questions.identity": { "topic": "questions_recipients", "status": "delegated", "summary": "Identity questions.", "value": { "name": "name", "email": "email", "phone": "phone" }, "source": "user" },
    "questions.conditions": { "topic": "questions_recipients", "status": "confirmed", "summary": "Phone required in person; details required for その他.", "value": { "phone": "required_when_office", "topic_detail": "required_when_other" }, "source": "user" },
    "questions.sensitive": { "topic": "questions_recipients", "status": "confirmed", "summary": "No sensitive questions.", "value": [], "source": "user" },
    "mail.source": { "topic": "questions_recipients", "status": "delegated", "summary": "The Website's existing mail setup.", "value": "website_profile", "source": "user" },
    "cutoffs.cancel": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Online cancellation until 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "cutoffs.reschedule": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Online rescheduling until 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "reminder.timing": { "topic": "cutoffs_copy", "status": "delegated", "summary": "One reminder 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "copy.confirmed": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Recommended confirmation message.", "value": "ご予約が確定しました。確認メールをお送りしましたので、内容をご確認ください。", "source": "user" },
    "success.redirect": { "topic": "cutoffs_copy", "status": "confirmed", "summary": "Show the message in the booking page; no thanks page.", "value": "message", "source": "user" },
    "placement.route": { "topic": "theme_embedding", "status": "confirmed", "summary": "The booking is on the consultation page.", "value": "/consultation/", "source": "user" },
    "theme.tokens": { "topic": "theme_embedding", "status": "delegated", "summary": "Taken from the site's palette and fonts.", "value": { "primary": "#1F4E79", "onPrimary": "#FFFFFF", "background": "#FFFFFF", "surface": "#F5F7FA", "text": "#1A1A1A", "mutedText": "#5B6470", "border": "#D5DBE3", "error": "#B42318", "focus": "#1F4E79", "fontFamily": "\"Noto Sans JP\", system-ui, sans-serif", "spacing": "comfortable", "radius": 8 }, "source": "user", "note": "Derived from src/styles/global.css." },
    "embed.origins": { "topic": "theme_embedding", "status": "confirmed", "summary": "The production origin from astro.config.mjs.", "value": ["https://www.example.jp"], "source": "repository" },
    "review.approved": { "topic": "review", "status": "confirmed", "summary": "The user approved the summary, mapping and open items.", "value": true, "source": "user" },
    "operations.seed": { "topic": "review", "status": "confirmed", "summary": "No seed yet: hosts and hours are unknown, so staff enter operations in Yatris.", "value": "omitted", "source": "user" }
  },
  "pending": ["pairing", "operating_facts", "recipient_setup", "embedding_origins", "yatris_import", "staff_publication"]
}
```
