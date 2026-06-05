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
two unrelated products. Any future Ora endpoint must meter through the daily-quota
helpers in `ora-usage.ts`, never `deductCreditsAtomic`.

## Quota enforcement must be atomic reserve-then-refund, reserved AFTER validation

For the authed daily quota, use the **atomic** reserve helper (increment-if-under-
limit in one SQL statement) and **refund on every path that does not complete the
metered action** — model 502s, "not configured" branches, `catch` blocks, and even
a bare `await import("../../lib/<module>")` that could throw (wrap those in
try/catch + refund). A check-then-increment pattern races: concurrent requests
overshoot the tier limit.

Two ordering rules that are easy to get wrong:

1. **Reserve AFTER cheap deterministic validation** (`scanUserInput`, `getFile`/
   `getImage` existence, dataset-vs-doc checks). Reserving before a 400/404 branch
   leaks a daily slot on every rejected/stale request.
2. **The anonymous per-session cap is a side-effect-free read — keep it EARLY.**
   Only the authed reservation (consume) is deferred. Collapsing both into one
   `if (authed) {...} else if (session.count >= LIMIT)` block placed after
   validation regresses anon behavior: an at-limit anon user with a bad
   `fileRef` then gets 404 instead of the expected 429 (a phase3 route test pins
   this). Split them: anon-limit 429 early, authed consume late.

**How to apply:** when adding/auditing any metered Ora route, confirm there is no
`return` between the reservation and the model call that lacks a refund, and that
the anon cap is signaled before file/image validation.

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
