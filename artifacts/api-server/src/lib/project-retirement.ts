import { and, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import {
  assetAnalysisEventsTable,
  db,
  purchasedDomainsTable,
  projectActivityTable,
  projectDomainsTable,
  projectRetirementOperationsTable,
  projectsTable,
  projectVersionsTable,
  type ProjectRetirementOperation,
  type ProjectRetirementProgress,
  type CloudflareSecurityResourceReceipt,
  type DomainSecurityConfig,
} from "@workspace/db";
import {
  deriveRuntimeIdentity,
  type ProductionArtifactRelease,
} from "@workspace/tenant-runtime-contracts";
import { logger } from "./logger";
import { tenantRuntimeProvider } from "./tenant-runtime";
import {
  supportsProductionArtifactPromotion,
  supportsProductionRouteInventory,
} from "./tenant-runtime-provider";
import { CloudflareRuntimeControlError } from "./cloudflare-runtime-provider";
import {
  discoverCloudflareSecurityResources,
  inventoryCustomHostnamesByHostname,
  inventoryHostnameKVRoutesByProject,
  purgeCacheForHostnames,
  retireCloudflareSecurityResource,
  retireCustomHostname,
  retireHostnameKV,
  retireLegacyR2ProjectPrefix,
  retireObservedHostnameKV,
} from "./cloudflare";
import {
  durableEnqueueRawResult,
  isDurableWorkerReady,
  QUEUE_PROJECT_RETIREMENT,
} from "./durable-queue";
import {
  decideProjectJobAdmission,
  decideProjectRetirementReconciliation,
  classifyStoredRuntimePointer,
  initialProjectRetirementProgress,
  planLegacyProjectRetirementAdoptions,
  planHostnameCertificateRetirements,
  projectRetirementCacheHostnames,
  PROJECT_LIFECYCLE_LOCK_NAMESPACE,
  PROJECT_RETIREMENT_LEASE_MINUTES,
  PROJECT_RETIREMENT_MAX_ATTEMPTS,
  PROJECT_RETIREMENT_TASK_STATUSES,
  projectRetirementFailure,
  type ProjectJobAdmission,
  type ProjectRetirementFailure,
  type ProjectRetirementRuntimeTarget,
} from "./project-retirement-contract";
import { resolveLegacyHostnameKvPosture } from "./project-retirement-activation";
import { retireProjectAccessSurfaces } from "./project-retirement-access";

export * from "./project-retirement-contract";

export type AcceptedProjectRetirement = {
  operationId: string;
  projectId: number;
  state: "accepted";
};

/**
 * The single mutation boundary for both owner and bounded-admin retirement.
 * Tombstone, receipt, schedule suspension and provenance commit together.
 */
export async function acceptProjectRetirement(input: {
  projectId: number;
  requestedBy: string;
  ownerId?: string;
}): Promise<AcceptedProjectRetirement | null> {
  const { disableProjectDeploymentSchedulesStatement } = await import("./deployment-scheduler");
  const operationId = crypto.randomUUID();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${input.projectId})`,
    );
    const predicates = [
      eq(projectsTable.id, input.projectId),
      isNull(projectsTable.deletedAt),
      ...(input.ownerId ? [eq(projectsTable.ownerId, input.ownerId)] : []),
    ];
    const [existing] = await tx
      .select({ id: projectsTable.id, name: projectsTable.name })
      .from(projectsTable)
      .where(and(...predicates))
      .limit(1);
    if (!existing) return null;
    const [project] = await tx
      .update(projectsTable)
      .set({ deletedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(...predicates))
      .returning({ id: projectsTable.id });
    if (!project) return null;
    const progress = await retireProjectAccessSurfaces(tx, {
      projectId: project.id,
      actorUserId: input.requestedBy,
      progress: initialProjectRetirementProgress(),
    });
    await tx.insert(projectRetirementOperationsTable).values({
      id: operationId,
      projectId: project.id,
      requestedBy: input.requestedBy,
      state: "accepted",
      progress,
    });
    await tx.execute(disableProjectDeploymentSchedulesStatement(project.id));
    await tx
      .update(assetAnalysisEventsTable)
      .set({ status: "canceled" })
      .where(
        and(
          eq(assetAnalysisEventsTable.projectId, project.id),
          inArray(assetAnalysisEventsTable.status, ["queued", "started"]),
        ),
      );
    await tx.insert(projectActivityTable).values({
      projectId: existing.id,
      actorId: input.requestedBy,
      actorName: null,
      eventType: "delete",
      summary: `Project "${existing.name}" was moved to Trash`,
      metadata: { projectName: existing.name, operationId },
    });
    return { operationId, projectId: project.id, state: "accepted" as const };
  });
}

class ProjectRetirementStepError extends Error {
  constructor(readonly receipt: ProjectRetirementFailure) {
    super(receipt.code);
    this.name = "ProjectRetirementStepError";
  }
}

class ProjectRetirementLeaseLostError extends Error {
  constructor() {
    super("project_retirement_lease_lost");
    this.name = "ProjectRetirementLeaseLostError";
  }
}

const RETIREMENT_PROVIDER_CONCURRENCY = 4;

type RuntimeRouteRetirementReceipt = {
  hostname: string;
  manifestRevision: string;
  sandboxIdentity: string;
  state: "releasing" | "verified_absent" | "present" | "unavailable";
};

function runtimeRouteProgress(progress: ProjectRetirementProgress): {
  runtimeRoutes?: RuntimeRouteRetirementReceipt[];
} {
  return progress.route as ProjectRetirementProgress["route"] & {
    runtimeRoutes?: RuntimeRouteRetirementReceipt[];
  };
}

async function mapInBoundedBatches<T, R>(values: T[], run: (value: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let offset = 0; offset < values.length; offset += RETIREMENT_PROVIDER_CONCURRENCY) {
    results.push(
      ...(await Promise.all(
        values.slice(offset, offset + RETIREMENT_PROVIDER_CONCURRENCY).map(run),
      )),
    );
  }
  return results;
}

/** Central read-only boundary shared by every queued/durable job entry point. */
export async function readProjectJobAdmission(projectId: number): Promise<ProjectJobAdmission> {
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)))
    .limit(1);
  return decideProjectJobAdmission({ projectId, activeProjectId: project?.id ?? null });
}

function isProviderNotFound(error: unknown): boolean {
  return (
    error instanceof CloudflareRuntimeControlError &&
    ["runtime_not_found", "published_route_not_found"].includes(error.code)
  );
}

async function updateProgress(
  operationId: string,
  progress: ProjectRetirementProgress,
  leaseVersion: number,
): Promise<void> {
  const renewed = await db
    .update(projectRetirementOperationsTable)
    .set({
      progress,
      leaseExpiresAt: sql`now() + interval '${sql.raw(String(PROJECT_RETIREMENT_LEASE_MINUTES))} minutes'`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectRetirementOperationsTable.id, operationId),
        eq(projectRetirementOperationsTable.state, "running"),
        eq(projectRetirementOperationsTable.leaseVersion, leaseVersion),
      ),
    )
    .returning({ id: projectRetirementOperationsTable.id });
  if (renewed.length !== 1) throw new ProjectRetirementLeaseLostError();
}

async function cancelQueuedTasks(
  operation: ProjectRetirementOperation,
  progress: ProjectRetirementProgress,
  leaseVersion: number,
): Promise<void> {
  if (progress.tasks.state === "canceled") return;
  const { retireProjectTasks } = await import("./jobs");
  const receipt = await retireProjectTasks(operation.projectId, PROJECT_RETIREMENT_TASK_STATUSES);
  progress.tasks = {
    state: "canceled",
    count: receipt.selected,
    terminalized: receipt.terminalized,
    creditsRefunded: receipt.creditsRefunded,
    telemetryFlushed: receipt.telemetryFlushed,
  };
  await updateProgress(operation.id, progress, leaseVersion);
}

async function deactivatePublishedRoutes(
  operation: ProjectRetirementOperation,
  progress: ProjectRetirementProgress,
  leaseVersion: number,
): Promise<void> {
  if (progress.route.state === "verified_absent") return;
  const previousRuntimeRoutes = runtimeRouteProgress(progress).runtimeRoutes ?? [];
  progress.route = {
    state: "deactivating",
    failureCode: null,
    hostnames: progress.route.hostnames ?? [],
    cache: progress.route.cache ?? { state: "pending" },
  };
  runtimeRouteProgress(progress).runtimeRoutes = previousRuntimeRoutes;
  await updateProgress(operation.id, progress, leaseVersion);

  const [project] = await db
    .select({
      publicSlug: projectsTable.publicSlug,
      customDomain: projectsTable.customDomain,
      publishedSnapshotId: projectsTable.publishedSnapshotId,
      builderMode: projectsTable.builderMode,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, operation.projectId));
  if (!project) {
    throw new ProjectRetirementStepError({
      code: "project_retirement_operation_unavailable",
      target: null,
      retryable: false,
    });
  }

  const customDomains = await db
    .select({ hostname: projectDomainsTable.hostname })
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.projectId, operation.projectId));
  const customHostnames = customDomains.map((row) => row.hostname);
  const purchasedDomains = await db
    .select({ hostname: purchasedDomainsTable.hostname })
    .from(purchasedDomainsTable)
    .where(eq(purchasedDomainsTable.projectId, operation.projectId));
  const platformDomain = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
  const knownHostnames = [
    ...(project.publicSlug
      ? [
          `${project.publicSlug}.${platformDomain}`,
          `${project.publicSlug}-staging.${platformDomain}`,
        ]
      : []),
    ...(project.customDomain ? [project.customDomain] : []),
    ...customHostnames,
    ...purchasedDomains.map((domain) => domain.hostname),
  ].filter((hostname, index, all) => all.indexOf(hostname) === index);
  const legacyKvPosture = resolveLegacyHostnameKvPosture();
  if (legacyKvPosture.state === "blocked") {
    progress.route.state = "failed";
    progress.route.failureCode = "project_retirement_operation_unavailable";
    progress.route.legacyHostnameKv = {
      state: "failed",
      failureCode: "project_retirement_operation_unavailable",
    };
    await updateProgress(operation.id, progress, leaseVersion);
    throw new ProjectRetirementStepError({
      code: "project_retirement_operation_unavailable",
      target: null,
      retryable: true,
    });
  }

  const inventory =
    legacyKvPosture.state === "configured"
      ? await inventoryHostnameKVRoutesByProject(operation.projectId)
      : { state: "complete" as const, observations: [] };
  if (inventory.state !== "complete") {
    progress.route.state = "failed";
    progress.route.failureCode = "project_retirement_route_deactivation_unverified";
    progress.route.legacyHostnameKv = {
      state: "failed",
      failureCode: "project_retirement_route_deactivation_unverified",
    };
    await updateProgress(operation.id, progress, leaseVersion);
    throw new ProjectRetirementStepError({
      code: "project_retirement_route_deactivation_unverified",
      target: null,
      retryable: true,
    });
  }
  const observedByHostname = new Map(
    inventory.observations.map((observation) => [observation.hostname, observation]),
  );
  const kvHostnames =
    legacyKvPosture.state === "configured"
      ? [...new Set([...knownHostnames, ...observedByHostname.keys()])]
      : [];
  const routeResults = await mapInBoundedBatches(kvHostnames, (hostname) => {
    const observation = observedByHostname.get(hostname);
    return observation
      ? retireObservedHostnameKV(observation)
      : retireHostnameKV(hostname, operation.projectId);
  });
  progress.route.hostnames = routeResults.map((result, index) => ({
    hostname: kvHostnames[index]!,
    state: result.state,
    stage: result.state === "unavailable" ? result.stage : null,
  }));
  await updateProgress(operation.id, progress, leaseVersion);
  if (routeResults.some((result) => result.state === "unavailable" && result.stage === "delete")) {
    progress.route.state = "failed";
    progress.route.failureCode = "project_retirement_route_deactivation_failed";
    progress.route.legacyHostnameKv = {
      state: "failed",
      failureCode: "project_retirement_route_deactivation_failed",
    };
    await updateProgress(operation.id, progress, leaseVersion);
    throw new ProjectRetirementStepError({
      code: "project_retirement_route_deactivation_failed",
      target: null,
      retryable: true,
    });
  }
  if (routeResults.some((result) => result.state !== "absent")) {
    progress.route.state = "failed";
    progress.route.failureCode = "project_retirement_route_deactivation_unverified";
    progress.route.legacyHostnameKv = {
      state: "failed",
      failureCode: "project_retirement_route_deactivation_unverified",
    };
    await updateProgress(operation.id, progress, leaseVersion);
    throw new ProjectRetirementStepError({
      code: "project_retirement_route_deactivation_unverified",
      target: null,
      retryable: true,
    });
  }
  progress.route.legacyHostnameKv = {
    state: legacyKvPosture.state === "configured" ? "verified_absent" : "not_configured",
    failureCode: null,
  };
  await updateProgress(operation.id, progress, leaseVersion);

  const runtimeRouteHostnames: string[] = [];
  const routeInventoryProvider = supportsProductionRouteInventory(tenantRuntimeProvider)
    ? tenantRuntimeProvider
    : null;
  if (routeInventoryProvider) {
    try {
      const runtimeRoutes = await routeInventoryProvider.inventoryProductionRoutes(
        operation.projectId,
      );
      runtimeRouteProgress(progress).runtimeRoutes = runtimeRoutes.map((route) => ({
        hostname: route.hostname,
        manifestRevision: route.manifestRevision,
        sandboxIdentity: route.sandboxIdentity,
        state: "releasing" as const,
      }));
      runtimeRouteHostnames.push(...runtimeRoutes.map((route) => route.hostname));
      await updateProgress(operation.id, progress, leaseVersion);
      const retired = await mapInBoundedBatches(runtimeRoutes, (route) =>
        routeInventoryProvider.retireObservedProductionRoute(route),
      );
      runtimeRouteProgress(progress).runtimeRoutes = runtimeRoutes.map((route, index) => ({
        hostname: route.hostname,
        manifestRevision: route.manifestRevision,
        sandboxIdentity: route.sandboxIdentity,
        state: retired[index]?.state === "absent" ? "verified_absent" : "present",
      }));
      await updateProgress(operation.id, progress, leaseVersion);
      if (retired.some((result) => result.state !== "absent")) {
        throw new ProjectRetirementStepError({
          code: "project_retirement_route_deactivation_unverified",
          target: null,
          retryable: true,
        });
      }
    } catch (error) {
      if (error instanceof ProjectRetirementStepError) throw error;
      runtimeRouteProgress(progress).runtimeRoutes = (
        runtimeRouteProgress(progress).runtimeRoutes ?? []
      ).map((route) => ({
        ...route,
        state: route.state === "verified_absent" ? route.state : ("unavailable" as const),
      }));
      await updateProgress(operation.id, progress, leaseVersion);
      throw new ProjectRetirementStepError({
        code: "project_retirement_route_deactivation_failed",
        target: null,
        retryable: true,
      });
    }
  }

  if (project.publishedSnapshotId !== null) {
    const [version] = await db
      .select({ productionRelease: projectVersionsTable.productionRelease })
      .from(projectVersionsTable)
      .where(eq(projectVersionsTable.id, project.publishedSnapshotId))
      .limit(1);
    const release = version?.productionRelease as ProductionArtifactRelease | null | undefined;
    if (!release && project.builderMode === "agentic" && !routeInventoryProvider) {
      throw new ProjectRetirementStepError({
        code: "project_retirement_route_deactivation_unverified",
        target: null,
        retryable: true,
      });
    }
    if (release) {
      if (!supportsProductionArtifactPromotion(tenantRuntimeProvider)) {
        throw new ProjectRetirementStepError({
          code: "project_retirement_operation_unavailable",
          target: null,
          retryable: true,
        });
      }
      try {
        await tenantRuntimeProvider.rollbackProductionArtifactActivation({
          activatedRelease: release,
          previousRelease: null,
        });
      } catch (error) {
        if (!isProviderNotFound(error)) {
          throw new ProjectRetirementStepError({
            code: "project_retirement_route_deactivation_failed",
            target: null,
            retryable: true,
          });
        }
      }
    }
  }

  const cachePurged = await purgeCacheForHostnames(
    projectRetirementCacheHostnames({
      knownHostnames,
      legacyKvHostnames: kvHostnames,
      runtimeRouteHostnames,
    }),
  );
  if (!cachePurged) {
    progress.route.state = "failed";
    progress.route.cache = { state: "failed" };
    progress.route.failureCode = "project_retirement_route_deactivation_unverified";
    await updateProgress(operation.id, progress, leaseVersion);
    throw new ProjectRetirementStepError({
      code: "project_retirement_route_deactivation_unverified",
      target: null,
      retryable: true,
    });
  }
  const verifiedRuntimeRoutes = runtimeRouteProgress(progress).runtimeRoutes ?? [];
  const verifiedLegacyHostnameKv = progress.route.legacyHostnameKv;
  progress.route = {
    state: "verified_absent",
    failureCode: null,
    legacyHostnameKv: verifiedLegacyHostnameKv,
    hostnames: progress.route.hostnames,
    cache: { state: "purged" },
  };
  runtimeRouteProgress(progress).runtimeRoutes = verifiedRuntimeRoutes;
  await updateProgress(operation.id, progress, leaseVersion);
}

function securityResourceKey(resource: CloudflareSecurityResourceReceipt): string {
  return `${resource.kind}:${resource.rulesetId ?? ""}:${resource.id}`;
}

async function retireLegacyCdnObjects(
  operation: ProjectRetirementOperation,
  progress: ProjectRetirementProgress,
  leaseVersion: number,
): Promise<void> {
  progress.legacyR2 ??= {
    state: "pending",
    discoveredCount: 0,
    deletedCount: 0,
    failureCode: null,
  };
  if (
    progress.legacyR2.state === "verified_absent" ||
    progress.legacyR2.state === "not_configured"
  ) {
    return;
  }

  progress.legacyR2.state = "deleting";
  progress.legacyR2.failureCode = null;
  await updateProgress(operation.id, progress, leaseVersion);

  const outcome = await retireLegacyR2ProjectPrefix(operation.projectId);
  progress.legacyR2.discoveredCount = outcome.discoveredCount;
  progress.legacyR2.deletedCount = outcome.deletedCount;
  if (outcome.state === "not_configured") {
    progress.legacyR2.state = "not_configured";
    await updateProgress(operation.id, progress, leaseVersion);
    return;
  }
  if (outcome.state === "absent") {
    progress.legacyR2.state = "verified_absent";
    await updateProgress(operation.id, progress, leaseVersion);
    return;
  }

  const code =
    outcome.stage === "delete"
      ? "project_retirement_legacy_r2_release_failed"
      : "project_retirement_legacy_r2_release_unverified";
  progress.legacyR2.state = "failed";
  progress.legacyR2.failureCode = code;
  await updateProgress(operation.id, progress, leaseVersion);
  throw new ProjectRetirementStepError({ code, target: null, retryable: true });
}

async function releaseTrackedDomainSecurityResources(
  operation: ProjectRetirementOperation,
  progress: ProjectRetirementProgress,
  leaseVersion: number,
): Promise<void> {
  const domains = await db
    .select({
      id: projectDomainsTable.id,
      hostname: projectDomainsTable.hostname,
      cfHostnameId: projectDomainsTable.cfHostnameId,
      securityConfig: projectDomainsTable.securityConfig,
    })
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.projectId, operation.projectId));

  // The legacy projects.custom_domain surface has no security_config column.
  // Include it as a synthetic discovery target when no project_domains row
  // shadows the hostname, so its deterministic WAF resources cannot escape.
  const [legacyProject] = await db
    .select({
      hostname: projectsTable.customDomain,
      cfHostnameId: projectsTable.cfHostnameId,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, operation.projectId))
    .limit(1);
  const securityDomains: Array<{
    id: number | null;
    hostname: string;
    cfHostnameId: string | null;
    securityConfig: DomainSecurityConfig | null;
  }> = [
    ...domains,
    ...(legacyProject?.hostname &&
    !domains.some((domain) => domain.hostname === legacyProject.hostname)
      ? [
          {
            id: null,
            hostname: legacyProject.hostname,
            cfHostnameId: legacyProject.cfHostnameId,
            securityConfig: null,
          },
        ]
      : []),
  ];

  progress.securityResources ??= [];
  const discoveries = await mapInBoundedBatches(securityDomains, (domain) =>
    discoverCloudflareSecurityResources({
      hostname: domain.hostname,
      cfHostnameId: domain.cfHostnameId,
      config: (domain.securityConfig ?? {}) as DomainSecurityConfig,
      existing: domain.securityConfig?.cloudflareResources ?? [],
    }),
  );
  const discoveredConfigs = securityDomains.map((domain, index) => {
    const resources = discoveries[index]!.resources;
    const securityConfig: DomainSecurityConfig = {
      ...((domain.securityConfig ?? {}) as DomainSecurityConfig),
      cloudflareResources: resources,
    };
    for (const resource of resources) {
      if (
        !progress.securityResources!.some(
          (receipt) =>
            receipt.kind === resource.kind &&
            receipt.providerId === resource.id &&
            receipt.rulesetId === (resource.rulesetId ?? null),
        )
      ) {
        progress.securityResources!.push({
          domainId: domain.id,
          hostname: domain.hostname,
          kind: resource.kind,
          providerId: resource.id,
          rulesetId: resource.rulesetId ?? null,
          ref: resource.ref,
          state: "pending",
          failureCode: null,
        });
      }
    }
    return { domain, securityConfig };
  });
  await db.transaction(async (tx) => {
    for (const discovered of discoveredConfigs) {
      if (discovered.domain.id === null) {
        discovered.domain.securityConfig = discovered.securityConfig;
        continue;
      }
      const persisted = await tx
        .update(projectDomainsTable)
        .set({ securityConfig: discovered.securityConfig, updatedAt: sql`now()` })
        .where(
          and(
            eq(projectDomainsTable.id, discovered.domain.id),
            eq(projectDomainsTable.projectId, operation.projectId),
          ),
        )
        .returning({ id: projectDomainsTable.id });
      if (persisted.length !== 1) throw new ProjectRetirementLeaseLostError();
      discovered.domain.securityConfig = discovered.securityConfig;
    }
    const fenced = await tx
      .update(projectRetirementOperationsTable)
      .set({
        progress,
        leaseExpiresAt: sql`now() + interval '${sql.raw(
          String(PROJECT_RETIREMENT_LEASE_MINUTES),
        )} minutes'`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projectRetirementOperationsTable.id, operation.id),
          eq(projectRetirementOperationsTable.state, "running"),
          eq(projectRetirementOperationsTable.leaseVersion, leaseVersion),
        ),
      )
      .returning({ id: projectRetirementOperationsTable.id });
    if (fenced.length !== 1) throw new ProjectRetirementLeaseLostError();
  });
  if (discoveries.some((discovery) => discovery.state !== "complete")) {
    throw new ProjectRetirementStepError({
      code: "project_retirement_domain_security_release_unverified",
      target: null,
      retryable: true,
    });
  }

  const targets = new Map<
    string,
    {
      resource: CloudflareSecurityResourceReceipt;
      domains: Array<{
        id: number | null;
        hostname: string;
        securityConfig: DomainSecurityConfig;
      }>;
    }
  >();
  for (const domain of securityDomains) {
    const securityConfig = (domain.securityConfig ?? {}) as DomainSecurityConfig;
    for (const resource of securityConfig.cloudflareResources ?? []) {
      const key = securityResourceKey(resource);
      const target = targets.get(key) ?? { resource, domains: [] };
      if (!target.domains.some((candidate) => candidate.id === domain.id)) {
        target.domains.push({ id: domain.id, hostname: domain.hostname, securityConfig });
      }
      targets.set(key, target);
    }
  }

  const orderedTargets = [...targets.values()].sort((left, right) => {
    const rank = (kind: CloudflareSecurityResourceReceipt["kind"]): number =>
      kind === "firewall_rule" ? 0 : kind === "firewall_filter" ? 2 : 1;
    return rank(left.resource.kind) - rank(right.resource.kind);
  });
  for (const target of orderedTargets) {
    const key = securityResourceKey(target.resource);
    let receipt = progress.securityResources.find(
      (entry) =>
        entry.kind === target.resource.kind &&
        entry.providerId === target.resource.id &&
        entry.rulesetId === (target.resource.rulesetId ?? null),
    );
    if (!receipt) {
      const firstDomain = target.domains[0]!;
      receipt = {
        domainId: firstDomain.id,
        hostname: firstDomain.hostname,
        kind: target.resource.kind,
        providerId: target.resource.id,
        rulesetId: target.resource.rulesetId ?? null,
        ref: target.resource.ref,
        state: "pending",
        failureCode: null,
      };
      progress.securityResources.push(receipt);
    }
    receipt.state = "releasing";
    receipt.failureCode = null;
    await updateProgress(operation.id, progress, leaseVersion);

    const outcome = await retireCloudflareSecurityResource(target.resource);
    if (outcome.state !== "absent") {
      const code =
        outcome.state === "unavailable" && outcome.stage === "delete"
          ? "project_retirement_domain_security_release_failed"
          : "project_retirement_domain_security_release_unverified";
      receipt.state = "failed";
      receipt.failureCode = code;
      await updateProgress(operation.id, progress, leaseVersion);
      throw new ProjectRetirementStepError({ code, target: null, retryable: true });
    }

    receipt.state = "verified_absent";
    receipt.failureCode = null;
    const nextConfigs = target.domains.map((domain) => ({
      domain,
      value: {
        ...domain.securityConfig,
        cloudflareResources: (domain.securityConfig.cloudflareResources ?? []).filter(
          (resource) => securityResourceKey(resource) !== key,
        ),
      } satisfies DomainSecurityConfig,
    }));
    await db.transaction(async (tx) => {
      for (const next of nextConfigs) {
        if (next.domain.id === null) continue;
        const cleared = await tx
          .update(projectDomainsTable)
          .set({ securityConfig: next.value, updatedAt: sql`now()` })
          .where(
            and(
              eq(projectDomainsTable.id, next.domain.id),
              eq(projectDomainsTable.projectId, operation.projectId),
            ),
          )
          .returning({ id: projectDomainsTable.id });
        if (cleared.length !== 1) throw new ProjectRetirementLeaseLostError();
      }
      const fenced = await tx
        .update(projectRetirementOperationsTable)
        .set({
          progress,
          leaseExpiresAt: sql`now() + interval '${sql.raw(
            String(PROJECT_RETIREMENT_LEASE_MINUTES),
          )} minutes'`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(projectRetirementOperationsTable.id, operation.id),
            eq(projectRetirementOperationsTable.state, "running"),
            eq(projectRetirementOperationsTable.leaseVersion, leaseVersion),
          ),
        )
        .returning({ id: projectRetirementOperationsTable.id });
      if (fenced.length !== 1) throw new ProjectRetirementLeaseLostError();
    });
    for (const next of nextConfigs) Object.assign(next.domain.securityConfig, next.value);
  }
}

