---
name: Ora asset Library and durable asset persistence
description: Where the Ora asset Library lives vs the public lessons gallery, and the rule that all Ora output-generation paths must persist to it.
---

Two distinct "Library" pages exist — do not confuse them:

- `pages/library.tsx` is the **public lessons / knowledge gallery** (public-knowledge listing). NOT an asset store.
- `pages/ora-library.tsx` at route `/ora/library` is the **durable Ora asset home** — lists the signed-in user's generated files/images from the `ora_assets` table. The Ora sidebar "Library" link points here.

**Durable persistence rule:** Ora-generated outputs are saved to `ora_assets` via `persistOraAsset()` (best-effort: never throws into the request path, has a size cap) from every output-generation path — the standalone generate-file route AND each generation branch inside the chat handler (files and images). Chat persistence is fire-and-forget _after_ the response is sent so it never adds latency.

**Why:** an early version persisted images but not files, silently breaking the durable-library promise for documents. The failure mode is invisible — generation succeeds, the user sees the file, but it never reaches the Library.

**How to apply:** when adding a NEW Ora output type or generation path, you MUST also persist it (and extend the regression guard in the ora-assets test) or it will silently never reach the Library.

**API pattern:** Ora endpoints are deliberately NOT in OpenAPI/Orval — the frontend calls them with `authFetch` directly (bearer token; the dev cookie expires ~60s in the preview iframe). `<img src>` can't carry the bearer, so image thumbnails must be fetched as blobs via `authFetch` and rendered as object URLs. Do not add Ora routes to OpenAPI just for typing — it only creates codegen-drift.
