---
name: stopEvidence nesting inside evidence wrapper
description: In TIP5+, stopEvidence lives at evidence.stopEvidence, not top-level terminal. The disease (pre-TIP5) had no stopEvidence at all.
---

Terminal shape BEFORE fix (disease, task 260):
```json
{"outcome":"response_succeeded","evidence":{"assistantMessageId":644},...}
```
No stopEvidence anywhere — the cure was absent.

Terminal shape AFTER fix (TIP5, task 261):
```json
{"outcome":"response_succeeded","evidence":{"stopEvidence":{"providerReason":"stop"},"assistantMessageId":646},...}
```
`stopEvidence` is INSIDE `evidence`, not a sibling of `evidence`.

**Why:** messages.ts writes `evidence: { assistantMessageId, stopEvidence: converseResult.stopEvidence }` — stopEvidence is a field of the evidence object, not the terminal root.

**How to apply:** C3 branch condition "stopEvidence.providerReason" means `evidence.stopEvidence.providerReason` in the actual DB row. Always path through `evidence` when reading it from task_events.data.
