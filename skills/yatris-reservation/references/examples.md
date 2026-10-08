# Examples

Every example here validates with `validateSetup` from
`@yatris/astro/reservations`. The businesses, people and addresses are
fictional: never copy a host, hour, address or meeting URL from an example
into a real setup.

## 1. A seed-less time-slot setup

The declaration behind the brief in `brief.md`: the duration, locations and
questions are decided, but the hosts, their hours and the office address are
not. So the declaration has **no `operations`**, the phone question's
condition names the `office` location key the brief already confirmed, and
Yatris staff enter the operating facts once the client gives them.

```json
{
  "$schema": "https://yatris.jp/schemas/reservations/v1/setup.schema.json",
  "contractVersion": 1,
  "key": "free-consultation",
  "name": "無料相談（30分）",
  "locale": "ja",
  "mode": "time_slot",
  "identityFields": { "name": "name", "email": "email", "phone": "phone" },
  "questions": [
    { "key": "name", "type": "text", "label": "お名前", "required": true, "autocomplete": "name" },
    { "key": "email", "type": "email", "label": "メールアドレス", "required": true, "autocomplete": "email" },
    {
      "key": "phone",
      "type": "tel",
      "label": "電話番号",
      "required": false,
      "autocomplete": "tel",
      "help": "来社でのご相談の場合は、当日の連絡先としてご入力ください。",
      "requiredWhen": { "field": "booking.location_key", "operator": "eq", "value": "office" }
    },
    {
      "key": "topic",
      "type": "radio",
      "label": "ご相談内容",
      "required": true,
      "options": [
        { "value": "website", "label": "ホームページ制作" },
        { "value": "renewal", "label": "リニューアル" },
        { "value": "other", "label": "その他" }
      ]
    },
    {
      "key": "topic_detail",
      "type": "textarea",
      "label": "ご相談内容の詳細",
      "required": false,
      "rows": 4,
      "requiredWhen": { "field": "topic", "operator": "eq", "value": "other" }
    }
  ],
  "copy": { "confirmedMessage": "ご予約が確定しました。確認メールをお送りしましたので、内容をご確認ください。" }
}
```

## 2. Complete declarations, one per mode

The contract ships three complete declarations, operations seed included, in
`node_modules/@yatris/astro/contracts/reservations/v1/examples/`. Read the
one for your mode before writing a seed.

| File | Mode | Shows |
| --- | --- | --- |
| `consultation.json` | `time_slot` | Two hosts with `one_available`, per-host hours and closures, online and in-person locations, a phone question required only in person, a thanks page, automatic confirmation |
| `salon.json` | `business` + `service` | Services with variants and buffers, two practitioners and a room, visitor choice of practitioner, a sensitive allergy question with consent shown only for some services, automatic confirmation |
| `restaurant.json` | `business` + `party` | Tables with seat ranges and one combination, lunch and dinner periods, questions conditional on party size, a sensitive allergy note, manual approval with a 12-hour window and a pending message |

The briefs below are the interviews behind them, after implementation.
Every seeded fact is `confirmed`; only defaults are delegated. Recipients are
never in them: the Website Owner sets those in Yatris.

### `src/reservations/consultation.brief.json`

