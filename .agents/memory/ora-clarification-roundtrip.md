---
name: Ora clarifying-questions round-trip
description: Design contract for Ora's one-question clarification flow on ambiguous uploaded-file edits (stateless server, client echo, one-shot semantics).
---

# Ora clarifying-questions round-trip

Rule: the server is stateless per turn — a clarifying reply carries
`needsClarification`/`clarificationKind`/`pendingTaskContext`, and the CLIENT
echoes it back as `pendingClarification` on the very next send. The planner
(`clarification-planner.ts`) runs AFTER `resolveFinalOraRoute` and BEFORE
quota (clarifications are never charged), and never fires when the turn
already carries a pendingClarification echo (one question max per task).

**Why:** keeping pending-task state on the client avoids new DB state and
races across web/mobile; running after route resolution means a clarification
can never fight an image/search/ZIP/forced-search escape; pre-quota placement
keeps questions free.

**How to apply:**
- One-shot on BOTH surfaces: any completed reply without `needsClarification`
  clears the pending context; streaming success clears it (the stream route
  bounces would-be clarifications pre-stream with
  `{streamingFallback:true, tool:"file_generation"}` so a streamed reply is
  never a question — streaming cadence untouched). Cutoff/error branches
  leave the ref alone; temporary mode never persists it.
- Persistence is cache-only and keyed like document refs (web sessionStorage,
  mobile AsyncStorage sync-mirror): standalone→conversation move on first
  save, restore on conversation open / app launch.
- Stale-pending guard: if the next message is a complete edit instruction on
  its own (`isUploadedFileModificationRequest` + not ambiguous), ignore the
  echoed context — treat it as a new task, don't merge.
- New detector kinds must stay ANCHORED patterns so any extra concrete
  instruction keeps the request clear, and must be added to BOTH
  `planOraClarification` and `looksAmbiguous` in the same order.
