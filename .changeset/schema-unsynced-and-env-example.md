---
'@yatris/astro': patch
'create-yatris': patch
---

`yatris schema verify` no longer reports `schema-lock-missing` for a `.yatris/schema.lock.json` that exists but has no revision synced yet (YatrisCMS#307). That case is now the warning `schema-lock-unsynced`, and `verify` exits 0 for it; `yatris schema status` says "no schema revision synced yet". Both, and a truly missing lock, name the next step: read `yatris://websites/{id}/schema` from the Yatris MCP, save it outside the repository and run `yatris schema sync --manifest <file>`. `yatris doctor` still treats the empty lock of a new site as normal. New sites get a `.env.example` for `YATRIS_DELIVERY_ENDPOINT` and `YATRIS_DELIVERY_API_KEY` that says where a local read key comes from.
