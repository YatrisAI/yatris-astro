# Declaration examples

Each example is a complete, valid `src/forms/<key>.json` (the package tests
validate every JSON block in this file). Start from the one closest to the
brief, then change it to match the decisions exactly. Addresses on
`example.jp` are placeholders: never put a placeholder or guessed address in
a real declaration. Leave `mail.notification.to` out until the user gives
the real recipients.

The optional `$schema` points editors at the JSON Schema shipped in the
package. More: `contracts/forms/v1/examples/` in `@yatris/astro`
(`full-coverage.json` uses every node type).

## 1. General inquiry: message on the page, recipients not yet known

The brief for this form is the example in `brief.md`.

```json
{
  "$schema": "../../node_modules/@yatris/astro/contracts/forms/v1/declaration.schema.json",
  "contractVersion": 1,
  "key": "contact",
  "name": "お問い合わせ",
  "locale": "ja",
  "fields": [
    { "key": "name", "type": "text", "label": "お名前", "required": true, "autocomplete": "name", "validation": { "maxLength": 100 } },
    { "key": "furigana", "type": "text", "label": "フリガナ", "required": false, "preset": "katakana", "validation": { "maxLength": 100 } },
    { "key": "email", "type": "email", "label": "メールアドレス", "required": true, "autocomplete": "email" },
    { "key": "tel", "type": "tel", "label": "電話番号", "required": false, "autocomplete": "tel" },
    { "key": "message", "type": "textarea", "label": "お問い合わせ内容", "required": true, "rows": 8, "characterCount": "remaining", "validation": { "maxLength": 5000 } },
    {
      "key": "consent",
      "type": "acceptance",
      "label": "個人情報の取り扱いに同意する",
      "required": true,
      "consentText": "入力いただいた個人情報は、お問い合わせへの回答のためにのみ利用します。",
      "privacyPolicyPath": "/privacy/"
    }
  ],
  "confirmStep": { "enabled": false },
  "submit": { "label": "送信する", "pendingLabel": "送信中…" },
  "success": { "mode": "message", "message": "お問い合わせを受け付けました。内容を確認のうえ、担当者よりご連絡いたします。" },
  "mail": {
    "notification": {
      "replyToField": "email",
      "subject": "【お問い合わせ】{{form.name}}",
      "body": "受付番号: {{submission.reference}}\n受付日時: {{submission.date}}\n\n{{submission.answers}}"
    },
    "thankYou": {
      "enabled": true,
      "toField": "email",
      "subject": "お問い合わせありがとうございます（{{website.name}}）",
      "body": "{{field.name}} 様\n\nこのたびはお問い合わせいただき、ありがとうございます。以下の内容で受け付けました。\n\n{{submission.answers}}"
    }
  }
}
```

`yatris forms validate` prints `⚠ … /mail/notification/to recipients_missing`
for this file. That warning is expected while recipients are unresolved.

## 2. Individual or business, confirmation step, thanks page

`company` and `department` appear only for businesses; a business must give
its company name. The confirmation step shows 入力→確認→完了. `source` is
declared `hidden` metadata the page fills in (`hidden={{ source: 'contact-page' }}`).

```json
{
  "$schema": "../../node_modules/@yatris/astro/contracts/forms/v1/declaration.schema.json",
  "contractVersion": 1,
  "key": "inquiry",
  "name": "お問い合わせ",
  "locale": "ja",
  "fields": [
    {
      "key": "customer_type",
      "type": "radio",
      "label": "お客様の区分",
      "required": true,
      "options": [
        { "value": "individual", "label": "個人" },
        { "value": "business", "label": "法人" }
      ]
    },
    {
      "key": "company",
      "type": "text",
      "label": "会社名",
      "required": true,
      "autocomplete": "organization",
      "visibleWhen": { "field": "customer_type", "operator": "eq", "value": "business" },
      "validation": { "maxLength": 200 }
    },
    {
      "key": "department",
      "type": "text",
      "label": "部署名",
      "required": false,
      "visibleWhen": { "field": "customer_type", "operator": "eq", "value": "business" },
      "validation": { "maxLength": 200 }
    },
    { "key": "name", "type": "text", "label": "お名前", "required": true, "autocomplete": "name", "validation": { "maxLength": 100 } },
    { "key": "furigana", "type": "text", "label": "フリガナ", "required": true, "preset": "katakana", "validation": { "maxLength": 100 } },
    { "key": "email", "type": "email", "label": "メールアドレス", "required": true, "autocomplete": "email" },
    { "key": "tel", "type": "tel", "label": "電話番号", "required": false, "autocomplete": "tel" },
    { "key": "message", "type": "textarea", "label": "お問い合わせ内容", "required": true, "validation": { "maxLength": 5000 } },
    { "key": "source", "type": "hidden", "validation": { "maxLength": 100 } },
    {
      "key": "consent",
      "type": "acceptance",
      "label": "個人情報の取り扱いに同意する",
      "required": true,
      "consentText": "入力いただいた個人情報は、お問い合わせへの回答のためにのみ利用します。",
      "consentVersion": "2026-10",
      "privacyPolicyPath": "/privacy/"
    }
  ],
  "confirmStep": { "enabled": true, "heading": "入力内容の確認", "backLabel": "修正する", "submitLabel": "この内容で送信する" },
  "submit": { "label": "入力内容を確認する", "pendingLabel": "送信中…" },
  "success": { "mode": "redirect", "redirectPath": "/contact/thanks/" },
  "mail": {
    "notification": {
      "to": ["info@example.jp"],
      "replyToField": "email",
      "subject": "【お問い合わせ】{{field.name}} 様",
      "body": "受付番号: {{submission.reference}}\n\n{{submission.answers}}"
    },
    "thankYou": {
      "enabled": true,
      "toField": "email",
      "subject": "お問い合わせありがとうございます",
      "body": "{{field.name}} 様\n\n以下の内容で受け付けました。\n\n{{submission.answers}}",
      "replyToAddress": "info@example.jp"
    }
  }
}
```

