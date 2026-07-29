# Wave D.3 Task 7 — stop and edit

## Clean stop contract

No event or API schema changed. The inline run Stop action calls the workspace's existing
`handleStopStream` path:

1. Abort the conversational stream and close the task `EventSource`.
2. Select the real task from `activeTaskId`, with `pendingFeedTaskIdRef` as the
   just-created-task fallback.
3. Call the generated `useCancelTask` mutation:
   `POST /api/projects/:projectId/tasks/:taskId/cancel`.
4. The existing job cancellation path aborts the runner and persists/publishes terminal
   `eventType: "cancelled"` with `Build cancelled by user.`

The composer Stop button and the new live-run Stop action use the same callback. The
inline Stop disappears when the run is terminal; the completed/cancelled run then
follows the existing collapsed-history behavior.

## Edit and resend

- Only the most recent user-authored message exposes `Edit & resend`.
- The action is available in recent chat and Full History.
- It returns the original text to the existing controlled `prompt` /
  `QueueComposer.promptValue` state and focuses the composer.
- The original message remains in history. Nothing is deleted or mutated, and the
  normal send, credit gate, draft-preservation, mode, and attachment-clearing paths
  remain the authority when the edited text is sent.

## Evidence

- `light-live-stop.png`, `dark-live-stop.png`: the real live-run component exposes its
  restrained Stop action beside the running step count.
- `light-edit-and-resend.png`, `dark-edit-and-resend.png`: clicking the last user
  message restores its text into the composer while the run remains visible.
- `light-stopped.png`, `dark-stopped.png`: after Stop, no Stop action remains and the
  replay shows a static `Stopped` state; the edited draft remains intact.
- `light-stop-and-edit.gif`, `dark-stop-and-edit.gif`: short interaction recordings of
  live → edit → clean stop.

The evidence harness imported the production run-group, activity, narration, avatar,
and edit components with the application stylesheet. It was removed before commit.

## Verification

- Focused Vitest: 7 tests passed, including last-user selection, edit action, live Stop
  callback, and terminal Stop removal.
- NabuFlow frontend TypeScript: passed.
- ESLint on changed TypeScript/TSX files: passed.
