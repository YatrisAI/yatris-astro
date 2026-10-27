---
'@yatris/astro': minor
'create-yatris': minor
---

Item slugs (YatrisCMS#519). Every Delivery item now has `slug` (its URL slug in its type; `null` for a type that still keeps a slug field of its own, and from older servers) and `number`. `@yatris/astro/delivery` adds `getYatrisSlugPaths(type, options)` for a detail page's `getStaticPaths` (one path per published item, failing the build for an item without a slug), `getYatrisItemBySlug(type, slug)`, `getYatrisRedirects(type?)`, and `bySlug` / `redirects` on `createDeliveryClient`. Name each slug-routed detail page in `yatris({ slugRoutes: { works: '/works/[slug]/' } })`: a production build then writes a 301 from every old slug of an item to its current page into `_redirects`, after the site's own rules (which win for the same path), and fails past Cloudflare Pages' 2,000 static rules. New sites from `create-yatris` start with `slugRoutes: {}` and the routing rules in `AGENTS.md`.
