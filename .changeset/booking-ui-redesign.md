---
'@yatris/astro': minor
---

Booking page redesign (`@yatris/astro/booking/client`, `components/YatrisBooking.css`): three steps (日時を選択 → 情報を入力 → 完了) in a card with a duration chip; date and time chosen together on a five-day week grid (a day strip and slot list below 640px) for appointments and services, and a seven-day 空席表 with ○ △ × – for parties; the mode's choices as cards above the picker (hosts and practitioners with おまかせ first, a filter and 「すべて表示」 past eight; 人数 pills); the review folded into the details step with a summary box and the terms above 「予約を確定する」 / 「予約をリクエストする」; a success panel. Every colour comes from the theme tokens; an embedded page draws no background or card. Japanese line breaking is strict and dates and times never break inside.

`BookingStep` is now `select | details | outcome` (`stepsOf` returns these three for every flow); `selectionProblem` returns the new `SelectionProblem` type.

Contract (additive): theme keys `font` and `headingFont` (`sans` | `serif`, always Noto; `fontFamily` and `headingFontFamily` stay valid but the booking UI ignores them), and optional availability fields `days[].closed` and `days[].slots[].few`. The synthetic preview simulates both.

Forms field renderer: `FieldEnv.selectAsChoices` draws a short single-choice select as radio cards (the booking UI uses six); email and tel inputs default to `autocomplete="email"` / `"tel"` when the declaration names none.
