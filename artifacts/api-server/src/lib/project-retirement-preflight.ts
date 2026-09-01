import { and, eq, inArray, like, or, type ExtractTablesWithRelations } from "drizzle-orm";
import type { NodePgTransaction } from "drizzle-orm/node-postgres";
import type * as DatabaseSchema from "@workspace/db/schema";
import {
  deploymentLogsTable,
  managedAddonsTable,
  projectDomainsTable,
  projectVersionsTable,
  purchasedDomainsTable,
} from "@workspace/db/schema";
import {
  classifyStoredRuntimePointer,
  decideProjectRetirementPreflight,
  type ProjectRetirementPreflightDecision,
} from "./project-retirement-contract";
import {
  resolveCurrentCloudflareRetirementPosture,
  resolveLegacyHostnameKvPosture,
  type LegacyHostnameKvPosture,
} from "./project-retirement-activation";
import type { HostnameRouteInventoryResult } from "./cloudflare";
import { supportsProductionRouteInventory } from "./tenant-runtime-provider";

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
  publicSlug?: string | null;
  customDomain?: string | null;
  publishedSnapshotId?: number | null;
};

export type ProjectRetirementProviderHostnameInventory =
  | { state: "complete"; hasHostnameInventory: boolean }
  | { state: "unavailable" };

type ProjectRetirementProviderHostnameInventoryDependencies = {
  readLegacyPosture: () => LegacyHostnameKvPosture;
  readLegacyInventory: (projectId: number) => Promise<HostnameRouteInventoryResult>;
  readRuntimeInventory: (projectId: number) => Promise<readonly unknown[] | null>;
};

const defaultProviderHostnameInventoryDependencies: ProjectRetirementProviderHostnameInventoryDependencies =
  {
    readLegacyPosture: () => resolveLegacyHostnameKvPosture(),
    readLegacyInventory: async (projectId) => {
      const { inventoryHostnameKVRoutesByProject } = await import("./cloudflare");
      return inventoryHostnameKVRoutesByProject(projectId);
    },
    readRuntimeInventory: async (projectId) => {
      const { tenantRuntimeProvider } = await import("./tenant-runtime");
      return supportsProductionRouteInventory(tenantRuntimeProvider)
        ? tenantRuntimeProvider.inventoryProductionRoutes(projectId)
        : null;
    },
  };

/**
 * Read the same provider-side hostname inventories that the retirement worker
 * consumes later. `null` runtime inventory means the selected provider cannot
 * prove whether an earlier Cloudflare route remains; ambiguity is never empty.
 */
export async function readProjectRetirementProviderHostnameInventory(
  projectId: number,
  dependencies: ProjectRetirementProviderHostnameInventoryDependencies = defaultProviderHostnameInventoryDependencies,
): Promise<ProjectRetirementProviderHostnameInventory> {
  const legacyPosture = dependencies.readLegacyPosture();
  if (legacyPosture.state !== "configured") return { state: "unavailable" };

  let hasHostnameInventory = false;
  try {
    const inventory = await dependencies.readLegacyInventory(projectId);
    if (inventory.state !== "complete") return { state: "unavailable" };
    hasHostnameInventory = inventory.observations.length > 0;
  } catch {
    return { state: "unavailable" };
  }

  try {
    const runtimeRoutes = await dependencies.readRuntimeInventory(projectId);
    if (runtimeRoutes === null) return { state: "unavailable" };
    if (runtimeRoutes.length > 0) hasHostnameInventory = true;
  } catch {
    return { state: "unavailable" };
  }

  return { state: "complete", hasHostnameInventory };
}

type ProjectRetirementPreflightDependencies = {
  readProviderHostnameInventory: (
    projectId: number,
  ) => Promise<ProjectRetirementProviderHostnameInventory>;
};

const defaultProjectRetirementPreflightDependencies: ProjectRetirementPreflightDependencies = {
  readProviderHostnameInventory: readProjectRetirementProviderHostnameInventory,
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
  dependencies: ProjectRetirementPreflightDependencies = defaultProjectRetirementPreflightDependencies,
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

  const [projectDomain, purchasedDomain, publishedVersion] = await Promise.all([
    tx
      .select({ id: projectDomainsTable.id })
      .from(projectDomainsTable)
      .where(eq(projectDomainsTable.projectId, project.id))
      .limit(1),
    tx
      .select({ id: purchasedDomainsTable.id })
      .from(purchasedDomainsTable)
      .where(eq(purchasedDomainsTable.projectId, project.id))
      .limit(1),
    project.publishedSnapshotId === null || project.publishedSnapshotId === undefined
      ? Promise.resolve<Array<{ productionRelease: unknown }>>([])
      : tx
          .select({ productionRelease: projectVersionsTable.productionRelease })
          .from(projectVersionsTable)
          .where(eq(projectVersionsTable.id, project.publishedSnapshotId))
          .limit(1),
  ]);
  const hasHostnameInventory =
    Boolean(project.publicSlug) ||
    Boolean(project.customDomain) ||
    projectDomain.length > 0 ||
    purchasedDomain.length > 0 ||
    publishedVersion.some((version) => version.productionRelease !== null);
  const cloudflarePosture = resolveCurrentCloudflareRetirementPosture();
  const providerHostnameInventory =
    cloudflarePosture.state === "blocked" && !hasHostnameInventory
      ? await dependencies.readProviderHostnameInventory(project.id)
      : ({ state: "complete", hasHostnameInventory: false } as const);
  const providerCachePurgeUnavailable =
    cloudflarePosture.state === "blocked" &&
    (hasHostnameInventory ||
      providerHostnameInventory.state === "unavailable" ||
      providerHostnameInventory.hasHostnameInventory);

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
    hasUnavailableCloudflareCachePurge: providerCachePurgeUnavailable,
    hasUnverifiedSqliteRecovery: false,
    hasUnverifiedManagedAddon: managedAddon.length > 0,
    hasInFlightRemoteBuild: inFlightRemoteBuild.length > 0,
  });
}
