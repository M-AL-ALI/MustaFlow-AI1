/**
 * Testing workflow invalidation helpers.
 *
 * Two distinct functions — never conflate them:
 *
 * staleDraftCandidate(projectId, reason)
 *   Called when draft FILES change (build, refine, Apply, visual edit).
 *   The test container may remain running for visual audit comparison.
 *   The preview session stays valid so the user can still view the last tested snapshot.
 *   Clears publish eligibility but does NOT stop the container or revoke the session.
 *
 * revokePreviewForSecurityChange(projectId, reason)
 *   Called when SECURITY CONFIGURATION changes:
 *     - testing secret created / edited / deleted
 *     - isPreviewSafe or exposureType toggled
 *     - preview database reset or replaced
 *     - preview migration failure
 *     - runtime/build config change (stack, dbProvider)
 *   The test container may be holding stale/revoked credentials — it MUST be stopped.
 *   The preview session is revoked immediately so the subdomain gateway blocks access.
 */

import { eq } from "drizzle-orm";
import { db, projectsTable, previewSessionsTable } from "@workspace/db";
import { logger } from "./logger";

export type InvalidationReason =
  | "draft-file-change"
  | "build"
  | "refine"
  | "apply"
  | "visual-edit"
  | "manual-save"
  | "rollback"
  | "testing-secret-created"
  | "testing-secret-updated"
  | "testing-secret-deleted"
  | "preview-safe-toggled"
  | "exposure-type-changed"
  | "preview-db-reset"
  | "preview-migration-failed"
  | "runtime-config-changed"
  | "task-agent-apply";

const SECURITY_REASONS = new Set<InvalidationReason>([
  "testing-secret-created",
  "testing-secret-updated",
  "testing-secret-deleted",
  "preview-safe-toggled",
  "exposure-type-changed",
  "preview-db-reset",
  "preview-migration-failed",
  "runtime-config-changed",
]);

/**
 * Called when draft content changes only. Marks the test candidate stale and
 * clears publish eligibility. Does NOT touch the running test container or
 * preview session — the old snapshot remains viewable for comparison.
 */
export async function staleDraftCandidate(
  projectId: number,
  reason: InvalidationReason,
): Promise<void> {
  const result = await db
    .update(projectsTable)
    .set({
      testingStatus: "stale",
      testingCandidateSnapshotId: null,
      testedSnapshotId: null,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId))
    .returning({
      testingStatus: projectsTable.testingStatus,
      testingCandidateSnapshotId: projectsTable.testingCandidateSnapshotId,
    });

  if (result.length > 0) {
    logger.info({ projectId, reason }, "Test candidate marked stale (draft content changed)");
  }
}

/**
 * Called when security configuration changes. Marks stale, revokes the active
 * preview session, and stops the test container so it cannot continue running
 * with outdated credentials or database access.
 */
export async function revokePreviewForSecurityChange(
  projectId: number,
  reason: InvalidationReason,
): Promise<void> {
  const [project] = await db
    .select({
      activePreviewSessionId: projectsTable.activePreviewSessionId,
      testContainerId: projectsTable.testContainerId,
      testContainerStatus: projectsTable.testContainerStatus,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project) return;

  // Revoke active preview session immediately.
  if (project.activePreviewSessionId) {
    await db
      .update(previewSessionsTable)
      .set({ revokedAt: new Date(), revokeReason: reason })
      .where(eq(previewSessionsTable.sessionId, project.activePreviewSessionId));
  }

  // Stop the test container (non-fatal if it fails — machine may already be stopped).
  if (
    project.testContainerId &&
    project.testContainerStatus !== "stopped" &&
    project.testContainerStatus !== "error"
  ) {
    try {
      const { destroyContainer } = await import("./container");
      await destroyContainer(project.testContainerId, projectId);
    } catch (err) {
      logger.warn(
        { err, projectId },
        "Failed to stop test container after security change — ignoring",
      );
    }
  }

  // Update project row: clear all testing eligibility.
  await db
    .update(projectsTable)
    .set({
      testingStatus: "stale",
      testingCandidateSnapshotId: null,
      testedSnapshotId: null,
      testContainerStatus: "stopped",
      activePreviewSessionId: null,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, projectId));

  logger.warn(
    { projectId, reason },
    "Preview session revoked and test container stopped (security configuration changed)",
  );
}

/**
 * Route a project-level change event to the correct invalidation function.
 * Callers can use this instead of deciding which function to call directly.
 */
export async function handleProjectChangeInvalidation(
  projectId: number,
  reason: InvalidationReason,
): Promise<void> {
  if (SECURITY_REASONS.has(reason)) {
    await revokePreviewForSecurityChange(projectId, reason);
  } else {
    await staleDraftCandidate(projectId, reason);
  }
}
