import { and, eq, inArray, like, or, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type * as DatabaseSchema from "@workspace/db/schema";
import { deploymentLogsTable, managedAddonsTable } from "@workspace/db/schema";
import {
  classifyStoredRuntimePointer,
  decideProjectRetirementPreflight,
  type ProjectRetirementPreflightDecision,
} from "./project-retirement-contract";

type ProjectRetirementTransaction = NodePgTransaction<
  typeof DatabaseSchema,
  ExtractTablesWithRelations<typeof DatabaseSchema>
>;

export const PROJECT_RETIREMENT_IN_FLIGHT_EAS_STATUSES = [
  "started",
  "queued",
  "building",
  "submitting",
] as const;
export const PROJECT_RETIREMENT_LEGACY_EAS_ENVS = ["ios", "android"] as const;

export type ProjectRetirementPreflightProject = {
  id: number;
  containerId: string | null;
  prodContainerId: string | null;
  testContainerId: string | null;
  dbProvider: string;
  provisioningStatus: string;
  previewDbStatus: string;
};

async function hasLegacyRuntimePointer(
  project: ProjectRetirementPreflightProject,
): Promise<boolean> {
  if (project.testContainerId !== null) return true;
  const namespace = process.env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE ?? "";
  for (const stored of [
    { pointer: "containerId" as const, identity: project.containerId },
    { pointer: "prodContainerId" as const, identity: project.prodContainerId },
  ]) {
    if (stored.identity === null) continue;
    const classification = await classifyStoredRuntimePointer({
      identity: stored.identity,
      namespace,
      projectId: project.id,
      pointer: stored.pointer,
    });
    if (classification.state === "retained_legacy") return true;
  }
  return false;
}

/**
 * A database row is not a provider-absence receipt. The current managed-add-on
 * implementation can mark a row removed without calling or inventorying its
 * provider, so the only state we can prove safe from existing durable facts is
 * that no add-on row has ever existed for this project.
 *
 * SQLite data lives inside the runtime at /data/db.sqlite. Existing snapshots
 * are point-in-time, best-effort captures and are not bound to retirement or
 * automatic restore. Until that binding exists, every SQLite project is
 * conservatively refused before any runtime can be destroyed.
 */
export async function readProjectRetirementPreflight(
  tx: ProjectRetirementTransaction,
  project: ProjectRetirementPreflightProject,
): Promise<ProjectRetirementPreflightDecision> {
  const hasLegacyRuntime = await hasLegacyRuntimePointer(project);
  const projectOnlyDecision = decideProjectRetirementPreflight({
    hasLegacyRuntime,
    hasInFlightProviderProvisioning:
      project.provisioningStatus === "provisioning" || project.previewDbStatus === "provisioning",
    hasUnverifiedSqliteRecovery: project.dbProvider === "sqlite",
    hasUnverifiedManagedAddon: false,
    hasInFlightRemoteBuild: false,
  });
  if (!projectOnlyDecision.allowed) return projectOnlyDecision;

  const managedAddon = await tx
    .select({ id: managedAddonsTable.id })
    .from(managedAddonsTable)
    .where(eq(managedAddonsTable.projectId, project.id))
    .limit(1);

  const inFlightRemoteBuild = await tx
    .select({ id: deploymentLogsTable.id })
    .from(deploymentLogsTable)
    .where(
      and(
        eq(deploymentLogsTable.projectId, project.id),
        or(
          like(deploymentLogsTable.env, "eas-%"),
          inArray(deploymentLogsTable.env, PROJECT_RETIREMENT_LEGACY_EAS_ENVS),
        ),
        inArray(deploymentLogsTable.status, PROJECT_RETIREMENT_IN_FLIGHT_EAS_STATUSES),
      ),
    )
    .limit(1);

  return decideProjectRetirementPreflight({
    hasLegacyRuntime: false,
    hasInFlightProviderProvisioning: false,
    hasUnverifiedSqliteRecovery: false,
    hasUnverifiedManagedAddon: managedAddon.length > 0,
    hasInFlightRemoteBuild: inFlightRemoteBuild.length > 0,
  });
}
