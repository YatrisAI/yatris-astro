---
'@yatris/astro': minor
---

Preview builds (YatrisCMS#310). A build of the `yatris-preview` branch that has `YATRIS_PREVIEW_URL` and `YATRIS_PREVIEW_KEY` (installed by Yatris on the Pages project's Preview environment only) reads the preview's draft items from Yatris: each one replaces the published item with the same canonical ID in `getYatrisList`, `getYatrisSingleton` and `getYatrisItem`, or is added when there is none. Every page of such a build gets `<meta name="robots" content="noindex, nofollow">` from `YatrisHead`, no Google Tag Manager or Search Console tag, and `dist/_headers` gains an `X-Robots-Tag: noindex, nofollow` rule for `/*` alongside the site's own rules. Any other branch, including the production branch, ignores the preview variables even if they leak into it, and a preview build whose drafts cannot be read fails instead of showing published content.
