import type { ProjectRetirementProgress } from "@workspace/db";
import {
  parseRuntimeIdentity,
  parseRuntimeIdentityForNamespace,
} from "@workspace/tenant-runtime-contracts";

export const PROJECT_LIFECYCLE_LOCK_NAMESPACE = 0x4e424a42;
export const PROJECT_RETIREMENT_MAX_ATTEMPTS = 4;
export const PROJECT_RETIREMENT_MAX_RECONCILIATIONS = 2;
export const PROJECT_RETIREMENT_LEASE_MINUTES = 10;

export const PROJECT_RETIREMENT_TASK_STATUSES = [
  "queued",
  "answering",
  "planning",
  "building",
  "needs_review",
  "needs_fix",
  "paused-insufficient-credits",
] as const;

export const PROJECT_RETIREMENT_RUNTIME_TARGETS = [
  { role: "preview", slot: "primary" },
  { role: "production", slot: "blue" },
  { role: "production", slot: "green" },
] as const;

export type ProjectRetirementRuntimeTarget = (typeof PROJECT_RETIREMENT_RUNTIME_TARGETS)[number];

export const PROJECT_RETIREMENT_FAILURE_CODES = [
  "project_retirement_route_deactivation_failed",
  "project_retirement_route_deactivation_unverified",
  "project_retirement_domain_release_failed",
  "project_retirement_domain_release_unverified",
  "project_retirement_domain_security_release_failed",
  "project_retirement_domain_security_release_unverified",
  "project_retirement_legacy_r2_release_failed",
  "project_retirement_legacy_r2_release_unverified",
  "project_retirement_runtime_destroy_failed",
  "project_retirement_runtime_destroy_unverified",
  "project_retirement_legacy_runtime_retained",
  "project_retirement_attempts_exhausted",
  "project_retirement_operation_unavailable",
] as const;

export type ProjectRetirementFailureCode = (typeof PROJECT_RETIREMENT_FAILURE_CODES)[number];

export type ProjectRetirementFailure = {
  code: ProjectRetirementFailureCode;
  target: ProjectRetirementRuntimeTarget | null;
  retryable: boolean;
};

const RETRYABLE_TERMINAL_FAILURE_CODES = new Set<ProjectRetirementFailureCode>([
  "project_retirement_route_deactivation_failed",
  "project_retirement_route_deactivation_unverified",
  "project_retirement_domain_release_failed",
  "project_retirement_domain_release_unverified",
  "project_retirement_domain_security_release_failed",
  "project_retirement_domain_security_release_unverified",
  "project_retirement_legacy_r2_release_failed",
  "project_retirement_legacy_r2_release_unverified",
  "project_retirement_runtime_destroy_failed",
  "project_retirement_runtime_destroy_unverified",
  "project_retirement_attempts_exhausted",
  "project_retirement_operation_unavailable",
]);

export type ProjectRetirementReconciliationDecision =
  | { allowed: true; reason: "retryable_terminal" | "legacy_admin_reconciliation" }
  | {
      allowed: false;
      code:
        | "project_retirement_not_terminal"
        | "project_retirement_retry_not_allowed"
        | "project_retirement_reconciliation_limit_reached";
    };

export function decideProjectRetirementReconciliation(input: {
  state: string;
  completedAt: Date | null;
  failureCode: string | null;
  generation: number;
  allowLegacyAdminReconciliation: boolean;
}): ProjectRetirementReconciliationDecision {
  if (input.state !== "failed" || input.completedAt === null) {
    return { allowed: false, code: "project_retirement_not_terminal" };
  }
  if (input.generation >= PROJECT_RETIREMENT_MAX_RECONCILIATIONS) {
    return { allowed: false, code: "project_retirement_reconciliation_limit_reached" };
  }
  if (
    input.failureCode &&
    RETRYABLE_TERMINAL_FAILURE_CODES.has(input.failureCode as ProjectRetirementFailureCode)
  ) {
    return { allowed: true, reason: "retryable_terminal" };
  }
  if (
    input.allowLegacyAdminReconciliation &&
    input.failureCode === "project_retirement_legacy_runtime_retained"
  ) {
    return { allowed: true, reason: "legacy_admin_reconciliation" };
  }
  return { allowed: false, code: "project_retirement_retry_not_allowed" };
}

