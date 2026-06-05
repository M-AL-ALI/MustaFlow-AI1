---
name: Ora credit/quota isolation (daily quotas, not Builder credits)
description: How the standalone Ora assistant is metered (daily message/image quotas per tier) vs the AI Builder credit wallet, plus the shared-image-edit and overloaded-session caveats.
---

# Ora is metered by daily quotas, NOT the Builder credit wallet

The standalone Ora assistant is metered by **message-based daily quotas per
subscription tier** (`ora_daily_usage` table; helpers in
`artifacts/api-server/src/lib/public-ai/ora-usage.ts`). The AI Builder keeps its
separate credit wallet. These two must never be coupled again.

- Buckets: `image_generation`/`image_editing` -> IMAGE bucket; everything else
  (`answer`/deep/`search`/`file_generation`/`*_analysis`) -> MESSAGE bucket.
  Uploads are uncounted.
- Quotas reset midnight UTC. Authed over-cap -> 429 with `upgradeCta:true`.
- Anonymous visitors are unchanged: they keep the per-session caps (msg/file/image).

**Why:** the prior design deducted Builder credits for Ora usage, which conflated
two unrelated products. Any future Ora endpoint must call `checkOraQuota` +
`incrementOraMessage`/`incrementOraImage`, never `deductCreditsAtomic`.

## Caveat 1 — `/images/:id/edit` is SHARED with Image Studio and still charges credits

Ora's inline image **edit** (frontend `editInlineImage` -> `POST /api/images/:id/edit`
in `routes/image-gen.ts`) reuses the Image Studio pipeline, which deducts Builder
credits (`IMAGE_CREDIT_COSTS`). This is a **deliberate, test-asserted** behavior
(`routes/__tests__/ora-image-edit.test.ts` asserts a credit debit). So Ora inline
edits are NOT yet on the daily IMAGE quota — a residual credit coupling.

**How to apply:** if asked to fully decouple Ora image editing, distinguish
Ora-origin edits from Image Studio edits (e.g. source row `creditCost===0` /
`sourceType`) and route Ora ones through the daily IMAGE quota — and update/replace
`ora-image-edit.test.ts`. Do not silently change the shared endpoint; it breaks
Image Studio's intentional credit pricing.

## Caveat 2 — `session.imageCount`/`imageLimit` is overloaded by auth state

`GET|POST /public-ai/session` returns `imageCount`/`imageLimit` that mean different
things: for anonymous users it's the per-session **upload** count; for authed users
it's the **daily generated-image** count (from `getTodayOraUsage`).

**Why:** uploads are unlimited for signed-in users, so the frontend upload
affordance (`atImageLimit`/`atFileLimit`/`atAllLimits` in `ora-panel`/`ora-bubble`)
must be gated by `!isSignedIn`. Otherwise an authed user who exhausts their daily
image-generation quota would have the upload button disabled — wrongly. The backend
`upload.ts` likewise skips the session cap when `authed`.
