# E2E test plan — agent Stop button (Task #747)

This file documents the manual / runTest plan for verifying that the Stop
button in the AI Builder chat cancels an active build (Task #743). It was
authored alongside the unit tests in
`agent-loop.tool-call-event.test.ts` for Task #747.

**Why this lives as a doc, not an automated runTest call:** the testing
subagent's wall-clock budget (~10 min) is not long enough to spin up a real
agentic build, wait for the streaming UI to appear, click Stop, and
verify the server-side cancellation — the AI calls alone consume most of
the budget. Run this plan via `runTest()` interactively when the
environment has fast OpenAI keys, or convert it to a Playwright spec
against a stubbed AI provider.

## Plan

```text
1. [New Context] Create a new browser context.
2. [Clerk Auth] Sign in as a fresh test user.
3. [API] Find or create a project (POST /api/projects). Call the id PROJECT_ID.
4. [API] POST /api/projects/PROJECT_ID/tasks with a "build" body containing a
   verbose prompt so the build runs long enough to cancel. Read TASK_ID.
5. [Browser] Navigate to /projects/PROJECT_ID. Within 5s the chat composer
   must render with a Stop button (lucide Square) instead of the send arrow.
6. [Browser] Click Stop.
7. [API] Within 5s, observe POST /api/projects/PROJECT_ID/tasks/TASK_ID/cancel
   returning HTTP 200.
8. [API] Within 8s, GET /api/projects/PROJECT_ID/tasks and assert the row for
   TASK_ID has status === "canceled".
9. [Verify] Stop button is gone from the composer; no error toast.
```

## Code paths exercised

- `handleStopStream` — `artifacts/mustaflow/src/pages/projects/[id].tsx` (~L1721)
- `useCancelTask` (generated) → `POST /api/projects/:id/tasks/:taskId/cancel`
- Cancel handler — `artifacts/api-server/src/routes/tasks.ts` (~L142)
  - calls `cancelActiveJob(taskId)` then updates `agent_tasks.status='canceled'`
- Agent loop abort — `artifacts/api-server/src/lib/agent-loop.ts` (~L1875)
  - `if (input.signal.aborted) { terminationReason = "aborted"; break; }`
- SSE "cancelled" emission — `artifacts/api-server/src/lib/jobs.ts` (~L3706)
  - `await emitEvent(taskId, "cancelled", "Build cancelled by user.");`
