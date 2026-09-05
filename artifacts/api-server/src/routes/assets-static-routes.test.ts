import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  return {
    select: vi.fn(),
    getQuota: vi.fn(),
    subscriptions: vi.fn(),
    lifecycle: vi.fn(),
    createAltTextEvent: vi.fn(),
  };
});

vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/db")>()),
  db: { select: mocks.select },
}));
vi.mock("../lib/auth", () => ({
  checkProjectAccess: vi.fn(),
  requireProjectAccess: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/support-access", () => ({ findLiveSupportGrant: vi.fn() }));
vi.mock("../lib/asset-analysis", () => ({
  analyzeAssetBuffer: vi.fn(),
  MAX_INLINE_ASSET_ANALYSIS_BYTES: 1024,
}));
vi.mock("../lib/asset-image-normalization", () => ({ normalizeUploadedImage: vi.fn() }));
vi.mock("../lib/asset-alt-text-analysis", () => ({
  createAssetAltTextEvent: mocks.createAltTextEvent,
  enqueueAutomaticAssetAltText: vi.fn(),
  runAssetAltTextAnalysis: vi.fn(),
}));
vi.mock("../lib/asset-derivatives", () => ({
  ASSET_DERIVATIVE_PRESETS: [],
  generateAssetDerivatives: vi.fn(),
}));
vi.mock("../lib/asset-registry", () => ({
  AssetAdmissionError: class extends Error {},
  beginAssetUpload: vi.fn(),
  cancelReservedAsset: vi.fn(),
  completeAsset: vi.fn(),
  deleteReadyAsset: vi.fn(),
  getQuota: mocks.getQuota,
  recordAssetDeleted: vi.fn(),
  rejectReservedAsset: vi.fn(),
  reserveAsset: vi.fn(),
}));
vi.mock("../lib/asset-r2", () => ({
  assetR2Configured: vi.fn(),
  deleteAssetObject: vi.fn(),
  openAsset: vi.fn(),
  putAssetBuffer: vi.fn(),
  putAssetStream: vi.fn(),
  readAssetBuffer: vi.fn(),
}));
vi.mock("../lib/asset-storage-billing", () => ({
  ASSET_STORAGE_PLANS: {
    small: { sku: "small", label: "Extra storage", allowanceBytes: 1024, monthlyCents: 100 },
  },
  createAssetStorageCheckout: vi.fn(),
  isAssetStorageSku: (sku: unknown) => sku === "small",
  listAssetStorageSubscriptions: mocks.subscriptions,
}));
vi.mock("../lib/nabuflow-stripe", () => ({ requireStripe: vi.fn() }));
vi.mock("./billing", () => ({ ensureStripeCustomer: vi.fn() }));
vi.mock("../lib/artifacts", () => ({ resolveArtifactId: vi.fn() }));
vi.mock("../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("../lib/asset-storage-cleanup", () => ({
  deleteTrackedAssetStorageObjects: vi.fn(),
}));
vi.mock("../lib/project-lifecycle", () => ({
  holdResponseProjectLifecycleSession: vi.fn(),
  requireActiveProjectLifecycleFor: mocks.lifecycle,
  withResponseProjectLifecycleTransaction: vi.fn(),
}));
vi.mock("../lib/project-file-asset-usage", () => ({
  PROJECT_FILE_ASSET_USAGE_CONSUMER: "project-file",
  reconcileProjectFileAssetUsage: vi.fn(),
}));
vi.mock("../lib/project-file-asset-reference", () => ({
  encodeProjectFileAssetReference: vi.fn(),
  PROJECT_FILE_ASSET_HISTORY_CONSUMER: "project-file-history",
}));
vi.mock("../lib/asset-project-use", () => ({
  assertExistingProjectAssetUse: vi.fn(),
  grantExplicitProjectAssetUse: vi.fn(),
}));

import assetsRouter from "./assets";

function appAs(userId: string | null = "owner") {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (userId) req.userId = userId;
    next();
  });
  app.use("/api", assetsRouter);
  return app;
}

describe("static storage routes and dynamic asset fences", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getQuota.mockResolvedValue({ usedBytes: 100, reservedBytes: 20, limitBytes: 1024 });
    mocks.subscriptions.mockResolvedValue([]);
    mocks.select.mockImplementation(() => ({
      from: () => ({
        where: async () => [{ ownerUserId: "owner", actorUserId: "owner", projectId: 77 }],
      }),
    }));
    mocks.lifecycle.mockImplementation(async (_id, res) => {
      res.status(409).json({ code: "project_inactive" });
    });
  });

  it("serves storage plans without treating their static name as an asset id", async () => {
    const response = await request(appAs()).get("/api/assets/storage-plans");
    expect(response.status).toBe(200);
    expect(response.body.quota).toEqual({ usedBytes: 100, reservedBytes: 20, limitBytes: 1024 });
    expect(mocks.getQuota).toHaveBeenCalledWith("owner");
    expect(mocks.subscriptions).toHaveBeenCalledWith("owner");
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it("reaches checkout validation without invoking a provider or asset-id lookup", async () => {
    const response = await request(appAs())
      .post("/api/assets/storage-checkout")
      .send({ sku: "invalid" });
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Choose one of the available storage options.");
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.lifecycle).not.toHaveBeenCalled();
  });

  it.each([
    ["get", "/api/assets/storage-plans"],
    ["post", "/api/assets/storage-checkout"],
  ] as const)("still requires authentication for %s %s", async (method, path) => {
    const response = await request(appAs(null))[method](path);
    expect(response.status).toBe(401);
    expect(mocks.getQuota).not.toHaveBeenCalled();
    expect(mocks.subscriptions).not.toHaveBeenCalled();
  });

  it.each([
    ["post", "/api/assets/7/alt-text-proposal"],
    ["put", "/api/assets/7/content"],
    ["patch", "/api/assets/7"],
    ["delete", "/api/assets/7"],
    ["delete", "/api/assets/7/reservation"],
    ["post", "/api/assets/7/derivatives"],
  ] as const)("keeps %s %s behind the lifecycle fence", async (method, path) => {
    const response = await request(appAs())[method](path).send({});
    expect(response.status).toBe(409);
    expect(response.body.code).toBe("project_inactive");
    expect(mocks.lifecycle).toHaveBeenCalledWith(77, expect.anything(), expect.any(Function));
    expect(mocks.createAltTextEvent).not.toHaveBeenCalled();
  });

  it("continues to reject non-canonical dynamic asset ids", async () => {
    const response = await request(appAs()).get("/api/assets/not-an-id/content");
    expect(response.status).toBe(404);
    expect(response.body.code).toBe("asset_not_found");
    expect(mocks.select).not.toHaveBeenCalled();
  });
});