async function releaseCustomHostnameCertificates(
  operation: ProjectRetirementOperation,
  progress: ProjectRetirementProgress,
  leaseVersion: number,
): Promise<void> {
  const [project] = await db
    .select({
      customDomain: projectsTable.customDomain,
      cfHostnameId: projectsTable.cfHostnameId,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, operation.projectId))
    .limit(1);
  if (!project) {
    throw new ProjectRetirementStepError({
      code: "project_retirement_operation_unavailable",
      target: null,
      retryable: false,
    });
  }
  const domains = await db
    .select({
      id: projectDomainsTable.id,
      hostname: projectDomainsTable.hostname,
      cfHostnameId: projectDomainsTable.cfHostnameId,
    })
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.projectId, operation.projectId));

  // Repair the old two-write crash window deterministically: the previous
  // implementation only nulled a row after strict provider absence, so a null
  // pointer with a non-terminal legacy receipt is sufficient proof to finish it.
  let repairedLegacyReceipt = false;
  for (const receipt of progress.domains ?? []) {
    const domain = domains.find((candidate) => candidate.id === receipt.domainId);
    if (domain && !domain.cfHostnameId && receipt.state !== "verified_absent") {
      receipt.state = "verified_absent";
      receipt.failureCode = null;
      repairedLegacyReceipt = true;
    }
  }
  if (repairedLegacyReceipt) await updateProgress(operation.id, progress, leaseVersion);

  const planned = planHostnameCertificateRetirements({
    legacyProject: { cfHostnameId: project.cfHostnameId, hostname: project.customDomain },
    domains,
  });
  const hostnameInventory = await inventoryCustomHostnamesByHostname([
    ...new Set(
      [project.customDomain, ...domains.map((domain) => domain.hostname)].filter(
        (hostname): hostname is string => Boolean(hostname),
      ),
    ),
  ]);
  if (hostnameInventory.state !== "complete") {
    throw new ProjectRetirementStepError({
      code: "project_retirement_domain_release_unverified",
      target: null,
      retryable: true,
    });
  }
  for (const match of hostnameInventory.matches) {
    const knownTarget = planned.find((target) => target.cfHostnameId === match.id);
    if (knownTarget) {
      if (!knownTarget.hostnames.includes(match.hostname))
        knownTarget.hostnames.push(match.hostname);
      continue;
    }
    planned.push({
      cfHostnameId: match.id,
      hostnames: [match.hostname],
      projectDomainIds: [],
      legacyProjectPointer: false,
    });
  }

  progress.hostnameCertificates ??= [];
  progress.domains ??= [];
  for (const target of planned) {
    const { cfHostnameId } = target;
    let receipt = progress.hostnameCertificates.find(
      (entry) => entry.cfHostnameId === cfHostnameId,
    );
    if (!receipt) {
      receipt = {
        cfHostnameId,
        hostnames: target.hostnames,
        projectDomainIds: [...target.projectDomainIds],
        legacyProjectPointer: target.legacyProjectPointer,
        state: "pending",
        failureCode: null,
      };
      progress.hostnameCertificates.push(receipt);
    }
    for (const domainId of target.projectDomainIds) {
      const domain = domains.find((candidate) => candidate.id === domainId)!;
      if (!progress.domains.some((entry) => entry.domainId === domainId)) {
        progress.domains.push({
          domainId,
          hostname: domain.hostname,
          state: "pending",
          failureCode: null,
        });
      }
    }
    receipt.state = "releasing";
    receipt.failureCode = null;
    for (const domainReceipt of progress.domains) {
      if (
        domainReceipt.domainId !== null &&
        target.projectDomainIds.includes(domainReceipt.domainId)
      ) {
        domainReceipt.state = "releasing";
        domainReceipt.failureCode = null;
      }
    }
    await updateProgress(operation.id, progress, leaseVersion);

    const outcome = await retireCustomHostname(cfHostnameId);
    if (outcome.state !== "absent") {
      const code =
        outcome.state === "unavailable" && outcome.stage === "delete"
          ? "project_retirement_domain_release_failed"
          : "project_retirement_domain_release_unverified";
      receipt.state = "failed";
      receipt.failureCode = code;
      for (const domainReceipt of progress.domains) {
        if (
          domainReceipt.domainId !== null &&
          target.projectDomainIds.includes(domainReceipt.domainId)
        ) {
          domainReceipt.state = "failed";
          domainReceipt.failureCode = code;
        }
      }
      await updateProgress(operation.id, progress, leaseVersion);
      throw new ProjectRetirementStepError({ code, target: null, retryable: true });
    }

    receipt.state = "verified_absent";
    receipt.failureCode = null;
    for (const domainReceipt of progress.domains) {
      if (
        domainReceipt.domainId !== null &&
        target.projectDomainIds.includes(domainReceipt.domainId)
      ) {
        domainReceipt.state = "verified_absent";
        domainReceipt.failureCode = null;
      }
    }
    await db.transaction(async (tx) => {
      if (target.projectDomainIds.length > 0) {
        const cleared = await tx
          .update(projectDomainsTable)
          .set({
            cfHostnameId: null,
            sslStatus: "pending",
            sslLastCheckedAt: null,
            sslExpiresAt: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(projectDomainsTable.projectId, operation.projectId),
              eq(projectDomainsTable.cfHostnameId, cfHostnameId),
            ),
          )
          .returning({ id: projectDomainsTable.id });
        if (cleared.length !== target.projectDomainIds.length) {
          throw new ProjectRetirementLeaseLostError();
        }
      }
      if (target.legacyProjectPointer) {
        const cleared = await tx
          .update(projectsTable)
          .set({
            cfHostnameId: null,
            sslStatus: "pending",
            sslVerifiedAt: null,
            sslError: null,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(projectsTable.id, operation.projectId),
              eq(projectsTable.cfHostnameId, cfHostnameId),
            ),
          )
          .returning({ id: projectsTable.id });
        if (cleared.length !== 1) throw new ProjectRetirementLeaseLostError();
      }
      const fenced = await tx
        .update(projectRetirementOperationsTable)
        .set({
          progress,
          leaseExpiresAt: sql`now() + interval '${sql.raw(
            String(PROJECT_RETIREMENT_LEASE_MINUTES),
          )} minutes'`,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(projectRetirementOperationsTable.id, operation.id),
            eq(projectRetirementOperationsTable.state, "running"),
            eq(projectRetirementOperationsTable.leaseVersion, leaseVersion),
          ),
        )
        .returning({ id: projectRetirementOperationsTable.id });
      if (fenced.length !== 1) throw new ProjectRetirementLeaseLostError();
    });
  }
}

