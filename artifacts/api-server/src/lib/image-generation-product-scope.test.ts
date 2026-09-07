import { readFileSync } from "node:fs";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { generatedImagesTable, userCreditsTable, userSubscriptionsTable } from "@workspace/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  select: vi.fn(),
  insert: vi.fn(),
  values: vi.fn(),
  update: vi.fn(),
  reserve: vi.fn(),
  begin: vi.fn(),
  complete: vi.fn(),
  reject: vi.fn(),
  deduct: vi.fn(),
  refund: vi.fn(),
  generate: vi.fn(),
  edit: vi.fn(),
  persistOra: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { select: mocks.select, insert: mocks.insert, update: mocks.update },
  assetsTable: {
    id: "id",
    storageKey: "storage_key",
    ownerUserId: "owner_user_id",
    productScope: "product_scope",
    state: "state",
    deletedAt: "deleted_at",
  },
  generatedImagesTable: {
    id: "id",
    userId: "user_id",
    assetId: "asset_id",
    productScope: "product_scope",
    projectId: "project_id",
    aspectRatio: "aspect_ratio",
    status: "status",
    createdAt: "created_at",
    deletedAt: "deleted_at",
  },
  userCreditsTable: { balance: "balance", userId: "user_id" },
  userSubscriptionsTable: { tier: "tier", status: "status", userId: "user_id" },
  TIER_MONTHLY_IMAGE_CAP: { free: 20 },
}));
vi.mock("./image-provider", () => ({ generateImage: mocks.generate, editImage: mocks.edit }));
vi.mock("./image-safety", () => ({ validateImagePrompt: () => ({ safe: true }) }));
vi.mock("./image-storage", () => ({
  deleteStoredImageObjects: vi.fn(async () => undefined),
  getImageBuffer: vi.fn(async () => Buffer.from("image")),
  storeGeneratedImage: vi.fn(async () => ({
    fileUrl: "https://private.invalid/image.webp",
    thumbnailUrl: null,
    storageKey: "assets/test/image.webp",
    storageObjects: [],
  })),
  storeEditedImage: vi.fn(),
}));
vi.mock("../routes/image-credits", () => ({
  deductCreditsAtomic: mocks.deduct,
  refundCredits: mocks.refund,
  IMAGE_CREDIT_COSTS: { standard: 3 },
  IMAGE_RATE_LIMIT_PER_HOUR: 10,
  IMAGE_DAILY_LIMIT: 20,
}));
vi.mock("./billing-privileges", () => ({ isBillingPrivileged: vi.fn(async () => false) }));
vi.mock("./public-ai/ora-usage", () => ({ refundOraQuota: vi.fn(async () => undefined) }));
vi.mock("./public-ai/model-router", () => ({
  normalizeOraPlanTier: () => "free",
  openAiModelForOraImage: () => "test-model",
  oraImageQualityForPlan: () => "standard",
}));
vi.mock("./public-ai/image-quality", () => ({
  buildOraImageEditProfile: () => ({ quality: "standard", instruction: "edit" }),
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./asset-registry", () => ({
  AssetAdmissionError: class extends Error {
    constructor(
      public code: string,
      public status: number,
    ) {
      super(code);
    }
  },
  beginAssetUpload: mocks.begin,
  completeAsset: mocks.complete,
  rejectReservedAsset: mocks.reject,
  reserveAssetAgainstAvailableQuota: mocks.reserve,
}));
vi.mock("./project-lifecycle", () => ({
  acquireProjectLifecycleSession: vi.fn(async () => ({ release: async () => undefined })),
  registerProjectWorkController: vi.fn(() => () => undefined),
}));
vi.mock("./ora-assets", () => ({ persistOraAsset: mocks.persistOra }));

import {
  enforceMonthlyImageCap,
  enqueueImageEditJob,
  enqueueImageJob,
  getJob,
  preflightImageJobs,
  type EnqueueImageEditJobOpts,
  type EnqueueImageJobOpts,
} from "./image-generation-jobs";

