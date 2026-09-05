import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  class AssetAdmissionError extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  }
  return {
    AssetAdmissionError,
    select: vi.fn(),
    enqueue: vi.fn(),
    enqueueEdit: vi.fn(),
    refundOraQuota: vi.fn(),
  };
});

vi.mock("@workspace/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@workspace/db")>()),
  db: { select: mocks.select },
}));
vi.mock("../lib/auth", () => ({ checkProjectAccess: vi.fn() }));
vi.mock("../lib/image-provider", () => ({ isImageProviderConfigured: () => true }));
vi.mock("../lib/image-generation-jobs", () => ({
  enqueueImageJob: mocks.enqueue,
  enqueueImageEditJob: mocks.enqueueEdit,
  getJob: vi.fn(),
  preflightImageJobs: vi.fn(),
}));
vi.mock("../lib/image-storage", () => ({
  deleteStoredImageObjects: vi.fn(),
  getImageBuffer: vi.fn(),
  storeUploadedImage: vi.fn(),
}));
vi.mock("./image-credits", () => ({
  IMAGE_CREDIT_COSTS: { draft: 1, standard: 3, high: 6 },
}));
vi.mock("../lib/public-ai/authed-user", () => ({
  resolveTierForUser: async () => ({ tier: "free" }),
}));
vi.mock("../lib/public-ai/ora-usage", () => ({
  consumeOraQuota: vi.fn(),
  refundOraQuota: mocks.refundOraQuota,
}));
vi.mock("../lib/project-lifecycle", () => ({
  requireActiveProjectLifecycleFor: vi.fn(),
}));
vi.mock("../lib/asset-registry", () => ({
  AssetAdmissionError: mocks.AssetAdmissionError,
  beginAssetUpload: vi.fn(),
  completeAsset: vi.fn(),
  deleteReadyAsset: vi.fn(),
  recordAssetDeleted: vi.fn(),
  rejectReservedAsset: vi.fn(),
  reserveAsset: vi.fn(),
}));
vi.mock("../lib/project-purge-resources", () => ({
  canonicalizeSurvivingAssetAliases: vi.fn(),
}));
vi.mock("../lib/asset-storage-cleanup", () => ({
  deleteTrackedAssetStorageObjects: vi.fn(),
}));
vi.mock("../lib/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import imageGenRouter from "./image-gen";

const message =
  "Your storage total is still being verified. Please try again after storage reconciliation finishes.";

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

describe("image admission error responses", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    const error = new mocks.AssetAdmissionError(
      "asset_storage_reconciliation_required",
      409,
      message,
    );
    mocks.enqueue.mockRejectedValue(error);
    mocks.enqueueEdit.mockRejectedValue(error);
    mocks.select.mockImplementation(() => ({
      from: () => ({
        where: async () => [
          {
            id: 7,
            assetId: 71,
            productScope: "nabuflow",
            projectId: null,
            status: "completed",
            fileUrl: "/api/assets/71/content",
            storageKey: "accounts/owner/assets/71/full.webp",
            aspectRatio: "1:1",
          },
        ],
      }),
    }));
  });

  it.each([1, 2, 4])(
    "preserves the reconciliation refusal for %i variations",
    async (variationCount) => {
      const response = await request(appAsOwner()).post("/api/images/generate").send({
        prompt: "A quiet mountain landscape",
        quality: "draft",
        aspectRatio: "1:1",
        style: "vivid",
        purpose: "general",
        transparentBackground: false,
        variationCount,
      });
      expect(mocks.enqueue).toHaveBeenCalled();
      expect(response.status).toBe(409);
      expect(response.body).toEqual({
        code: "asset_storage_reconciliation_required",
        error: message,
      });
      expect(mocks.refundOraQuota).not.toHaveBeenCalled();
    },
  );

  it("preserves the same code, status and message for an image edit", async () => {
    const response = await request(appAsOwner())
      .post("/api/images/7/edit")
      .send({ instruction: "Make the sky brighter", quality: "standard" });
    expect(mocks.enqueueEdit).toHaveBeenCalled();
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: "asset_storage_reconciliation_required",
      error: message,
    });
    expect(mocks.refundOraQuota).not.toHaveBeenCalled();
  });

  it("preserves other typed admission statuses", async () => {
    mocks.enqueue.mockRejectedValueOnce(
      new mocks.AssetAdmissionError("asset_not_found", 404, "That asset is not available."),
    );
    const response = await request(appAsOwner()).post("/api/images/generate").send({
      prompt: "A quiet mountain landscape",
      quality: "standard",
      aspectRatio: "1:1",
      style: "vivid",
      variationCount: 1,
    });
    expect(response.status).toBe(404);
    expect(response.body).toEqual({
      code: "asset_not_found",
      error: "That asset is not available.",
    });
  });

  it("keeps unknown errors generic", async () => {
    mocks.enqueue.mockRejectedValueOnce(new Error("internal diagnostic"));
    const response = await request(appAsOwner()).post("/api/images/generate").send({
      prompt: "A quiet mountain landscape",
      quality: "standard",
      aspectRatio: "1:1",
      style: "vivid",
      variationCount: 1,
    });
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "Image generation failed" });
  });
});
