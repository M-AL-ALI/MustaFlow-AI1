import { and, eq, isNull, sql } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { withActiveProjectLifecycle } from "./project-lifecycle";
import { logger } from "./logger";

/** A private Cloudflare descriptor intentionally has no public endpoint. */
export function sealedRuntimeProvisioningState(status: string): {
  provisioningStatus: "ready" | "provisioning";
  provisioningStep: "runtime-start" | null;
} {
  const settled = status === "stopped" || status === "running";
  return {
    provisioningStatus: settled ? "ready" : "provisioning",
    provisioningStep: settled ? null : "runtime-start",
  };
}

/**
 * The old sealed-create path wrote runtime-start without a provisioning start
 * time. Traditional database provisioning owns a start time and is excluded.
 * Unknown/nonterminal task states and unresolved database claims fail closed.
 * Repeat this predicate at write time while holding the lifecycle admission
 * lock, so a new user build or Trash cannot race historical recovery.
 */
export function staleSealedPreviewProvisioningPredicate() {
  return and(
    isNull(projectsTable.deletedAt),
    eq(projectsTable.status, "failed"),
    eq(projectsTable.provisioningStatus, "provisioning"),
    eq(projectsTable.provisioningStep, "runtime-start"),
    isNull(projectsTable.provisioningStartedAt),
    eq(projectsTable.dbProvider, "none"),
    eq(projectsTable.previewDbStatus, "none"),
    isNull(projectsTable.previewDbAllocation),
    sql`${projectsTable.containerId} IS NOT NULL`,
    sql`EXISTS (
      SELECT 1 FROM agent_tasks failed_task
      WHERE failed_task.project_id = ${projectsTable.id}
        AND failed_task.status = 'failed'
        AND failed_task.completed_at IS NOT NULL
    )`,
    sql`NOT EXISTS (
      SELECT 1 FROM agent_tasks pending_task
      WHERE pending_task.project_id = ${projectsTable.id}
        AND (pending_task.status NOT IN ('completed', 'failed', 'canceled', 'cancelled')
          OR pending_task.completed_at IS NULL)
    )`,
  );
}

type RuntimeDescriptor = { identity: string; status: string } | null;

async function readProjectRuntimeDescriptor(projectId: number): Promise<RuntimeDescriptor> {
  const { tenantRuntimeProvider } = await import("./tenant-runtime");
  const { supportsZeroGeneration } = await import("./tenant-runtime-provider");
  if (!supportsZeroGeneration(tenantRuntimeProvider)) return null;
  // The provider derives this identity from the deployment namespace and project
  // id. Never treat a user-supplied or legacy stored pointer as ownership proof.
  return tenantRuntimeProvider.zeroGenerationRuntimeDescriptorForProject(projectId);
}

/**
 * Bounded, repeatable boot convergence for a terminal failed build only. It
 * changes no resources, credentials, project content, task state or tombstone.
 * The ordinary Trash coordinator still performs all cleanup and absence proof.
 */
export async function recoverStaleSealedPreviewProvisioning(
  readDescriptor: (projectId: number) => Promise<RuntimeDescriptor> = readProjectRuntimeDescriptor,
): Promise<number> {
  const candidates = await db
    .select({ id: projectsTable.id, containerId: projectsTable.containerId })
    .from(projectsTable)
    .where(staleSealedPreviewProvisioningPredicate())
    .orderBy(projectsTable.id)
    .limit(50);
  let recovered = 0;
  for (const candidate of candidates) {
    try {
      const result = await withActiveProjectLifecycle(candidate.id, async (session) => {
        const [current] = await db
          .select({ id: projectsTable.id, containerId: projectsTable.containerId })
          .from(projectsTable)
          .where(and(eq(projectsTable.id, candidate.id), staleSealedPreviewProvisioningPredicate()))
          .limit(1);
        if (!current?.containerId || current.containerId !== candidate.containerId) return false;
        const descriptor = await readDescriptor(current.id);
        if (
          !descriptor ||
          descriptor.identity !== current.containerId ||
          sealedRuntimeProvisioningState(descriptor.status).provisioningStatus !== "ready" ||
          !(await session.assertActive())
        ) {
          return false;
        }
        const changed = await db
          .update(projectsTable)
          .set({
            provisioningStatus: "error",
            provisioningStep: null,
            provisioningError:
              "The preview build failed. Retry the build or move the project to Trash.",
          })
          .where(
            and(
              eq(projectsTable.id, current.id),
              eq(projectsTable.containerId, current.containerId),
              staleSealedPreviewProvisioningPredicate(),
            ),
          )
          .returning({ id: projectsTable.id });
        return changed.length === 1;
      });
      if (result.state === "active" && result.value) {
        recovered += 1;
        logger.info({ projectId: candidate.id }, "Recovered failed sealed-preview setup marker");
      }
    } catch (error) {
      // An uncertain provider read must never become permission to delete.
      logger.warn(
        { error, projectId: candidate.id },
        "Sealed-preview recovery remains unconfirmed",
      );
    }
  }
  return recovered;
}
