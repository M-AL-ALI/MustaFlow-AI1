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
  operationType:
    | "build"
    | "refine"
    | "apply"
    | "rollback"
    | "visual-edit"
    | "manual-save"
    | "qa-auto-fix"
    | "delete-reinsert";
  requiresInstall: boolean;
  requiresRestart: boolean;
}

export type ProjectFilesChangedFrame = {
  eventType: string;
  projectId?: number;
  data?: Omit<Partial<ProjectFilesChangedPayload>, "operationType"> & {
    operationType?: string;
  };
};

export function projectFilesChangedPayloadFromFrame(
  event: ProjectFilesChangedFrame,
  fallbackProjectId: number,
): ProjectFilesChangedPayload {
  const data = event.data ?? {};
  return {
    projectId: data.projectId ?? event.projectId ?? fallbackProjectId,
    operationType: (data.operationType ??
      "manual-save") as ProjectFilesChangedPayload["operationType"],
    changedPaths: data.changedPaths ?? [],
    removedPaths: data.removedPaths ?? [],
    files: data.files ?? {},
    requiresInstall: data.requiresInstall ?? false,
    requiresRestart: data.requiresRestart ?? false,
  };
}