The page, `src/pages/contact/index.astro`:

```astro
---
import BaseLayout from '../../layouts/BaseLayout.astro';
import YatrisForm from '@yatris/astro/YatrisForm.astro';
---
<BaseLayout page={{ title: 'お問い合わせ', description: 'お問い合わせはこちらのフォームから。' }}>
  <h1>お問い合わせ</h1>
  <YatrisForm form="inquiry" hidden={{ source: 'contact-page' }} classes={{ submit: 'rounded bg-neutral-900 px-6 py-3 text-white' }} />
</BaseLayout>
```

And `src/pages/contact/thanks.astro`, reached only after an accepted
submission:

```astro
---
import BaseLayout from '../../layouts/BaseLayout.astro';
---
<BaseLayout page={{ title: 'お問い合わせありがとうございました', noindex: true }}>
  <h1>お問い合わせありがとうございました</h1>
  <p>内容を確認のうえ、担当者よりご連絡いたします。</p>
  <p><a href="/">トップページへ戻る</a></p>
</BaseLayout>
```

## 3. Estimate request: choices with "Other", attachments, conditional requiredness

"その他" reveals a required text field. The phone number becomes required
only when the visitor asks to be called. Drawings are attached to the
notification mail. No thank-you mail.

```json
{
  "$schema": "../../node_modules/@yatris/astro/contracts/forms/v1/declaration.schema.json",
  "contractVersion": 1,
  "key": "estimate",
  "name": "お見積もり依頼",
  "locale": "ja",
  "fields": [
    { "key": "request_heading", "type": "heading", "text": "ご依頼内容", "level": 2 },
    {
      "key": "services",
      "type": "checkboxes",
      "label": "ご依頼の種類",
      "required": true,
      "options": [
        { "value": "design", "label": "設計" },
        { "value": "construction", "label": "施工" },
        { "value": "repair", "label": "修繕" },
        { "value": "other", "label": "その他" }
      ]
    },
    {
      "key": "services_other",
      "type": "text",
      "label": "その他の内容",
      "required": true,
      "visibleWhen": { "field": "services", "operator": "contains", "value": "other" },
      "validation": { "maxLength": 200 }
    },
    {
      "key": "budget",
      "type": "select",
      "label": "ご予算",
      "required": false,
      "prompt": "選択してください",
      "options": [
        { "value": "under_1m", "label": "100万円未満" },
        { "value": "1m_5m", "label": "100万〜500万円" },
        { "value": "over_5m", "label": "500万円以上" }
      ]
    },
    { "key": "preferred_date", "type": "date", "label": "ご希望の着工時期", "required": false },
    {
      "key": "drawings",
      "type": "file",
      "label": "図面・写真",
      "required": false,
      "help": "PDF・JPEG・PNG、3ファイルまで（1ファイル10MBまで）。",
      "validation": { "maxFiles": 3, "maxFileSize": 10485760, "accept": ["pdf", "jpeg", "png"] }
    },
    { "key": "contact_divider", "type": "divider" },
    { "key": "contact_heading", "type": "heading", "text": "ご連絡先", "level": 2 },
    { "key": "name", "type": "text", "label": "お名前", "required": true, "autocomplete": "name" },
    { "key": "email", "type": "email", "label": "メールアドレス", "required": true, "autocomplete": "email" },
    {
      "key": "contact_method",
      "type": "radio",
      "label": "ご希望の連絡方法",
      "required": true,
      "options": [
        { "value": "email", "label": "メール" },
        { "value": "phone", "label": "電話" }
      ]
    },
    {
      "key": "tel",
      "type": "tel",
      "label": "電話番号",
      "required": false,
      "autocomplete": "tel",
      "requiredWhen": { "field": "contact_method", "operator": "eq", "value": "phone" }
    },
    {
      "key": "consent",
      "type": "acceptance",
      "label": "個人情報の取り扱いに同意する",
      "required": true,
      "consentText": "入力いただいた個人情報は、お見積もりへの回答のためにのみ利用します。",
      "privacyPolicyPath": "/privacy/"
    }
  ],
  "uploads": { "maxFiles": 3, "maxTotalBytes": 20971520 },
  "confirmStep": { "enabled": true },
  "submit": { "label": "入力内容を確認する" },
  "success": { "mode": "redirect", "redirectPath": "/estimate/thanks/" },
  "mail": {
    "notification": {
      "to": ["estimate@example.jp"],
      "replyToField": "email",
      "subject": "【見積もり依頼】{{field.name}} 様",
      "body": "受付番号: {{submission.reference}}\n受付日時: {{submission.date}}\n\n{{submission.answers}}",
      "attachmentFields": ["drawings"]
    },
    "thankYou": { "enabled": false }
  }
}
```