async function retainPurchasedDomainAssignments(
  operation: ProjectRetirementOperation,
  progress: ProjectRetirementProgress,
  leaseVersion: number,
): Promise<void> {
  const domains = await db
    .select({ id: purchasedDomainsTable.id, hostname: purchasedDomainsTable.hostname })
    .from(purchasedDomainsTable)
    .where(eq(purchasedDomainsTable.projectId, operation.projectId));
  if (domains.length === 0) return;
  const associations = await db
    .select({ id: projectDomainsTable.id, hostname: projectDomainsTable.hostname })
    .from(projectDomainsTable)
    .where(
      and(
        eq(projectDomainsTable.projectId, operation.projectId),
        inArray(
          projectDomainsTable.hostname,
          domains.map((domain) => domain.hostname),
        ),
      ),
    );
  const associationByHostname = new Map(
    associations.map((association) => [association.hostname, association.id]),
  );
  progress.purchasedDomains ??= [];
  const purchasedReceipts = progress.purchasedDomains as Array<
    NonNullable<ProjectRetirementProgress["purchasedDomains"]>[number] & {
      projectDomainId?: number | null;
    }
  >;
  for (const domain of domains) {
    const existing = purchasedReceipts.find((entry) => entry.purchasedDomainId === domain.id);
    if (!existing) {
      purchasedReceipts.push({
        purchasedDomainId: domain.id,
        projectDomainId: associationByHostname.get(domain.hostname) ?? null,
        hostname: domain.hostname,
        state: "pending",
      });
    } else if (existing.projectDomainId === undefined) {
      existing.projectDomainId = associationByHostname.get(domain.hostname) ?? null;
    }
  }
  await updateProgress(operation.id, progress, leaseVersion);
  // Trash is recoverable. Registration ownership, billing, the project
  // assignment, and its project_domains configuration therefore remain intact.
  // Public serving is already disabled and absence-proven by the preceding
  // route/certificate steps. Permanent deletion owns the later detach policy.
  for (const receipt of purchasedReceipts) receipt.state = "retained";
  await updateProgress(operation.id, progress, leaseVersion);
}

