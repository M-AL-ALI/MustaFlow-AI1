import { describe, expect, it } from "vitest";
import {
  ARTIFACT_COMMIT_EVENT_LIMIT,
  ARTIFACT_COMMIT_OBSERVATION_MARGIN_MS,
  ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
  ARTIFACT_COMMIT_SERVER_EXECUTION_DEADLINE_MS,
  DURABLE_OPERATION_OBSERVATION_MARGIN_MS,
  DURABLE_OPERATION_PROVIDER_BOUND_MS,
  DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS,
  DURABLE_OPERATION_DISCOVERY_MAX_LIMIT,
  durableOperationDiscoveryResponseSchema,
  artifactCommitDiagnosticsResponseSchema,
  runtimeManifestRestartDiagnosticsResponseSchema,
  runtimeStartDiagnosticsResponseSchema,
} from "../src";

describe("artifact commit execution contract", () => {
  it("defines one non-racing server deadline and provider observation margin", () => {
    expect(ARTIFACT_COMMIT_SERVER_EXECUTION_DEADLINE_MS).toBe(270_000);
    expect(ARTIFACT_COMMIT_OBSERVATION_MARGIN_MS).toBe(30_000);
    expect(
      ARTIFACT_COMMIT_SERVER_EXECUTION_DEADLINE_MS + ARTIFACT_COMMIT_OBSERVATION_MARGIN_MS,
    ).toBe(ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS);
    expect(ARTIFACT_COMMIT_SERVER_EXECUTION_DEADLINE_MS).toBeLessThan(
      ARTIFACT_COMMIT_PROVIDER_OPERATION_BOUND_MS,
    );
    expect(DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS).toBe(270_000);
    expect(DURABLE_OPERATION_OBSERVATION_MARGIN_MS).toBe(30_000);
    expect(
      DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS + DURABLE_OPERATION_OBSERVATION_MARGIN_MS,
    ).toBe(DURABLE_OPERATION_PROVIDER_BOUND_MS);
  });

  it("accepts only the bounded sanitized diagnostic shape", () => {
    const events = Array.from({ length: ARTIFACT_COMMIT_EVENT_LIMIT }, (_, index) => ({
      sequence: index + 1,
      at: new Date(index * 1_000).toISOString(),
      event: "lease-renewed" as const,
      attempt: 1,
      checkpoint: "verification-complete" as const,
    }));
    const value = {
      ok: true as const,
      job: {
        kind: "layers-v1" as const,
        runtimeIdentity: "nrf-e919a75364398a44-p42-preview-primary",
        sealedArtifactSha256: "a".repeat(64),
        state: "active" as const,
        checkpoint: "verification-complete" as const,
        attempt: 1,
        leaseUntil: "2026-08-10T00:00:15.000Z",
        deadline: "2026-08-10T00:04:30.000Z",
        updatedAt: "2026-08-10T00:00:05.000Z",
        terminal: null,
        events,
      },
    };
    expect(artifactCommitDiagnosticsResponseSchema.parse(value)).toEqual(value);
    expect(() =>
      artifactCommitDiagnosticsResponseSchema.parse({
        ...value,
        job: { ...value.job, events: [...events, events[0]] },
      }),
    ).toThrow();
    expect(() =>
      artifactCommitDiagnosticsResponseSchema.parse({
        ...value,
        job: { ...value.job, ownerId: "must-not-escape" },
      }),
    ).toThrow();
  });

  it("accepts only bounded metadata from durable-operation discovery", () => {
    const job = {
      jobKey: `durable-operation-job:layers-v1:${"r".repeat(40)}:${"a".repeat(64)}`,
      kind: "layers-v1" as const,
      runtimeIdentity: "nrf-e919a75364398a44-p42-preview-primary",
      subjectKey: "a".repeat(64),
      createdAt: "2026-08-10T00:00:00.000Z",
      updatedAt: "2026-08-10T00:00:05.000Z",
      state: "active" as const,
      checkpoint: "verification-complete" as const,
      attempt: 1,
    };
    const value = {
      ok: true as const,
      window: {
        since: "2026-08-09T00:00:00.000Z",
        until: "2026-08-10T00:00:00.000Z",
        limit: DURABLE_OPERATION_DISCOVERY_MAX_LIMIT,
      },
      jobs: [job],
    };
    expect(durableOperationDiscoveryResponseSchema.parse(value)).toEqual(value);
    expect(() =>
      durableOperationDiscoveryResponseSchema.parse({
        ...value,
        jobs: [{ ...job, fingerprint: "must-not-escape" }],
      }),
    ).toThrow();
    expect(() =>
      durableOperationDiscoveryResponseSchema.parse({
        ...value,
        jobs: Array.from({ length: DURABLE_OPERATION_DISCOVERY_MAX_LIMIT + 1 }, () => job),
      }),
    ).toThrow();
  });

  it("accepts only the bounded runtime-start diagnostic shape", () => {
    const value = {
      ok: true as const,
      job: {
        kind: "runtime-start" as const,
        runtimeIdentity: "nrf-e919a75364398a44-p42-preview-primary",
        artifactRevision: "runtime-start-recovery",
        artifactSha256: "a".repeat(64),
        state: "active" as const,
        checkpoint: "materialized" as const,
        attempt: 2,
        leaseUntil: "2026-08-10T00:00:15.000Z",
        deadline: "2026-08-10T00:04:30.000Z",
        updatedAt: "2026-08-10T00:00:05.000Z",
        terminal: null,
        events: [
          {
            sequence: 1,
            at: "2026-08-10T00:00:00.000Z",
            event: "driver-adopted" as const,
            attempt: 2,
            checkpoint: "materialized" as const,
          },
        ],
      },
    };
    expect(runtimeStartDiagnosticsResponseSchema.parse(value)).toEqual(value);
    expect(() =>
      runtimeStartDiagnosticsResponseSchema.parse({
        ...value,
        job: { ...value.job, ownerId: "must-not-escape" },
      }),
    ).toThrow();
  });

  it("accepts only the bounded runtime-manifest-restart diagnostic shape", () => {
    const value = {
      ok: true as const,
      job: {
        kind: "runtime-manifest-restart" as const,
        runtimeIdentity: "nrf-e919a75364398a44-p42-preview-primary",
        expectedManifestRevision: "manifest-v1",
        manifestRevision: "manifest-v2",
        state: "active" as const,
        checkpoint: "manifest-persisted" as const,
        attempt: 2,
        leaseUntil: "2026-08-10T00:00:15.000Z",
        deadline: "2026-08-10T00:04:30.000Z",
        updatedAt: "2026-08-10T00:00:05.000Z",
        terminal: null,
        events: [
          {
            sequence: 1,
            at: "2026-08-10T00:00:00.000Z",
            event: "driver-adopted" as const,
            attempt: 2,
            checkpoint: "manifest-persisted" as const,
          },
        ],
      },
    };
    expect(runtimeManifestRestartDiagnosticsResponseSchema.parse(value)).toEqual(value);
    expect(() =>
      runtimeManifestRestartDiagnosticsResponseSchema.parse({
        ...value,
        job: { ...value.job, ownerId: "must-not-escape" },
      }),
    ).toThrow();
  });
});
