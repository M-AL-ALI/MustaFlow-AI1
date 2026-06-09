---
name: ORAX wiring test is a source-string snapshot
description: Why orax-wiring.test.ts breaks on call-site refactors and only Linux/Replit catches it
---

`artifacts/mustaflow/src/lib/__tests__/orax-wiring.test.ts` asserts ORAX isolation + key wiring by `expect(oraxPage).toContain("<exact source substring>")` — it reads `orax.tsx` as raw text and matches literal code fragments (route URLs, call sites like `appendTaskMessage(targetTaskId, content)`, copy strings, state-reset blocks via `collapse(...)`).

**Why:** It is effectively a string snapshot of the source. Any refactor of a matched call site silently breaks an assertion even when the source is correct. Example: hardening the task-switch race renamed the send path from `appendTaskMessage(selectedTask.id, content)` to capture `const targetTaskId = selectedTask.id;` then `appendTaskMessage(targetTaskId, content)` — the source was right but the test still asserted the old literal and failed.

**How to apply:** In this project's verify loop the feature author works in a separate Windows checkout where vitest cannot run (Linux-only esbuild binary), so these stale-literal breaks ONLY surface when Replit/Linux runs the suite. After ANY edit to `orax.tsx` that touches a matched substring, update the corresponding literal in this test. The fix is mechanical (test-only) — the source logic is usually already correct. Treat a single failing `toContain` here as "assertion drifted," not "feature broke," until proven otherwise.
