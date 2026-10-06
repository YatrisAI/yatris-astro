# Mail and secret provisioning

Yatris sends every contact-form mail itself. The site never sends mail and
never holds mail credentials: not in the declaration, the brief, the
repository, browser code, Cloudflare settings or the conversation.

## Mail sources

| Source | When | Sender |
| --- | --- | --- |
| Yatris platform mail | Default: no customer SMTP configured | A Yatris address with the business name as display name |
| Customer SMTP | The client wants mail from their own address or domain, and a tested SMTP profile is active for the Website | The customer's SMTP-authorized address |

Both work without any change to the declaration. One mail profile belongs to
the Website and all its forms share it. If an active customer SMTP fails,
Yatris retries it; it never silently switches to platform mail. Every
inquiry also lands in the dashboard inbox regardless of mail.

## The two provisioning routes for customer SMTP

1. **Connections page (Website Owner).** The Website Owner, or Yatris staff,
   enters the SMTP settings on the Website's Connections page in the Yatris
   dashboard, tests them and activates them. Approvers and Editors cannot.
2. **Env-file helper (Yatris staff).** Staff put the settings in the site's
   ignored `.env` and run `npx yatris mail sync --env-file .env`. The helper
   reads the file itself, signs in to Yatris and imports the settings
   encrypted. Variable names:

   ```dotenv
   YATRIS_SMTP_HOST=
   YATRIS_SMTP_PORT=
   YATRIS_SMTP_SECURITY=          # starttls or tls
   YATRIS_SMTP_USERNAME=
   YATRIS_SMTP_PASSWORD=
   YATRIS_MAIL_FROM_ADDRESS=
   YATRIS_MAIL_FROM_NAME=
   YATRIS_MAIL_REPLY_TO_ADDRESS=
   ```

Both arrive with Yatris mail provisioning, after this release. If the
Connections page has no SMTP section yet, or `yatris mail sync` is an
unknown command, record the chosen route as the intent (`mail.source`,
`mail.provisioning` in the brief), add `mail_setup` to `pending` and report
it. Never substitute a different route.

Ordinary form work never changes mail settings: a missing `.env` or a form
sync never removes a configured profile.

## Rules for agents

- **Never ask for SMTP credentials in chat**, and never ask the user to
  paste them anywhere you can read. Explain the two routes instead.
- If someone pastes a password anyway: do not repeat it, do not write it to
  any file, tell them it is now exposed in the conversation and should be
  changed, and point them to the routes above.
- Never open, print, `cat`, grep or summarize `.env` files for SMTP values,
  and never put a secret on a command line. Writing the empty variable names
  above into `.env.example` is fine only if the user asks.
- The user's general "build the site" or "add a contact form" request does
  not authorize reading SMTP values, sending test mail or activating a
  profile.
- Never claim that SMTP is configured, tested or verified. Only Yatris can
  say so, and today you cannot read it.
- Never read Cloudflare secrets or deployment settings to recover
  credentials, and never install SMTP settings in Cloudflare: Yatris sends
  the mail.
- Recipient addresses are not secrets but they are business facts: use only
  the ones the user gives. They seed a new form only; afterwards the Website
  Owner manages them in the dashboard.

## How to explain it to a client (Japanese)

> メールはYatrisが送信します。特に設定しなければYatrisのメールサーバーから、
> 送信者名に御社名を表示して送ります。御社のメールアドレス（独自ドメイン）から
> 送りたい場合は、Yatris管理画面の接続設定（Connections）ページでWebサイトの
> オーナー様がSMTP設定を登録するか、Yatrisスタッフが安全な方法で取り込みます。
> パスワードなどはこのチャットには絶対に書かないでください。

Use the dashboard's actual page name once you have seen it; do not promise a
screen you have not confirmed exists.
