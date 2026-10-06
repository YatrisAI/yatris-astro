# Interview: question bank, defaults and decision ids

Use this with the workflow in `SKILL.md`. Every decision has an id; it is the
key under `decisions` in the brief (`brief.md`). Ask in topic order, at most
three questions per round, and only what discovery did not already answer.

**Blocking** decisions must be `confirmed` or `delegated` before the review
and before the declaration is written. Non-blocking ones may stay
`unresolved`; the declaration is still valid and the report names them as
pending.

Recommended defaults below are proposals. Present them, and use them only
when the user confirms or delegates.

## 1. Purpose and placement

| Id | Blocking | Ask (or discover) | Recommendation |
| --- | --- | --- | --- |
| `purpose.summary` | yes | What is the form for, and who fills it in? | — |
| `purpose.key` | yes | Usually not asked: derive it from the purpose (`contact`, `estimate`, `recruit`) and show it in the review. It never changes once the form exists in Yatris. | `contact` |
| `placement.route` | yes | Which page shows the form? Discover existing routes first. | `/contact/` |
| `placement.existing` | yes | Discovered, not asked: an existing declaration, Yatris form, hand-built form, `functions/` handler or `mailto:` link. | — |
| `placement.layout` | no | Where on the page and what sits around it (intro text, phone number, map). Mostly a design decision. | Below a short intro, full content width on mobile. |

A second form on the same site is a separate key and declaration, with its
own brief.

## 2. Fields

| Id | Blocking | Ask | Recommendation |
| --- | --- | --- | --- |
| `fields.list` | yes | Which fields, in which order, with which labels? Present a candidate list in plain words; ask what to add or drop. | General inquiry: お名前, フリガナ, メールアドレス, 電話番号, お問い合わせ内容, 個人情報の取り扱いへの同意. |
| `fields.<key>.required` | yes, per input | Show every input with your proposed 必須/任意 and ask for confirmation. `hidden` and `quiz` fields take none. | お名前, メールアドレス, お問い合わせ内容, 同意: 必須. Others: 任意. |
| `fields.<key>.options` | yes, per choice field | The exact choices and their order. "Other" is a separate conditional text field. | — |
| `fields.<key>.validation` | no | Limits, placeholders, defaults, only where they matter. | Name ≤ 100, message ≤ 5000 characters with a remaining-character counter. |
| `fields.kana_preset` | yes, if a name field exists | Is a reading (フリガナ) field wanted, and in katakana or hiragana? It uses the `text` field's `preset`, which also converts what visitors type. | Katakana, optional. |
| `form.confirm_step` | yes | Should visitors see a 入力→確認→完了 confirmation screen before sending? | Off for short forms; on for long forms or ones with attachments. |

Fold the furigana choice into the field-list proposal ("フリガナ（カタカナ）")
so the fields round stays at three questions.

Japanese conventions worth offering when relevant: a postal code field
(`validation.format: "postal_code_jp"`, normalized to `123-4567`), `tel` for
phone numbers (leading zeros kept), split 姓/名 only if the client needs it.
Postcode-to-address autofill is not available yet; do not build one or call
an outside API.

Map plain-language fields to contract types with `fields.md`.

## 3. Conditions

| Id | Blocking | Ask | Recommendation |
| --- | --- | --- | --- |
| `conditions.<key>` | yes, per conditional field | When is this field shown (`visibleWhen`) or required (`requiredWhen`)? Confirm one concrete example per branch: "法人を選んだ人だけ会社名を入力し、必須". | — |
| `conditions.none` | yes, if no field is conditional | Confirm that every field is always shown. Often discovered from the field list; ask only when a field sounds conditional. | — |

Express them with `conditions.md`. A hidden field's old answer never counts
and is never sent.

## 4. Files and consent

Skip the file questions when no attachment is wanted.

| Id | Blocking | Ask | Recommendation |
| --- | --- | --- | --- |
| `files.enabled` | yes | Do visitors attach files (drawings, photos, a CV)? | No. |
| `files.limits` | yes, if files | Which kinds, how many, how large? Limits: up to 5 files, 10 MiB each, 20 MiB per submission; PDF, JPEG, PNG, WebP, plain text only. | PDF/JPEG/PNG, up to 3 files, 10 MiB each. |
| `consent.enabled` | yes | Must visitors agree to the privacy handling before sending? | Yes, when the site has a privacy policy page. |
| `consent.text` | yes, if consent | The exact consent wording. Offer a draft, but the client approves it; it is a legal statement. | 「入力いただいた個人情報は、お問い合わせへの回答のためにのみ利用します。」 |
| `consent.policy_path` | no | The privacy policy route. Discover it; if missing, report it instead of writing a policy. | `/privacy/` if it exists. |

