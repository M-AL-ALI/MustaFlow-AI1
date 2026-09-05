import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  class AssetAdmissionError extends Error {
    constructor(
      public readonly code: string,
      public readonly status: number,
    ) {
      super(code);
    }
  }
  return {
    AssetAdmissionError,
    select: vi.fn(),
    transaction: vi.fn(),
    poolConnect: vi.fn(),
    poolQuery: vi.fn(),
    poolRelease: vi.fn(),
    canonicalizeSurvivingAssetAliases: vi.fn(async () => undefined),
    txUpdateReturning: vi.fn(async () => [{ id: 7 }]),
    txDeleteWhere: vi.fn(async () => []),
    deleteReadyAsset: vi.fn(),
    recordAssetDeleted: vi.fn(async () => undefined),
    deleteTrackedAssetStorageObjects: vi.fn(async () => undefined),
  };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return {
    ...actual,
    db: {
      select: mocks.select,
      transaction: mocks.transaction,
    },
    pool: { connect: mocks.poolConnect },
  };
});
vi.mock("../lib/auth", () => ({ checkProjectAccess: vi.fn() }));
vi.mock("../lib/image-provider", () => ({ isImageProviderConfigured: vi.fn() }));
vi.mock("../lib/image-generation-jobs", () => ({
  enqueueImageJob: vi.fn(),
  getJob: vi.fn(),
  preflightImageJobs: vi.fn(),
  enqueueImageEditJob: vi.fn(),
}));
vi.mock("../lib/image-storage", () => ({
  deleteStoredImageObjects: vi.fn(),
  getImageBuffer: vi.fn(),
  storeUploadedImage: vi.fn(),
}));
vi.mock("../lib/public-ai/authed-user", () => ({ resolveTierForUser: vi.fn() }));
vi.mock("../lib/public-ai/ora-usage", () => ({
  consumeOraQuota: vi.fn(),
  refundOraQuota: vi.fn(),
}));
vi.mock("../lib/project-lifecycle", () => ({
  requireActiveProjectLifecycleFor: vi.fn(),
}));
vi.mock("../lib/asset-registry", () => {
  return {
    AssetAdmissionError: mocks.AssetAdmissionError,
    beginAssetUpload: vi.fn(),
    completeAsset: vi.fn(),
    deleteReadyAsset: mocks.deleteReadyAsset,
    recordAssetDeleted: mocks.recordAssetDeleted,
    rejectReservedAsset: vi.fn(),
    reserveAsset: vi.fn(),
  };
});
vi.mock("../lib/project-purge-resources", () => ({
  canonicalizeSurvivingAssetAliases: mocks.canonicalizeSurvivingAssetAliases,
}));
vi.mock("../lib/asset-storage-cleanup", () => ({
  deleteTrackedAssetStorageObjects: mocks.deleteTrackedAssetStorageObjects,
}));
vi.mock("../lib/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import imageGenRouter from "./image-gen";

const storageObjects = [
  {
    storageKey: "accounts/owner/assets/71/full.webp",
    storageBackend: "r2",
    sizeBytes: 80,
  },
  {
    storageKey: "accounts/owner/assets/71/thumb.webp",
    storageBackend: "r2",
    sizeBytes: 20,
  },
];

function appAsOwner() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "owner";
    next();
  });
  app.use("/api", imageGenRouter);
  return app;
}

