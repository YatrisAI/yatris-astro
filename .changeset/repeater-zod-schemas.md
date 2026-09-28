---
'create-yatris': minor
'@yatris/astro': minor
---

`yatris schema sync` now also writes `src/generated/yatris-zod.ts` (YatrisCMS#307): a zod schema per Content Type, derived from the manifest's canonical schema and pinned in `.yatris/schema.lock.json` like Yatris's own generated files, so `yatris schema verify` catches a hand edit. Pass `yatrisSchemas['<slug>']` as the `schema` of `getYatrisList`, `getYatrisSingleton` or `getYatrisItem`. The new `repeater` field type becomes `z.array(z.object({ … }))` of its sub-fields with its `min_items` / `max_items` bounds (an optional repeater may also be empty); a list of strings is a repeater with one text sub-field. Locks written by earlier versions keep verifying; the file appears on the next sync.
