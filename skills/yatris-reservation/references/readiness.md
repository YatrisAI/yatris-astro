# Readiness and the honest report

A declaration that validates and a preview that looks right are design
evidence only. Before a setup takes real bookings, Yatris needs facts and
actions that are outside the repository. List them, every time, in the review
and in the final report, with who resolves each one.

## Readiness blockers

| `pending` id | Blocker | Who resolves it |
| --- | --- | --- |
| `operating_facts` | Any `fact` decision still `unresolved`: hosts or practitioners, rooms, tables or seats, durations, bookable hours and closures, locations and their details, who maintains the schedule, and the confirmation choice. Name each one. | The client answers; Yatris staff enter the facts in Yatris (or the seed carries them) |
| `recipient_setup` | Booking notification recipients for this setup | The Website Owner, in Yatris; each address confirmed by link |
| `embedding_origins` | The site origins the booking page may be embedded in | Yatris staff register them |
| `staff_review` | Sensitive questions, their consent and purpose notice | Yatris staff review before publication |
| `yatris_import` | The declaration is not in Yatris yet | `npx yatris reservations plan` and `apply` (saves a draft), or Yatris staff in the setup builder |
| `staff_publication` | The setup is not published | Yatris staff |
| `pairing` | The site is not paired (`websiteId` is `null`) | Yatris staff |
| `mail_setup` | The client wants their own sender, not yet active | The Website Owner on the Connections page, or staff |
| `provider_integration` | A Calendar, Meet or Zoom wish waits for its Yatris phase, the Owner's authorization and staff enablement | Yatris (phase), then the Owner and staff |
| `privacy_page` | A consent links to a privacy page that does not exist | The client; never write the policy yourself |

`confirmation.mode` unresolved is always an `operating_facts` blocker: a
setup cannot be published without an explicit automatic or manual choice.

## The synthetic-preview statement

Whenever you mention the preview, say plainly that its availability is
synthetic. For a Japanese user:

> プレビューに表示される担当者と空き枠は、画面確認用の架空のデータです。
> 実際の予約受付は、Yatrisでの設定・確認・公開が終わってから始まります。

In English: "The hosts and free times in the preview are synthetic sample
data for checking the design. Real bookings start only after the setup is
configured, reviewed and published in Yatris."

## The report

Finish with:

1. **Files** created or changed (declaration, brief, page, thanks page).
2. **Checks**: validation (which validator), `npm run build`,
   `npm run doctor`, and what you checked in preview, with the
   synthetic-preview statement. If you could not open a browser, say so.
3. **Decided**: the mode, the confirmation choice (or that it is open), and
   the defaults the user delegated, labelled as defaults.
4. **Not ready yet**: every readiness blocker above that applies, by name,
   with the unresolved facts listed one by one.

Never write 「予約を受け付けられるようになりました」, "the booking page is
live", "Google Calendar is connected" or "mail is configured" unless Yatris
itself shows it, and today you usually cannot read it.
