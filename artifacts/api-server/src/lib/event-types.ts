/**
 * Canonical SSE / task-event type strings used across agent-loop.ts,
 * jobs.ts, check-profiles.ts, and the frontend DevChatPanel.
 *
 * Keeping them in one place prevents typo-drift between emitters and consumers.
 */

export const EventTypes = {
  // ── Agent loop lifecycle ────────────────────────────────────────────────
  STARTED: "started",
  NARRATION: "narration",
  THINKING: "thinking",
  GENERATING_CODE: "generating_code",
  TOOL_CALL: "tool_call",
  FILE_DIFF: "file_diff",
  COMMAND_OUTPUT: "command_output",
  FINALIZED: "finalized",
  FAILED: "failed",
  ABORTED: "aborted",

  // ── Preflight ───────────────────────────────────────────────────────────
  PREFLIGHT_START: "preflight_start",
  PREFLIGHT_STEP: "preflight_step",
  PREFLIGHT_ERROR: "preflight_error",

  // ── Preview / container ─────────────────────────────────────────────────
  UPDATING_PREVIEW: "updating_preview",
  PREVIEW_UPDATED: "preview.updated",
  CONTAINER_UNAVAILABLE: "container_unavailable",

  // ── Heartbeat / stuck-run ───────────────────────────────────────────────
  HEARTBEAT: "heartbeat",
  STUCK_RUN_DETECTED: "stuck_run_detected",

  // ── Developer-mode runtime checks ───────────────────────────────────────
  TYPECHECK_RESULT: "typecheck_result",
  BUILD_RESULT: "build_result",
  TEST_RESULT: "test_result",
  HEALTH_CHECK_RESULT: "health_check_result",
} as const;

export type EventType = (typeof EventTypes)[keyof typeof EventTypes];
