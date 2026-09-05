import type { ProjectRetirementProgress } from "@workspace/db";
import {
  parseRuntimeIdentity,
  parseRuntimeIdentityForNamespace,
} from "@workspace/tenant-runtime-contracts";

export const PROJECT_LIFECYCLE_LOCK_NAMESPACE = 0x4e424a42;
export const PROJECT_RETIREMENT_MAX_ATTEMPTS = 4;
export const PROJECT_RETIREMENT_MAX_RECONCILIATIONS = 2;
export const PROJECT_RETIREMENT_LEASE_MINUTES = 10;

export const PROJECT_RETIREMENT_PREFLIGHT_REFUSAL_CODES = [
  "project_retirement_legacy_runtime_requires_migration",
  "project_retirement_managed_addon_unverified",
  "project_retirement_remote_build_in_progress",
  "project_retirement_provider_provisioning_in_progress",
  "project_retirement_provider_configuration_unavailable",
  "project_retirement_sqlite_recovery_unverified",
  "project_retirement_receipt_upgrade_in_progress",
  "project_retirement_reconciliation_required",
] as const;

export type ProjectRetirementPreflightRefusalCode =
  (typeof PROJECT_RETIREMENT_PREFLIGHT_REFUSAL_CODES)[number];

export type ProjectRetirementPreflightDecision =
  | { allowed: true }
  | { allowed: false; code: ProjectRetirementPreflightRefusalCode };

const PROJECT_RETIREMENT_PREFLIGHT_MESSAGES: Readonly<
  Record<ProjectRetirementPreflightRefusalCode, string>
> = {
  project_retirement_legacy_runtime_requires_migration:
    "This project uses an older runtime that cannot be retired safely yet.",
  project_retirement_managed_addon_unverified:
    "This project has an add-on whose safe removal cannot be verified yet.",
  project_retirement_remote_build_in_progress:
    "This project has a mobile build in progress. Wait for it to finish before moving the project to Trash.",
  project_retirement_provider_provisioning_in_progress:
    "This project is still setting up its runtime or database. Wait for setup to finish before moving it to Trash.",
  project_retirement_provider_configuration_unavailable:
    "This project's public routes cannot be retired safely right now. Please try again after platform configuration is restored.",
  project_retirement_sqlite_recovery_unverified:
    "This project's database cannot be preserved and restored safely yet.",
  project_retirement_receipt_upgrade_in_progress:
    "This project's earlier Trash cleanup is still running and must finish before its safety receipt can be upgraded.",
  project_retirement_reconciliation_required:
    "This project's Trash cleanup did not finish safely. Retry its governed cleanup before continuing.",
};

export function presentProjectRetirementPreflightRefusal(
  code: ProjectRetirementPreflightRefusalCode,
): string {
  return PROJECT_RETIREMENT_PREFLIGHT_MESSAGES[code];
}

export function decideProjectRetirementPreflight(input: {
  hasLegacyRuntime: boolean;
  hasUnverifiedManagedAddon: boolean;
  hasInFlightRemoteBuild: boolean;
  hasInFlightProviderProvisioning: boolean;
  hasUnavailableCloudflareCachePurge?: boolean;
  hasUnverifiedSqliteRecovery: boolean;
}): ProjectRetirementPreflightDecision {
  if (input.hasLegacyRuntime) {
    return { allowed: false, code: "project_retirement_legacy_runtime_requires_migration" };
  }
  if (input.hasInFlightProviderProvisioning) {
    return { allowed: false, code: "project_retirement_provider_provisioning_in_progress" };
  }
  if (input.hasUnavailableCloudflareCachePurge) {
    return {
      allowed: false,
      code: "project_retirement_provider_configuration_unavailable",
    };
  }
  if (input.hasUnverifiedSqliteRecovery) {
    return { allowed: false, code: "project_retirement_sqlite_recovery_unverified" };
  }
  if (input.hasUnverifiedManagedAddon) {
    return { allowed: false, code: "project_retirement_managed_addon_unverified" };
  }
  if (input.hasInFlightRemoteBuild) {
    return { allowed: false, code: "project_retirement_remote_build_in_progress" };
  }
  return { allowed: true };
}

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
  "project_retirement_managed_addon_release_failed",
  "project_retirement_managed_addon_release_unverified",
  "project_retirement_sqlite_snapshot_failed",
  "project_retirement_sqlite_snapshot_unverified",
  "project_retirement_runtime_destroy_failed",
  "project_retirement_runtime_destroy_unverified",
  "project_retirement_legacy_runtime_provider_unavailable",
  "project_retirement_legacy_runtime_absence_unverified",
  "project_retirement_legacy_runtime_retained",
  "project_retirement_attempts_exhausted",
  "project_retirement_completion_evidence_incomplete",
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
  "project_retirement_managed_addon_release_failed",
  "project_retirement_managed_addon_release_unverified",
  "project_retirement_sqlite_snapshot_failed",
  "project_retirement_sqlite_snapshot_unverified",
  "project_retirement_runtime_destroy_failed",
  "project_retirement_runtime_destroy_unverified",
  "project_retirement_legacy_runtime_provider_unavailable",
  "project_retirement_legacy_runtime_absence_unverified",
  "project_retirement_attempts_exhausted",
  "project_retirement_operation_unavailable",
]);

