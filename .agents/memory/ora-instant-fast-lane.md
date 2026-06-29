---
name: Ora Instant fast-lane
description: The real quotaMs bottleneck is the 500ms classifier deadline, not oraMessageLimit; fast-lane design and gotchas
---

## Rule

`quotaMs` in production logs (~537ms) is NOT `oraMessageLimit()` (that's a near-instant constant lookup). It's the `await withTimeout(classifierPromise, 500ms, FALLBACK)` call — the classifier always takes 2–4s and always hits the deadline.

The Instant fast-lane skips this wait entirely for short, simple prompts:

```ts
const isInstantFastLane =
  mode === "instant" &&
  message.length <= 120 &&
  documentRefs.length === 0 &&
  !looksLikeImageGenerationIntent(message) &&
  !looksLikeWebSearchIntent(message) &&
  !looksLikeFileGenIntent(message);

const classifierResult = isInstantFastLane
  ? CLASSIFIER_FALLBACK   // skip ~500ms
  : await withTimeout(classifierPromise, classifierTimeoutMs, CLASSIFIER_FALLBACK);

const usesMini =
  isInstantFastLane ||    // force fast model
  (!deepAllowed && classifierResult.intent === "simple_faq" && ...);
```

## Critical gotcha: do NOT skip cross-conv context on fast-lane

Cross-conv runs inline in Promise.all and costs ~18ms in practice (already parallelised). Skipping it breaks the "uses relevant past-conversation summaries" test AND loses real user recall. Keep the `authed && referenceChatHistory && !temporary` condition unchanged — no `!isInstantFastLane` guard there.

**Why:** The TTFT wins come from (1) saving the 500ms classifier wait and (2) forcing `routeTier="fast"` → ORA_FAST_MODEL (gpt-5-mini) with ~200–400ms model first-token latency vs ~1300ms for claude-sonnet-4-6. Cross-conv is not a bottleneck.

## CTX_BUDGET_MS

| Mode | Budget |
|---|---|
| Deep | 2000ms |
| Instant fast-lane | 150ms |
| Instant standard | 300ms (was 600ms) |

## What is NOT fast-laned

- Deep mode prompts
- Prompts > 120 chars
- Any request with documentRefs
- Messages matching image generation, web search, or file generation patterns

## Where it lives

Both `/api/public-ai/chat` (non-streaming) and `/api/public-ai/chat/stream` (streaming) — same logic, same shared backend, covers website and mobile with no client changes needed.
