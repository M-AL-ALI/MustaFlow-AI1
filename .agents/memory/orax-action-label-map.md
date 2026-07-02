---
name: formatOraxExecutionStepLabel exhaustive map
description: Adding a new OraxTaskRunnerResult action requires a matching entry in formatOraxExecutionStepLabel
---

**Rule:** `formatOraxExecutionStepLabel(action)` in `orax.ts` uses an exhaustive `Record<OraxTaskRunnerResult["action"], string>`. Every value in the `action` union must have a key in this map.

**Why:** TypeScript checks `Record<K, V>` exhaustiveness at compile time. Adding a new string literal to the `action` union without a matching entry causes TS2741 ("Property X is missing in type ... but required in type Record<...>").

**How to apply:** Whenever extending the `action` union on `OraxTaskRunnerResult` (or `OraxTaskActionSuggestion["type"]`), immediately add a corresponding label entry to `formatOraxExecutionStepLabel`'s `labels` object, or the typecheck will fail with TS2741 at that map.
