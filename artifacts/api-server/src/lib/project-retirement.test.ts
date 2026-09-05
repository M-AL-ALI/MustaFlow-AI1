import { describe, expect, it } from "vitest";
import { deriveRuntimeIdentity } from "@workspace/tenant-runtime-contracts";
import * as retirement from "./project-retirement-contract";

function completedRetirementProgress() {
  const progress = retirement.initialProjectRetirementProgress();
  progress.route = {
    state: "verified_absent",
    failureCode: null,
    legacyHostnameKv: { state: "not_configured", failureCode: null },
    hostnames: [],
    runtimeRoutes: [],
    cache: { state: "purged" },
  };
  progress.tasks = {
    state: "canceled",
    count: 0,
    terminalized: 0,
    creditsRefunded: 0,
    telemetryFlushed: 0,
  };
  progress.access = {
    state: "revoked",
    shareLinksRevoked: 0,
    previewSessionsRevoked: 0,
    supportGrantsRevoked: 0,
    supportSessionsInterrupted: 0,
    canvasShareTokensCleared: 0,
    canvasAbTestsEnded: 0,
  };
  progress.legacyR2 = {
    state: "not_configured",
    discoveredCount: 0,
    deletedCount: 0,
    failureCode: null,
  };
  progress.managedAddons = {
    state: "verified_detached",
    discoveredCount: 0,
    detachedCount: 0,
    secretsRemoved: 0,
    bindingsRemaining: 0,
    failureCode: null,
  };
  progress.sqliteRecovery = {
    state: "not_applicable",
    snapshotId: null,
    sizeBytes: 0,
    storage: null,
    failureCode: null,
  };
  progress.runtimes = progress.runtimes.map((runtime) => ({
    ...runtime,
    state: "verified_absent",
    failureCode: null,
  }));
  return progress;
}

