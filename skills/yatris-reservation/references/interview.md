# Interview: question bank, defaults and decision ids

Use this with the workflow in `SKILL.md`. Every decision has an id; it is the
key under `decisions` in the brief (`brief.md`). Ask in topic order, at most
three questions per round, and only what discovery did not already answer.

Columns:

- **Modes**: the booking modes the decision exists in. `all`, `time_slot`,
  `business` (both business flows), `service` or `party`. **Never ask, and
  never record, a decision outside the setup's mode**: a restaurant (`party`)
  gets no host or service questions, a consultant (`time_slot`) gets no
  table, party-size or practitioner questions.
- **Kind**:
  - `fact`: a business fact. Only the user (or an existing file, or Yatris)
    can settle it. Never delegated, never filled with a guess, never taken
    from page text such as published phone hours. Unknown stays
    `unresolved`.
  - `default`: a setting with a **proposed default** (spec §3, decision
    §13). Present the default as a default ("Yatrisの標準設定は…です"), never
    as how the business works. Delegated, it is recorded with
    `proposedDefault: true`.
  - `choice`: a preference you may recommend; the user confirms or
    delegates it.
- **Needed for**:
  - `declaration`: confirmed or delegated before the review and before
    `src/reservations/<key>.json` is written.
  - `publication`: may stay `unresolved` while you write the declaration
    and preview it, but it is a **readiness blocker** before live
    publication (`readiness.md`).
  - `—`: optional.

## 1. Booking mode

| Id | Modes | Kind | Needed for | Ask (or discover) | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `setup.purpose` | all | choice | declaration | What do visitors book, and who are they? | — |
| `mode.flow` | all | choice | declaration | Which flow fits: `time_slot` (an appointment with a person: 相談, 面談, 打ち合わせ), `business_service` (a menu item that needs staff and maybe a room: salon, clinic, 整体) or `business_party` (a party size and a time: restaurant, café, 体験教室 with seats)? Usually clear from the business; confirm it in one sentence. It never changes once the setup exists in Yatris: another mode is a new setup. | From the business type. |
| `setup.key` | all | choice | declaration | Usually not asked: derive it (`consultation`, `reservation`, `salon`) and show it in the review. Immutable once the setup exists in Yatris. | — |
| `setup.name` | all | choice | declaration | The name visitors see, e.g. 「無料相談（30分）」「お席のご予約」. | From the purpose. |
| `placement.existing` | all | fact | declaration | Discovered, not asked: an existing `src/reservations/` file, a third-party booking widget or link (TimeRex, Calendly, Google Calendar appointment pages, STORES 予約, Airリザーブ, ホットペッパー, TableCheck, a LINE booking link), a hand-built booking form, or a contact form used for bookings. | — |

A second kind of booking on the same site (for example 来店予約 and
オンライン相談 with different hosts) is a separate setup with its own key,
declaration and brief.

## 2. Durations and resources

Ask only the rows of the setup's mode.

| Id | Modes | Kind | Needed for | Ask | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `appointment.duration` | time_slot | fact | publication | How long is one appointment? | — |
| `hosts.list` | time_slot | fact | publication | Who can be booked (names as visitors may see them)? Hosts are Yatris schedule records; nobody needs a Yatris login to be bookable. | — |
| `hosts.strategy` | time_slot | fact | publication | One fixed host (`single`), or any available host from the list (`one_available`)? | — |
| `hosts.visitor_choice` | time_slot | choice | — | With several hosts: may visitors choose one, or does Yatris assign an available host? | Assign (no choice), unless visitors ask for a specific person. |
| `appointment.buffers` | time_slot | default | — | Free time before or after each appointment? | No buffer before, 15 minutes after (a proposed default, not a verified fact). |
| `services.list` | service | fact | publication | Which menu items are bookable, each with its duration and any variants (ショート/ロング)? One service per booking in v1. | — |
| `practitioners.list` | service | fact | publication | Which staff members provide services? | — |
| `services.requirements` | service | fact | publication | For each service: who can provide it, and does it also need a room or equipment? | — |
| `services.visitor_choice` | service | choice | — | May visitors choose a practitioner (with 指名なし always possible)? | Yes where clients usually ask for a person (salons); no otherwise. |
| `services.buffers` | service | default | — | Preparation or cleaning time before or after a service? | None, unless the client names one. |
| `party.size_limits` | party | fact | publication | Smallest and largest party that can book online? | — |
| `party.duration` | party | fact | publication | How long does a party keep its seats (for example 2 hours)? | — |
| `party.strategy` | party | fact | publication | Are seats assigned by table (`tables`) or counted from one capacity (`pool`, for example 20 seats at a counter or a class)? | — |
| `party.tables` | party | fact | publication | `tables` only: each table with its seat range, and which tables may be combined for larger parties. Table assignment can stay private. | — |
| `party.capacity` | party | fact | publication | `pool` only: how many seats or places in total? | — |
| `party.buffer` | party | default | — | Turnover time after each party? | 15 minutes (a proposed default). |

