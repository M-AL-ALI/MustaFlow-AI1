/**
 * GDPR erasure worker — hard-deletes all data for a user 30 days after their
 * deletion request. Registered as a pg-boss durable job (mustaflow.gdpr-erasure).
 *
 * Idempotent: safe to retry — all deletes use WHERE clauses that are no-ops
 * when the rows are already gone.
 *
 * What gets deleted:
 *  - All project rows (ON DELETE CASCADE removes: files, versions, messages,
 *    agent_tasks, project_uploads DB rows, deployment_logs, project_domains,
 *    project_secrets, canvas_variants, agent_inbox rows, and more)
 *  - Knowledge vault entries owned by the user
 *  - Org membership rows
 *  - Credit balance and transaction history
 *  - User subscription record
 *  - User preferences (including erasure job metadata)
 *  - Personal access tokens
 *
 * External storage (best-effort — logged on failure, never blocks completion):
 *  - Object-storage upload files
 *  - Fly.io containers for agentic projects
 */

import {
  db,
  projectsTable,
  knowledgeEntriesTable,
  orgMembersTable,
  userCreditsTable,
  creditTransactionsTable,
  projectUploadsTable,
  userPreferencesTable,
  userSubscriptionsTable,
  personalAccessTokensTable,
  oraTranscriptsTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import { logger } from "./logger";
import { evictTierCache } from "./public-ai/authed-user";
import { destroyContainer } from "./tenant-runtime";
import { objectStorageClient } from "./objectStorage";

/**
 * Best-effort: delete a file from Replit object storage by its objectPath.
 * objectPath format: /<bucketName>/<objectName>
 */
async function deleteStorageObject(objectPath: string): Promise<void> {
  try {
    if (!objectPath || !objectPath.startsWith("/")) return;
    const parts = objectPath.split("/");
    if (parts.length < 3) return;
    const bucketName = parts[1];
    const objectName = parts.slice(2).join("/");
    if (!bucketName || !objectName) return;
    await objectStorageClient.bucket(bucketName).file(objectName).delete({ ignoreNotFound: true });
  } catch (err) {
    logger.warn({ err, objectPath }, "gdpr-erasure: failed to delete storage object (non-fatal)");
  }
}

/**
 * Hard-erase all platform data for a given userId.
 * Called by the durable GDPR erasure job ~30 days after account deletion is initiated.
 */
export async function runGdprErasure(userId: string): Promise<void> {
  logger.info({ userId }, "gdpr-erasure: starting hard-delete for user");

  // ── 1. Collect upload objectPaths before cascading project deletes ─────────
  // Projects are about to be hard-deleted (ON DELETE CASCADE removes uploads DB rows),
  // so we must fetch objectPaths now while the rows still exist.
  const userProjects = await db
    .select({ id: projectsTable.id, containerId: projectsTable.containerId })
    .from(projectsTable)
    .where(eq(projectsTable.ownerId, userId));

  const projectIds = userProjects.map((p) => p.id);

  let uploadObjectPaths: string[] = [];
  if (projectIds.length > 0) {
    const uploadRows = await db
      .select({ objectPath: projectUploadsTable.objectPath })
      .from(projectUploadsTable)
      .where(inArray(projectUploadsTable.projectId, projectIds));
    uploadObjectPaths = uploadRows.map((r) => r.objectPath).filter(Boolean);
  }

  // ── 2. Destroy Fly.io containers (best-effort) ─────────────────────────────
  for (const project of userProjects) {
    if (project.containerId) {
      try {
        await destroyContainer(project.containerId, project.id);
      } catch (err) {
        logger.warn(
          { err, projectId: project.id, containerId: project.containerId },
          "gdpr-erasure: container destroy failed (non-fatal)",
        );
      }
    }
  }

  // ── 3. Hard-delete all project rows (cascades to all child tables) ─────────
  if (projectIds.length > 0) {
    await db.delete(projectsTable).where(eq(projectsTable.ownerId, userId));
    logger.info({ userId, count: projectIds.length }, "gdpr-erasure: projects hard-deleted");
  }

  // ── 4. Delete object-storage upload files (best-effort) ───────────────────
  for (const objectPath of uploadObjectPaths) {
    await deleteStorageObject(objectPath);
  }
  if (uploadObjectPaths.length > 0) {
    logger.info(
      { userId, count: uploadObjectPaths.length },
      "gdpr-erasure: upload objects deleted",
    );
  }

  // ── 5. Hard-delete knowledge vault entries ─────────────────────────────────
  await db.delete(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.userId, userId));

  // ── 6. Hard-delete org membership rows ────────────────────────────────────
  await db.delete(orgMembersTable).where(eq(orgMembersTable.userId, userId));

  // ── 7. Hard-delete credits and transactions ───────────────────────────────
  await db.delete(creditTransactionsTable).where(eq(creditTransactionsTable.userId, userId));
  await db.delete(userCreditsTable).where(eq(userCreditsTable.userId, userId));

  // ── 8. Hard-delete subscription record ───────────────────────────────────
  await db.delete(userSubscriptionsTable).where(eq(userSubscriptionsTable.userId, userId));
  evictTierCache(userId);

  // ── 9. Hard-delete personal access tokens ────────────────────────────────
  await db.delete(personalAccessTokensTable).where(eq(personalAccessTokensTable.userId, userId));

  // ── 10. Hard-delete Ora transcript ───────────────────────────────────────
  await db.delete(oraTranscriptsTable).where(eq(oraTranscriptsTable.userId, userId));
  logger.info({ userId }, "gdpr-erasure: ora transcript hard-deleted");

  // ── 11. Hard-delete user preferences (last — contains erasure metadata) ──
  await db.delete(userPreferencesTable).where(eq(userPreferencesTable.userId, userId));

  logger.info({ userId }, "gdpr-erasure: hard-delete complete");
}
