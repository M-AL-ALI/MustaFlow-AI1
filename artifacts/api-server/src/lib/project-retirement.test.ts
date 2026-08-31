import { describe, expect, it } from "vitest";
import { deriveRuntimeIdentity } from "@workspace/tenant-runtime-contracts";
import * as retirement from "./project-retirement-contract";

describe("project retirement foundation", () => {
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
      expect(retirement.decideProjectRestoreAdmission(state)).toEqual({
        allowed: false,
        code: "project_retirement_cleanup_unverified",
      });
    },
  );

  it("admits restore only after a completed cleanup receipt", () => {
    expect(retirement.decideProjectRestoreAdmission("completed")).toEqual({ allowed: true });
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

  it("adopts legacy tombstones once with stable deterministic identities", () => {
    const first = retirement.planLegacyProjectRetirementAdoptions({
      deletedProjectIds: [9, 4, 9],
      projectsWithReceipts: new Set(),
    });
    expect(first).toEqual([
      { projectId: 4, operationId: "project-retirement:legacy:v1:4" },
      { projectId: 9, operationId: "project-retirement:legacy:v1:9" },
    ]);
    const second = retirement.planLegacyProjectRetirementAdoptions({
      deletedProjectIds: [4, 9],
      projectsWithReceipts: new Set(first.map((entry) => entry.projectId)),
    });
    expect(second).toEqual([]);
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