Never ask a restaurant about hosts or meeting links, and never ask a
consultant about tables or party sizes. Children, accessibility and dietary
notes are questions (topic 6), not resources.

## 3. Hours and exceptions

| Id | Modes | Kind | Needed for | Ask | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `hours.weekly` | all | fact | publication | Bookable hours for each weekday, with breaks (昼休み) and lunch/dinner periods. **Bookable** hours, not phone or opening hours printed on the site. | — |
| `hours.exceptions` | all | fact | publication | Known closures and special days (年末年始, 定休日 that are not weekly, holidays). | — |
| `hours.resources` | time_slot, service | fact | publication | Do individual hosts or practitioners work different hours from the venue? | — |
| `hours.timezone` | all | default | — | Usually not asked. | `Asia/Tokyo` (default). |
| `policy.slot_interval` | all | default | — | How often a start time is offered, separate from the duration. | Every 15 minutes (default). |
| `policy.horizon` | all | default | — | How far ahead visitors can book. | 90 days (default). |
| `policy.lead_time` | all | default | — | How soon before the start a booking is still accepted. | 2 hours (default). |
| `policy.hold` | all | default | — | Usually not asked: how long a chosen time is held while the visitor fills in the form. | 5 minutes (default). |

Daily operations (hours, closures, services, staff availability, capacity)
belong to the client and live in Yatris after the setup is created. The
interview collects them once so the setup can start correctly; it does not
make the repository their home (`declaration.md`, "Operations seed").

## 4. Confirmation policy

| Id | Modes | Kind | Needed for | Ask | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `confirmation.mode` | all | fact | publication | Should bookings be confirmed **automatically**, or should staff **approve** each request? Explain both in one line each. **Never inferred and never delegated**: even 「おまかせ」 leaves it unresolved. The Website Owner decides it. | None. Present both; the client chooses. |
| `confirmation.approval_window` | all | default | — | Manual only: how long staff have to approve before the request expires. | 24 hours, ending early enough before the appointment (default). |

Explain without asking: in manual mode a pending request already holds its
time; a reschedule is a change request and the original booking stays valid
until staff approve the new time. Automatic confirmation is safe only when
the schedule in Yatris is complete (`calendar.maintenance`).

## 5. Locations, Calendar and conferencing

| Id | Modes | Kind | Needed for | Ask | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `locations.list` | all | fact | publication | Which ways of meeting does the business **actually** offer: in person, online, phone? Offer only those. Never add one the client did not name (a business that takes phone inquiries does not thereby offer phone appointments). | — |
| `locations.<key>.details` | all | fact | publication | In person: the exact address and access notes. Online: the fixed meeting URL or the instructions visitors receive. Phone: who calls whom. | — |
| `calendar.maintenance` | all | fact | publication | Who keeps the schedule in Yatris current, and how do appointments already arranged by phone, LINE or the contact form get in? | Staff enter them as staff bookings in Yatris. |
| `calendar.wish` | all | choice | — | Would they like bookings to appear in Google Calendar later? **A wish only**: Calendar is a later Yatris phase and stays off unless enabled; the core works without it. | Record the wish; plan for Yatris-only operation. |
| `conferencing.wish` | time_slot, service | choice | — | Online only: would they like an automatic Google Meet or Zoom link per booking later? **A wish only**: a later phase. In the core an online appointment uses a fixed meeting URL or written instructions. | Record the wish; use a fixed URL or instructions now. |

Ask the Calendar and conferencing wishes only when they are relevant (an
online location, or the client mentions Google Calendar). A restaurant is not
asked about meeting links.

## 6. Questions and recipients

| Id | Modes | Kind | Needed for | Ask | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `questions.list` | all | choice | declaration | Which questions, in which order, with which labels? Present a candidate list. | Time slot: お名前, メールアドレス, 電話番号, ご相談内容. Service: お名前, フリガナ, メールアドレス, 電話番号, ご来店（初回/2回目以降）, ご要望. Party: お名前, メールアドレス, 電話番号, ご利用目的, ご要望. |
| `questions.<key>.required` | all | choice | declaration | Show every input with your proposed 必須/任意 and get it confirmed. | Name and email: 必須 (always). |
| `questions.identity` | all | choice | declaration | Usually not asked: which questions hold the visitor's name and email (and phone, if any). Name and email are always required, unconditional and never `sensitive`. | `{ "name": "name", "email": "email" }`, plus `"phone"` when a phone question exists. |
| `questions.conditions` | all | choice | — | Questions shown or required only for some bookings (for one service, a party of six or more, the in-person location). Confirm one example per branch. | — |
| `questions.sensitive` | all | choice | declaration, if any | Which answers are health or similarly private information? List them; they are marked `sensitive: true`. Do not collect detailed medical histories. | Clinics and treatments: only what the treatment needs. |
| `questions.consent` | all | choice | declaration, if sensitive | The consent wording (an `acceptance` question, never pre-checked) and the purpose notice. Required for health or clinic intake; for a short restaurant allergy note, ask whether the client wants one. The client approves the wording; it is a legal statement. | 「ご記入いただいた健康に関する情報は、施術の安全のためにのみ利用し、担当スタッフ以外には共有しません。」 |
| `mail.source` | all | choice | — | Should booking mail come from the Website's mail profile (the client's own SMTP, if one is set up for contact forms) or Yatris platform mail? Never ask for SMTP settings (`connections.md`). | The Website's existing mail setup; platform mail when none. |

