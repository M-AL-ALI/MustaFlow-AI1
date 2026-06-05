---
name: Ora asset Library and durable asset persistence
description: Where the Ora asset Library lives, vs the public lessons gallery, and the rule that all Ora output-generation paths must persist to it.
---

Two distinct "Library" pages exist — do not confuse them:

- `artifacts/mustaflow/src/pages/library.tsx` is the **public lessons / knowledge gallery** (`useListPublicKnowledge`, Build/Refine/Style/Auth categories). NOT an asset store.
- `artifacts/mustaflow/src/pages/ora-library.tsx` at route `/ora/library` is the **durable Ora asset home** — lists the signed-in user's generated files/images from the `ora_assets` table. The Ora sidebar "Library" link points here.

**Durable persistence rule:** Ora-generated outputs are saved to `ora_assets` via `persistOraAsset()` (best-effort, never throws into the request path, 12MB cap) from **three** generation paths: the `/api/public-ai/generate-file` route, the chat `file_generation` branch, and the chat `image_generation` branch. Chat persistence is fire-and-forget *after* `res.json` so it never adds latency.

**Why:** an early version persisted images but not files, silently breaking the durable-library promise for documents. A source-level regression guard in `routes/__tests__/ora-assets.test.ts` asserts every branch still calls `persistOraAsset`.

**How to apply:** when adding a NEW Ora output type or generation path, you MUST also persist it (and extend the regression guard) or it will silently never reach the Library.

**API pattern:** Ora endpoints are NOT in `openapi.yaml` / Orval — the frontend calls them with `authFetch` directly (bearer token; the dev cookie expires ~60s in the preview iframe). `<img src>` can't carry the bearer, so image thumbnails are fetched as blobs via `authFetch` and rendered as object URLs. Do not add Ora routes to OpenAPI just for this — it only creates codegen-drift.