async function destroyRuntimeTargets(
  operation: ProjectRetirementOperation,
  progress: ProjectRetirementProgress,
  leaseVersion: number,
): Promise<{
  clearContainerPointer: boolean;
  clearProductionPointer: boolean;
}> {
  const namespace = process.env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE;
  if (!namespace) {
    throw new ProjectRetirementStepError({
      code: "project_retirement_operation_unavailable",
      target: null,
      retryable: true,
    });
  }

  const [project] = await db
    .select({
      containerId: projectsTable.containerId,
      prodContainerId: projectsTable.prodContainerId,
      testContainerId: projectsTable.testContainerId,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, operation.projectId));
  if (!project) {
    throw new ProjectRetirementStepError({
      code: "project_retirement_operation_unavailable",
      target: null,
      retryable: false,
    });
  }

  progress.retainedLegacyRuntimePointers ??= [];
  let clearContainerPointer = project.containerId === null;
  let clearProductionPointer = project.prodContainerId === null;
  // testContainerId belongs to the historical Fly-backed testing workflow. It
  // is not a Cloudflare preview identity and must never be sent to the current
  // tenant-runtime provider or silently cleared. Retain it as explicit typed
  // evidence so cleanup cannot complete until a separately governed Fly path
  // has preserved any SQLite data and proven the machine absent.
  if (
    project.testContainerId &&
    !progress.retainedLegacyRuntimePointers.some((item) => item.pointer === "testContainerId")
  ) {
    progress.retainedLegacyRuntimePointers.push({
      pointer: "testContainerId",
      identity: project.testContainerId,
      reason: "legacy_runtime_provider",
    });
    await updateProgress(operation.id, progress, leaseVersion);
  }
  for (const stored of [
    { pointer: "containerId" as const, identity: project.containerId },
    { pointer: "prodContainerId" as const, identity: project.prodContainerId },
  ]) {
    if (!stored.identity) continue;
    const classification = await classifyStoredRuntimePointer({
      identity: stored.identity,
      namespace,
      projectId: operation.projectId,
      pointer: stored.pointer,
    });
    if (classification.state === "valid") {
      if (stored.pointer === "containerId") clearContainerPointer = true;
      else clearProductionPointer = true;
      continue;
    }
    if (!progress.retainedLegacyRuntimePointers.some((item) => item.pointer === stored.pointer)) {
      progress.retainedLegacyRuntimePointers.push({
        pointer: stored.pointer,
        identity: stored.identity,
        reason: classification.reason,
      });
    }
  }
  await updateProgress(operation.id, progress, leaseVersion);

  for (const runtime of progress.runtimes) {
    if (runtime.state === "verified_absent") continue;
    runtime.state = "destroying";
    runtime.attempts += 1;
    runtime.failureCode = null;
    await updateProgress(operation.id, progress, leaseVersion);
    const target = { role: runtime.role, slot: runtime.slot } as ProjectRetirementRuntimeTarget;
    const runtimeId = await deriveRuntimeIdentity({
      namespace,
      projectId: operation.projectId,
      role: runtime.role,
      slot: runtime.slot,
    });
    try {
      await tenantRuntimeProvider.destroy(runtimeId, operation.projectId, {
        operationTimeoutMs: 60_000,
      });
    } catch (error) {
      if (!isProviderNotFound(error)) {
        runtime.state = "failed";
        runtime.failureCode = "project_retirement_runtime_destroy_failed";
        await updateProgress(operation.id, progress, leaseVersion);
        throw new ProjectRetirementStepError({
          code: "project_retirement_runtime_destroy_failed",
          target,
          retryable: true,
        });
      }
    }
    try {
      await tenantRuntimeProvider.status(runtimeId);
      throw new ProjectRetirementStepError({
        code: "project_retirement_runtime_destroy_unverified",
        target,
        retryable: true,
      });
    } catch (error) {
      if (error instanceof ProjectRetirementStepError) throw error;
      if (!isProviderNotFound(error)) {
        runtime.state = "failed";
        runtime.failureCode = "project_retirement_runtime_destroy_unverified";
        await updateProgress(operation.id, progress, leaseVersion);
        throw new ProjectRetirementStepError({
          code: "project_retirement_runtime_destroy_unverified",
          target,
          retryable: true,
        });
      }
    }
    runtime.state = "verified_absent";
    runtime.failureCode = null;
    await updateProgress(operation.id, progress, leaseVersion);
  }
  return { clearContainerPointer, clearProductionPointer };
}