export type ProjectJobAdmission =
  | { allowed: true; projectId: number }
  | { allowed: false; projectId: number; code: "project_inactive" };

export function decideProjectJobAdmission(input: {
  projectId: number;
  activeProjectId: number | null;
}): ProjectJobAdmission {
  return input.activeProjectId === input.projectId
    ? { allowed: true, projectId: input.projectId }
    : { allowed: false, projectId: input.projectId, code: "project_inactive" };
}

export type ProjectRestoreAdmission =
  | { allowed: true }
  | { allowed: false; code: "project_retirement_cleanup_unverified" };

/**
 * A restored project keeps its source, immutable versions, database, secrets,
 * assets, and publish history, but it must not inherit any claim that a retired
 * serving surface is still live.  The route applies this closed projection set
 * atomically with clearing the tombstone.
 */
export const RESTORED_PROJECT_CONTROL_PLANE_STATE = {
  status: "draft",
  publishedSnapshotId: null,
  stagingPublishedSnapshotId: null,
  activePreviewSessionId: null,
  containerId: null,
  containerUrl: null,
  containerStatus: "stopped",
  prodContainerId: null,
  prodContainerUrl: null,
  prodContainerStatus: "stopped",
  provisioningStatus: "idle",
  provisioningError: null,
  provisioningStep: null,
  provisioningStartedAt: null,
  testContainerId: null,
  testContainerUrl: null,
  testContainerStatus: "stopped",
  runningTestSnapshotId: null,
  staticTestCandidateSnapshotId: null,
  testingCandidateSnapshotId: null,
  testingStatus: "stale",
  testedSnapshotId: null,
  previousPublishedSnapshotId: null,
  cfHostnameId: null,
  sslStatus: "pending",
  sslVerifiedAt: null,
  sslError: null,
} as const;

/** Restore is earned only by a receipt proving every cleanup step completed. */
export function decideProjectRestoreAdmission(
  latestRetirementState: string | null,
): ProjectRestoreAdmission {
  return latestRetirementState === "completed"
    ? { allowed: true }
    : { allowed: false, code: "project_retirement_cleanup_unverified" };
}

/**
 * @dormantExport The production worker currently claims with one atomic SQL predicate.
 */
export function decideProjectRetirementClaim(input: {
  state: string;
  attemptCount: number;
  leaseExpiresAt: Date | null;
  completedAt: Date | null;
  now: Date;
}): "claim" | "wait" | "terminal" {
  if (input.attemptCount >= PROJECT_RETIREMENT_MAX_ATTEMPTS) return "terminal";
  if (input.state === "accepted" || (input.state === "failed" && input.completedAt === null))
    return "claim";
  if (
    input.state === "running" &&
    (input.leaseExpiresAt === null || input.leaseExpiresAt.getTime() < input.now.getTime())
  ) {
    return "claim";
  }
  return "wait";
}

export function legacyProjectRetirementOperationId(projectId: number): string {
  return `project-retirement:legacy:v1:${projectId}`;
}

export function planLegacyProjectRetirementAdoptions(input: {
  deletedProjectIds: number[];
  projectsWithReceipts: ReadonlySet<number>;
}): Array<{ projectId: number; operationId: string }> {
  return [...new Set(input.deletedProjectIds)]
    .filter((projectId) => !input.projectsWithReceipts.has(projectId))
    .sort((left, right) => left - right)
    .map((projectId) => ({
      projectId,
      operationId: legacyProjectRetirementOperationId(projectId),
    }));
}

export function projectRetirementFailure(
  input: ProjectRetirementFailure,
): ProjectRetirementFailure {
  return { ...input };
}

export function initialProjectRetirementProgress(): ProjectRetirementProgress {
  return {
    route: {
      state: "pending",
      failureCode: null,
      hostnames: [],
      cache: { state: "pending" },
    },
    tasks: {
      state: "pending",
      count: 0,
      terminalized: 0,
      creditsRefunded: 0,
      telemetryFlushed: 0,
    },
    access: {
      state: "pending",
      shareLinksRevoked: 0,
      previewSessionsRevoked: 0,
      supportGrantsRevoked: 0,
      supportSessionsInterrupted: 0,
    },
    legacyR2: {
      state: "pending",
      discoveredCount: 0,
      deletedCount: 0,
      failureCode: null,
    },
    domains: [],
    hostnameCertificates: [],
    securityResources: [],
    purchasedDomains: [],
    retainedLegacyRuntimePointers: [],
    runtimes: PROJECT_RETIREMENT_RUNTIME_TARGETS.map((target) => ({
      ...target,
      state: "pending",
      attempts: 0,
      failureCode: null,
    })),
  };
}

