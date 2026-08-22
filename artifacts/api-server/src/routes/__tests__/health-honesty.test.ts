import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  containerSubsystem: vi.fn(),
  runtimeConfiguration: vi.fn(),
  encryptionKey: vi.fn(),
  startup: vi.fn(),
  queueSchemaContract: vi.fn(),
  buildIdentity: vi.fn(),
  buildCommit: vi.fn(),
}));

vi.mock("../../lib/tenant-runtime", () => ({
  getContainerSubsystemStatus: mocks.containerSubsystem,
  getTenantRuntimeConfigurationStatus: mocks.runtimeConfiguration,
}));

vi.mock("../../lib/encryption", () => ({
  getEncryptionKeyStatus: mocks.encryptionKey,
}));

vi.mock("../../lib/startup-health-state", () => ({
  startupHealthState: { read: mocks.startup },
}));

vi.mock("../../lib/schema-contract-state", () => ({
  zeroPromptQueueSchemaContractState: { read: mocks.queueSchemaContract },
}));

vi.mock("../../lib/build-info", () => ({
  getServedBuildIdentity: mocks.buildIdentity,
  getServedBuildCommit: mocks.buildCommit,
}));

import healthRouter from "../health";

function app() {
  const server = express();
  server.use("/api", healthRouter);
  return server;
}

describe("health startup honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.encryptionKey.mockReturnValue("ok");
    mocks.runtimeConfiguration.mockReturnValue({ status: "complete", missingBindings: [] });
    mocks.buildIdentity.mockReturnValue({ identity: "unknown" });
    mocks.buildCommit.mockReturnValue("unknown");
  });

  it("returns a machine-decidable startup-window shape without changing HTTP status", async () => {
    mocks.containerSubsystem.mockReturnValue(null);
    mocks.startup.mockReturnValue({ migrations: "unknown" });
    mocks.queueSchemaContract.mockReturnValue({ status: "starting" });

    const response = await request(app()).get("/api/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      containerSubsystem: "unknown",
      encryptionKey: "ok",
      startupMigrations: "unknown",
      queueSchemaContract: "unknown",
      buildCommit: "unknown",
    });
  });

  it("keeps the complete-configuration post-startup response exactly 200", async () => {
    mocks.containerSubsystem.mockReturnValue("ok");
    mocks.startup.mockReturnValue({ migrations: "ok" });
    mocks.queueSchemaContract.mockReturnValue({ status: "ready" });

    const response = await request(app()).get("/api/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      containerSubsystem: "ok",
      encryptionKey: "ok",
      startupMigrations: "ok",
      queueSchemaContract: "ok",
      buildCommit: "unknown",
    });
  });

  it("reports completed failures as data while preserving the existing 200 response", async () => {
    mocks.containerSubsystem.mockReturnValue("error");
    mocks.startup.mockReturnValue({ migrations: "error" });
    mocks.queueSchemaContract.mockReturnValue({ status: "unready" });

    const response = await request(app()).get("/api/healthz");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: "ok",
      containerSubsystem: "error",
      encryptionKey: "ok",
      startupMigrations: "error",
      queueSchemaContract: "error",
      buildCommit: "unknown",
    });
  });

  it("keeps partial Cloudflare configuration live so deployment cannot deadlock", async () => {
    const presentValue = "present-configuration-value-never-returned";
    const bindingNames = [
      "CLOUDFLARE_RUNTIME_CONTROL_URL",
      "CLOUDFLARE_RUNTIME_CONTROL_TOKEN",
      "CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE",
    ] as const;
    for (let presentMask = 0; presentMask < 7; presentMask += 1) {
      const missingBindings = bindingNames.filter(
        (_name, index) => (presentMask & (1 << index)) === 0,
      );
      mocks.containerSubsystem.mockReturnValue("partial-config");
      mocks.runtimeConfiguration.mockReturnValue({ status: "partial-config", missingBindings });
      mocks.startup.mockReturnValue({ migrations: "unknown" });
      mocks.queueSchemaContract.mockReturnValue({ status: "starting" });

      const response = await request(app()).get("/api/healthz");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: "degraded",
        containerSubsystem: "partial-config",
        encryptionKey: "ok",
        startupMigrations: "unknown",
        queueSchemaContract: "unknown",
        buildCommit: "unknown",
      });
      expect(response.body.containerSubsystem).not.toBe("ok");
      for (const bindingName of bindingNames) {
        expect(JSON.stringify(response.body)).not.toContain(bindingName);
      }
      expect(JSON.stringify(response.body)).not.toContain(presentValue);
    }
  });

  it("keeps partial Fly configuration live without reporting the subsystem as ok", async () => {
    const presentValue = "fly-configuration-value-never-returned";
    const bindingNames = ["FLY_APP_NAME", "FLY_ORG_SLUG", "FLY_REGION"] as const;
    for (let presentMask = 0; presentMask < 7; presentMask += 1) {
      const missingBindings = bindingNames.filter(
        (_name, index) => (presentMask & (1 << index)) === 0,
      );
      mocks.containerSubsystem.mockReturnValue("partial-config");
      mocks.runtimeConfiguration.mockReturnValue({ status: "partial-config", missingBindings });
      mocks.startup.mockReturnValue({ migrations: "unknown" });
      mocks.queueSchemaContract.mockReturnValue({ status: "starting" });

      const response = await request(app()).get("/api/healthz");

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        status: "degraded",
        containerSubsystem: "partial-config",
        encryptionKey: "ok",
        startupMigrations: "unknown",
        queueSchemaContract: "unknown",
        buildCommit: "unknown",
      });
      expect(response.body.containerSubsystem).not.toBe("ok");
      for (const bindingName of bindingNames) {
        expect(JSON.stringify(response.body)).not.toContain(bindingName);
      }
      expect(JSON.stringify(response.body)).not.toContain(presentValue);
    }
  });

  it("serves the exact build artifact and uses the same commit in health", async () => {
    const identity = {
      commit: "1".repeat(40),
      tree: "2".repeat(40),
      builtAt: "2026-08-22T12:34:56.000Z",
    };
    mocks.buildIdentity.mockReturnValue(identity);
    mocks.buildCommit.mockReturnValue(identity.commit);
    mocks.containerSubsystem.mockReturnValue("ok");
    mocks.startup.mockReturnValue({ migrations: "ok" });
    mocks.queueSchemaContract.mockReturnValue({ status: "ready" });

    const [version, health] = await Promise.all([
      request(app()).get("/api/version"),
      request(app()).get("/api/healthz"),
    ]);

    expect(version.status).toBe(200);
    expect(version.body).toEqual(identity);
    expect(health.status).toBe(200);
    expect(health.body.buildCommit).toBe(identity.commit);
  });

  it("reports unknown on both public read surfaces when build-info is absent", async () => {
    mocks.containerSubsystem.mockReturnValue("ok");
    mocks.startup.mockReturnValue({ migrations: "ok" });
    mocks.queueSchemaContract.mockReturnValue({ status: "ready" });

    const [version, health] = await Promise.all([
      request(app()).get("/api/version"),
      request(app()).get("/api/healthz"),
    ]);

    expect(version.status).toBe(200);
    expect(version.body).toEqual({ identity: "unknown" });
    expect(health.status).toBe(200);
    expect(health.body.buildCommit).toBe("unknown");
  });
});
