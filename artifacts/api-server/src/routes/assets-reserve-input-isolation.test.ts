import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    reserveAsset: vi.fn(),
    assetR2Configured: vi.fn(() => true),
  };
});

vi.mock("@workspace/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@workspace/db")>();
  return { ...actual, db: {} };
});
vi.mock("../lib/auth", () => ({
  checkProjectAccess: vi.fn(),
  requireProjectAccess: vi.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
vi.mock("../lib/support-access", () => ({ findLiveSupportGrant: vi.fn() }));
vi.mock("../lib/asset-analysis", () => ({
  analyzeAssetBuffer: vi.fn(),
  MAX_INLINE_ASSET_ANALYSIS_BYTES: 1024,
}));
vi.mock("../lib/asset-image-normalization", () => ({ normalizeUploadedImage: vi.fn() }));
vi.mock("../lib/asset-alt-text-analysis", () => ({
  createAssetAltTextEvent: vi.fn(),
  enqueueAutomaticAssetAltText: vi.fn(),
  runAssetAltTextAnalysis: vi.fn(),
}));
vi.mock("../lib/asset-derivatives", () => ({
  ASSET_DERIVATIVE_PRESETS: {},
  generateAssetDerivatives: vi.fn(),
}));
vi.mock("../lib/asset-contract", () => ({
  acceptsDeclaredAsset: vi.fn(() => true),
  ASSET_ERROR_MESSAGES: {
    asset_format_unsupported: "Unsupported asset format.",
    asset_storage_unavailable: "Asset storage unavailable.",
  },
  sniffAsset: vi.fn(),
}));
vi.mock("../lib/asset-registry", () => {
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
    beginAssetUpload: vi.fn(),
    cancelReservedAsset: vi.fn(),
    completeAsset: vi.fn(),
    deleteReadyAsset: vi.fn(),
    getQuota: vi.fn(),
    recordAssetDeleted: vi.fn(),
    rejectReservedAsset: vi.fn(),
    reserveAsset: mocks.reserveAsset,
  };
});
vi.mock("../lib/asset-r2", () => ({
  assetR2Configured: mocks.assetR2Configured,
  deleteAssetObject: vi.fn(),
  openAsset: vi.fn(),
  putAssetBuffer: vi.fn(),
  putAssetStream: vi.fn(),
  readAssetBuffer: vi.fn(),
}));
vi.mock("../lib/asset-storage-billing", () => ({
  ASSET_STORAGE_PLANS: [],
  createAssetStorageCheckout: vi.fn(),
  isAssetStorageSku: vi.fn(),
  listAssetStorageSubscriptions: vi.fn(),
}));
vi.mock("../lib/nabuflow-stripe", () => ({ requireStripe: vi.fn() }));
vi.mock("./billing", () => ({ ensureStripeCustomer: vi.fn() }));
vi.mock("../lib/artifacts", () => ({ resolveArtifactId: vi.fn() }));
vi.mock("../lib/asset-storage-cleanup", () => ({
  deleteTrackedAssetStorageObjects: vi.fn(),
}));
vi.mock("../lib/project-lifecycle", () => ({
  holdResponseProjectLifecycleSession: vi.fn(),
  requireActiveProjectLifecycleFor: vi.fn(),
}));
vi.mock("../lib/project-file-asset-usage", () => ({
  PROJECT_FILE_ASSET_USAGE_CONSUMER: "project-file",
  reconcileProjectFileAssetUsage: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import assetsRouter from "./assets";

function appAsOwner() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = "owner";
    next();
  });
  app.use(assetsRouter);
  return app;
}

describe("public asset reservation input isolation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assetR2Configured.mockReturnValue(true);
    mocks.reserveAsset.mockResolvedValue({
      id: 71,
      filename: "portrait.png",
      sizeBytes: 120,
      mimeType: "image/png",
    });
  });

  it("accepts only the resized receipt, not caller lineage, kind, thread, or arbitrary context", async () => {
    const response = await request(appAsOwner())
      .post("/assets/reserve")
      .send({
        filename: "portrait.png",
        mimeType: "image/png",
        sizeBytes: 120,
        source: "picker",
        productScope: "ora",
        product_scope: "ora",
        origin: "ora",
        versionId: 991,
        taskId: 992,
        threadKey: "another-thread",
        kind: "recording",
        context: {
          resized: true,
          productScope: "ora",
          derivativeOfAssetId: 993,
          arbitrary: "caller-controlled",
        },
      });

    expect(response.status).toBe(201);
    expect(mocks.reserveAsset).toHaveBeenCalledOnce();
    const admission = mocks.reserveAsset.mock.calls[0]?.[0];
    expect(admission).toEqual({
      productScope: "nabuflow",
      ownerUserId: "owner",
      actorUserId: "owner",
      projectId: null,
      threadKey: null,
      scope: "account",
      kind: "image",
      source: "picker",
      filename: "portrait.png",
      mimeType: "image/png",
      sizeBytes: 120,
      context: { resized: true },
    });
    expect(admission).not.toHaveProperty("versionId");
    expect(admission).not.toHaveProperty("taskId");
  });
});
