---
name: configureWorkflow phantom slot count
description: configureWorkflow can report a phantom full count (e.g. 10/10) even when fewer real workflows exist; removeWorkflow doesn't clear it, but system restarts via commits do.
---

## The rule

When `configureWorkflow` returns "maximum number of workflows" but `listWorkflows()` shows fewer than 10, the count is a platform-side phantom. Do NOT keep retrying — it will always fail until the cache clears.

**Why:** `removeWorkflow()` correctly removes the workflow from the live list and from `.replit`, but does NOT decrement configureWorkflow's internal slot counter. Only a full system restart (triggered by commits/pushes and the resulting Replit checkpoint cycle) clears the phantom count.

**How to apply:**
1. Note the discrepancy: `listWorkflows().length < 10` but `configureWorkflow` reports full.
2. Proceed with the rest of the task (commits, pushes, gate runs).
3. After 2–3 commits that trigger system restarts, retry `configureWorkflow`. It will succeed.
4. `removeWorkflow` still correctly affects `.replit` and the live list — the phantom is only in the slot counter.
5. If `.replit` workflows were lost (e.g. committed without them), restore via `configureWorkflow` once the phantom clears.
