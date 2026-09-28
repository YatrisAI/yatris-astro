---
'create-yatris': minor
'@yatris/astro': minor
---

Generated zod schemas keep image `variants` (YatrisCMS#329). `src/generated/yatris-zod.ts` now declares the resized copies Delivery serves on a library image (`variants: { width, height, url, webp_url }[]`, optional), which the previous schema let zod strip, so a page can build `srcset` from them without re-declaring the image fields. `.yatris/schema.lock.json` records the zod generator version it was synced with (`zodGenerator`), and `yatris schema verify --manifest` checks the file against that version: a lock synced by 0.3.0 has no version, counts as version 1 and keeps verifying, as do the build-time schema check and `yatris doctor`. Such a site gets the warning `schema-zod-outdated` until it runs `yatris schema sync --manifest <file>` again, which regenerates the file with `variants` and records version 2.
