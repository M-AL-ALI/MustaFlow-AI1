---
name: Ora Memory Center read path
description: Why the Ora Memory Center must list saved memories via the Ora endpoint, not the generic knowledge endpoint.
---

The Ora Memory Center dialog (the in-chat "Ora memory" manager) must list/edit/delete saved
memories through the dedicated Ora endpoints (`GET/PATCH/DELETE /api/ora/memories`), NOT the
generic knowledge hooks (`useListKnowledge` → `GET /api/knowledge`).

**Why:** `GET /api/knowledge` deliberately EXCLUDES `origin="ora"` rows (it filters
`origin IS NULL OR origin != "ora"`) to keep the AI Builder Knowledge Vault isolated from Ora
memories. Saves go to `POST /api/ora/memories` (origin="ora"). So if the manager reads from
`/api/knowledge`, every saved memory is silently invisible — the dialog shows "No saved memories
yet" even right after a successful save. This is a read/write endpoint mismatch, not a caching bug.

**How to apply:** Any surface that displays or mutates Ora user memories must go through the
origin="ora" Ora endpoints and invalidate the shared `ORA_MEMORIES_QUERY_KEY` (in
`lib/ora-memories.ts`). Never reuse the Builder knowledge list hooks for Ora memory UI.
