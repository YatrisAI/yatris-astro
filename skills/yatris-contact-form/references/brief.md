# The interview brief: `src/forms/<key>.brief.json`

The brief is the durable, committed record of a contact-form interview. It
lets any later session, or another agent, continue without asking again, and
lets Yatris import the decisions once synchronization exists. The shape is
`brief.schema.json` in this directory (version 1).

`yatris forms validate` and the preview skip `*.brief.json` files, and a build
never reads `src/forms/`, so nothing in a brief reaches the website.

## Shape

```text
{
  "briefVersion": 1,                     always 1
  "form": "<key>",                       the form key; matches the file name
  "stage": "interviewing" | "reviewed" | "implemented",
  "updated": "YYYY-MM-DD",               optional
  "decisions": { "<id>": Decision, ... },
  "pending": [ ... ]                     optional; what remains outside the repository
}

Decision {
  "topic": "purpose_placement" | "fields" | "conditions" | "files_consent"
         | "client_notification" | "visitor_email" | "mail_source"
         | "submission_result" | "review",
  "status": "confirmed" | "delegated" | "unresolved",
  "summary": "<one plain sentence: the decision, or the open question>",
  "value": <any JSON>,                   required unless unresolved; forbidden when unresolved
  "source": "user" | "repository" | "yatris",   required unless unresolved
  "recommendation": <any JSON>,          optional: what you proposed
  "note": "<text>"                       optional
}
```

- **Decision ids** are the ids in `interview.md` (`fields.email.required`,
  `success.mode`, …): lowercase, dot-separated, field keys as written in the
  declaration.
- **`confirmed`**: the user answered (`source: "user"`), or an existing file
  or Yatris state settles it (`"repository"`, `"yatris"`).
- **`delegated`**: the user let you choose (「おまかせします」); `value` is the
  recommendation you presented and `source` is `"user"`.
- **`unresolved`**: no value yet. Keep a `recommendation` if you made one.
  An unresolved requiredness is never written into a declaration as
  optional.
- **`pending`** names work outside the repository: `pairing`,
  `yatris_import`, `staff_publication`, `recipient_confirmation`,
  `mail_setup`, `privacy_page`.

## Rules

- Write it after every interview round, not only at the end.
- **Never** put an SMTP host, user name, password, API key, token or visitor
  data in it. Business recipient addresses the user gave are allowed; they
  are also in the declaration.
- On resume, read it first. Skip every `confirmed` and `delegated` decision
  and continue with the unresolved ones in topic order. Re-open a decision
  only when the user changes it or a fact it relied on changed (for example,
  the email field it names was removed); then update it and say why.
- When the declaration and the brief disagree, ask the user which is
  current; do not silently trust either.
- Delete nothing when the form is done: the brief stays as the record of
  what was agreed.

## Example

The brief behind example 1 in `examples.md`, after implementation. The
recipients are still unknown, so the declaration has no
`mail.notification.to` and the Website Owner sets them in the dashboard.

