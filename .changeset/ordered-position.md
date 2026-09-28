---
'@yatris/astro': minor
---

Ordered Content Types (YatrisCMS#312). Delivery items gain `position`, the item's 1-based place in an Ordered Content Type, or `null` for other structures and from servers that do not send it. `getYatrisList` now returns an Ordered type in the editor's order (lowest position first, ties by ID) when no `sort` is given and every item has a position; anything else keeps the most-recently-updated-first default. `sort: 'position'` asks for that order explicitly and fails the build if an item has no position.
