import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  const select = vi.fn(() => ({
    from: vi.fn(() => ({ where: vi.fn(async () => []) })),
  }));
  return { ...original, db: { ...original.db, select } };
});
vi.mock("../../lib/superusers", () => ({ isSuperuser: vi.fn(async () => false) }));
vi.mock("../../lib/sbom", () => ({ generateSbom: vi.fn() }));
vi.mock("../../lib/checks/cve-scanner", () => ({ runCveAudit: vi.fn() }));
vi.mock("../../lib/cve-scheduler", () => ({
  getCveScanStatus: vi.fn(),
  recordScanResult: vi.fn(),
  acknowledgeNewFindings: vi.fn(),
}));
vi.mock("../../lib/jobs", () => ({ enqueueCveAutoProtectJob: vi.fn() }));
vi.mock("../../lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const cases = [
  ["get", "/security/cve"],
  ["get", "/security/cve/scan-status"],
  ["post", "/security/cve/scan-status/acknowledge"],
  ["post", "/security/cve/scan"],
  ["patch", "/security/cve/71/dismiss"],
  ["get", "/security/sbom"],
  ["post", "/security/cve/71/apply-patch"],
] as const;

describe("authorization lockdown: account-wide security routes", () => {
  it.each(cases)("denies non-admin %s %s", async (method, path) => {
    const router = (await import("../security")).default;
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.userId = "signed-in-non-admin";
      next();
    });
    app.use(router);

    const response = await request(app)[method](path).send({});

    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "Forbidden — admin access required" });
  });
});
