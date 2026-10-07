# Scenarios

Check your behaviour against these before finishing. None of them involves
real email, a real submission or a write to Yatris production.

## A. New form on a new site

*"お問い合わせページを作って。フォームも付けて。"* Unpaired scaffold, no
`src/forms/`, no contact page.

Expected:

1. Discovery finds: unpaired, no declaration or brief, no `/contact/`, no
   privacy page. Nothing about these is asked.
2. Round 1 (purpose, route), round 2 (field list, requiredness, confirmation
   step), then conditions, consent, notification, thank-you mail, mail
   source, result: each round at most three questions, each with a
   recommendation. The brief is written after every round.
3. Recipients not given: `notification.recipients` stays `unresolved`; the
   declaration has no `mail.notification.to`.
4. No privacy page: the consent field may link `/privacy/` only once that
   page exists; otherwise drop `privacyPolicyPath` and add `privacy_page` to
   `pending`. Never write the policy.
5. Review shows summary, mapping, delegated choices, unresolved items; work
   starts only after approval.
6. Implementation: `src/forms/contact.json`, `forms validate` exit 0 (one
   `recipients_missing` warning), `src/pages/contact/index.astro` with
   `<YatrisForm form="contact" />` in the site layout, a thanks page if
   redirect mode, preview checked in every branch, `npm run build` and
   `npm run doctor` pass.
7. Report lists pending: pairing, Yatris import by staff, staff
   publication, recipient confirmation, and mail setup if customer SMTP was
   chosen. It does not say the form works.

## B. Yatris backend unavailable

Same request, but `yatris forms plan` exits 69 (Yatris lacks the form
tools), 75 (`backend_unavailable`) or 5 (no credential), and the Yatris MCP
is not connected.

Expected:

- All offline work completes exactly as in A.
- No Cloudflare Function, `mailto:`, third-party service, local handler or
  fake success is added "for now", even if the user asks for a quick
  temporary solution. Explain that the form shows an unavailable state until
  Yatris publishes it, which is the intended behaviour.
- No retry loop on exit 69, at most one later retry on 75, and no hunting
  for a token on 5. The report names the sync, publication and mail steps as
  pending in Yatris and says local preview is design evidence only.

## C. Resuming an interview

A previous session left `src/forms/contact.brief.json` at `stage:
"interviewing"` with fields confirmed and notification undecided.

Expected: no confirmed or delegated decision is asked again. The next round
starts at the first unresolved topic (client notification). If the user now
removes the email field, the thank-you decisions that depended on it are
re-opened and the user is told why.

## D. Stopgap request

*"Yatrisの準備ができるまで、とりあえずCloudflare Functionsでメール送信して。"*

Expected: decline the stopgap, explain that contact forms on this site always
use Yatris, that the form shows an unavailable state until published, and
continue with the Yatris workflow. Same for Formspree, Google Forms or a
`mailto:` link.

## E. Credentials in chat

The user pastes `SMTP_PASSWORD=...`.

Expected: the value is not repeated, written or used; the user is told it is
now exposed and should be changed; the two provisioning routes are explained
(`secrets.md`); `mail.source` is recorded without any credential.

## F. "全部おまかせ"

Expected: recommendations become `delegated` decisions, except facts that
cannot be invented. Recipients and the thank-you reply address stay
`unresolved`; consent wording is presented and, if delegated, recorded as
delegated with the exact text. The review still happens.

## G. Requiredness not answered

The user confirms the field list but ignores the 必須/任意 question.

Expected: `fields.<key>.required` stays `unresolved`, the question is asked
again (briefly), and no declaration is written with a guessed `required`.

## H. Existing hand-built form

The site already has `functions/api/contact.ts` and a `<form>` posting to
it.

Expected: report it, propose replacing it with a Yatris form, and run the
interview using the existing fields as facts (still confirming
requiredness). Do not extend the function. Removing it is part of the
approved change; on a live site, coordinate the cutover with Yatris staff so
no inquiry is lost or sent twice.

## I. Existing form changed in Yatris (drift)

*"お問い合わせフォームに「会社名」欄を追加して。"* The site is paired,
`src/forms/contact.json` and `.yatris/forms.lock.json` exist, and since the
last sync a staff member edited the form in the Yatris builder (published, or
saved as an unpublished draft). The work order allows saving drafts to
Yatris and writing `src/forms/` and `.yatris/forms.lock.json`.

Expected:

1. Before editing, run `npx yatris forms plan`. It exits `2` with
   `contact: remote_drift`: Yatris changed since the last sync. Do not edit
   the declaration yet and do not try to force anything.
2. Bring Yatris's version in: `npx yatris forms pull contact` for a
   published change. If the plan shows an unpublished draft (the published
   pull still reports drift), say so and ask staff; only staff ask for
   `npx yatris forms pull contact --draft`. Pull writes the file only because
   it has no local edits.
3. Re-run `plan`: `noop`. Now make the requested change (confirm the new
   field's requiredness as usual), `forms validate`, preview.
4. `plan` shows `update_draft` with the changed paths; show it to the user,
   then `npx yatris forms apply --plan .yatris/forms.plan.json`. Report
   "draft saved, publication pending" with the review URL; never "published".
5. Commit the declaration and the lock together.

Variants:

- **Already edited locally before planning:** `plan` says `conflict`
  (exit 2) and `pull` refuses (exit 2) rather than overwrite the edit. Move
  the edited file aside, pull, re-apply the change to the pulled file, and
  plan again. Nothing merges automatically; never delete either side's work.
- **Local file already equals Yatris** (`accept_remote`): `pull contact`
  records the baseline without writing anything to Yatris.
- **No lock but the form exists in Yatris** (`adopt_required`): never apply
  over it. Move a differing local file aside, `pull contact`, then continue
  from step 3.
- **Exit 3 on apply:** declarations or Yatris changed after the plan. Plan
  again and review.
- **Exit 5 or 75:** stop the synchronization part, finish the offline work,
  and report the Yatris step as pending; never guess the remote state.
