---
name: Ora TTFT context builder pattern
description: Safe pattern for parallelizing pre-model context builders in the Ora chat route; which builders can fire early vs which must run inline in Promise.all
---

## Rule

In the Ora chat routes (non-streaming + streaming), context builders have two tiers:

1. **Fire-early (right after auth):** `earlyMemoryP`, `earlyProfileP` — both are pure DB reads with no dynamic imports that could yield before reading mocked module state.
2. **Inline in Promise.all (after routing):** `buildCrossConversationContext` — must be called fresh inside the `Promise.all`, NOT as an early background promise.

```ts
// WRONG: earlyCrossConvP fired immediately after auth
const earlyCrossConvP = buildCrossConversationContext(...);
void earlyCrossConvP.catch(() => undefined);
// ... later in Promise.all: withTimeout(earlyCrossConvP, ...)

// CORRECT: call fresh inline, still runs concurrently with memory/profile
Promise.all([
  withTimeout(earlyMemoryP, CTX_BUDGET_MS, fallback),
  authed && referenceChatHistory && !temporary
    ? withTimeout(buildCrossConversationContext(...), CTX_BUDGET_MS, "")
    : Promise.resolve(""),
  withTimeout(earlyProfileP, CTX_BUDGET_MS, ""),
])
```

**Why:** `buildCrossConversationContext` uses `await import("@workspace/db")` which yields the microtask queue. In the Vitest mock environment this causes the continuation to run before the test's mock state is fully established, reading empty rows. The inline call (after routing) runs in a well-stabilized mock state and still achieves concurrency with memory/profile — which is the main TTFT gain.

**How to apply:** Any new context builder that contains a dynamic import should be placed inline in Promise.all rather than fired as an early background promise. Pure DB reads with static imports are safe to fire early.