export async function enqueueProjectRetirementOperation(
  operationId: string,
): Promise<string | null> {
  if (!isDurableWorkerReady(QUEUE_PROJECT_RETIREMENT)) return null;
  const outcome = await durableEnqueueRawResult(
    QUEUE_PROJECT_RETIREMENT,
    { operationId },
    operationId,
    {
      retryLimit: PROJECT_RETIREMENT_MAX_ATTEMPTS - 1,
      retryDelay: 30,
      retryBackoff: true,
      dedupeMode: "active",
    },
  );
  if (outcome.status === "enqueued") return outcome.jobId;
  // An active duplicate means cleanup is already scheduled. The operation id is
  // the stable receipt identity; callers must not turn suppression into a false 503.
  if (outcome.status === "duplicate") return operationId;
  return null;
}

export type ProjectRetirementReconciliationRequest =
  | AcceptedProjectRetirement
  | {
      code:
        | "project_retirement_not_found"
        | "project_retirement_not_terminal"
        | "project_retirement_retry_not_allowed"
        | "project_retirement_reconciliation_limit_reached";
    };

type ReconciliableRetirementProgress = ProjectRetirementProgress & {
  reconciliation?: {
    generation: number;
    parentOperationId: string;
    requestedBy: string;
    reason: "retryable_terminal" | "legacy_admin_reconciliation";
  };
};