Business notification **recipients** are not interview decisions and never
appear in the repository, the brief or the declaration. The Website Owner sets
them for the setup in Yatris and each address is confirmed by link. Explain
that, keep `recipient_setup` in `pending`, and never write an address down,
even one the user gives you.

## 7. Cutoffs and copy

| Id | Modes | Kind | Needed for | Ask | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `cutoffs.cancel` | all | default | — | Until when can visitors cancel online with their management link? | 24 hours before the start (default). |
| `cutoffs.reschedule` | all | default | — | Until when can visitors reschedule online? | 24 hours before the start (default). |
| `reminder.timing` | all | default | — | One reminder email to the visitor; when? | 24 hours before (default). |
| `copy.confirmed` | all | choice | — | The message after an automatically confirmed booking. | 「ご予約が確定しました。確認メールをお送りしましたので、内容をご確認ください。」 |
| `copy.pending` | all | choice | — | Manual only: the message after a request. Any promise in it (「12時間以内にご連絡」) is a business fact the client confirms. It must never suggest the booking is confirmed. | 「ご予約リクエストを受け付けました。確認のうえ、改めてご連絡いたします。」 |
| `success.redirect` | all | choice | — | Stay in the booking page with the message, or go to a thanks page on the site (useful for ad conversion tracking)? A thanks page must not claim a pending request is confirmed. | The message, unless they track conversions. |
| `copy.email_notes` | all | choice | — | Wishes for the confirmation, reminder or cancellation email wording. Yatris owns those templates; record wishes for staff. | Yatris's standard Japanese messages. |

Tell the user that a booking made less than a day ahead is already past a
24-hour cutoff, and the booking page says so before submission.

## 8. Theme and embedding

| Id | Modes | Kind | Needed for | Ask | Recommendation |
| --- | --- | --- | --- | --- | --- |
| `placement.route` | all | choice | declaration | Which page shows the booking? Discover routes first. | `/reservation/` or `/contact/consultation/`, matching the site. |
| `theme.tokens` | all | choice | — | Usually not asked: derive the theme tokens from `src/styles/global.css` and the layout, then show them in the review. | From the site's palette and fonts. |
| `embed.origins` | all | fact | publication | Discovered: the site's production origin (and preview origin, if any) that Yatris staff register so the booking page may be embedded there. | From `astro.config.*` `site` and `.yatris/project.json`. |
| `embed.direct_link` | all | choice | — | Besides the embedded page, also link to the hosted booking page elsewhere (for example in the header or a LINE message)? | The component's built-in fallback link is enough. |

## 9. Review and readiness

| Id | Modes | Kind | Needed for | Ask |
| --- | --- | --- | --- | --- |
| `review.approved` | all | choice | declaration | Present the summary, the technical mapping, the delegated choices and defaults, and the unresolved facts with who resolves them. Approval allows writing the declaration and the page. |
| `operations.seed` | all | choice | — | Not asked: record whether the declaration carries the operations seed (`included`) or not yet (`omitted`), and why. |

The approval covers repository work only. It does not authorize publishing in
Yatris, connecting accounts, sending mail or setting recipients.

## Asking well

- One round, one topic or two adjacent ones. Example round for a restaurant,
  topic 2: 「1) オンラインで受け付ける人数は何名様から何名様までですか？
  2) お席は何時間でご案内していますか？ 3) テーブルごとの席数と、つなげて使える
  テーブルを教えてください。」
- Example round for a consultant, topic 2: 「1) 1回の相談は何分ですか？
  2) 担当される方はどなたですか？ 3) 担当者を固定しますか、空いている方が
  対応しますか？」
- Say which values are defaults: 「予約の締切は、Yatrisの標準では開始2時間前
  です。この設定でよろしいですか？」
- When the user answers several topics at once, record all of it and move on.
- When an answer changes an earlier decision (a new location, another
  mode), update that decision and re-check what depends on it (conditions on
  `booking.location_key`, host questions that no longer apply).
