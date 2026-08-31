import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    select: vi.fn(),
    delete: vi.fn(),
    deleteWhere: vi.fn(async () => []),
    deleteTrackedAssetStorageObjects: vi.fn(async () => undefined),
    releaseProductionDatabasesForHardDelete: vi.fn(async () => undefined),
    destroyContainer: vi.fn(async () => undefined),
    evictTierCache: vi.fn(),
  };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: mocks.select,
      delete: mocks.delete,
    },
  };
});
vi.mock("./logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock("./public-ai/authed-user", () => ({ evictTierCache: mocks.evictTierCache }));
vi.mock("./tenant-runtime", () => ({
  destroyContainer: mocks.destroyContainer,
  tenantRuntimeProvider: { name: "test-runtime" },
}));
vi.mock("./production-database-lifecycle", () => ({
  releaseProductionDatabasesForHardDelete: mocks.releaseProductionDatabasesForHardDelete,
}));
vi.mock("./objectStorage", () => ({
  objectStorageClient: { bucket: vi.fn() },
}));
vi.mock("./asset-storage-cleanup", () => ({
  deleteTrackedAssetStorageObjects: mocks.deleteTrackedAssetStorageObjects,
}));
vi.mock("./stripeClient", () => ({ getUncachableStripeClient: vi.fn(async () => null) }));

import { assetsTable, projectsTable } from "@workspace/db";
import { runGdprErasure } from "./gdpr-erasure-worker";

function directSelect(rows: unknown[]) {
  return {
    from: vi.fn(() => ({ where: vi.fn(async () => rows) })),
  };
}

function joinedSelect(rows: unknown[]) {
  return {
    from: vi.fn(() => ({
      innerJoin: vi.fn(() => ({ where: vi.fn(async () => rows) })),
    })),
  };
}

function arrangeSelections(unifiedRows: unknown[]) {
  mocks.select
    .mockImplementationOnce(() => directSelect([{ id: 51, containerId: null }]))
    .mockImplementationOnce(() => directSelect([]))
    .mockImplementationOnce(() => joinedSelect(unifiedRows))
    .mockImplementationOnce(() => directSelect([]));
}

describe("GDPR unified asset storage erasure", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.delete.mockImplementation(() => ({ where: mocks.deleteWhere }));
    mocks.deleteTrackedAssetStorageObjects.mockResolvedValue(undefined);
    mocks.releaseProductionDatabasesForHardDelete.mockResolvedValue(undefined);
  });

  it("deletes full and thumbnail objects across backends before metadata cascades", async () => {
    const objects = [
      { storageBackend: "r2", storageKey: "accounts/owner/assets/71/full.webp" },
      { storageBackend: "r2", storageKey: "accounts/owner/assets/71/thumb.webp" },
      { storageBackend: "legacy-object", storageKey: "/bucket/legacy-full.png" },
      { storageBackend: "dev-file", storageKey: "C:/tmp/legacy-thumb.webp" },
    ];
    arrangeSelections([...objects, objects[1]]);

    await expect(runGdprErasure("owner")).resolves.toBeUndefined();

    expect(mocks.deleteTrackedAssetStorageObjects).toHaveBeenCalledOnce();
    expect(mocks.deleteTrackedAssetStorageObjects).toHaveBeenCalledWith(objects);
    expect(mocks.delete.mock.calls[0]?.[0]).toBe(projectsTable);
    expect(mocks.delete.mock.calls.some(([table]) => table === assetsTable)).toBe(true);
    expect(mocks.deleteTrackedAssetStorageObjects.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.delete.mock.invocationCallOrder[0]!,
    );
  });

  it("preserves all metadata when any physical-object backend fails", async () => {
    arrangeSelections([
      { storageBackend: "r2", storageKey: "accounts/owner/assets/71/full.webp" },
      { storageBackend: "legacy-object", storageKey: "/bucket/thumb.webp" },
    ]);
    mocks.deleteTrackedAssetStorageObjects.mockRejectedValueOnce(
      new Error("legacy object provider unavailable"),
    );

    await expect(runGdprErasure("owner")).rejects.toThrow("legacy object provider unavailable");

    expect(mocks.delete).not.toHaveBeenCalled();
    expect(mocks.releaseProductionDatabasesForHardDelete).not.toHaveBeenCalled();
    expect(mocks.destroyContainer).not.toHaveBeenCalled();
  });
});
