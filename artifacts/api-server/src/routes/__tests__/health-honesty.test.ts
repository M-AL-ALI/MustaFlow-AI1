import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  containerSubsystem: vi.fn(),
  encryptionKey: vi.fn(),
  startup: vi.fn(),
  queueSchemaContract: vi.fn(),
}));

vi.mock("../../lib/tenant-runtime", () => ({
  getContainerSubsystemStatus: mocks.containerSubsystem,
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

  it("returns a distinct machine-decidable post-startup shape", async () => {
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
});
