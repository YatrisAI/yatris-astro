# Recipients, mail, Calendar and conferencing

Yatris does all of this itself. The site and the repository never hold an
address list, a mail credential, an OAuth grant or a provider key, and
neither does the conversation.

## Business recipients

- The Website Owner sets the booking notification recipients **for each
  setup in Yatris**. Each address is confirmed by a link sent to it, and
  changes are audited and apply to future events.
- Recipients are never part of the declaration, the brief or a page, and
  you never write one down, even an address the user gives you. Tell them:
  「通知先のメールアドレスは、Yatrisの管理画面でWebサイトのオーナー様が設定し、
  届いた確認メールのリンクで有効になります。」 Keep `recipient_setup` in
  `pending`.
- Hosts and practitioners linked to a Yatris user get in-app alerts for
  their own bookings; approval requests go to people with approval
  authority. Linking a host never subscribes a personal email.

## Mail

- Booking mail uses the **Website's mail profile**, the same one as contact
  forms: the customer's own SMTP when the Website Owner has set it up and
  activated it on the Connections page, otherwise Yatris platform mail with
  the business name as sender name.
- Record the intent as `mail.source`. If the client wants their own sender
  and it is not set up yet, add `mail_setup` to `pending` and explain the
  routes in the `yatris-contact-form` skill's `references/secrets.md`. You
  run neither route.
- **Never ask for SMTP credentials in chat**, never read `.env` files for
  them and never claim mail is set up or tested.

## Google Calendar, Google Meet and Zoom

These are **later Yatris phases**. Every setup works entirely within Yatris
without them, and they stay off unless staff enable them.

- Record wishes only: `calendar.wish` (bookings in Google Calendar) and
  `conferencing.wish` (automatic Meet or Zoom links). Add
  `provider_integration` to `pending` when a wish is recorded.
- When a phase is available, the **Website Owner authorizes their own
  Google or Zoom account on the Connections page**, and Yatris staff map
  hosts to calendars and enable the integration per setup. Connecting an
  account never enables synchronization by itself. Automatic Meet needs an
  explicit calendar write binding; choosing Meet never enables it silently.
- Clients never create developer apps, API keys or OAuth clients, and
  nobody needs another person's password: other hosts authorize their own
  accounts through a consent invitation.
- **Never ask for a Google or Zoom password, token, client secret or API
  key**, never describe a connection as working, and never simulate a
  meeting link or a synced event. In the core, an online appointment uses a
  fixed meeting URL or written instructions (`declaration.md`).
- Explain the consequence of Yatris-only operation: Yatris cannot see
  appointments nobody records. Someone must enter phone, LINE and walk-in
  bookings as staff bookings (`calendar.maintenance`), or automatic
  confirmation can double-book.

## If someone pastes a secret

Do not repeat it, do not write it to any file and do not use it. Tell them it
is now exposed in the conversation and should be changed, and point them to
the Connections page or Yatris staff.

## How to explain it to a client (Japanese)

> 予約の受付、空き状況の確認、確認メールの送信はYatrisが行います。Googleカレンダー
> やZoomとの連携は今後の機能として順次対応予定で、現時点ではYatrisだけで予約を
> 管理します。連携をご希望の場合も、パスワードやAPIキーをこのチャットに書く
> 必要はありません。ご利用開始時に、Yatris管理画面の接続設定ページでオーナー様が
> ご自身のアカウントを認証します。

Use the dashboard's actual page names once you have seen them; do not promise
a screen you have not confirmed exists.