describe("project retirement foundation", () => {
  it.each(["managedAddons", "sqliteRecovery"] as const)(
    "keeps missing %s fail-closed while admitting bounded fresh evidence",
    (field) => {
      const progress = { ...completedRetirementProgress() } as Record<string, unknown>;
      delete progress[field];
      const input = {
        state: "completed",
        completedAt: new Date("2026-08-31T12:00:00Z"),
        progress,
        failureCode: null,
        generation: 0,
        allowLegacyAdminReconciliation: false,
        currentCloudflareCachePurgeConfigured: true,
      };
      expect(retirement.decideProjectRestoreAdmission(input).allowed).toBe(false);
      expect(retirement.decideProjectRetirementReconciliation(input)).toEqual({
        allowed: true,
        reason: "retryable_terminal",
      });
      expect(retirement.decideProjectRetirementReconciliation({ ...input, generation: 2 })).toEqual(
        {
          allowed: false,
          code: "project_retirement_reconciliation_limit_reached",
        },
      );
      expect(
        retirement.decideProjectRetirementReconciliation({ ...input, completedAt: null }).allowed,
      ).toBe(false);
      expect(
        retirement.decideProjectRetirementReconciliation({
          ...input,
          currentCloudflareCachePurgeConfigured: false,
        }),
      ).toEqual({ allowed: false, code: "project_retirement_provider_configuration_unavailable" });
    },
  );

  it("never spends reconciliation on complete evidence or uncaps generation-three recovery", () => {
    const input = {
      state: "completed",
      completedAt: new Date(),
      progress: completedRetirementProgress(),
      failureCode: null,
      generation: 0,
      allowLegacyAdminReconciliation: true,
      allowConfigurationRecovery: true,
      currentCloudflareCachePurgeConfigured: true,
    };
    expect(retirement.decideProjectRetirementReconciliation(input).allowed).toBe(false);
    expect(
      retirement.decideProjectRetirementReconciliation({
        ...input,
        state: "failed",
        failureCode: "project_retirement_legacy_runtime_absence_unverified",
        generation: 3,
        configurationRecoveryUsed: true,
      }),
    ).toEqual({ allowed: false, code: "project_retirement_reconciliation_limit_reached" });
  });
  it("denies background work when the active-project read does not find the project", () => {
    expect(retirement.decideProjectJobAdmission({ projectId: 51, activeProjectId: null })).toEqual({
      allowed: false,
      projectId: 51,
      code: "project_inactive",
    });
  });

  it("admits background work only for the exact active project", () => {
    expect(retirement.decideProjectJobAdmission({ projectId: 51, activeProjectId: 51 })).toEqual({
      allowed: true,
      projectId: 51,
    });
    expect(
      retirement.decideProjectJobAdmission({ projectId: 51, activeProjectId: 52 }),
    ).toMatchObject({
      allowed: false,
      code: "project_inactive",
    });
  });

  it.each([null, "accepted", "running", "failed", "canceled"])(
    "refuses restore when the latest cleanup receipt is %s",
    (state) => {
      expect(
        retirement.decideProjectRestoreAdmission({
          state,
          progress: completedRetirementProgress(),
        }),
      ).toEqual({
        allowed: false,
        code: "project_retirement_cleanup_unverified",
      });
    },
  );

  it("refuses an old completed label without current complete absence evidence", () => {
    const current = completedRetirementProgress();
    const { semantics: _semantics, ...legacy } = current;
    expect(
      retirement.decideProjectRestoreAdmission({ state: "completed", progress: legacy }),
    ).toEqual({
      allowed: false,
      code: "project_retirement_cleanup_unverified",
    });
    expect(
      retirement.decideProjectRestoreAdmission({
        state: "completed",
        progress: { ...current, retainedLegacyRuntimePointers: [{ pointer: "containerId" }] },
      }),
    ).toMatchObject({ allowed: false });
  });

  it("admits restore only after every current absence proof is terminal", () => {
    expect(
      retirement.decideProjectRestoreAdmission({
        state: "completed",
        progress: completedRetirementProgress(),
      }),
    ).toEqual({ allowed: true });
  });

  it("keeps a terminal label unreachable while access evidence is pending", () => {
    const progress = completedRetirementProgress();
    progress.access = retirement.initialProjectRetirementProgress().access;
    expect(retirement.hasCurrentProjectRetirementCompletionEvidence(progress)).toBe(false);
  });

  it("recognizes only a current completed operation as a restore replay", () => {
    const progress = completedRetirementProgress();
    progress.restore = { state: "restored", restoredAt: "2026-08-31T12:00:00.000Z" };
    expect(retirement.hasProjectRestoreReplayReceipt({ state: "completed", progress })).toBe(true);
    expect(
      retirement.hasProjectRestoreReplayReceipt({
        state: "completed",
        progress: { ...progress, semantics: "older" },
      }),
    ).toBe(false);
  });

  it("restores retained project data into a truthful non-serving control-plane state", () => {
    expect(retirement.RESTORED_PROJECT_CONTROL_PLANE_STATE).toEqual({
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
    });
    expect(retirement.RESTORED_PROJECT_CONTROL_PLANE_STATE).not.toHaveProperty("publicSlug");
    expect(retirement.RESTORED_PROJECT_CONTROL_PLANE_STATE).not.toHaveProperty("customDomain");
    expect(retirement.RESTORED_PROJECT_CONTROL_PLANE_STATE).not.toHaveProperty("neonProjectId");
    expect(retirement.RESTORED_PROJECT_CONTROL_PLANE_STATE).not.toHaveProperty("dbConnectionId");
    expect(
      retirement.matchesRestoredProjectControlPlaneState({
        ...retirement.RESTORED_PROJECT_CONTROL_PLANE_STATE,
        id: 51,
        publicSlug: "stable-history",
      }),
    ).toBe(true);
    expect(
      retirement.matchesRestoredProjectControlPlaneState({
        ...retirement.RESTORED_PROJECT_CONTROL_PLANE_STATE,
        status: "published",
      }),
    ).toBe(false);
  });

  it("enumerates preview and both production slots exactly once", () => {
    expect(retirement.PROJECT_RETIREMENT_RUNTIME_TARGETS).toEqual([
      { role: "preview", slot: "primary" },
      { role: "production", slot: "blue" },
      { role: "production", slot: "green" },
    ]);
    expect(
      new Set(retirement.PROJECT_RETIREMENT_RUNTIME_TARGETS.map((target) => target.slot)).size,
    ).toBe(3);
  });

  it("carries a closed typed failure code and the failed runtime target", () => {
    const failure = retirement.projectRetirementFailure({
      code: "project_retirement_runtime_destroy_failed",
      target: { role: "production", slot: "green" },
      retryable: true,
    });
    expect(retirement.PROJECT_RETIREMENT_FAILURE_CODES).toContain(failure.code);
    expect(failure).toEqual({
      code: "project_retirement_runtime_destroy_failed",
      target: { role: "production", slot: "green" },
      retryable: true,
    });
  });

  it.each([
    "project_retirement_legacy_runtime_provider_unavailable",
    "project_retirement_legacy_runtime_absence_unverified",
  ])("allows terminal reconciliation for retryable legacy Fly failure %s", (failureCode) => {
    expect(
      retirement.decideProjectRetirementReconciliation({
        state: "failed",
        completedAt: new Date(),
        failureCode,
        generation: 0,
        allowLegacyAdminReconciliation: false,
      }),
    ).toEqual({ allowed: true, reason: "retryable_terminal" });
  });

  it("reclaims only a stale running lease after a crash and caps attempts", () => {
    const now = new Date("2026-08-30T12:00:00.000Z");
    expect(
      retirement.decideProjectRetirementClaim({
        state: "running",
        attemptCount: 1,
        leaseExpiresAt: new Date("2026-08-30T11:59:59.000Z"),
        completedAt: null,
        now,
      }),
    ).toBe("claim");
    expect(
      retirement.decideProjectRetirementClaim({
        state: "running",
        attemptCount: 1,
        leaseExpiresAt: new Date("2026-08-30T12:01:00.000Z"),
        completedAt: null,
        now,
      }),
    ).toBe("wait");
    expect(
      retirement.decideProjectRetirementClaim({
        state: "running",
        attemptCount: retirement.PROJECT_RETIREMENT_MAX_ATTEMPTS,
        leaseExpiresAt: new Date("2026-08-30T11:59:59.000Z"),
        completedAt: null,
        now,
      }),
    ).toBe("terminal");
    expect(
      retirement.decideProjectRetirementClaim({
        state: "failed",
        attemptCount: retirement.PROJECT_RETIREMENT_MAX_ATTEMPTS,
        leaseExpiresAt: null,
        completedAt: null,
        now,
      }),
    ).toBe("terminal");
    expect(
      retirement.decideProjectRetirementClaim({
        state: "failed",
        attemptCount: 1,
        leaseExpiresAt: null,
        completedAt: new Date("2026-08-30T11:00:00.000Z"),
        now,
      }),
    ).toBe("wait");
  });

  it("allows only two explicit terminal reconciliation generations", () => {
    expect(
      retirement.decideProjectRetirementReconciliation({
        state: "failed",
        completedAt: new Date(),
        failureCode: "project_retirement_attempts_exhausted",
        generation: 0,
        allowLegacyAdminReconciliation: false,
      }),
    ).toEqual({ allowed: true, reason: "retryable_terminal" });
    expect(
      retirement.decideProjectRetirementReconciliation({
        state: "failed",
        completedAt: new Date(),
        failureCode: "project_retirement_route_deactivation_failed",
        generation: 0,
        allowLegacyAdminReconciliation: false,
      }),
    ).toEqual({ allowed: true, reason: "retryable_terminal" });
    expect(
      retirement.decideProjectRetirementReconciliation({
        state: "failed",
        completedAt: new Date(),
        failureCode: "project_retirement_route_deactivation_failed",
        generation: retirement.PROJECT_RETIREMENT_MAX_RECONCILIATIONS,
        allowLegacyAdminReconciliation: true,
      }),
    ).toEqual({
      allowed: false,
      code: "project_retirement_reconciliation_limit_reached",
    });
  });

  it("permits exactly one owner-governed recovery after cache configuration is restored", () => {
    const terminal = {
      state: "failed",
      completedAt: new Date(),
      failureCode: "project_retirement_route_deactivation_unverified",
      generation: retirement.PROJECT_RETIREMENT_MAX_RECONCILIATIONS,
      allowLegacyAdminReconciliation: true,
    };
    expect(
      retirement.decideProjectRetirementReconciliation({
        ...terminal,
        allowConfigurationRecovery: true,
        currentCloudflareCachePurgeConfigured: false,
        configurationRecoveryUsed: false,
      }),
    ).toEqual({
      allowed: false,
      code: "project_retirement_provider_configuration_unavailable",
    });
    expect(
      retirement.decideProjectRetirementReconciliation({
        ...terminal,
        allowConfigurationRecovery: false,
        currentCloudflareCachePurgeConfigured: true,
        configurationRecoveryUsed: false,
      }),
    ).toEqual({
      allowed: false,
      code: "project_retirement_reconciliation_limit_reached",
    });
    expect(
      retirement.decideProjectRetirementReconciliation({
        ...terminal,
        allowConfigurationRecovery: true,
        currentCloudflareCachePurgeConfigured: true,
        configurationRecoveryUsed: false,
      }),
    ).toEqual({ allowed: true, reason: "configuration_recovery" });
    expect(
      retirement.decideProjectRetirementReconciliation({
        ...terminal,
        allowConfigurationRecovery: true,
        currentCloudflareCachePurgeConfigured: true,
        configurationRecoveryUsed: true,
      }),
    ).toEqual({
      allowed: false,
      code: "project_retirement_reconciliation_limit_reached",
    });
    expect(
      retirement.decideProjectRetirementReconciliation({
        ...terminal,
        failureCode: "project_retirement_runtime_destroy_unverified",
        allowConfigurationRecovery: true,
        currentCloudflareCachePurgeConfigured: true,
        configurationRecoveryUsed: false,
      }),
    ).toEqual({
      allowed: false,
      code: "project_retirement_reconciliation_limit_reached",
    });
  });

  it("reserves nonretryable legacy reconciliation for admins", () => {
    const input = {
      state: "failed",
      completedAt: new Date(),
      failureCode: "project_retirement_legacy_runtime_retained",
      generation: 0,
    };
    expect(
      retirement.decideProjectRetirementReconciliation({
        ...input,
        allowLegacyAdminReconciliation: false,
      }),
    ).toMatchObject({ allowed: false, code: "project_retirement_retry_not_allowed" });
    expect(
      retirement.decideProjectRetirementReconciliation({
        ...input,
        allowLegacyAdminReconciliation: true,
      }),
    ).toEqual({ allowed: true, reason: "legacy_admin_reconciliation" });
  });

  it("uses a fresh collision-safe identity when replacing an incompatible terminal", () => {
    expect(
      retirement.projectRetirementOperationIdForReceiptMode({
        mode: "adopt_legacy_tombstone",
        projectId: 51,
        freshOperationId: "fresh-receipt",
      }),
    ).toBe("project-retirement:legacy:v2:51");
    expect(
      retirement.projectRetirementOperationIdForReceiptMode({
        mode: "replace_incompatible_terminal",
        projectId: 51,
        freshOperationId: "fresh-receipt",
      }),
    ).toBe("fresh-receipt");
  });

  it("never presents the operation identity as a durable queue job identity", () => {
    expect(
      retirement.decideProjectRetirementSchedulingReceipt({
        status: "enqueued",
        jobId: "pg-boss-job",
      }),
    ).toEqual({ state: "enqueued", jobId: "pg-boss-job" });
    expect(retirement.decideProjectRetirementSchedulingReceipt({ status: "duplicate" })).toEqual({
      state: "already_scheduled",
    });
    expect(retirement.decideProjectRetirementSchedulingReceipt({ status: "failed" })).toEqual({
      state: "unavailable",
    });
  });

  it("normalizes and deduplicates every configured provider hostname", () => {
    expect(
      retirement.projectRetirementProviderHostnames([
        "App.Example.com.",
        "app.example.com",
        null,
        " bought.example.com ",
      ]),
    ).toEqual(["app.example.com", "bought.example.com"]);
  });

  it("creates current receipts and never lets an old receipt shadow current semantics", () => {
    const currentProgress = completedRetirementProgress();
    expect(
      retirement.decideProjectRetirementReceiptMode({
        deleted: false,
        existingOperation: {
          id: "completed-before-restore",
          state: "completed",
          completedAt: new Date(),
          progress: currentProgress,
        },
      }),
    ).toBe("retire_active");
    expect(
      retirement.decideProjectRetirementReceiptMode({
        deleted: true,
        existingOperation: null,
      }),
    ).toBe("adopt_legacy_tombstone");
    expect(
      retirement.decideProjectRetirementReceiptMode({
        deleted: true,
        existingOperation: {
          id: "project-retirement:legacy:v2:51",
          state: "completed",
          completedAt: new Date(),
          progress: currentProgress,
        },
      }),
    ).toBe("reuse_completed");
    const restoredProgress = completedRetirementProgress();
    restoredProgress.restore = {
      state: "restored",
      restoredAt: "2026-09-01T12:00:00.000Z",
    };
    expect(
      retirement.decideProjectRetirementReceiptMode({
        deleted: true,
        existingOperation: {
          id: "completed-before-second-trash",
          state: "completed",
          completedAt: new Date(),
          progress: restoredProgress,
        },
      }),
    ).toBe("refuse_terminal_reconciliation_required");
    expect(
      retirement.decideProjectRetirementReceiptMode({
        deleted: true,
        existingOperation: {
          id: "project-retirement:legacy:v1:51",
          state: "completed",
          completedAt: new Date(),
          progress: {},
        },
      }),
    ).toBe("refuse_terminal_reconciliation_required");
    expect(
      retirement.decideProjectRetirementReceiptMode({
        deleted: true,
        existingOperation: {
          id: "project-retirement:legacy:v1:51",
          state: "running",
          completedAt: null,
          progress: {},
        },
      }),
    ).toBe("refuse_incompatible_active");
    expect(
      retirement.decideProjectRetirementReceiptMode({
        deleted: true,
        existingOperation: {
          id: "current-failed",
          state: "failed",
          completedAt: new Date(),
          progress: currentProgress,
        },
      }),
    ).toBe("refuse_terminal_reconciliation_required");
    expect(
      retirement.decideProjectRetirementReceiptMode({
        deleted: true,
        existingOperation: {
          id: "current-running",
          state: "running",
          completedAt: null,
          progress: retirement.initialProjectRetirementProgress(),
        },
      }),
    ).toBe("reuse_in_flight");
  });

  it("deduplicates legacy and row hostname pointers into one provider retirement", () => {
    expect(
      retirement.planHostnameCertificateRetirements({
        legacyProject: { cfHostnameId: "shared-id", hostname: "legacy.example.test" },
        domains: [
          { id: 8, hostname: "www.example.test", cfHostnameId: "shared-id" },
          { id: 7, hostname: "example.test", cfHostnameId: "shared-id" },
          { id: 9, hostname: "other.example.test", cfHostnameId: "other-id" },
        ],
      }),
    ).toEqual([
      {
        cfHostnameId: "other-id",
        hostnames: ["other.example.test"],
        projectDomainIds: [9],
        legacyProjectPointer: false,
      },
      {
        cfHostnameId: "shared-id",
        hostnames: ["example.test", "legacy.example.test", "www.example.test"],
        projectDomainIds: [7, 8],
        legacyProjectPointer: true,
      },
    ]);
  });

  it("cancels every resumable or staged task state", () => {
    expect(retirement.PROJECT_RETIREMENT_TASK_STATUSES).toEqual([
      "queued",
      "answering",
      "planning",
      "building",
      "needs_review",
      "needs_fix",
      "paused-insufficient-credits",
    ]);
  });

  it("accepts only current, project-bound runtime pointers for their stored role", async () => {
    const identity = await deriveRuntimeIdentity({
      namespace: "production",
      projectId: 51,
      role: "production",
      slot: "green",
    });
    await expect(
      retirement.classifyStoredRuntimePointer({
        identity,
        namespace: "production",
        projectId: 51,
        pointer: "prodContainerId",
      }),
    ).resolves.toEqual({ state: "valid", role: "production", slot: "green" });
  });

  it("purges every known and observed hostname even when no legacy KV route exists", () => {
    expect(
      retirement.projectRetirementCacheHostnames({
        knownHostnames: ["slug.mustaflow.app", "custom.example.test"],
        legacyKvHostnames: [],
        runtimeRouteHostnames: ["custom.example.test", "runtime.example.test"],
      }),
    ).toEqual(["slug.mustaflow.app", "custom.example.test", "runtime.example.test"]);
  });

  it("retains malformed, cross-namespace, cross-project, and wrong-role pointers", async () => {
    const wrongNamespace = await deriveRuntimeIdentity({
      namespace: "legacy",
      projectId: 51,
      role: "preview",
      slot: "primary",
    });
    const wrongProject = await deriveRuntimeIdentity({
      namespace: "production",
      projectId: 52,
      role: "preview",
      slot: "primary",
    });
    const wrongRole = await deriveRuntimeIdentity({
      namespace: "production",
      projectId: 51,
      role: "production",
      slot: "blue",
    });
    const classify = (identity: string) =>
      retirement.classifyStoredRuntimePointer({
        identity,
        namespace: "production",
        projectId: 51,
        pointer: "containerId",
      });

    await expect(classify("fly-machine-legacy-pointer")).resolves.toEqual({
      state: "retained_legacy",
      reason: "runtime_identity_malformed",
    });
    await expect(classify(wrongNamespace)).resolves.toEqual({
      state: "retained_legacy",
      reason: "runtime_namespace_mismatch",
    });
    await expect(classify(wrongProject)).resolves.toEqual({
      state: "retained_legacy",
      reason: "runtime_project_mismatch",
    });
    await expect(classify(wrongRole)).resolves.toEqual({
      state: "retained_legacy",
      reason: "runtime_role_slot_mismatch",
    });
  });
});
