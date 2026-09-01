import { describe, expect, it } from "vitest";
import { sanitizeProjectRetirementProgress } from "./project-retirement-status";

describe("project retirement status sanitization", () => {
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
