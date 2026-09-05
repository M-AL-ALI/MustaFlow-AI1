import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectRetirementOperationsTable,
  projectPurgeOperationsTable,
  type ProjectRetirementOperation,
} from "@workspace/db";
import {
  initialProjectRetirementProgress,
  PROJECT_LIFECYCLE_LOCK_NAMESPACE,
  PROJECT_RETIREMENT_MAX_RECONCILIATIONS,
  projectRetirementVerificationRepairPointer,
} from "./project-retirement-contract";
import {
  decideProjectRetirementReconciliation,
  type ProjectRetirementReconciliationRequest,
} from "./project-retirement";
import { resolveCurrentCloudflareRetirementPosture } from "./project-retirement-activation";
import { retireProjectAccessSurfaces } from "./project-retirement-access";

type ReconciliationAuthority = {
  allowLegacyAdminReconciliation?: boolean;
  allowConfigurationRecovery?: boolean;
};

/** Missing historical metadata is generation zero; malformed metadata cannot reset a budget. */
export function readProjectRetirementReconciliationMetadata(progress: unknown) {
  const record =
    progress !== null && typeof progress === "object" && !Array.isArray(progress)
      ? (progress as Record<string, unknown>)
      : null;
  if (record && record.reconciliation === undefined) {
    return { generation: 0, configurationRecoveryUsed: false };
  }
  const metadata = record?.reconciliation;
  if (metadata !== null && typeof metadata === "object" && !Array.isArray(metadata)) {
    const fields = metadata as Record<string, unknown>;
    if (
      Number.isSafeInteger(fields.generation) &&
      Number(fields.generation) >= 0 &&
      (fields.configurationRecoveryUsed === undefined ||
        typeof fields.configurationRecoveryUsed === "boolean")
    ) {
      return {
        generation: Number(fields.generation),
        configurationRecoveryUsed: fields.configurationRecoveryUsed === true,
      };
    }
  }
  return { generation: PROJECT_RETIREMENT_MAX_RECONCILIATIONS, configurationRecoveryUsed: true };
}

function readStoredProjectRetirementReconciliationMetadata(
  operation: Pick<
    ProjectRetirementOperation,
    "id" | "projectId" | "state" | "completedAt" | "failureCode" | "progress"
  >,
) {
  if (
    (operation.progress == null ||
      (typeof operation.progress === "object" &&
        !Array.isArray(operation.progress) &&
        Object.keys(operation.progress).length === 0)) &&
    operation.state === "failed" &&
    operation.completedAt != null &&
    operation.failureCode === "project_retirement_operation_unavailable" &&
    operation.id === `project-retirement:legacy:v1:${operation.projectId}`
  ) {
    return { generation: 0, configurationRecoveryUsed: false };
  }
  return readProjectRetirementReconciliationMetadata(operation.progress);
}

export function decideStoredProjectRetirementReconciliation(
  operation:
    | Pick<
        ProjectRetirementOperation,
        "id" | "projectId" | "state" | "completedAt" | "failureCode" | "progress"
      >
    | null
    | undefined,
  authority: ReconciliationAuthority = {},
) {
  if (!operation) return { allowed: false as const, code: "project_retirement_not_found" as const };
  return decideProjectRetirementReconciliation({
    state: operation.state,
    completedAt: operation.completedAt,
    failureCode: operation.failureCode,
    progress: operation.progress,
    ...readStoredProjectRetirementReconciliationMetadata(operation),
    allowLegacyAdminReconciliation: authority.allowLegacyAdminReconciliation === true,
    allowConfigurationRecovery: authority.allowConfigurationRecovery === true,
    currentCloudflareCachePurgeConfigured:
      resolveCurrentCloudflareRetirementPosture().state === "configured",
  });
}

/** Fresh evidence only: preserve the parent receipt and re-run the existing durable worker. */
export async function requestProjectRetirementEvidenceReconciliation(input: {
  projectId: number;
  requestedBy: string;
  ownerId?: string;
  allowLegacyAdminReconciliation: boolean;
  allowConfigurationRecovery?: boolean;
}): Promise<ProjectRetirementReconciliationRequest | { code: "project_purge_in_progress" }> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${input.projectId})`,
    );
    const ownerId =
      input.ownerId ?? (input.allowLegacyAdminReconciliation ? undefined : input.requestedBy);
    const [project] = await tx
      .select({
        id: projectsTable.id,
        containerId: projectsTable.containerId,
        prodContainerId: projectsTable.prodContainerId,
        testContainerId: projectsTable.testContainerId,
      })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, input.projectId),
          isNotNull(projectsTable.deletedAt),
          ...(ownerId ? [eq(projectsTable.ownerId, ownerId)] : []),
        ),
      )
      .limit(1);
    if (!project) return { code: "project_retirement_not_found" as const };
    const [latest] = await tx
      .select()
      .from(projectRetirementOperationsTable)
      .where(eq(projectRetirementOperationsTable.projectId, input.projectId))
      .orderBy(desc(projectRetirementOperationsTable.createdAt))
      .limit(1);
    if (!latest) return { code: "project_retirement_not_found" as const };
    const decision = decideStoredProjectRetirementReconciliation(latest, input);
    if (!decision.allowed) return { code: decision.code };
    const repairPointer = projectRetirementVerificationRepairPointer(latest.progress);
    if (repairPointer) {
      const retained = latest.progress.retainedLegacyRuntimePointers[0];
      if (!retained || project[repairPointer] !== retained.identity) {
        return { code: "project_retirement_retry_not_allowed" as const };
      }
    }
    // Old completed evidence may already have a scheduled purge. Once purge has
    // started, its coordinator owns the project; recovery must not overlap it.
    if (latest.state === "completed" || repairPointer) {
      const [purge] = await tx
        .select({ state: projectPurgeOperationsTable.state })
        .from(projectPurgeOperationsTable)
        .where(eq(projectPurgeOperationsTable.projectId, input.projectId))
        .orderBy(desc(projectPurgeOperationsTable.createdAt))
        .limit(1);
      if (purge && purge.state !== "scheduled")
        return { code: "project_purge_in_progress" as const };
    }
    const metadata = readStoredProjectRetirementReconciliationMetadata(latest);
    const previousRepair = latest.progress?.reconciliation?.verificationRepair;
    const operationId = crypto.randomUUID();
    let progress = initialProjectRetirementProgress();
    progress.reconciliation = {
      generation: metadata.generation + 1,
      parentOperationId: latest.id,
      requestedBy: input.requestedBy,
      reason: decision.reason,
      configurationRecoveryUsed:
        metadata.configurationRecoveryUsed || decision.reason === "configuration_recovery",
      ...(previousRepair !== undefined ? { verificationRepair: previousRepair } : {}),
      ...(repairPointer
        ? {
            verificationRepair: {
              version: "fly-destroyed-tombstone-v1" as const,
              parentOperationId: latest.id,
              requestedBy: input.requestedBy,
              pointer: repairPointer,
              predecessorGeneration: 3 as const,
              failureCode: "project_retirement_legacy_runtime_absence_unverified" as const,
              reason: "absence_unverified" as const,
            },
          }
        : {}),
    };
    progress = await retireProjectAccessSurfaces(tx, {
      projectId: input.projectId,
      actorUserId: input.requestedBy,
      progress,
    });
    await tx.insert(projectRetirementOperationsTable).values({
      id: operationId,
      projectId: input.projectId,
      requestedBy: input.requestedBy,
      state: "accepted",
      progress,
    });
    return { operationId, projectId: input.projectId, state: "accepted" as const };
  });
}
