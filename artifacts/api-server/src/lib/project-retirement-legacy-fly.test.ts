import { describe, expect, it, vi } from "vitest";
import {
  reconcileLegacyFlyRuntime,
  type LegacyFlyRetirementRequest,
} from "./project-retirement-legacy-fly";

const MACHINE_ID = "9080e521b67587";
const PROJECT_ID = 77;

function response(status: number, body?: unknown): Pick<Response, "json" | "status"> {
  return {
    status,
    json: vi.fn(async () => body),
  };
}

function ownedMachine(override: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: MACHINE_ID,
    name: `project-${PROJECT_ID}`,
    config: {
      env: { PROJECT_ID: String(PROJECT_ID) },
      mounts: [],
    },
    ...override,
  };
}

describe("legacy Fly runtime reconciliation", () => {
  it("accepts an exact initial GET 404 as authoritative absence", async () => {
    const request = vi.fn<LegacyFlyRetirementRequest>().mockResolvedValue(response(404));

    await expect(
      reconcileLegacyFlyRuntime({ machineId: MACHINE_ID, projectId: PROJECT_ID }, request),
    ).resolves.toEqual({ state: "verified_absent", proof: "initial_get_404" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ machineId: MACHINE_ID, method: "GET" });
  });

  it("deletes only the exactly owned, unmounted machine and proves a second GET 404", async () => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(204))
      .mockResolvedValueOnce(response(404));

    await expect(
      reconcileLegacyFlyRuntime({ machineId: MACHINE_ID, projectId: PROJECT_ID }, request),
    ).resolves.toEqual({ state: "verified_absent", proof: "delete_then_get_404" });
    expect(request.mock.calls.map(([call]) => call)).toEqual([
      { machineId: MACHINE_ID, method: "GET" },
      { machineId: MACHINE_ID, method: "DELETE" },
      { machineId: MACHINE_ID, method: "GET" },
    ]);
  });

  it.each([
    ["machine id", ownedMachine({ id: "another-machine" }), "machine_identity_mismatch"],
    ["machine name", ownedMachine({ name: "project-78" }), "project_identity_mismatch"],
    [
      "required project environment",
      ownedMachine({ config: { env: { PROJECT_ID: "78" }, mounts: [] } }),
      "project_identity_mismatch",
    ],
    [
      "contradictory metadata",
      ownedMachine({
        config: {
          env: { PROJECT_ID: String(PROJECT_ID) },
          mounts: [],
          metadata: { nabu_project_id: "78" },
        },
      }),
      "contradictory_identity_marker",
    ],
    [
      "attached volume",
      ownedMachine({
        config: {
          env: { PROJECT_ID: String(PROJECT_ID) },
          mounts: [{ volume: "vol_secret" }],
        },
      }),
      "storage_ownership_ambiguous",
    ],
    [
      "missing mount inventory",
      ownedMachine({ config: { env: { PROJECT_ID: String(PROJECT_ID) } } }),
      "storage_ownership_ambiguous",
    ],
    [
      "unknown volume marker",
      ownedMachine({ volume_id: "vol_secret" }),
      "storage_ownership_ambiguous",
    ],
  ])("retains the pointer without DELETE for %s ambiguity", async (_label, body, reason) => {
    const request = vi.fn<LegacyFlyRetirementRequest>().mockResolvedValue(response(200, body));

    await expect(
      reconcileLegacyFlyRuntime({ machineId: MACHINE_ID, projectId: PROJECT_ID }, request),
    ).resolves.toEqual({ state: "retained", reason, retryable: false });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it.each(["bad/id", "machine id", "?force=true", ""])(
    "retains malformed pointer %j without any provider access",
    async (machineId) => {
      const request = vi.fn<LegacyFlyRetirementRequest>();

      await expect(
        reconcileLegacyFlyRuntime({ machineId, projectId: PROJECT_ID }, request),
      ).resolves.toEqual({
        state: "retained",
        reason: "legacy_pointer_malformed",
        retryable: false,
      });
      expect(request).not.toHaveBeenCalled();
    },
  );

  it("retains the pointer when DELETE is not followed by a GET 404", async () => {
    const secret = "provider-secret-body";
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockResolvedValueOnce(response(200, ownedMachine()))
      .mockResolvedValueOnce(response(202, { secret }))
      .mockResolvedValueOnce(response(200, { id: MACHINE_ID, secret }));

    const result = await reconcileLegacyFlyRuntime(
      { machineId: MACHINE_ID, projectId: PROJECT_ID },
      request,
    );

    expect(result).toEqual({ state: "retained", reason: "absence_unverified", retryable: true });
    expect(JSON.stringify(result)).not.toContain(MACHINE_ID);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("sanitizes provider failures and never returns raw response details", async () => {
    const request = vi
      .fn<LegacyFlyRetirementRequest>()
      .mockRejectedValue(new Error(`token=secret machine=${MACHINE_ID}`));

    const result = await reconcileLegacyFlyRuntime(
      { machineId: MACHINE_ID, projectId: PROJECT_ID },
      request,
    );

    expect(result).toEqual({
      state: "retained",
      reason: "provider_observation_unavailable",
      retryable: true,
    });
    expect(JSON.stringify(result)).not.toMatch(/secret|9080e521b67587/u);
  });
});