export function planHostnameCertificateRetirements(input: {
  legacyProject: { cfHostnameId: string | null; hostname: string | null };
  domains: Array<{ id: number; hostname: string; cfHostnameId: string | null }>;
}): Array<{
  cfHostnameId: string;
  hostnames: string[];
  projectDomainIds: number[];
  legacyProjectPointer: boolean;
}> {
  const grouped = new Map<
    string,
    { hostnames: Set<string>; projectDomainIds: Set<number>; legacyProjectPointer: boolean }
  >();
  for (const domain of input.domains) {
    if (!domain.cfHostnameId) continue;
    const target = grouped.get(domain.cfHostnameId) ?? {
      hostnames: new Set<string>(),
      projectDomainIds: new Set<number>(),
      legacyProjectPointer: false,
    };
    target.hostnames.add(domain.hostname);
    target.projectDomainIds.add(domain.id);
    grouped.set(domain.cfHostnameId, target);
  }
  if (input.legacyProject.cfHostnameId) {
    const target = grouped.get(input.legacyProject.cfHostnameId) ?? {
      hostnames: new Set<string>(),
      projectDomainIds: new Set<number>(),
      legacyProjectPointer: false,
    };
    if (input.legacyProject.hostname) target.hostnames.add(input.legacyProject.hostname);
    target.legacyProjectPointer = true;
    grouped.set(input.legacyProject.cfHostnameId, target);
  }
  return [...grouped]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cfHostnameId, target]) => ({
      cfHostnameId,
      hostnames: [...target.hostnames].sort(),
      projectDomainIds: [...target.projectDomainIds].sort((left, right) => left - right),
      legacyProjectPointer: target.legacyProjectPointer,
    }));
}

export type StoredRuntimePointerClassification =
  | { state: "valid"; role: "preview" | "production"; slot: "primary" | "blue" | "green" }
  | {
      state: "retained_legacy";
      reason: ProjectRetirementProgress["retainedLegacyRuntimePointers"][number]["reason"];
    };

export async function classifyStoredRuntimePointer(input: {
  identity: string;
  namespace: string;
  projectId: number;
  pointer: "containerId" | "prodContainerId";
}): Promise<StoredRuntimePointerClassification> {
  let parsed: ReturnType<typeof parseRuntimeIdentity>;
  try {
    parsed = parseRuntimeIdentity(input.identity);
  } catch {
    return { state: "retained_legacy", reason: "runtime_identity_malformed" };
  }
  try {
    await parseRuntimeIdentityForNamespace(input.identity, input.namespace);
  } catch {
    return { state: "retained_legacy", reason: "runtime_namespace_mismatch" };
  }
  if (parsed.projectId !== input.projectId) {
    return { state: "retained_legacy", reason: "runtime_project_mismatch" };
  }
  const roleSlotAllowed =
    input.pointer === "containerId"
      ? parsed.role === "preview" && parsed.slot === "primary"
      : parsed.role === "production" && (parsed.slot === "blue" || parsed.slot === "green");
  if (!roleSlotAllowed) {
    return { state: "retained_legacy", reason: "runtime_role_slot_mismatch" };
  }
  return {
    state: "valid",
    role: parsed.role,
    slot: parsed.slot,
  } as StoredRuntimePointerClassification;
}

/**
 * Every known or observed hostname is a cache eviction target, even when the
 * retired legacy KV registry is intentionally absent. A removed route can
 * still have a stale Cache API entry, so route inventory alone is insufficient.
 */
export function projectRetirementCacheHostnames(input: {
  knownHostnames: readonly string[];
  legacyKvHostnames: readonly string[];
  runtimeRouteHostnames: readonly string[];
}): string[] {
  return [
    ...new Set([
      ...input.knownHostnames,
      ...input.legacyKvHostnames,
      ...input.runtimeRouteHostnames,
    ]),
  ];
}
