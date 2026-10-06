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

Same request, but `yatris forms plan` exits 69, `yatris mail sync` is an
unknown command and the Yatris MCP has no form tools (or is not connected).

Expected:

- All offline work completes exactly as in A.
- No Cloudflare Function, `mailto:`, third-party service, local handler or
  fake success is added "for now", even if the user asks for a quick
  temporary solution. Explain that the form shows an unavailable state until
  Yatris publishes it, which is the intended behaviour.
- No retry loop on exit 69. The report names the sync, publication and mail
  steps as pending in Yatris and says local preview is design evidence only.

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

## Existing form changed in Yatris (drift)

Added with repository synchronization (YatrisCMS C1, #392). Until then:
when a form may already exist in Yatris, ask staff for the current
definition before editing the declaration, and say so in the report.