```json
{
  "briefVersion": 1,
  "form": "contact",
  "stage": "implemented",
  "updated": "2026-10-07",
  "decisions": {
    "purpose.summary": { "topic": "purpose_placement", "status": "confirmed", "summary": "General inquiries from prospective customers.", "value": "general_inquiry", "source": "user" },
    "purpose.key": { "topic": "purpose_placement", "status": "delegated", "summary": "Form key.", "value": "contact", "source": "user" },
    "placement.route": { "topic": "purpose_placement", "status": "confirmed", "summary": "The form is on the contact page.", "value": "/contact/", "source": "repository" },
    "placement.existing": { "topic": "purpose_placement", "status": "confirmed", "summary": "No form existed before.", "value": "none", "source": "repository" },
    "fields.list": { "topic": "fields", "status": "confirmed", "summary": "Fields in order.", "value": ["name", "furigana", "email", "tel", "message", "consent"], "source": "user" },
    "fields.name.required": { "topic": "fields", "status": "confirmed", "summary": "お名前 is required.", "value": true, "source": "user" },
    "fields.furigana.required": { "topic": "fields", "status": "confirmed", "summary": "フリガナ is optional.", "value": false, "source": "user" },
    "fields.email.required": { "topic": "fields", "status": "confirmed", "summary": "メールアドレス is required.", "value": true, "source": "user" },
    "fields.tel.required": { "topic": "fields", "status": "delegated", "summary": "電話番号 is optional, as recommended.", "value": false, "source": "user", "recommendation": false },
    "fields.message.required": { "topic": "fields", "status": "confirmed", "summary": "お問い合わせ内容 is required.", "value": true, "source": "user" },
    "fields.consent.required": { "topic": "fields", "status": "confirmed", "summary": "Consent is required.", "value": true, "source": "user" },
    "fields.kana_preset": { "topic": "fields", "status": "confirmed", "summary": "Reading in katakana.", "value": "katakana", "source": "user" },
    "form.confirm_step": { "topic": "fields", "status": "delegated", "summary": "No confirmation step for a short form.", "value": false, "source": "user", "recommendation": false },
    "conditions.none": { "topic": "conditions", "status": "confirmed", "summary": "Every field is always shown.", "value": true, "source": "user" },
    "files.enabled": { "topic": "files_consent", "status": "confirmed", "summary": "No attachments.", "value": false, "source": "user" },
    "consent.enabled": { "topic": "files_consent", "status": "confirmed", "summary": "Visitors agree to the privacy handling.", "value": true, "source": "user" },
    "consent.text": { "topic": "files_consent", "status": "confirmed", "summary": "Consent wording approved by the client.", "value": "入力いただいた個人情報は、お問い合わせへの回答のためにのみ利用します。", "source": "user" },
    "consent.policy_path": { "topic": "files_consent", "status": "confirmed", "summary": "The privacy page exists.", "value": "/privacy/", "source": "repository" },
    "notification.recipients": { "topic": "client_notification", "status": "unresolved", "summary": "Which business addresses receive inquiries? The client will confirm; the Website Owner can set them in the Yatris dashboard." },
    "notification.reply_to_field": { "topic": "client_notification", "status": "delegated", "summary": "Replies go to the visitor.", "value": "email", "source": "user" },
    "notification.subject": { "topic": "client_notification", "status": "delegated", "summary": "Default subject.", "value": "【お問い合わせ】{{form.name}}", "source": "user" },
    "notification.body": { "topic": "client_notification", "status": "delegated", "summary": "Default body.", "value": "受付番号: {{submission.reference}}\n受付日時: {{submission.date}}\n\n{{submission.answers}}", "source": "user" },
    "thank_you.enabled": { "topic": "visitor_email", "status": "confirmed", "summary": "Visitors get a thank-you mail.", "value": true, "source": "user" },
    "thank_you.to_field": { "topic": "visitor_email", "status": "confirmed", "summary": "Sent to the email field.", "value": "email", "source": "repository" },
    "thank_you.subject": { "topic": "visitor_email", "status": "delegated", "summary": "Default subject.", "value": "お問い合わせありがとうございます（{{website.name}}）", "source": "user" },
    "thank_you.body": { "topic": "visitor_email", "status": "confirmed", "summary": "Body approved by the client.", "value": "{{field.name}} 様\n\nこのたびはお問い合わせいただき、ありがとうございます。以下の内容で受け付けました。\n\n{{submission.answers}}", "source": "user" },
    "mail.source": { "topic": "mail_source", "status": "confirmed", "summary": "Yatris platform mail; no customer SMTP for now.", "value": "platform", "source": "user" },
    "success.mode": { "topic": "submission_result", "status": "confirmed", "summary": "Show a message on the page.", "value": "message", "source": "user" },
    "success.message": { "topic": "submission_result", "status": "delegated", "summary": "Recommended message.", "value": "お問い合わせを受け付けました。内容を確認のうえ、担当者よりご連絡いたします。", "source": "user" },
    "review.approved": { "topic": "review", "status": "confirmed", "summary": "The user approved the summary and mapping.", "value": true, "source": "user" }
  },
  "pending": ["pairing", "yatris_import", "staff_publication", "recipient_confirmation"]
}
```
