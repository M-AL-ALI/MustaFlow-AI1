---
name: Ora deep-mode classifier skip is byte-identical
description: Why skipping the intent classifier for mode==="deep" changes routing zero, and where that invariant lives.
---

Skipping the Ora intent classifier call for explicit `mode==="deep"` (and instant fast-lane) is byte-identical routing — no reasoning/quality loss.

**Why:** `pickProviderOrder` short-circuits on `tier === "deep"` BEFORE any topic/intent/multilingual branch, so the deep candidate chain is provably independent of the classifier result. `routeOraMessage` forces `deep_thinking` for `mode==="deep"`, and `usesMini` needs `!deepAllowed` so it's always false in deep. The only classifier-derived values on the deep path are `classifierResult.topic/intent` feeding `buildOraExpertiseProfile` + suggestions — and those were ALREADY the CLASSIFIER_FALLBACK defaults (premium/high/general) because the classifier reliably returns empty for deep (the small reasoning model consumes its ~150-token budget → empty content → withTimeout/default = CLASSIFIER_FALLBACK). So feeding CLASSIFIER_FALLBACK explicitly = what deep already got, minus the ~1.7s blocking await.

**How to apply:** Gate the skip as `skipClassifier = isInstantFastLane || mode === "deep"`. Never fold `mode==="deep"` into `isInstantFastLane` itself — fast-lane separately drives maxTokens cap, routeTier=fast, history slicing, context budget, and serverDiag.fastLane; deep must keep all of those at their non-fast-lane values. Free-tier deep stays gated: `checkToolAccess` runs AFTER routing and early-returns the deep_paid_only upsell (mode downgraded to instant) before any model call, so classifierResult is unused on that path. Measured deep TTFT after skip: 738–1539ms (was blocked ~1.7s longer by the classifier). If you ever make the classifier reliably non-empty for deep, re-verify this invariant before assuming the skip is still lossless.
