import type { CapabilityDefinition } from "@workspace/tenant-runtime-contracts";
import { describe, expect, it } from "vitest";
import { handleControlRequest } from "../src/worker";
import {
  MemoryCapabilityVault,
  MemoryCoordinator,
  MockBackend,
  TEST_NOW_MS,
  fakeEnv,
  signedRequest,
} from "./helpers";

const definition: CapabilityDefinition = {
  name: "echo",
  provider: "nabuflow-harness",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/echo" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 5_000,
    maxRequestBytes: 32_768,
    maxResponseBytes: 32_768,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

const databaseDefinition: CapabilityDefinition = {
  name: "database",
  provider: "neon-postgres",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/query" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 10_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 262_144,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

describe("capability vault control endpoints", () => {
  it("provisions and CAS-revokes the staging echo record under signed control auth", async () => {
    const coordinator = new MemoryCoordinator();
    const vault = new MemoryCapabilityVault();
    const env = fakeEnv();
    const dependencies = {
      coordinator,
      vault,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
    };
    const path = "/_nabuflow/control/v1/capabilities/42/nabuflow-harness/echo";
    const provisionBody = { projectId: 42, revision: "echo-v1", definition };
    const request = await signedRequest({
      path,
      method: "PUT",
      body: provisionBody,
      nonce: "capability-provision-valid",
      idempotencyKey: "capability-provision-42-v1",
    });
    const replay = request.clone() as unknown as Request;
    const provisioned = await handleControlRequest(request, env, dependencies);
    expect(provisioned.status).toBe(200);
    await expect(provisioned.json()).resolves.toEqual({
      ok: true,
      projectId: 42,
      capability: { provider: "nabuflow-harness", name: "echo" },
      revision: "echo-v1",
      keyId: "v1",
    });
    expect(vault.records.has(42)).toBe(true);

    const replayed = await handleControlRequest(replay, env, dependencies);
    expect(replayed.status).toBe(409);
    await expect(replayed.json()).resolves.toMatchObject({ code: "replay_detected" });

    const conflict = await handleControlRequest(
      await signedRequest({
        path,
        method: "DELETE",
        body: { projectId: 42, expectedRevision: "wrong-revision" },
        nonce: "capability-revoke-conflict",
        idempotencyKey: "capability-revoke-42-wrong",
      }),
      env,
      dependencies,
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({ code: "capability_revision_conflict" });

    const revoked = await handleControlRequest(
      await signedRequest({
        path,
        method: "DELETE",
        body: { projectId: 42, expectedRevision: "echo-v1" },
        nonce: "capability-revoke-valid",
        idempotencyKey: "capability-revoke-42-v1",
      }),
      env,
      dependencies,
    );
    expect(revoked.status).toBe(200);
    await expect(revoked.json()).resolves.toEqual({
      ok: true,
      projectId: 42,
      capability: { provider: "nabuflow-harness", name: "echo" },
    });
    expect(vault.records.has(42)).toBe(false);
    expect(coordinator.audits.filter((record) => record.projectId === 42).length).toBeGreaterThan(
      0,
    );
  });

  it("provisions and revokes an encrypted database credential without returning it", async () => {
    const coordinator = new MemoryCoordinator();
    const vault = new MemoryCapabilityVault();
    const env = fakeEnv();
    const dependencies = {
      coordinator,
      vault,
      backend: new MockBackend(),
      nowMs: TEST_NOW_MS,
    };
    const path = "/_nabuflow/control/v1/capabilities/42/neon-postgres/database";
    const credential =
      "postgresql://slice_user:staging-password@ep-db-broker.us-east-2.aws.neon.tech/slice_db";
    const provisioned = await handleControlRequest(
      await signedRequest({
        path,
        method: "PUT",
        body: {
          projectId: 42,
          revision: "database-v1",
          definition: databaseDefinition,
          credential: { kind: "neon-connection-string", value: credential },
        },
        nonce: "database-provision-valid",
        idempotencyKey: "database-provision-42-v1",
      }),
      env,
      dependencies,
    );
    expect(provisioned.status).toBe(200);
    const provisionBody = await provisioned.text();
    expect(provisionBody).not.toContain(credential);
    expect(JSON.parse(provisionBody)).toEqual({
      ok: true,
      projectId: 42,
      capability: { provider: "neon-postgres", name: "database" },
      revision: "database-v1",
      keyId: "v1",
    });

    const revoked = await handleControlRequest(
      await signedRequest({
        path,
        method: "DELETE",
        body: { projectId: 42, expectedRevision: "database-v1" },
        nonce: "database-revoke-valid",
        idempotencyKey: "database-revoke-42-v1",
      }),
      env,
      dependencies,
    );
    expect(revoked.status).toBe(200);
    expect(vault.databaseRecords.has(42)).toBe(false);
    expect(JSON.stringify(coordinator.audits)).not.toContain(credential);
  });
});