```json
{
  "briefVersion": 1,
  "setup": "consultation",
  "stage": "implemented",
  "updated": "2026-10-07",
  "decisions": {
    "setup.purpose": { "topic": "booking_mode", "status": "confirmed", "summary": "Prospective clients book a free consultation.", "value": "free_consultation", "source": "user" },
    "mode.flow": { "topic": "booking_mode", "status": "confirmed", "summary": "An appointment with an available advisor.", "value": "time_slot", "source": "user" },
    "setup.key": { "topic": "booking_mode", "status": "delegated", "summary": "Setup key.", "value": "consultation", "source": "user" },
    "setup.name": { "topic": "booking_mode", "status": "confirmed", "summary": "Name shown to visitors.", "value": "無料相談のご予約", "source": "user" },
    "placement.existing": { "topic": "booking_mode", "status": "confirmed", "summary": "No booking tool existed.", "value": "none", "source": "repository" },
    "appointment.duration": { "topic": "durations_resources", "status": "confirmed", "summary": "One consultation takes 60 minutes.", "value": 60, "source": "user" },
    "hosts.list": { "topic": "durations_resources", "status": "confirmed", "summary": "Sato and Tanaka take consultations.", "value": ["sato", "tanaka"], "source": "user" },
    "hosts.strategy": { "topic": "durations_resources", "status": "confirmed", "summary": "Any available advisor.", "value": "one_available", "source": "user" },
    "hosts.visitor_choice": { "topic": "durations_resources", "status": "delegated", "summary": "Yatris assigns the advisor.", "value": false, "source": "user", "recommendation": false },
    "appointment.buffers": { "topic": "durations_resources", "status": "delegated", "summary": "15 minutes after each consultation.", "value": { "before": 0, "after": 15 }, "source": "user", "recommendation": { "before": 0, "after": 15 }, "proposedDefault": true },
    "hours.weekly": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Weekdays 10:00–12:00 and 13:00–18:00.", "value": "mon-fri 10:00-12:00, 13:00-18:00", "source": "user" },
    "hours.exceptions": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Closed 29–31 December; afternoon only on 4 January.", "value": ["2026-12-29", "2026-12-30", "2026-12-31", "2027-01-04 13:00-17:00"], "source": "user" },
    "hours.resources": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Sato works Monday, Wednesday and Friday; Tanaka is off on 4 January.", "value": { "sato": "mon, wed, fri 10:00-18:00", "tanaka": "off 2027-01-04" }, "source": "user" },
    "hours.timezone": { "topic": "hours_exceptions", "status": "delegated", "summary": "Japan time.", "value": "Asia/Tokyo", "source": "user", "proposedDefault": true },
    "policy.slot_interval": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Start times every 30 minutes.", "value": 30, "source": "user", "recommendation": 15 },
    "policy.horizon": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Bookable up to 60 days ahead.", "value": 60, "source": "user", "recommendation": 90 },
    "policy.lead_time": { "topic": "hours_exceptions", "status": "confirmed", "summary": "At least one day ahead.", "value": 1440, "source": "user", "recommendation": 120 },
    "policy.hold": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Hold a chosen time for 10 minutes; the form is long.", "value": 10, "source": "user", "recommendation": 5 },
    "confirmation.mode": { "topic": "confirmation_policy", "status": "confirmed", "summary": "Bookings are confirmed automatically.", "value": "automatic", "source": "user" },
    "locations.list": { "topic": "locations_conferencing", "status": "confirmed", "summary": "Online and at the Osaka office; no phone consultations.", "value": ["online", "office"], "source": "user" },
    "locations.online.details": { "topic": "locations_conferencing", "status": "confirmed", "summary": "A fixed meeting URL, sent only to the booked visitor.", "value": { "meetingUrl": "https://meet.google.com/abc-defg-hij" }, "source": "user" },
    "locations.office.details": { "topic": "locations_conferencing", "status": "confirmed", "summary": "Office address and reception note.", "value": { "address": "大阪府大阪市北区梅田1-1-1 梅田ビル5階", "instructions": "5階受付でお名前をお伝えください。" }, "source": "user" },
    "calendar.maintenance": { "topic": "locations_conferencing", "status": "confirmed", "summary": "Staff keep the Yatris schedule current and enter other appointments as staff bookings.", "value": "staff_bookings", "source": "user" },
    "calendar.wish": { "topic": "locations_conferencing", "status": "confirmed", "summary": "No calendar sync wanted.", "value": "none", "source": "user" },
    "conferencing.wish": { "topic": "locations_conferencing", "status": "confirmed", "summary": "The fixed meeting URL is enough; no automatic links.", "value": "none", "source": "user" },
    "questions.list": { "topic": "questions_recipients", "status": "confirmed", "summary": "Questions in order.", "value": ["name", "email", "phone", "company", "topic", "topic_detail", "office_note"], "source": "user" },
    "questions.name.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "お名前 is required.", "value": true, "source": "user" },
    "questions.email.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "メールアドレス is required.", "value": true, "source": "user" },
    "questions.phone.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "電話番号 is optional, required for the office.", "value": false, "source": "user" },
    "questions.company.required": { "topic": "questions_recipients", "status": "delegated", "summary": "会社名 is optional.", "value": false, "source": "user", "recommendation": false },
    "questions.topic.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "ご相談内容 is required.", "value": true, "source": "user" },
    "questions.topic_detail.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "Details are optional, required for その他.", "value": false, "source": "user" },
    "questions.identity": { "topic": "questions_recipients", "status": "delegated", "summary": "Identity questions.", "value": { "name": "name", "email": "email", "phone": "phone" }, "source": "user" },
    "questions.conditions": { "topic": "questions_recipients", "status": "confirmed", "summary": "Phone required and a reception note shown for the office; details required for その他.", "value": { "phone": "required_when_office", "office_note": "visible_when_office", "topic_detail": "required_when_other" }, "source": "user" },
    "questions.sensitive": { "topic": "questions_recipients", "status": "confirmed", "summary": "No sensitive questions.", "value": [], "source": "user" },
    "mail.source": { "topic": "questions_recipients", "status": "delegated", "summary": "The Website's existing mail setup.", "value": "website_profile", "source": "user" },
    "cutoffs.cancel": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Online cancellation until 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "cutoffs.reschedule": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Online rescheduling until 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "reminder.timing": { "topic": "cutoffs_copy", "status": "delegated", "summary": "One reminder 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "copy.confirmed": { "topic": "cutoffs_copy", "status": "confirmed", "summary": "Confirmation message.", "value": "ご予約が確定しました。確認メールをお送りしましたので、内容をご確認ください。", "source": "user" },
    "success.redirect": { "topic": "cutoffs_copy", "status": "confirmed", "summary": "A thanks page, for ad conversion tracking.", "value": "/consultation/thanks/", "source": "user" },
    "placement.route": { "topic": "theme_embedding", "status": "confirmed", "summary": "The booking is on the consultation page.", "value": "/consultation/", "source": "user" },
    "theme.tokens": { "topic": "theme_embedding", "status": "delegated", "summary": "Taken from the site's palette and fonts.", "value": { "primary": "#0B5CAD", "onPrimary": "#FFFFFF", "background": "#FFFFFF", "surface": "#F4F6F8", "text": "#1C2430", "mutedText": "#5A6472", "border": "#D3D9E0", "error": "#B3261E", "focus": "#0B5CAD", "font": "sans", "spacing": "comfortable", "radius": 6 }, "source": "user", "note": "Derived from src/styles/global.css." },
    "embed.origins": { "topic": "theme_embedding", "status": "confirmed", "summary": "The production origin.", "value": ["https://www.example.jp"], "source": "repository" },
    "review.approved": { "topic": "review", "status": "confirmed", "summary": "The user approved the summary, mapping and open items.", "value": true, "source": "user" },
    "operations.seed": { "topic": "review", "status": "confirmed", "summary": "Every operating fact is confirmed, so the seed is included.", "value": "included", "source": "user" }
  },
  "pending": ["pairing", "recipient_setup", "embedding_origins", "yatris_import", "staff_publication"]
}
```

