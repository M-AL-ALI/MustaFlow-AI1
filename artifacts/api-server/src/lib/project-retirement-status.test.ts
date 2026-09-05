import { describe, expect, it } from "vitest";
import { sanitizeProjectRetirementProgress } from "./project-retirement-status";

describe("project retirement status sanitization", () => {
  it("shows the repair version and predecessor cause without exposing its actor or raw identifiers", () => {
    const sanitized = sanitizeProjectRetirementProgress({
      reconciliation: {
        generation: 4,
        reason: "retryable_terminal",
        configurationRecoveryUsed: true,
        verificationRepair: {
          version: "fly-destroyed-tombstone-v1",
          parentOperationId: "private-operation",
          requestedBy: "private-actor",
          pointer: "containerId",
          predecessorGeneration: 3,
          failureCode: "project_retirement_legacy_runtime_absence_unverified",
          reason: "absence_unverified",
        },
      },
    });
    expect(sanitized).toMatchObject({
      reconciliation: {
        verificationRepair: {
          version: "fly-destroyed-tombstone-v1",
          pointer: "containerId",
          predecessorGeneration: 3,
          hasParent: true,
        },
      },
    });
    expect(JSON.stringify(sanitized)).not.toContain("private-");
  });
  it.each([
    "initial_destroyed_tombstone_active_catalog_absent",
    "delete_then_destroyed_tombstone_active_catalog_absent",
  ])("preserves the closed corrected Fly proof %s", (proof) => {
    expect(
      sanitizeProjectRetirementProgress({
        legacyRuntimeResolutions: [{ pointer: "containerId", state: "verified_absent", proof }],
      }),
    ).toMatchObject({ legacyRuntimeResolutions: { proofs: { [proof]: 1 }, unrecognized: 0 } });
  });
  it("distinguishes missing legacy add-on and SQLite evidence without exposing stored data", () => {
    expect(sanitizeProjectRetirementProgress({})).toMatchObject({
      managedAddons: null,
      sqliteRecovery: null,
    });
    const result = sanitizeProjectRetirementProgress({
      managedAddons: {
        state: "verified_detached",
        discoveredCount: 1,
        detachedCount: 1,
        secretsRemoved: 2,
        bindingsRemaining: 0,
        failureCode: null,
        credentials: "private-addon-credentials",
      },
      sqliteRecovery: {
        state: "preserved",
        snapshotId: 987654,
        sizeBytes: 128,
        storage: "object",
        failureCode: null,
        objectKey: "private/snapshot",
        contents: "private-database-content",
      },
    });
    expect(result).toMatchObject({
      managedAddons: { state: "verified_detached", bindingsRemaining: 0 },
      sqliteRecovery: { state: "preserved", sizeBytes: 128, storage: "object" },
    });
    expect(JSON.stringify(result)).not.toMatch(/private|987654|snapshotId/u);
    expect(
      sanitizeProjectRetirementProgress({
        managedAddons: { state: "hostile", discoveredCount: -1, failureCode: "secret" },
        sqliteRecovery: {
          state: "hostile",
          sizeBytes: "128",
          storage: "secret",
          failureCode: "secret",
        },
      }),
    ).toMatchObject({
      managedAddons: { state: null, discoveredCount: null, failureCode: null },
      sqliteRecovery: { state: null, sizeBytes: null, storage: null, failureCode: null },
    });
  });
  it("exposes only closed legacy runtime resolution counts, reasons, and proofs", () => {
    const rawMachineId = "9080e521b67587";
    const rawSecret = "provider-secret-response";

    const sanitized = sanitizeProjectRetirementProgress({
      legacyRuntimeResolutions: [
        {
          pointer: "containerId",
          state: "verified_absent",
          proof: "initial_get_404",
          identity: rawMachineId,
          providerBody: rawSecret,
        },
        {
          pointer: "prodContainerId",
          state: "retained",
          reason: "absence_unverified",
          retryable: true,
          identity: rawMachineId,
        },
        {
          pointer: "testContainerId",
          state: "retained",
          reason: "raw-provider-reason",
          retryable: true,
          proof: "raw-provider-proof",
        },
      ],
    });

    expect(sanitized.legacyRuntimeResolutions).toEqual({
      total: 3,
      unrecognized: 1,
      pointers: { containerId: 1, prodContainerId: 1 },
      states: { verified_absent: 1, retained: 1 },
      proofs: { initial_get_404: 1 },
      reasons: { absence_unverified: 1 },
      retryable: 1,
    });
    expect(JSON.stringify(sanitized)).not.toMatch(
      /9080e521b67587|provider-secret-response|raw-provider-reason|raw-provider-proof/u,
    );
  });
});
