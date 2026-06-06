---
name: Ora credit/quota isolation (personal rolling windows, not Builder credits)
description: How the standalone Ora assistant is metered (per-user rolling time-window message/image quotas per tier) vs the AI Builder credit wallet, plus the shared-image-edit and overloaded-session caveats.
---

# Ora is metered by personal rolling windows, NOT the Builder credit wallet

The standalone Ora assistant is metered by **per-user rolling time-windows per
subscription tier** (`ora_usage_windows` table, one row/user; helpers in
`artifacts/api-server/src/lib/public-ai/ora-usage.ts`). The AI Builder keeps its
separate credit wallet. These two must never be coupled again.

- Buckets: `image_generation`/`image_editing` -> IMAGE bucket; everything else
  (`answer`/deep/`search`/`file_generation`/`*_analysis`) -> MESSAGE bucket.
  Uploads are uncounted.
- Allowances live in `TIER_ORA_MESSAGE_LIMIT`/`TIER_ORA_IMAGE_LIMIT`/
  `TIER_ORA_WINDOW_HOURS` (subscriptions.ts): Free=30msg/4img/5h,
  Core=100/15/3h, Wave=280/30/3h.
- **Window opens on the user's FIRST metered message after a reset; the full
  allowance refills exactly N hours after that personal `windowStart`.** Messages
  and images share ONE window timer per user. Every usage helper returns
  `resetsAt` (windowStart + N hours, or null when no window open / fail-open).
- Authed over-cap -> 429 with `upgradeCta:true`. Anonymous visitors are
  unchanged: they keep the per-session caps (msg/file/image).
- The old per-UTC-day `ora_daily_usage` table is left in place as harmless
  history; nothing reads it. Don't re-add midnight-UTC reset logic.

**Why:** the prior design deducted Builder credits for Ora usage, which conflated
two unrelated products. Any future Ora endpoint must meter through the
rolling-window helpers in `ora-usage.ts`, never `deductCreditsAtomic`.

## Quota enforcement must be atomic reserve-then-refund, reserved AFTER validation

For the authed window quota, use the **atomic** reserve helper (`consumeOraQuota`:
INSERT...ON CONFLICT(user_id) DO UPDATE that resets the window when expired, else
increments only when the bucket counter is under the tier limit, in one SQL
statement) and **refund on every path that does not complete the metered action**
— model 502s, "not configured" branches, `catch` blocks, and even a bare
`await import("../../lib/<module>")` that could throw (wrap those in try/catch +
refund). A check-then-increment pattern races: concurrent requests overshoot the
tier limit.

Two ordering rules that are easy to get wrong:

1. **Reserve AFTER cheap deterministic validation** (`scanUserInput`, `getFile`/
   `getImage` existence, dataset-vs-doc checks). Reserving before a 400/404 branch
   leaks a daily slot on every rejected/stale request.
2. **The anonymous per-session cap is a side-effect-free read — keep it EARLY.**
   Only the authed reservation (consume) is deferred. Collapsing both into one
   `if (authed) {...} else if (session.count >= LIMIT)` block placed after
   validation regresses anon behavior: an at-limit anon user with a bad
   `fileRef` then gets 404 instead of the expected 429. Split them: anon-limit
   429 early, authed consume late.

**How to apply:** when adding/auditing any metered Ora route, confirm there is no
`return` between the reservation and the model call that lacks a refund, and that
the anon cap is signaled before file/image validation.

## Caveat 1 — `/images/:id/edit` is SHARED but branches by origin

Ora's inline image **edit** shares the Image Studio edit endpoint, but billing is
decoupled by `origin`: `origin:"ora"` requests meter through the window IMAGE quota
and NEVER deduct Builder credits; Image Studio edits (`origin:"image_studio"`)
still charge credits. The `origin` discriminator is the single source of truth.

**How to apply:** keep the `origin` discriminator as the single source of truth for
billing mode on this shared endpoint. Do not collapse the two paths — Image Studio's
credit pricing is intentional. Any new shared image endpoint must branch the same way.

## Caveat 2 — `session.imageCount`/`imageLimit` is overloaded by auth state

`GET|POST /public-ai/session` returns `imageCount`/`imageLimit` that mean different
things: for anonymous users it's the per-session **upload** count; for authed users
it's the **window generated-image** count (from `getOraUsage`).

**Why:** uploads are unlimited for signed-in users, so the frontend upload
affordance (`atImageLimit`/`atFileLimit`/`atAllLimits` in `ora-panel`/`ora-bubble`)
must be gated by `!isSignedIn`. Otherwise an authed user who exhausts their window
image-generation quota would have the upload button disabled — wrongly. The backend
`upload.ts` likewise skips the session cap when `authed`.