/**
 * Mint a fresh bounded operation after a terminal cleanup failure. Each
 * operation still has its four-attempt cap; at most two explicit generations
 * can follow it, preventing both permanent stranding and infinite retries.
 */
export async function requestProjectRetirementReconciliation(input: {
  projectId: number;
  requestedBy: string;
  ownerId?: string;
  allowLegacyAdminReconciliation: boolean;
}): Promise<ProjectRetirementReconciliationRequest> {
  const operationId = crypto.randomUUID();
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${input.projectId})`,
    );
    const projectPredicates = [
      eq(projectsTable.id, input.projectId),
      isNotNull(projectsTable.deletedAt),
      ...(input.ownerId ? [eq(projectsTable.ownerId, input.ownerId)] : []),
    ];
    const [project] = await tx
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(and(...projectPredicates))
      .limit(1);
    if (!project) return { code: "project_retirement_not_found" as const };

    const [latest] = await tx
      .select()
      .from(projectRetirementOperationsTable)
      .where(eq(projectRetirementOperationsTable.projectId, input.projectId))
      .orderBy(desc(projectRetirementOperationsTable.createdAt))
      .limit(1);
    if (!latest) return { code: "project_retirement_not_found" as const };
    const latestProgress = latest.progress as ReconciliableRetirementProgress;
    const generation = latestProgress.reconciliation?.generation ?? 0;
    const decision = decideProjectRetirementReconciliation({
      state: latest.state,
      completedAt: latest.completedAt,
      failureCode: latest.failureCode,
      generation,
      allowLegacyAdminReconciliation: input.allowLegacyAdminReconciliation,
    });
    if (!decision.allowed) return { code: decision.code };

    const progress = initialProjectRetirementProgress() as ReconciliableRetirementProgress;
    progress.reconciliation = {
      generation: generation + 1,
      parentOperationId: latest.id,
      requestedBy: input.requestedBy,
      reason: decision.reason,
    };
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

export async function runProjectRetirementOperation(operationId: string): Promise<void> {
  const [candidate] = await db
    .select({ projectId: projectRetirementOperationsTable.projectId })
    .from(projectRetirementOperationsTable)
    .where(eq(projectRetirementOperationsTable.id, operationId))
    .limit(1);
  if (!candidate) return;

  const claimed = await db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(${PROJECT_LIFECYCLE_LOCK_NAMESPACE}, ${candidate.projectId})`,
    );
    const [operation] = await tx
      .update(projectRetirementOperationsTable)
      .set({
        state: "running",
        attemptCount: sql`${projectRetirementOperationsTable.attemptCount} + 1`,
        leaseVersion: sql`${projectRetirementOperationsTable.leaseVersion} + 1`,
        leaseExpiresAt: sql`now() + interval '${sql.raw(String(PROJECT_RETIREMENT_LEASE_MINUTES))} minutes'`,
        startedAt: sql`COALESCE(${projectRetirementOperationsTable.startedAt}, now())`,
        failureCode: null,
        failureTarget: null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projectRetirementOperationsTable.id, operationId),
          or(
            eq(projectRetirementOperationsTable.state, "accepted"),
            and(
              eq(projectRetirementOperationsTable.state, "failed"),
              isNull(projectRetirementOperationsTable.completedAt),
            ),
            and(
              eq(projectRetirementOperationsTable.state, "running"),
              or(
                isNull(projectRetirementOperationsTable.leaseExpiresAt),
                lt(projectRetirementOperationsTable.leaseExpiresAt, sql`now()`),
              ),
            ),
          ),
          lt(projectRetirementOperationsTable.attemptCount, PROJECT_RETIREMENT_MAX_ATTEMPTS),
        ),
      )
      .returning();
    if (!operation) return null;
    const [project] = await tx
      .select({ deletedAt: projectsTable.deletedAt })
      .from(projectsTable)
      .where(eq(projectsTable.id, operation.projectId));
    if (project?.deletedAt) return operation;
    await tx
      .update(projectRetirementOperationsTable)
      .set({
        state: "canceled",
        leaseExpiresAt: null,
        completedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projectRetirementOperationsTable.id, operationId),
          eq(projectRetirementOperationsTable.leaseVersion, operation.leaseVersion),
        ),
      );
    return null;
  });
  if (!claimed) return;

  const progress = claimed.progress;
  try {
    await cancelQueuedTasks(claimed, progress, claimed.leaseVersion);
    await deactivatePublishedRoutes(claimed, progress, claimed.leaseVersion);
    await retireLegacyCdnObjects(claimed, progress, claimed.leaseVersion);
    await releaseTrackedDomainSecurityResources(claimed, progress, claimed.leaseVersion);
    await releaseCustomHostnameCertificates(claimed, progress, claimed.leaseVersion);
    await retainPurchasedDomainAssignments(claimed, progress, claimed.leaseVersion);
    const pointerDisposition = await destroyRuntimeTargets(claimed, progress, claimed.leaseVersion);
    const hasRetainedLegacyPointers = progress.retainedLegacyRuntimePointers.length > 0;
    await db.transaction(async (tx) => {
      const fenced = await tx
        .update(projectRetirementOperationsTable)
        .set({
          progress,
          updatedAt: sql`now()`,
        })
        .where(
          and(
            eq(projectRetirementOperationsTable.id, operationId),
            eq(projectRetirementOperationsTable.state, "running"),
            eq(projectRetirementOperationsTable.leaseVersion, claimed.leaseVersion),
          ),
        )
        .returning({ id: projectRetirementOperationsTable.id });
      if (fenced.length !== 1) throw new ProjectRetirementLeaseLostError();
      const pointerUpdates = {
        status: "testing",
        publishedSnapshotId: null,
        stagingPublishedSnapshotId: null,
        activePreviewSessionId: null,
        domainStatus: sql`CASE
          WHEN ${projectsTable.customDomain} IS NULL THEN 'unconfigured'
          ELSE 'pending_verification'
        END`,
        sslStatus: "pending",
        sslVerifiedAt: null,
        sslError: null,
        updatedAt: sql`now()`,
        ...(pointerDisposition.clearContainerPointer
          ? { containerId: null, containerUrl: null, containerStatus: "stopped" }
          : {}),
        ...(pointerDisposition.clearProductionPointer
          ? { prodContainerId: null, prodContainerUrl: null, prodContainerStatus: "stopped" }
          : {}),
      };
      await tx
        .update(projectDomainsTable)
        .set({
          sslStatus: "pending",
          sslLastCheckedAt: null,
          sslExpiresAt: null,
          updatedAt: sql`now()`,
        })
        .where(eq(projectDomainsTable.projectId, claimed.projectId));
      await tx
        .update(projectsTable)
        .set(pointerUpdates)
        .where(
          and(eq(projectsTable.id, claimed.projectId), sql`${projectsTable.deletedAt} IS NOT NULL`),
        );
      if (!hasRetainedLegacyPointers) {
        await tx
          .update(projectRetirementOperationsTable)
          .set({
            state: "completed",
            progress,
            leaseExpiresAt: null,
            completedAt: sql`now()`,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(projectRetirementOperationsTable.id, operationId),
              eq(projectRetirementOperationsTable.state, "running"),
              eq(projectRetirementOperationsTable.leaseVersion, claimed.leaseVersion),
            ),
          );
      }
    });
    if (hasRetainedLegacyPointers) {
      throw new ProjectRetirementStepError({
        code: "project_retirement_legacy_runtime_retained",
        target: null,
        retryable: false,
      });
    }
  } catch (error) {
    if (error instanceof ProjectRetirementLeaseLostError) return;
    const receipt =
      error instanceof ProjectRetirementStepError
        ? error.receipt
        : projectRetirementFailure({
            code: "project_retirement_operation_unavailable",
            target: null,
            retryable: true,
          });
    await db
      .update(projectRetirementOperationsTable)
      .set({
        state: "failed",
        progress,
        failureCode: receipt.code,
        failureTarget: receipt.target,
        leaseExpiresAt: null,
        completedAt:
          !receipt.retryable || claimed.attemptCount >= PROJECT_RETIREMENT_MAX_ATTEMPTS
            ? sql`now()`
            : null,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projectRetirementOperationsTable.id, operationId),
          eq(projectRetirementOperationsTable.state, "running"),
          eq(projectRetirementOperationsTable.leaseVersion, claimed.leaseVersion),
        ),
      );
    logger.warn(
      { operationId, projectId: claimed.projectId, ...receipt },
      "Project retirement attempt failed",
    );
    if (receipt.retryable && claimed.attemptCount < PROJECT_RETIREMENT_MAX_ATTEMPTS) throw error;
  }
}

