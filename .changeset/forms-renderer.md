---
'@yatris/astro': minor
---

Add the contact-form renderer `<YatrisForm form="…">` (`@yatris/astro/YatrisForm.astro`, browser renderer `@yatris/astro/forms/client`). It loads the published definition from Yatris at runtime, renders every contract v1 field and display node as accessible HTML with a stable `yf-*` class contract and zero-specificity default styles, runs conditions and validation in the browser, supports the 入力→確認→完了 step, and submits with the documented multipart wire format (idempotency, Turnstile, honeypot, every API error code). A local preview (`astro dev` with `YATRIS_FORMS_PREVIEW=1`) renders `src/forms/<key>.json` with synthetic responses and sends nothing; `astro build` refuses it. Add `yatris forms validate`; `yatris forms plan|apply|pull` report that synchronization is not available yet and exit 69. File parts are now named `files[<fieldKey>][]` (YatrisCMS#380).