const base = { userId: "product-scope-test", prompt: "A mountain lake", subscriptionTier: "free" };
const editBase = {
  userId: base.userId,
  parentImageId: 12,
  parentStorageKey: "untrusted/key",
  parentFileUrl: "https://untrusted.invalid/image",
  parentAspectRatio: "1:1",
  instruction: "Make the sky blue",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.select.mockImplementation(() => ({
    from: () => ({
      where: async () => [],
      innerJoin: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
  }));
  mocks.insert.mockReturnValue({ values: mocks.values });
  mocks.values.mockReturnValue({ returning: async () => [{ id: 23 }] });
  mocks.update.mockReturnValue({ set: () => ({ where: async () => [] }) });
  mocks.reserve.mockReset().mockImplementation(async (input: { productScope: string }) => ({
    id: 81,
    storageKey: "assets/test/image.webp",
    productScope: input.productScope,
  }));
  mocks.begin.mockResolvedValue({ id: 81 });
  mocks.complete.mockResolvedValue(undefined);
  mocks.reject.mockResolvedValue(undefined);
  mocks.deduct.mockResolvedValue({ charged: 3, balance: 20 });
  mocks.refund.mockResolvedValue(undefined);
  mocks.generate.mockResolvedValue({
    openaiUrl: "data:image/webp;base64,aW1hZ2U=",
    providerName: "test",
    modelName: "test-model",
    quality: "standard",
    revisedPrompt: null,
  });
  mocks.persistOra.mockResolvedValue(92);
});

describe("server-assigned image product scope", () => {
  it.each([undefined, null, "unknown"])(
    "rejects missing or unknown scope before work: %s",
    async (productScope) => {
      await expect(
        enqueueImageJob({ ...base, productScope } as EnqueueImageJobOpts),
      ).rejects.toThrow();
      await expect(
        enqueueImageEditJob({ ...editBase, productScope } as EnqueueImageEditJobOpts),
      ).rejects.toThrow();
      expect(mocks.select).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
      expect(mocks.reserve).not.toHaveBeenCalled();
      expect(mocks.deduct).not.toHaveBeenCalled();
      expect(mocks.generate).not.toHaveBeenCalled();
      expect(mocks.edit).not.toHaveBeenCalled();
    },
  );

  it("rejects mixed project namespaces and a billing-mode scope override before work", async () => {
    await expect(enqueueImageJob({ ...base, productScope: "ora", projectId: 7 })).rejects.toThrow();
    await expect(
      enqueueImageJob({ ...base, productScope: "nabuflow", oraProjectId: 7 }),
    ).rejects.toThrow();
    await expect(
      enqueueImageEditJob({
        ...editBase,
        productScope: "nabuflow",
        billingMode: "ora",
      }),
    ).rejects.toThrow();
    expect(mocks.select).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.deduct).not.toHaveBeenCalled();
  });

  it("requires an authoritative matching parent, not caller storage metadata", async () => {
    await expect(
      enqueueImageEditJob({
        ...editBase,
        productScope: "ora",
        billingMode: "ora",
      }),
    ).rejects.toThrow("asset_not_found");
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
  });

  it("stamps NabuFlow receipts and never accepts the old automatic mirror flag", async () => {
    const input = { ...base, productScope: "nabuflow" as const, persistToOraLibrary: true };
    const { jobId } = await enqueueImageJob(input);
    await vi.waitFor(() => expect(getJob(jobId)?.status).toBe("completed"));
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ productScope: "nabuflow" }),
    );
    expect(mocks.reserve).toHaveBeenCalledWith(
      expect.objectContaining({ productScope: "nabuflow" }),
    );
    expect(getJob(jobId)).toMatchObject({
      productScope: "nabuflow",
      fileUrl: "/api/assets/81/content",
    });
    expect(mocks.persistOra).not.toHaveBeenCalled();
  });

  it("links known Ora output using its scope, independently of credit cost", async () => {
    const { jobId } = await enqueueImageJob({ ...base, productScope: "ora" });
    await vi.waitFor(() => expect(getJob(jobId)?.status).toBe("completed"));
    await vi.waitFor(() => expect(mocks.persistOra).toHaveBeenCalled());
    expect(mocks.values).toHaveBeenCalledWith(
      expect.objectContaining({ productScope: "ora", creditCost: 3 }),
    );
    expect(getJob(jobId)?.fileUrl).toBe("/api/ora/canonical-assets/81/content");
    expect(mocks.persistOra).toHaveBeenCalledWith(expect.objectContaining({ unifiedAssetId: 81 }));
  });

  it("does not spend credits or call a provider when reservation fails", async () => {
    mocks.reserve.mockRejectedValueOnce(new Error("reservation failed"));
    await expect(enqueueImageJob({ ...base, productScope: "nabuflow" })).rejects.toThrow(
      "reservation failed",
    );
    expect(mocks.deduct).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

type ImageUsage = { monthly: number; hourly: number; daily: number };

function mockProductImageUsage(nabuflow: ImageUsage, ora: ImageUsage, creditBalance = 100) {
  const dialect = new PgDialect();
  const imageScopes: Array<"nabuflow" | "ora" | null> = [];
  const subscriptionReads: unknown[] = [];
  mocks.select.mockImplementation(() => ({
    from: (table: unknown) => ({
      where: async (condition: SQL) => {
        if (table === userSubscriptionsTable) {
          subscriptionReads.push(condition);
          return [{ tier: "free", status: "active" }];
        }
        if (table === userCreditsTable) return [{ balance: creditBalance }];
        if (table !== generatedImagesTable) throw new Error("Unexpected quota query");
        const query = dialect.sqlToQuery(condition);
        const scope = query.params.includes("product_scope")
          ? query.params.includes("nabuflow")
            ? "nabuflow"
            : query.params.includes("ora")
              ? "ora"
              : null
          : null;
        imageScopes.push(scope);
        const window = query.sql.includes("interval '1 hour'")
          ? "hourly"
          : query.sql.includes("interval '24 hours'")
            ? "daily"
            : "monthly";
        const used =
          scope === "nabuflow"
            ? nabuflow[window]
            : scope === "ora"
              ? ora[window]
              : nabuflow[window] + ora[window];
        return [{ c: used }];
      },
    }),
  }));
  return { imageScopes, subscriptionReads };
}

describe("product-isolated image allowances", () => {
  const small = { monthly: 3, hourly: 1, daily: 1 };
  const exhausted = { monthly: 99, hourly: 99, daily: 99 };
  const empty = { monthly: 0, hourly: 0, daily: 0 };

  it("excludes Ora images from the NabuFlow monthly allowance", async () => {
    const queries = mockProductImageUsage(small, exhausted);
    await expect(enforceMonthlyImageCap(base.userId, 1)).resolves.toBeUndefined();
    expect(queries.imageScopes).toEqual(["nabuflow"]);
  });

  it("isolates all three NabuFlow batch preflight windows", async () => {
    const queries = mockProductImageUsage(small, exhausted);
    await expect(preflightImageJobs(base.userId, 2, "standard")).resolves.toBeUndefined();
    expect(queries.imageScopes).toEqual(["nabuflow", "nabuflow", "nabuflow"]);
  });

  it.each([
    { scope: "monthly", usage: { monthly: 20, hourly: 0, daily: 0 }, code: "MONTHLY_CAP_REACHED" },
    { scope: "hourly", usage: { monthly: 10, hourly: 10, daily: 10 }, code: "RATE_LIMITED" },
    { scope: "daily", usage: { monthly: 19, hourly: 0, daily: 20 }, code: "RATE_LIMITED" },
  ])("still enforces the product's own $scope limit", async ({ scope, usage, code }) => {
    mockProductImageUsage(usage, empty);
    await expect(preflightImageJobs(base.userId, 1, "standard")).rejects.toMatchObject({
      code,
      scope,
    });
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.deduct).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });

  it("preserves credit preflight after excluding another product's usage", async () => {
    mockProductImageUsage(small, exhausted, 0);
    await expect(preflightImageJobs(base.userId, 2, "standard")).rejects.toMatchObject({
      code: "INSUFFICIENT_CREDITS",
      balance: 0,
      required: 6,
    });
  });

  it("admits NabuFlow generation despite exhausted Ora usage", async () => {
    const queries = mockProductImageUsage(small, exhausted);
    const { jobId } = await enqueueImageJob({ ...base, productScope: "nabuflow" });
    await vi.waitFor(() => expect(getJob(jobId)?.status).toBe("completed"));
    expect(queries.imageScopes).toEqual(["nabuflow", "nabuflow", "nabuflow"]);
    expect(mocks.persistOra).not.toHaveBeenCalled();
  });

  it("never applies NabuFlow subscription limits to Ora generation", async () => {
    const queries = mockProductImageUsage(exhausted, small);
    const { jobId } = await enqueueImageJob({ ...base, productScope: "ora" });
    await vi.waitFor(() => expect(getJob(jobId)?.status).toBe("completed"));
    expect(queries.subscriptionReads).toEqual([]);
    expect(queries.imageScopes).toEqual(["ora", "ora"]);
  });

  it.each([
    { scope: "hourly", usage: { monthly: 10, hourly: 10, daily: 10 } },
    { scope: "daily", usage: { monthly: 20, hourly: 0, daily: 20 } },
  ])("still enforces Ora's own $scope rate limit", async ({ scope, usage }) => {
    const queries = mockProductImageUsage(exhausted, usage);
    await expect(enqueueImageJob({ ...base, productScope: "ora" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      scope,
    });
    expect(queries.subscriptionReads).toEqual([]);
    expect(queries.imageScopes.every((value) => value === "ora")).toBe(true);
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.deduct).not.toHaveBeenCalled();
    expect(mocks.generate).not.toHaveBeenCalled();
  });
});

describe("producer and Ora library access contracts", () => {
  const messages = readFileSync(new URL("../routes/messages.ts", import.meta.url), "utf8");
  const chat = readFileSync(new URL("../routes/public-ai/chat.ts", import.meta.url), "utf8");
  const ora = readFileSync(new URL("./ora-assets.ts", import.meta.url), "utf8");
  const routes = readFileSync(new URL("../routes/ora-assets.ts", import.meta.url), "utf8");

  it("stamps both inline producers and removes the project-chat Ora mirror", () => {
    expect(messages).toMatch(
      /enqueueImageJob\(\{\s+userId: imageOwner,\s+productScope: "nabuflow"/u,
    );
    expect(messages).not.toContain("persistToOraLibrary");
    expect(chat).toMatch(
      /userId: authed\.userId,\s+productScope: "ora",\s+prompt: imageProfile\.originalPrompt/u,
    );
    expect(chat).toContain('canonicalAssetContentUrl(pendingEditableAsset.id, "ora")');
  });

  it("filters Ora list/count/detail/version/restore access through canonical provenance", () => {
    expect(routes.match(/oraAssetProductScopePredicate\(\)/gu)).toHaveLength(6);
    expect(ora).toContain("AND product_scope='ora' AND deleted_at IS NULL");
    expect(ora).toContain("AND owned.product_scope='ora'");
    expect(ora).toContain("ora_assets.ora_project_id IS NOT DISTINCT FROM EXCLUDED.ora_project_id");
  });

  it("never treats legacy blobs, keys or mirrors as delivery authority", () => {
    expect(ora).not.toContain('if (row.data) return Buffer.from(row.data, "base64")');
    expect(ora).not.toContain("r2GetObject(");
    expect(ora).toContain('isOwnedReadyAssetForProduct(asset, row.userId, "ora")');
    expect(ora).toContain("readAssetBuffer(asset.storageKey");
    expect(ora).not.toMatch(/UPDATE\s+assets\s+SET\s+product_scope/iu);
    expect(ora).not.toMatch(/DELETE FROM ora_assets/iu);
  });
});