## 5. Client notification

| Id | Blocking | Ask | Recommendation |
| --- | --- | --- | --- |
| `notification.recipients` | no | Which business addresses receive each inquiry? Only addresses the user gives. They seed a new form only: afterwards the Website Owner manages them in the Yatris dashboard. Unknown: leave unresolved and out of the declaration. | — |
| `notification.reply_to_field` | no | Should replying to the notification answer the visitor? | Yes, the visitor's email field. |
| `notification.subject`, `notification.body` | yes | Accept or adjust the default wording. | Subject `【お問い合わせ】{{form.name}}`; body `受付番号: {{submission.reference}}`, `受付日時: {{submission.date}}`, blank line, `{{submission.answers}}`. |
| `notification.attachments` | no, if files | Attach uploaded files to the notification mail, or only show them in the dashboard inbox? | Dashboard only. |

Every inquiry also appears in the client's Yatris dashboard inbox, whatever
the mail settings.

## 6. Visitor email

| Id | Blocking | Ask | Recommendation |
| --- | --- | --- | --- |
| `thank_you.enabled` | yes | Send visitors an automatic thank-you mail? Needs an email field. | On, when the form has a required email field. |
| `thank_you.to_field` | yes, if on | Which email field receives it. Usually discovered. | The email field. |
| `thank_you.subject`, `thank_you.body` | yes, if on | Accept or adjust the wording. Promises in it (reply times) are business facts the client confirms. | Subject `お問い合わせありがとうございます（{{website.name}}）`; body `{{field.name}} 様`, blank line, `このたびはお問い合わせいただき、ありがとうございます。以下の内容で受け付けました。`, blank line, `{{submission.answers}}`. |
| `thank_you.reply_to_address` | no | The business address a visitor's reply goes to. Only an address the user gives. | — |

## 7. Mail source

| Id | Blocking | Ask | Recommendation |
| --- | --- | --- | --- |
| `mail.source` | no | Should mail go out through Yatris's platform mail, or the client's own mail server (SMTP), for example to send from their own domain? | Platform mail unless they ask for their own sender. |
| `mail.provisioning` | no, if customer SMTP | Who will enter the SMTP settings, and how? Explain the two routes in `secrets.md`; **never collect credentials**. | The Website Owner on the Yatris dashboard's Connections page. |

Explain in plain words: Yatris sends the mail either way. Without customer
SMTP it uses Yatris's own mail server with the business name as the sender
name. The SMTP settings are never part of the form, the repository or this
conversation.

## 8. Submission result

| Id | Blocking | Ask | Recommendation |
| --- | --- | --- | --- |
| `success.mode` | yes | After sending, stay on the page with a message, or go to a thanks page? A thanks page is useful for ad conversion tracking. | Message, unless they track conversions. |
| `success.message` | yes, if message | The wording shown. | 「お問い合わせを受け付けました。内容を確認のうえ、担当者よりご連絡いたします。」 |
| `success.redirect_path` | yes, if redirect | The thanks page path: an existing page or a new one. A same-site path starting with a single `/`. | `/contact/thanks/` |
| `success.thanks_page` | yes, if redirect | Create a new thanks page, or use the existing one? Its content if new. | New page with the message above and a link home. |

## 9. Review

| Id | Blocking | Ask |
| --- | --- | --- |
| `review.approved` | yes | Present the summary, the technical mapping, delegated choices and unresolved items. Approval allows writing the declaration and the page. |

The approval covers the repository work only. It does not authorize reading
SMTP values, sending test mail or publishing anything in Yatris.

## Asking well

- One round, one topic or two adjacent ones. Example round for topic 2:
  "1) この項目案で過不足はありますか？ 2) 必須/任意はこの案でよいですか？
  3) 送信前に確認画面を挟みますか？（おすすめ: 短いフォームなので無し）"
- When the user answers several topics at once, record all of it and move on.
- When an answer changes an earlier decision, update that decision and
  re-check everything that depends on it (fields used in conditions, the
  email field used for the thank-you mail).
