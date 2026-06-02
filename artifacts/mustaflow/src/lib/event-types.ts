/**
 * Shared event type constants and payload interfaces.
 * This file mirrors the subset of artifacts/api-server/src/lib/event-types.ts
 * that the frontend needs. Keep in sync when adding new event types.
 */

export const EventTypes = {
  PROJECT_FILES_CHANGED: "project_files_changed",
} as const;

/**
 * Payload for the PROJECT_FILES_CHANGED event.
 * Carried in the SSE frame's `data` field — allows the frontend to sync files
 * into the WebContainer filesystem without a full page reload.
 */
export interface ProjectFilesChangedPayload {
  projectId: number;
  changedPaths: string[];
  files: Record<string, string>;
  removedPaths: string[];
  operationType: "build" | "refine" | "apply" | "rollback" | "visual-edit" | "manual-save";
  requiresInstall: boolean;
  requiresRestart: boolean;
}