### `src/reservations/salon.brief.json`

```json
{
  "briefVersion": 1,
  "setup": "salon",
  "stage": "implemented",
  "updated": "2026-10-07",
  "decisions": {
    "setup.purpose": { "topic": "booking_mode", "status": "confirmed", "summary": "Customers book a hair service.", "value": "salon_booking", "source": "user" },
    "mode.flow": { "topic": "booking_mode", "status": "confirmed", "summary": "A service with a stylist, sometimes a room.", "value": "business_service", "source": "user" },
    "setup.key": { "topic": "booking_mode", "status": "delegated", "summary": "Setup key.", "value": "salon", "source": "user" },
    "setup.name": { "topic": "booking_mode", "status": "confirmed", "summary": "Name shown to visitors.", "value": "ヘアサロンのご予約", "source": "user" },
    "placement.existing": { "topic": "booking_mode", "status": "confirmed", "summary": "A link to a third-party booking site, to be replaced.", "value": "third_party_link", "source": "repository" },
    "services.list": { "topic": "durations_resources", "status": "confirmed", "summary": "Cut (ショート 45 or ロング 75 minutes), colour 90 minutes, head spa 60 minutes.", "value": ["cut", "color", "head_spa"], "source": "user" },
    "practitioners.list": { "topic": "durations_resources", "status": "confirmed", "summary": "Yamada and Suzuki.", "value": ["yamada", "suzuki"], "source": "user" },
    "services.requirements": { "topic": "durations_resources", "status": "confirmed", "summary": "Either stylist cuts and colours; only Yamada does head spa, in the spa room.", "value": { "cut": "yamada|suzuki", "color": "yamada|suzuki", "head_spa": "yamada + spa_room" }, "source": "user" },
    "services.visitor_choice": { "topic": "durations_resources", "status": "confirmed", "summary": "Visitors may choose a stylist for cut and colour.", "value": { "cut": true, "color": true, "head_spa": false }, "source": "user" },
    "services.buffers": { "topic": "durations_resources", "status": "confirmed", "summary": "10 minutes after a cut; 5 before and 15 after a colour.", "value": { "cut": { "after": 10 }, "color": { "before": 5, "after": 15 } }, "source": "user" },
    "hours.weekly": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Tuesday to Sunday; closed Mondays.", "value": "tue-thu 10:00-19:00, fri 10:00-20:00, sat-sun 09:00-18:00", "source": "user" },
    "hours.exceptions": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Closed on New Year's Day.", "value": ["2027-01-01"], "source": "user" },
    "hours.resources": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Suzuki works Friday afternoon and weekends.", "value": { "suzuki": "fri 12:00-20:00, sat-sun 09:00-18:00" }, "source": "user" },
    "hours.timezone": { "topic": "hours_exceptions", "status": "delegated", "summary": "Japan time.", "value": "Asia/Tokyo", "source": "user", "proposedDefault": true },
    "policy.slot_interval": { "topic": "hours_exceptions", "status": "delegated", "summary": "Start times every 15 minutes.", "value": 15, "source": "user", "proposedDefault": true },
    "policy.horizon": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Bookable up to 60 days ahead.", "value": 60, "source": "user", "recommendation": 90 },
    "policy.lead_time": { "topic": "hours_exceptions", "status": "confirmed", "summary": "At least 3 hours ahead.", "value": 180, "source": "user", "recommendation": 120 },
    "policy.hold": { "topic": "hours_exceptions", "status": "delegated", "summary": "Hold a chosen time for 5 minutes.", "value": 5, "source": "user", "proposedDefault": true },
    "confirmation.mode": { "topic": "confirmation_policy", "status": "confirmed", "summary": "Bookings are confirmed automatically.", "value": "automatic", "source": "user" },
    "locations.list": { "topic": "locations_conferencing", "status": "confirmed", "summary": "In the salon only.", "value": ["salon"], "source": "user" },
    "locations.salon.details": { "topic": "locations_conferencing", "status": "confirmed", "summary": "Salon address and arrival note.", "value": { "address": "東京都港区南青山5-1-1 青山ビル2階", "instructions": "ご予約時間の5分前を目安にお越しください。" }, "source": "user" },
    "calendar.maintenance": { "topic": "locations_conferencing", "status": "confirmed", "summary": "Reception enters phone and walk-in bookings in Yatris.", "value": "staff_bookings", "source": "user" },
    "calendar.wish": { "topic": "locations_conferencing", "status": "confirmed", "summary": "No calendar sync wanted.", "value": "none", "source": "user" },
    "questions.list": { "topic": "questions_recipients", "status": "confirmed", "summary": "Questions in order.", "value": ["name", "name_kana", "email", "phone", "visit", "length_note", "health", "allergy", "health_consent", "request"], "source": "user" },
    "questions.name.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "お名前 is required.", "value": true, "source": "user" },
    "questions.name_kana.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "フリガナ is required, in katakana.", "value": true, "source": "user" },
    "questions.email.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "メールアドレス is required.", "value": true, "source": "user" },
    "questions.phone.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "電話番号 is required.", "value": true, "source": "user" },
    "questions.visit.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "First visit or repeat is required.", "value": true, "source": "user" },
    "questions.allergy.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "The allergy note is optional.", "value": false, "source": "user" },
    "questions.health_consent.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "Consent is required whenever the health questions are shown.", "value": true, "source": "user" },
    "questions.request.required": { "topic": "questions_recipients", "status": "delegated", "summary": "ご要望 is optional.", "value": false, "source": "user", "recommendation": false },
    "questions.identity": { "topic": "questions_recipients", "status": "delegated", "summary": "Identity questions.", "value": { "name": "name", "email": "email", "phone": "phone" }, "source": "user" },
    "questions.conditions": { "topic": "questions_recipients", "status": "confirmed", "summary": "Health questions only for colour and head spa; a note for long hair.", "value": { "health": "visible_for_color_head_spa", "length_note": "visible_for_long" }, "source": "user" },
    "questions.sensitive": { "topic": "questions_recipients", "status": "confirmed", "summary": "The allergy note is sensitive.", "value": ["allergy"], "source": "user" },
    "questions.consent": { "topic": "questions_recipients", "status": "confirmed", "summary": "Unselected consent with the approved wording; the help text states the purpose.", "value": { "consentText": "ご記入いただいたアレルギー等の情報は、施術の安全のためにのみ利用し、担当スタッフ以外には共有しません。", "consentVersion": "2026-10" }, "source": "user" },
    "mail.source": { "topic": "questions_recipients", "status": "delegated", "summary": "Yatris platform mail; no customer SMTP.", "value": "platform", "source": "user" },
    "cutoffs.cancel": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Online cancellation until 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "cutoffs.reschedule": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Online rescheduling until 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "reminder.timing": { "topic": "cutoffs_copy", "status": "delegated", "summary": "One reminder 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "copy.confirmed": { "topic": "cutoffs_copy", "status": "confirmed", "summary": "Confirmation message.", "value": "ご予約が確定しました。ご来店をお待ちしております。", "source": "user" },
    "success.redirect": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Show the message in the booking page.", "value": "message", "source": "user", "recommendation": "message" },
    "placement.route": { "topic": "theme_embedding", "status": "confirmed", "summary": "The booking page.", "value": "/reservation/", "source": "user" },
    "theme.tokens": { "topic": "theme_embedding", "status": "delegated", "summary": "Taken from the site's palette and fonts.", "value": { "primary": "#3D3A35", "onPrimary": "#FFFFFF", "background": "#FBF9F6", "surface": "#FFFFFF", "text": "#2B2925", "mutedText": "#6E6A63", "border": "#E2DDD5", "error": "#A4262C", "focus": "#8A6D3B", "font": "sans", "headingFont": "serif", "spacing": "spacious", "radius": 12 }, "source": "user", "note": "Derived from src/styles/global.css." },
    "embed.origins": { "topic": "theme_embedding", "status": "confirmed", "summary": "The production origin.", "value": ["https://salon.example.jp"], "source": "repository" },
    "review.approved": { "topic": "review", "status": "confirmed", "summary": "The user approved the summary, mapping and open items.", "value": true, "source": "user" },
    "operations.seed": { "topic": "review", "status": "confirmed", "summary": "Every operating fact is confirmed, so the seed is included.", "value": "included", "source": "user" }
  },
  "pending": ["pairing", "recipient_setup", "staff_review", "embedding_origins", "yatris_import", "staff_publication"]
}
```