/**
 * Boot-time adoption for tombstones created before governed retirement existed.
 * Deterministic ids and ON CONFLICT make repeated boots a zero-write no-op.
 */
export async function adoptLegacyProjectRetirementOperations(limit = 50): Promise<number> {
  const projects = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(
      and(
        isNotNull(projectsTable.deletedAt),
        sql`NOT EXISTS (
          SELECT 1 FROM ${projectRetirementOperationsTable}
          WHERE ${projectRetirementOperationsTable.projectId} = ${projectsTable.id}
        )`,
      ),
    )
    .orderBy(projectsTable.id)
    .limit(limit);
  let created = 0;
  const planned = planLegacyProjectRetirementAdoptions({
    deletedProjectIds: projects.map((project) => project.id),
    projectsWithReceipts: new Set(),
  });
  for (const project of planned) {
    const inserted = await db
      .insert(projectRetirementOperationsTable)
      .values({
        id: project.operationId,
        projectId: project.projectId,
        requestedBy: "system:legacy-trash-reconciliation",
        state: "accepted",
        progress: initialProjectRetirementProgress(),
      })
      .onConflictDoNothing({ target: projectRetirementOperationsTable.id })
      .returning({ id: projectRetirementOperationsTable.id });
    created += inserted.length;
  }
  return created;
}

