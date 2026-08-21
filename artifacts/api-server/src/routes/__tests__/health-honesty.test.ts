import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  containerSubsystem: vi.fn(),
  runtimeConfiguration: vi.fn(),
  encryptionKey: vi.fn(),
  startup: vi.fn(),
  queueSchemaContract: vi.fn(),
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
    });
  });

  it("returns a synchronous names-only 503 for every partial configuration combination", async () => {
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

      expect(response.status).toBe(503);
      expect(response.body).toEqual({
        status: "partial-config",
        containerSubsystem: "partial-config",
        encryptionKey: "ok",
        startupMigrations: "unknown",
        queueSchemaContract: "unknown",
        missingRuntimeBindings: missingBindings,
      });
      expect(JSON.stringify(response.body)).not.toContain(presentValue);
    }
  });
});
