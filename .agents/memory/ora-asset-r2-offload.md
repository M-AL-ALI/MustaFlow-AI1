---
name: Ora asset R2 offload
description: Why Ora library byte offload to R2 is flag-gated and how the data/storage_key invariant is enforced.
---

# Ora asset R2 offload (Phase 6)

Ora library asset bytes (`ora_assets`) can live EITHER as base64 in the `data`
column OR in Cloudflare R2 (key recorded in `storage_key`), never both. A DB
CHECK constraint `ora_assets_storage_xor` enforces
`(data IS NOT NULL) <> (storage_key IS NOT NULL)`.

**Rule:** R2 offload is gated behind BOTH `ORA_ASSETS_R2_ENABLED === "true"` AND
`r2Enabled()` — see `oraR2OffloadEnabled()` in `lib/ora-assets.ts`. Do NOT gate
on `r2Enabled()` alone.

**Why:** CF R2 credentials are already present in dev/prod for snapshot serving,
so keying off `r2Enabled()` would silently flip Ora storage behavior the moment
those creds exist — breaking the existing DB-path tests (which assert
`row.data === base64`) and changing prod storage without an explicit decision.

**How to apply:** persist must stay exception-safe — any R2 upload failure
(returned false OR thrown) falls back to writing `data` (base64). The download
route resolves R2 first, then DB `data`, so partial migrations never strand an
asset. Soft-delete leaves R2 objects intact (matches DB keeping the row).
