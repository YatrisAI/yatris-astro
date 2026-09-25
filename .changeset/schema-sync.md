---
'create-yatris': minor
'@yatris/astro': minor
---

`yatris schema status | sync --manifest=<file> | verify [--manifest=<file>]`: sites lock to an exact Yatris schema revision in `.yatris/schema.lock.json` and commit the Yatris-generated `src/generated/yatris-schema.ts`. `sync` writes only what an integrity-checked manifest from the Yatris MCP carries; `verify` is read-only. New sites start with an explicit empty lock, and `yatris doctor` fails a missing lock or a hand-edited generated file.