describe("DELETE /images/:id physical storage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.select.mockImplementation((selection: Record<string, unknown>) => {
      const rows = Object.hasOwn(selection, "assetId")
        ? [{ id: 7, assetId: 71, projectId: null }]
        : [{ projectId: null }];
      const whereResult = Object.assign(Promise.resolve(rows), {
        limit: vi.fn(async () => rows),
      });
      return { from: vi.fn(() => ({ where: vi.fn(() => whereResult) })) };
    });
    const tx = {
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn(() => ({ returning: mocks.txUpdateReturning })),
        })),
      })),
      delete: vi.fn(() => ({ where: mocks.txDeleteWhere })),
    };
    mocks.transaction.mockImplementation(async (work: (value: typeof tx) => unknown) => work(tx));
    mocks.deleteReadyAsset.mockResolvedValue({
      storageKey: storageObjects[0]!.storageKey,
      storageBackend: "r2",
      sizeBytes: 100,
      storageObjects,
    });
    mocks.recordAssetDeleted.mockResolvedValue(undefined);
    mocks.deleteTrackedAssetStorageObjects.mockResolvedValue(undefined);
    mocks.poolQuery.mockImplementation(async (statement: string) => {
      if (statement.includes("SELECT id FROM assets")) return { rows: [{ id: 71 }], rowCount: 1 };
      if (statement.includes("UPDATE generated_images")) return { rows: [{ id: 7 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    });
    mocks.poolConnect.mockResolvedValue({
      query: mocks.poolQuery,
      release: mocks.poolRelease,
    });
  });

  it("deletes every tracked physical object before completing the asset receipt", async () => {
    const response = await request(appAsOwner()).delete("/api/images/7");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ success: true, storageCleanup: "complete" });
    expect(mocks.deleteTrackedAssetStorageObjects).toHaveBeenCalledWith(storageObjects);
    expect(mocks.deleteReadyAsset).toHaveBeenCalledWith({
      assetId: 71,
      userId: "owner",
      generatedImageIdBeingDeleted: 7,
      productScope: "nabuflow",
    });
    expect(mocks.deleteReadyAsset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.transaction.mock.invocationCallOrder[0]!,
    );
    expect(mocks.recordAssetDeleted).toHaveBeenCalledWith({
      assetId: 71,
      userId: "owner",
      sizeBytes: 100,
    });
    expect(mocks.deleteTrackedAssetStorageObjects.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.recordAssetDeleted.mock.invocationCallOrder[0]!,
    );
  });

  it("returns 202 and leaves the durable deleting claim unfinalized for retry", async () => {
    mocks.deleteTrackedAssetStorageObjects.mockRejectedValueOnce(
      new Error("provider temporarily unavailable"),
    );

    const response = await request(appAsOwner()).delete("/api/images/7");

    expect(response.status).toBe(202);
    expect(response.body).toEqual({ success: true, storageCleanup: "pending" });
    expect(mocks.deleteReadyAsset).toHaveBeenCalledWith({
      assetId: 71,
      userId: "owner",
      generatedImageIdBeingDeleted: 7,
      productScope: "nabuflow",
    });
    expect(mocks.deleteTrackedAssetStorageObjects).toHaveBeenCalledWith(storageObjects);
    expect(mocks.recordAssetDeleted).not.toHaveBeenCalled();
  });

  it("rewrites every surviving legacy alias under the asset lock before hiding the gallery row", async () => {
    mocks.deleteReadyAsset.mockRejectedValueOnce(
      new mocks.AssetAdmissionError("asset_referenced", 409),
    );

    const response = await request(appAsOwner()).delete("/api/images/7");

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      success: true,
      storageCleanup: "retained-while-referenced",
    });
    expect(mocks.poolQuery.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(String(mocks.poolQuery.mock.calls[1]?.[0])).toContain("FOR UPDATE");
    expect(mocks.canonicalizeSurvivingAssetAliases).toHaveBeenCalledWith(
      expect.any(Object),
      null,
      71,
    );
    expect(mocks.canonicalizeSurvivingAssetAliases.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.poolQuery.mock.invocationCallOrder.find((_order, index) =>
        String(mocks.poolQuery.mock.calls[index]?.[0]).includes("UPDATE generated_images"),
      )!,
    );
    expect(mocks.poolQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it.each(["007", "+7", "7e0", "7.0"])(
    "denies non-canonical image id %s without reading storage",
    async (id) => {
      const response = await request(appAsOwner()).delete(`/api/images/${encodeURIComponent(id)}`);
      expect(response.status).toBe(404);
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.deleteReadyAsset).not.toHaveBeenCalled();
    },
  );
});
