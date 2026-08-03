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
  /** Emitted after writeFiles completes. Carries a ProjectFilesChangedPayload
   *  in the `data` field. Bus-only (not persisted to taskEventsTable). */
  PROJECT_FILES_CHANGED: "project_files_changed",

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

/**
 * Payload for the PROJECT_FILES_CHANGED event.
 * Carried in `TaskEventPayload.data` — allows the frontend to sync files into
 * the WebContainer filesystem without a full page reload.
 */
export interface ProjectFilesChangedPayload {
  projectId: number;
  /** Monotonic committed project version that this live payload represents. */
  revision: number;
  /** Paths of files that were written (created or updated). */
  changedPaths: string[];
  /** Map of path → content for all changed files. */
  files: Record<string, string>;
  /** Paths of files that were deleted. */
  removedPaths: string[];
  /** What triggered this change. */
  operationType:
    | "build"
    | "refine"
    | "apply"
    | "rollback"
    | "visual-edit"
    | "manual-save"
    | "qa-auto-fix"
    | "delete-reinsert";
  /** True when package.json, package-lock.json, yarn.lock, or pnpm-lock.yaml changed. */
  requiresInstall: boolean;
  /** True when vite.config.*, tsconfig.*, or .env* changed. */
  requiresRestart: boolean;
  /** Backend emission timestamp used by preview reconciliation diagnostics. */
  generatedAt: string;
}
