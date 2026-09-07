import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const mocks = vi.hoisted(() => ({
  testDatabaseUrl: (process.env.DATABASE_URL =
    process.env.DATABASE_URL ?? "postgresql://test:test@127.0.0.1:1/test"),
  rows: [] as unknown[][],
  select: vi.fn(),
  update: vi.fn(),
  set: vi.fn(),
  updateWhere: vi.fn(),
  returning: vi.fn(),
  lifecycle: vi.fn(),
  assertActive: vi.fn(),
}));

vi.mock("@workspace/db", async (importOriginal) => {
  const original = await importOriginal<typeof import("@workspace/db")>();
  return { ...original, db: { select: mocks.select, update: mocks.update } };
});
vi.mock("./project-lifecycle", () => ({ withActiveProjectLifecycle: mocks.lifecycle }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));

import {
  recoverStaleSealedPreviewProvisioning,
  sealedRuntimeProvisioningState,
  staleSealedPreviewProvisioningPredicate,
} from "./sealed-runtime-provisioning-state";

const candidate = { id: 58, containerId: "nrf-owned-p58-preview-primary" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.rows = [[candidate], [candidate]];
  mocks.select.mockImplementation(() => {
    const rows = mocks.rows.shift() ?? [];
    const query = {
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      orderBy: vi.fn().mockReturnThis(),
      limit: vi.fn().mockResolvedValue(rows),
    };
    return query;
  });
  mocks.update.mockReturnValue({ set: mocks.set });
  mocks.set.mockReturnValue({ where: mocks.updateWhere });
  mocks.updateWhere.mockReturnValue({ returning: mocks.returning });
  mocks.returning.mockResolvedValue([{ id: candidate.id }]);
  mocks.assertActive.mockResolvedValue(true);
  mocks.lifecycle.mockImplementation(async (_id, work) => ({
    state: "active",
    value: await work({ assertActive: mocks.assertActive }),
  }));
});

describe("sealed runtime provisioning state", () => {
  it.each(["stopped", "running"])(
    "treats a durable %s private runtime as provisioned",
    (status) => {
      expect(sealedRuntimeProvisioningState(status)).toEqual({
        provisioningStatus: "ready",
        provisioningStep: null,
      });
    },
  );

  it.each(["starting", "creating", "unknown", "failed"])(
    "does not accept an unsettled %s descriptor",
    (status) => {
      expect(sealedRuntimeProvisioningState(status).provisioningStatus).toBe("provisioning");
    },
  );

  it("keeps database allocation, active tasks, tombstones and normal provisioning excluded", () => {
    const query = new PgDialect().sqlToQuery(staleSealedPreviewProvisioningPredicate()!);
    expect(query.sql).toContain('"projects"."deleted_at" is null');
    expect(query.sql).toContain('"projects"."provisioning_started_at" is null');
    expect(query.sql).toContain('"projects"."preview_db_allocation" is null');
    expect(query.sql).toContain("pending_task.completed_at IS NULL");
    expect(query.sql).toContain("pending_task.status NOT IN");
    expect(query.sql).toContain("failed_task.status = 'failed'");
    expect(query.params).toEqual(["failed", "provisioning", "runtime-start", "none", "none"]);
  });

  it("converges the failed private-runtime marker under lifecycle admission and a repeated fence", async () => {
    const descriptor = vi
      .fn()
      .mockResolvedValue({ identity: candidate.containerId, status: "stopped" });
    await expect(recoverStaleSealedPreviewProvisioning(descriptor)).resolves.toBe(1);
    expect(mocks.lifecycle).toHaveBeenCalledWith(candidate.id, expect.any(Function));
    expect(descriptor).toHaveBeenCalledWith(candidate.id);
    expect(mocks.set).toHaveBeenCalledWith({
      provisioningStatus: "error",
      provisioningStep: null,
      provisioningError: "The preview build failed. Retry the build or move the project to Trash.",
    });
    const write = new PgDialect().sqlToQuery(mocks.updateWhere.mock.calls[0]![0]);
    expect(write.sql).toContain("pending_task.status NOT IN");
    expect(write.params).toContain(candidate.containerId);
  });

  it.each([
    null,
    { identity: "another-project", status: "stopped" },
    { identity: candidate.containerId, status: "starting" },
  ])("refuses absent, foreign, or unsettled provider proof: %j", async (descriptor) => {
    await expect(recoverStaleSealedPreviewProvisioning(async () => descriptor)).resolves.toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not query the provider after a new task or changed project invalidates the claim", async () => {
    mocks.rows = [[candidate], []];
    const descriptor = vi.fn();
    await expect(recoverStaleSealedPreviewProvisioning(descriptor)).resolves.toBe(0);
    expect(descriptor).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not alter a replaced runtime pointer", async () => {
    mocks.rows = [[candidate], [{ ...candidate, containerId: "replacement" }]];
    await expect(recoverStaleSealedPreviewProvisioning(vi.fn())).resolves.toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not recover when lifecycle admission is denied", async () => {
    mocks.lifecycle.mockResolvedValue({ state: "inactive" });
    await expect(recoverStaleSealedPreviewProvisioning(vi.fn())).resolves.toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("fails closed when the provider is unavailable", async () => {
    await expect(
      recoverStaleSealedPreviewProvisioning(async () => {
        throw new Error("timeout");
      }),
    ).resolves.toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("refuses lost lifecycle admission after provider observation", async () => {
    mocks.assertActive.mockResolvedValue(false);
    await expect(
      recoverStaleSealedPreviewProvisioning(async () => ({
        identity: candidate.containerId,
        status: "stopped",
      })),
    ).resolves.toBe(0);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not claim success after a final compare-and-set conflict", async () => {
    mocks.returning.mockResolvedValue([]);
    await expect(
      recoverStaleSealedPreviewProvisioning(async () => ({
        identity: candidate.containerId,
        status: "stopped",
      })),
    ).resolves.toBe(0);
  });
});