export type ProjectRetirementReconciliationDecision =
  | {
      allowed: true;
      reason: "retryable_terminal" | "legacy_admin_reconciliation" | "configuration_recovery";
    }
  | {
      allowed: false;
      code:
        | "project_retirement_not_terminal"
        | "project_retirement_retry_not_allowed"
        | "project_retirement_provider_configuration_unavailable"
        | "project_retirement_reconciliation_limit_reached";
    };

export function decideProjectRetirementReconciliation(input: {
  state: string;
  completedAt: Date | null;
  progress?: unknown;
  failureCode: string | null;
  generation: number;
  allowLegacyAdminReconciliation: boolean;
  allowConfigurationRecovery?: boolean;
  currentCloudflareCachePurgeConfigured?: boolean;
  configurationRecoveryUsed?: boolean;
}): ProjectRetirementReconciliationDecision {
  const incompleteCompletion =
    input.state === "completed" &&
    input.progress !== undefined &&
    (!hasCurrentProjectRetirementCompletionEvidence(input.progress) ||
      hasProjectRestoreReplayReceipt({ state: input.state, progress: input.progress }));
  if ((input.state !== "failed" && !incompleteCompletion) || input.completedAt == null) {
    return { allowed: false, code: "project_retirement_not_terminal" };
  }
  if (!Number.isSafeInteger(input.generation) || input.generation < 0) {
    return { allowed: false, code: "project_retirement_reconciliation_limit_reached" };
  }
  const isRouteOrCacheFailure =
    input.failureCode === "project_retirement_route_deactivation_failed" ||
    input.failureCode === "project_retirement_route_deactivation_unverified";
  if (
    (isRouteOrCacheFailure || incompleteCompletion) &&
    input.currentCloudflareCachePurgeConfigured === false
  ) {
    return { allowed: false, code: "project_retirement_provider_configuration_unavailable" };
  }
  if (input.generation >= PROJECT_RETIREMENT_MAX_RECONCILIATIONS) {
    if (
      input.state === "failed" &&
      input.generation === 3 &&
      (input.failureCode === "project_retirement_legacy_runtime_absence_unverified" ||
        input.failureCode === "project_retirement_legacy_runtime_retained") &&
      input.allowLegacyAdminReconciliation === true &&
      input.allowConfigurationRecovery === true &&
      input.currentCloudflareCachePurgeConfigured === true &&
      input.configurationRecoveryUsed === true &&
      projectRetirementVerificationRepairPointer(input.progress) !== null
    ) {
      return { allowed: true, reason: "retryable_terminal" };
    }
    if (
      isRouteOrCacheFailure &&
      input.allowConfigurationRecovery === true &&
      input.currentCloudflareCachePurgeConfigured === true &&
      input.configurationRecoveryUsed !== true
    ) {
      return { allowed: true, reason: "configuration_recovery" };
    }
    return { allowed: false, code: "project_retirement_reconciliation_limit_reached" };
  }
  // An old completed label can earn fresh evidence through the ordinary bounded
  // worker path. It never authorizes restore or grants an extra generation.
  if (incompleteCompletion) return { allowed: true, reason: "retryable_terminal" };
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

/** Exact stale-checker witness. This is admission evidence, never provider absence evidence. */
export function projectRetirementVerificationRepairPointer(
  progress: unknown,
): "containerId" | "prodContainerId" | "testContainerId" | null {
  if (!isRecord(progress) || !isRecord(progress.reconciliation)) return null;
  const metadata = progress.reconciliation;
  if (
    metadata.generation !== 3 ||
    metadata.reason !== "configuration_recovery" ||
    metadata.configurationRecoveryUsed !== true ||
    "verificationRepair" in metadata ||
    typeof metadata.parentOperationId !== "string" ||
    metadata.parentOperationId.length === 0 ||
    !Array.isArray(progress.legacyRuntimeResolutions) ||
    progress.legacyRuntimeResolutions.length !== 1 ||
    !Array.isArray(progress.retainedLegacyRuntimePointers) ||
    progress.retainedLegacyRuntimePointers.length !== 1
  )
    return null;
  const resolution = progress.legacyRuntimeResolutions[0];
  const retained = progress.retainedLegacyRuntimePointers[0];
  if (
    !isRecord(resolution) ||
    !isRecord(retained) ||
    resolution.state !== "retained" ||
    resolution.reason !== "absence_unverified" ||
    resolution.retryable !== true ||
    resolution.proof !== undefined ||
    !["containerId", "prodContainerId", "testContainerId"].includes(String(resolution.pointer)) ||
    retained.pointer !== resolution.pointer ||
    retained.reason !== "runtime_identity_malformed" ||
    typeof retained.identity !== "string" ||
    retained.identity.length === 0
  )
    return null;
  return resolution.pointer as "containerId" | "prodContainerId" | "testContainerId";
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

export const PROJECT_RETIREMENT_SEMANTICS = "project-retirement-v2" as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function hasExactCurrentRuntimeAbsenceReceipts(value: unknown): boolean {
  if (!Array.isArray(value) || value.length !== PROJECT_RETIREMENT_RUNTIME_TARGETS.length) {
    return false;
  }
  const expected = new Set(
    PROJECT_RETIREMENT_RUNTIME_TARGETS.map((target) => `${target.role}:${target.slot}`),
  );
  const observed = new Set<string>();
  for (const entry of value) {
    if (
      !isRecord(entry) ||
      entry.state !== "verified_absent" ||
      entry.failureCode !== null ||
      !isNonnegativeInteger(entry.attempts) ||
      typeof entry.role !== "string" ||
      typeof entry.slot !== "string"
    ) {
      return false;
    }
    observed.add(`${entry.role}:${entry.slot}`);
  }
  return observed.size === expected.size && [...observed].every((target) => expected.has(target));
}

/**
 * Validate the complete current absence receipt. Merely carrying a terminal
 * state is insufficient: old or truncated JSONB receipts fail closed.
 */
export function hasCurrentProjectRetirementCompletionEvidence(progress: unknown): boolean {
  if (!isRecord(progress) || progress.semantics !== PROJECT_RETIREMENT_SEMANTICS) return false;

  const route = progress.route;
  if (!isRecord(route) || route.state !== "verified_absent" || route.failureCode !== null) {
    return false;
  }
  const legacyHostnameKv = route.legacyHostnameKv;
  if (
    !isRecord(legacyHostnameKv) ||
    !["not_configured", "verified_absent"].includes(String(legacyHostnameKv.state)) ||
    legacyHostnameKv.failureCode !== null ||
    !Array.isArray(route.hostnames) ||
    !route.hostnames.every(
      (receipt) => isRecord(receipt) && receipt.state === "absent" && receipt.stage === null,
    ) ||
    !Array.isArray(route.runtimeRoutes) ||
    !route.runtimeRoutes.every(
      (receipt) => isRecord(receipt) && receipt.state === "verified_absent",
    ) ||
    !isRecord(route.cache) ||
    route.cache.state !== "purged"
  ) {
    return false;
  }

  const tasks = progress.tasks;
  if (
    !isRecord(tasks) ||
    tasks.state !== "canceled" ||
    !["count", "terminalized", "creditsRefunded", "telemetryFlushed"].every((field) =>
      isNonnegativeInteger(tasks[field]),
    )
  ) {
    return false;
  }

  const access = progress.access;
  if (
    !isRecord(access) ||
    access.state !== "revoked" ||
    ![
      "shareLinksRevoked",
      "previewSessionsRevoked",
      "supportGrantsRevoked",
      "supportSessionsInterrupted",
      "canvasShareTokensCleared",
      "canvasAbTestsEnded",
    ].every((field) => isNonnegativeInteger(access[field]))
  ) {
    return false;
  }

  const legacyR2 = progress.legacyR2;
  if (
    !isRecord(legacyR2) ||
    !["not_configured", "verified_absent"].includes(String(legacyR2.state)) ||
    legacyR2.failureCode !== null ||
    !isNonnegativeInteger(legacyR2.discoveredCount) ||
    !isNonnegativeInteger(legacyR2.deletedCount) ||
    legacyR2.discoveredCount !== legacyR2.deletedCount
  ) {
    return false;
  }

  const managedAddons = progress.managedAddons;
  if (
    !isRecord(managedAddons) ||
    managedAddons.state !== "verified_detached" ||
    managedAddons.failureCode !== null ||
    !isNonnegativeInteger(managedAddons.discoveredCount) ||
    !isNonnegativeInteger(managedAddons.detachedCount) ||
    !isNonnegativeInteger(managedAddons.secretsRemoved) ||
    managedAddons.bindingsRemaining !== 0 ||
    managedAddons.detachedCount !== managedAddons.discoveredCount
  ) {
    return false;
  }

  const sqliteRecovery = progress.sqliteRecovery;
  if (!isRecord(sqliteRecovery) || sqliteRecovery.failureCode !== null) return false;
  if (sqliteRecovery.state === "preserved") {
    if (
      !Number.isInteger(sqliteRecovery.snapshotId) ||
      Number(sqliteRecovery.snapshotId) <= 0 ||
      !Number.isInteger(sqliteRecovery.sizeBytes) ||
      Number(sqliteRecovery.sizeBytes) <= 0 ||
      !["inline", "object"].includes(String(sqliteRecovery.storage))
    ) {
      return false;
    }
  } else if (
    !["not_applicable", "not_present"].includes(String(sqliteRecovery.state)) ||
    sqliteRecovery.snapshotId !== null ||
    sqliteRecovery.sizeBytes !== 0 ||
    sqliteRecovery.storage !== null
  ) {
    return false;
  }

  const allTerminal = (value: unknown, terminal: string): boolean =>
    Array.isArray(value) &&
    value.every(
      (receipt) =>
        isRecord(receipt) &&
        receipt.state === terminal &&
        (!("failureCode" in receipt) || receipt.failureCode === null),
    );
  if (
    !allTerminal(progress.domains, "verified_absent") ||
    !allTerminal(progress.hostnameCertificates, "verified_absent") ||
    !allTerminal(progress.securityResources, "verified_absent") ||
    !allTerminal(progress.purchasedDomains, "retained") ||
    !Array.isArray(progress.retainedLegacyRuntimePointers) ||
    progress.retainedLegacyRuntimePointers.length !== 0 ||
    !hasExactCurrentRuntimeAbsenceReceipts(progress.runtimes)
  ) {
    return false;
  }
  return true;
}

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
export function decideProjectRestoreAdmission(input: {
  state: string | null;
  progress: unknown;
}): ProjectRestoreAdmission {
  return input.state === "completed" &&
    hasCurrentProjectRetirementCompletionEvidence(input.progress)
    ? { allowed: true }
    : { allowed: false, code: "project_retirement_cleanup_unverified" };
}

export function hasProjectRestoreReplayReceipt(input: {
  state: string | null;
  progress: unknown;
}): boolean {
  if (!decideProjectRestoreAdmission(input).allowed || !isRecord(input.progress)) return false;
  const restore = input.progress.restore;
  return (
    isRecord(restore) &&
    restore.state === "restored" &&
    typeof restore.restoredAt === "string" &&
    Number.isFinite(Date.parse(restore.restoredAt))
  );
}

export function matchesRestoredProjectControlPlaneState(project: unknown): boolean {
  if (!isRecord(project)) return false;
  return Object.entries(RESTORED_PROJECT_CONTROL_PLANE_STATE).every(
    ([field, expected]) => project[field] === expected,
  );
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
  return `project-retirement:legacy:v2:${projectId}`;
}

export function projectRetirementOperationIdForReceiptMode(input: {
  mode: ProjectRetirementReceiptMode;
  projectId: number;
  freshOperationId: string;
}): string {
  return input.mode === "adopt_legacy_tombstone"
    ? legacyProjectRetirementOperationId(input.projectId)
    : input.freshOperationId;
}

export type ProjectRetirementReceiptMode =
  | "retire_active"
  | "adopt_legacy_tombstone"
  | "reuse_in_flight"
  | "reuse_completed"
  | "replace_incompatible_terminal"
  | "refuse_incompatible_active"
  | "refuse_terminal_reconciliation_required";

export type ExistingProjectRetirementReceipt = {
  id: string;
  state: string;
  completedAt: Date | null;
  progress: unknown;
};

/**
 * Active projects always earn a fresh retirement receipt, including a project
 * that was restored after an earlier completed retirement. A legacy tombstone
 * is adopted exactly once; subsequent exact-ID requests reuse its receipt.
 */
export function decideProjectRetirementReceiptMode(input: {
  deleted: boolean;
  existingOperation: ExistingProjectRetirementReceipt | null;
}): ProjectRetirementReceiptMode {
  if (!input.deleted) return "retire_active";
  if (input.existingOperation === null) return "adopt_legacy_tombstone";
  const operation = input.existingOperation;
  const currentSemantics =
    isRecord(operation.progress) && operation.progress.semantics === PROJECT_RETIREMENT_SEMANTICS;
  const active =
    operation.state === "accepted" ||
    operation.state === "running" ||
    (operation.state === "failed" && operation.completedAt === null);
  if (active) return currentSemantics ? "reuse_in_flight" : "refuse_incompatible_active";
  if (operation.state === "failed") return "refuse_terminal_reconciliation_required";
  if (operation.state === "completed") {
    // A completed receipt that has already been used to restore the project
    // describes an earlier lifecycle. A later tombstone must earn a fresh
    // retirement and new absence proofs; it may never reuse stale evidence.
    if (hasProjectRestoreReplayReceipt({ state: operation.state, progress: operation.progress })) {
      return "refuse_terminal_reconciliation_required";
    }
    return decideProjectRestoreAdmission({ state: operation.state, progress: operation.progress })
      .allowed
      ? "reuse_completed"
      : "refuse_terminal_reconciliation_required";
  }
  // Every existing terminal tombstone needing a successor uses bounded
  // reconciliation. Batch adoption must never manufacture a new budget root.
  return "refuse_terminal_reconciliation_required";
}

export type ProjectRetirementSchedulingReceipt =
  | { state: "enqueued"; jobId: string }
  | { state: "already_scheduled" }
  | { state: "unavailable" };

export function decideProjectRetirementSchedulingReceipt(
  input:
    | { status: "enqueued"; jobId: string }
    | { status: "duplicate" }
    | { status: "unavailable" }
    | { status: "failed" },
): ProjectRetirementSchedulingReceipt {
  if (input.status === "enqueued") return { state: "enqueued", jobId: input.jobId };
  if (input.status === "duplicate") return { state: "already_scheduled" };
  return { state: "unavailable" };
}

/** One normalized hostname inventory shared by route, certificate, and security cleanup. */
export function projectRetirementProviderHostnames(
  hostnames: readonly (string | null | undefined)[],
): string[] {
  return [
    ...new Set(
      hostnames
        .filter((hostname): hostname is string => typeof hostname === "string")
        .map((hostname) => hostname.trim().toLowerCase().replace(/\.$/u, ""))
        .filter((hostname) => hostname.length > 0),
    ),
  ].sort();
}

export function projectRetirementFailure(
  input: ProjectRetirementFailure,
): ProjectRetirementFailure {
  return { ...input };
}

export function initialProjectRetirementProgress(): ProjectRetirementProgress {
  return {
    semantics: PROJECT_RETIREMENT_SEMANTICS,
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
      canvasShareTokensCleared: 0,
      canvasAbTestsEnded: 0,
    },
    legacyR2: {
      state: "pending",
      discoveredCount: 0,
      deletedCount: 0,
      failureCode: null,
    },
    managedAddons: {
      state: "pending",
      discoveredCount: 0,
      detachedCount: 0,
      secretsRemoved: 0,
      bindingsRemaining: 0,
      failureCode: null,
    },
    sqliteRecovery: {
      state: "pending",
      snapshotId: null,
      sizeBytes: 0,
      storage: null,
      failureCode: null,
    },
    domains: [],
    hostnameCertificates: [],
    securityResources: [],
    purchasedDomains: [],
    retainedLegacyRuntimePointers: [],
    legacyRuntimeResolutions: [],
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
