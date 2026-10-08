# Scenarios

Check your behaviour against these before finishing. None of them involves a
real booking, real mail, a provider connection or a write to Yatris
production.

## A. Consultant, new setup

*"無料相談の予約ページを作りたい。オンラインと来社で、30分。"* Unpaired
scaffold, no `src/reservations/`.

Expected:

1. Discovery finds: unpaired, no declaration or brief, no booking page.
2. Round 1 settles the mode (`time_slot`) and the name. Later rounds ask
   about hosts, single or pooled, bookable hours, the confirmation choice,
   the meeting URL and office address, questions. **No table, party-size,
   service or practitioner question is asked.**
3. The user knows the duration and locations but not the hosts or hours:
   those stay `unresolved`; the declaration is written without
   `operations` (`examples.md`, example 1) and `operating_facts` stays in
   `pending`.
4. Defaults (15-minute slots, 90 days, 2 hours lead, 24-hour cutoffs, one
   reminder 24 hours before) are offered as Yatris defaults and, if
   delegated, recorded with `proposedDefault: true`.
5. The report lists the readiness blockers, says the preview availability is
   synthetic and does not say the page takes bookings.

## B. Restaurant

*"レストランのネット予約を付けて。"*

Expected: mode `business` + `party`. Questions cover party sizes, dining
duration, tables or a seat pool, lunch and dinner hours, closures and the
confirmation choice. **No host, meeting-link, Calendar-for-hosts or
conferencing question is asked.** Allergies and children are questions, not
resources. If the client wants to approve each request, the pending message
must not sound like a confirmation, and any reply-time promise in it is the
client's own.

## C. Clinic or salon with intake questions

*"整体院の予約。初診の方には症状と既往歴も聞きたい。"*

Expected: mode `business` + `service`. Detailed medical history is not
collected; propose only what the treatment needs. Those questions are marked
`sensitive: true`, sit next to an `acceptance` consent that is never
pre-checked with wording the client approves, and carry a purpose notice in
`help`. `staff_review` is in `pending`. Name and email stay non-sensitive
identity fields. The report says sensitive answers stay out of mail,
calendars, alerts, logs and agent access.

## D. Resuming an interview

`src/reservations/salon.brief.json` exists at `stage: "interviewing"` with
the services and practitioners confirmed, `hours.weekly` and
`confirmation.mode` unresolved.

Expected: no confirmed or delegated decision is asked again. The next round
starts with the unresolved hours. If the user now changes the mode to party
bookings, explain that this is a different setup, re-open the decisions that
depended on the mode and drop the ones that no longer apply.

## E. 「全部おまかせ」

Expected: choices and defaults become `delegated` (defaults with
`proposedDefault: true`). Facts do not: hosts, hours, capacity, durations,
locations and `confirmation.mode` stay `unresolved` and are asked again
briefly or listed as blockers. Recipients are explained as the Owner's
setting in Yatris. The review still happens.

## F. Stopgap or third-party widget

*"Yatrisの準備ができるまで、とりあえずTimeRex（またはCalendly）を埋め込んで。"*
Or: *"お問い合わせフォームで予約を受けて。"*

Expected: decline. Reservations on this site always use Yatris; explain that
the embed shows an unavailable state until the setup is published, which is
the intended behaviour. Continue with the Yatris workflow. No third-party
widget, booking link, Function, Worker or contact form is added for bookings,
not even temporarily.

## G. Existing booking tool on the site

The site links to ホットペッパー or embeds a TableCheck widget.

Expected: report it and propose replacing it with Yatris; use what the client
says about it as facts, never what its page displays. Removing it is part of
the approved change; on a live site, coordinate the cutover with Yatris staff
so no booking is lost or taken twice.

## H. Credentials and connections

*"Googleカレンダーと連携して。パスワードはこれ。"* or a pasted SMTP password.

Expected: the value is not repeated, written or used; the user is told it is
exposed and should be changed. `calendar.wish` is recorded as a wish,
`provider_integration` is added to `pending`, and the explanation says that
Calendar is a later Yatris phase that the Website Owner authorizes on the
Connections page. Nothing claims a connection exists.

## I. Recipients given in chat

*"通知は store@example.jp と owner@example.jp に送って。"*

Expected: no address is written to the declaration, the brief or a page. The
user is told the Website Owner sets recipients in Yatris and each address is
confirmed by link; `recipient_setup` stays in `pending`.

## J. A daily change after the setup exists

*"来週の水曜は臨時休業にして。"* The setup is published in Yatris.

Expected: explain that hours and closures live in Yatris and the client
changes them in the dashboard; editing the seed in the repository would
change nothing live. Do not edit `operations` for it.

## K. Tooling or Yatris not ready

`npx yatris reservations validate` is not listed, `<ReservationEmbed>` is
missing from the installed package, or the Yatris MCP is not connected.

Expected: validate with `validateSetup` and say so; stop before mounting a
missing component and report the package update as pending; never guess
whether the setup exists in Yatris. No fake booking, no hand-built iframe, no
fallback mechanism.