### `src/reservations/restaurant.brief.json`

```json
{
  "briefVersion": 1,
  "setup": "restaurant",
  "stage": "implemented",
  "updated": "2026-10-07",
  "decisions": {
    "setup.purpose": { "topic": "booking_mode", "status": "confirmed", "summary": "Guests reserve a table.", "value": "table_reservation", "source": "user" },
    "mode.flow": { "topic": "booking_mode", "status": "confirmed", "summary": "A party size and a time.", "value": "business_party", "source": "user" },
    "setup.key": { "topic": "booking_mode", "status": "delegated", "summary": "Setup key.", "value": "restaurant", "source": "user" },
    "setup.name": { "topic": "booking_mode", "status": "confirmed", "summary": "Name shown to visitors.", "value": "お席のご予約", "source": "user" },
    "placement.existing": { "topic": "booking_mode", "status": "confirmed", "summary": "Reservations were by phone only.", "value": "none", "source": "user" },
    "party.size_limits": { "topic": "durations_resources", "status": "confirmed", "summary": "Online for 1 to 8 guests.", "value": { "min": 1, "max": 8 }, "source": "user" },
    "party.duration": { "topic": "durations_resources", "status": "confirmed", "summary": "Two hours per party.", "value": 120, "source": "user" },
    "party.strategy": { "topic": "durations_resources", "status": "confirmed", "summary": "Seats are assigned by table.", "value": "tables", "source": "user" },
    "party.tables": { "topic": "durations_resources", "status": "confirmed", "summary": "Two tables for 2, one for 4, a private room for 4 to 8; tables 1 and 2 combine for 3 or 4.", "value": ["t1", "t2", "t3", "t4"], "source": "user" },
    "party.buffer": { "topic": "durations_resources", "status": "delegated", "summary": "15 minutes to reset a table.", "value": 15, "source": "user", "recommendation": 15, "proposedDefault": true },
    "hours.weekly": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Lunch and dinner Tuesday to Friday, all day at weekends; closed Mondays.", "value": "tue-thu 11:30-14:00, 17:30-22:00; fri 11:30-14:00, 17:30-23:00; sat 11:30-23:00; sun 11:30-21:00", "source": "user" },
    "hours.exceptions": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Lunch only on New Year's Eve; closed on New Year's Day.", "value": ["2026-12-31 11:30-15:00", "2027-01-01"], "source": "user" },
    "hours.timezone": { "topic": "hours_exceptions", "status": "delegated", "summary": "Japan time.", "value": "Asia/Tokyo", "source": "user", "proposedDefault": true },
    "policy.slot_interval": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Seatings every 30 minutes.", "value": 30, "source": "user", "recommendation": 15 },
    "policy.horizon": { "topic": "hours_exceptions", "status": "confirmed", "summary": "Bookable up to 30 days ahead.", "value": 30, "source": "user", "recommendation": 90 },
    "policy.lead_time": { "topic": "hours_exceptions", "status": "delegated", "summary": "At least 2 hours ahead.", "value": 120, "source": "user", "proposedDefault": true },
    "policy.hold": { "topic": "hours_exceptions", "status": "delegated", "summary": "Hold a chosen time for 5 minutes.", "value": 5, "source": "user", "proposedDefault": true },
    "confirmation.mode": { "topic": "confirmation_policy", "status": "confirmed", "summary": "Staff approve each request.", "value": "manual", "source": "user" },
    "confirmation.approval_window": { "topic": "confirmation_policy", "status": "confirmed", "summary": "Staff answer within 12 hours.", "value": 720, "source": "user", "recommendation": 1440 },
    "locations.list": { "topic": "locations_conferencing", "status": "confirmed", "summary": "The restaurant itself.", "value": ["restaurant"], "source": "user" },
    "locations.restaurant.details": { "topic": "locations_conferencing", "status": "confirmed", "summary": "Restaurant address.", "value": { "address": "大阪府大阪市北区梅田2-2-2 グルメビル1階" }, "source": "user" },
    "calendar.maintenance": { "topic": "locations_conferencing", "status": "confirmed", "summary": "Staff enter phone and walk-in bookings in Yatris.", "value": "staff_bookings", "source": "user" },
    "calendar.wish": { "topic": "locations_conferencing", "status": "confirmed", "summary": "No calendar sync wanted.", "value": "none", "source": "user" },
    "questions.list": { "topic": "questions_recipients", "status": "confirmed", "summary": "Questions in order.", "value": ["name", "email", "phone", "occasion", "children", "allergies"], "source": "user" },
    "questions.name.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "お名前 is required.", "value": true, "source": "user" },
    "questions.email.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "メールアドレス is required.", "value": true, "source": "user" },
    "questions.phone.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "電話番号 is optional, required for 6 or more guests.", "value": false, "source": "user" },
    "questions.occasion.required": { "topic": "questions_recipients", "status": "delegated", "summary": "ご利用目的 is optional.", "value": false, "source": "user", "recommendation": false },
    "questions.children.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "お子様の人数 is optional.", "value": false, "source": "user" },
    "questions.allergies.required": { "topic": "questions_recipients", "status": "confirmed", "summary": "The allergy note is optional.", "value": false, "source": "user" },
    "questions.identity": { "topic": "questions_recipients", "status": "delegated", "summary": "Identity questions.", "value": { "name": "name", "email": "email", "phone": "phone" }, "source": "user" },
    "questions.conditions": { "topic": "questions_recipients", "status": "confirmed", "summary": "Phone required for 6 or more; children asked for 2 or more.", "value": { "phone": "required_when_party_6_plus", "children": "visible_when_party_2_plus" }, "source": "user" },
    "questions.sensitive": { "topic": "questions_recipients", "status": "confirmed", "summary": "The allergy note is sensitive.", "value": ["allergies"], "source": "user" },
    "questions.consent": { "topic": "questions_recipients", "status": "confirmed", "summary": "No separate consent for a short allergy note; its help text states that only the kitchen sees it.", "value": "none", "source": "user" },
    "mail.source": { "topic": "questions_recipients", "status": "delegated", "summary": "Yatris platform mail; no customer SMTP.", "value": "platform", "source": "user" },
    "cutoffs.cancel": { "topic": "cutoffs_copy", "status": "confirmed", "summary": "Online cancellation until 3 hours before.", "value": 180, "source": "user", "recommendation": 1440 },
    "cutoffs.reschedule": { "topic": "cutoffs_copy", "status": "confirmed", "summary": "Online rescheduling until 3 hours before.", "value": 180, "source": "user", "recommendation": 1440 },
    "reminder.timing": { "topic": "cutoffs_copy", "status": "delegated", "summary": "One reminder 24 hours before.", "value": 1440, "source": "user", "proposedDefault": true },
    "copy.pending": { "topic": "cutoffs_copy", "status": "confirmed", "summary": "Request message with the 12-hour promise the client confirmed.", "value": "ご予約リクエストを受け付けました。店舗で確認のうえ、12時間以内に確定のご連絡をいたします。", "source": "user" },
    "copy.confirmed": { "topic": "cutoffs_copy", "status": "delegated", "summary": "Confirmation message.", "value": "ご予約が確定しました。ご来店をお待ちしております。", "source": "user" },
    "success.redirect": { "topic": "cutoffs_copy", "status": "confirmed", "summary": "A thanks page that says the request awaits confirmation.", "value": "/reserve/thanks/", "source": "user" },
    "placement.route": { "topic": "theme_embedding", "status": "confirmed", "summary": "The reservation page.", "value": "/reserve/", "source": "user" },
    "theme.tokens": { "topic": "theme_embedding", "status": "delegated", "summary": "Taken from the site's palette and fonts.", "value": { "primary": "#7A2E1F", "onPrimary": "#FFFFFF", "background": "#FFFDF8", "surface": "#FFFFFF", "text": "#2A2420", "mutedText": "#6B625B", "border": "#E5DED3", "error": "#A4262C", "focus": "#7A2E1F", "font": "sans", "spacing": "comfortable", "radius": 4 }, "source": "user", "note": "Derived from src/styles/global.css." },
    "embed.origins": { "topic": "theme_embedding", "status": "confirmed", "summary": "The production origin.", "value": ["https://restaurant.example.jp"], "source": "repository" },
    "review.approved": { "topic": "review", "status": "confirmed", "summary": "The user approved the summary, mapping and open items.", "value": true, "source": "user" },
    "operations.seed": { "topic": "review", "status": "confirmed", "summary": "Every operating fact is confirmed, so the seed is included.", "value": "included", "source": "user" }
  },
  "pending": ["pairing", "recipient_setup", "staff_review", "embedding_origins", "yatris_import", "staff_publication"]
}
```