export async function resumeProjectRetirementOperations(): Promise<number> {
  await adoptLegacyProjectRetirementOperations();
  await db
    .update(projectRetirementOperationsTable)
    .set({
      state: "failed",
      failureCode: "project_retirement_attempts_exhausted",
      failureTarget: null,
      leaseExpiresAt: null,
      completedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(projectRetirementOperationsTable.state, "running"),
        or(
          isNull(projectRetirementOperationsTable.leaseExpiresAt),
          lt(projectRetirementOperationsTable.leaseExpiresAt, sql`now()`),
        ),
        sql`${projectRetirementOperationsTable.attemptCount} >= ${PROJECT_RETIREMENT_MAX_ATTEMPTS}`,
      ),
    );
  const operations = await db
    .select({ id: projectRetirementOperationsTable.id })
    .from(projectRetirementOperationsTable)
    .where(
      and(
        or(
          eq(projectRetirementOperationsTable.state, "accepted"),
          and(
            eq(projectRetirementOperationsTable.state, "failed"),
            isNull(projectRetirementOperationsTable.completedAt),
          ),
          and(
            eq(projectRetirementOperationsTable.state, "running"),
            or(
              isNull(projectRetirementOperationsTable.leaseExpiresAt),
              lt(projectRetirementOperationsTable.leaseExpiresAt, sql`now()`),
            ),
          ),
        ),
        lt(projectRetirementOperationsTable.attemptCount, PROJECT_RETIREMENT_MAX_ATTEMPTS),
      ),
    )
    .orderBy(projectRetirementOperationsTable.createdAt)
    .limit(50);
  for (const operation of operations) await enqueueProjectRetirementOperation(operation.id);
  return operations.length;
}

export async function readProjectRetirementOperation(
  projectId: number,
): Promise<ProjectRetirementOperation | null> {
  const [operation] = await db
    .select()
    .from(projectRetirementOperationsTable)
    .where(eq(projectRetirementOperationsTable.projectId, projectId))
    .orderBy(desc(projectRetirementOperationsTable.createdAt))
    .limit(1);
  return operation ?? null;
}
