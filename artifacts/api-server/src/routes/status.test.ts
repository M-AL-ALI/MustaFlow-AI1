import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  queueStats: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: { connect: mocks.connect },
}));

vi.mock("../lib/durable-queue", () => ({
  getQueueStats: mocks.queueStats,
}));

vi.mock("../lib/resilience", () => ({
  ALL_BREAKERS: [],
}));

import statusRouter from "./status";

function app() {
  const server = express();
  server.use("/api", statusRouter);
  return server;
}

describe("public database status diagnostics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queueStats.mockResolvedValue({ build: { active: 0 }, refine: { active: 0 } });
  });

  it.each([
    ["28P01", "authentication_failed"],
    ["42501", "authorization_failed"],
    ["3D000", "database_missing"],
    ["53300", "capacity_exhausted"],
    ["ERR_TLS_CERT_ALTNAME_INVALID", "tls_failed"],
    ["ENOTFOUND", "name_resolution_failed"],
    ["ECONNREFUSED", "connection_refused"],
    ["ETIMEDOUT", "connection_timeout"],
    ["ECONNRESET", "connection_lost"],
    ["ERR_INVALID_URL", "configuration_invalid"],
    ["SOMETHING_NEW", "unknown"],
  ])("publishes only the closed cause for %s", async (code, expectedCause) => {
    mocks.connect.mockRejectedValueOnce(
      Object.assign(new Error("sensitive detail: private-user private-pass private-host"), {
        code,
      }),
    );

    const response = await request(app()).get("/api/status");
    const database = response.body.components.find(
      (component: { name: string }) => component.name === "Database",
    );

    expect(response.status).toBe(200);
    expect(database).toMatchObject({
      name: "Database",
      status: "outage",
      message: "DB probe failed",
      cause: expectedCause,
    });
    expect(JSON.stringify(response.body)).not.toContain("private-user");
    expect(JSON.stringify(response.body)).not.toContain("private-pass");
    expect(JSON.stringify(response.body)).not.toContain("private-host");
  });

  it("omits a failure cause when the database is reachable", async () => {
    const release = vi.fn();
    mocks.connect.mockResolvedValueOnce({
      query: vi.fn().mockResolvedValueOnce({ rows: [{ ok: 1 }] }),
      release,
    });

    const response = await request(app()).get("/api/status");
    const database = response.body.components.find(
      (component: { name: string }) => component.name === "Database",
    );

    expect(database).toMatchObject({ name: "Database", status: "operational" });
    expect(database).not.toHaveProperty("cause");
    expect(release).toHaveBeenCalledOnce();
  });
});
