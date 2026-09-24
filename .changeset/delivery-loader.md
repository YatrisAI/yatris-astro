---
'create-yatris': minor
'@yatris/astro': minor
---

Build-time Delivery API loader. `@yatris/astro/delivery` adds `getYatrisList`, `getYatrisSingleton`, `getYatrisItem` and `createDeliveryClient` for today's Delivery API: every page is fetched, only published items are read, an optional `schema` (for example from `astro/zod`) types and validates each item, empty lists fail unless `allowEmpty` is set, malformed or changing responses fail the build, transient failures retry, and the key is never printed. The integration loads `YATRIS_DELIVERY_*` from the site's ignored `.env` files. `yatris doctor` now fails direct Delivery API calls that bypass the loader.
