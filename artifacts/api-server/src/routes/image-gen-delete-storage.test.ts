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
    canonicalizeSurvivingAssetAliases:
      vi.fn<typeof import("../lib/project-purge-resources").canonicalizeSurvivingAssetAliases>(),
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
vi.mock("../lib/asset-r2", () => ({
  deleteAssetObject: vi.fn(),
  headAssetObject: vi.fn(),
  openAsset: vi.fn(),
  putAssetStream: vi.fn(),
}));
vi.mock("../lib/snapshot-storage", () => ({
  deleteSnapshotBlob: vi.fn(),
  snapshotBlobExists: vi.fn(),
}));
vi.mock("../lib/objectStorage", () => ({
  ObjectNotFoundError: class extends Error {},
  ObjectStorageService: class {},
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
    mocks.canonicalizeSurvivingAssetAliases.mockReset().mockResolvedValue(undefined);
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

  it.each([
    { label: "foreign Nabu", userId: "foreign-owner", scope: "nabuflow", allowed: false },
    { label: "same-owner Ora", userId: "owner", scope: "ora", allowed: false },
    { label: "foreign Ora", userId: "foreign-owner", scope: "ora", allowed: false },
    { label: "same-owner unknown-scope", userId: "owner", scope: null, allowed: false },
    { label: "same-owner Nabu", userId: "owner", scope: "nabuflow", allowed: true },
  ])(
    "keeps $label NULL-project aliases within authority during source gallery deletion",
    async ({ userId, scope, allowed }) => {
      const actual = await vi.importActual<typeof import("../lib/project-purge-resources")>(
        "../lib/project-purge-resources",
      );
      mocks.canonicalizeSurvivingAssetAliases.mockImplementationOnce(
        actual.canonicalizeSurvivingAssetAliases,
      );
      mocks.deleteReadyAsset.mockRejectedValueOnce(
        new mocks.AssetAdmissionError("asset_referenced", 409),
      );
      const alias = "/api/images/7/file";
      const canonical = "/api/assets/71/content";
      const images: Array<{
        id: number;
        asset_id: number;
        project_id: number | null;
        user_id: string;
        product_scope: string | null;
        file_url: string | null;
        thumbnail_url: string | null;
        deleted_at: string | null;
        updated_at: string;
      }> = [
        {
          id: 7,
          asset_id: 71,
          project_id: null,
          user_id: "owner",
          product_scope: "nabuflow",
          file_url: alias,
          thumbnail_url: null,
          deleted_at: null,
          updated_at: "before",
        },
        {
          id: 8,
          asset_id: 72,
          project_id: null,
          user_id: userId,
          product_scope: scope,
          file_url: alias,
          thumbnail_url: null,
          deleted_at: null,
          updated_at: "before",
        },
        {
          id: 9,
          asset_id: 73,
          project_id: null,
          user_id: userId,
          product_scope: scope,
          file_url: null,
          thumbnail_url: alias,
          deleted_at: null,
          updated_at: "before",
        },
        {
          id: 10,
          asset_id: 74,
          project_id: null,
          user_id: "foreign-owner",
          product_scope: "ora",
          file_url: alias,
          thumbnail_url: alias,
          deleted_at: "historical",
          updated_at: "before",
        },
      ];
      const before = images.map((row) => ({ ...row }));
      let usageRemoved = false;
      // Stateful SQL-contract substitute, not PostgreSQL or trigger validation.
      // In particular, NULL IS DISTINCT FROM NULL is false unless the query
      // explicitly admits NULL as "exclude no project".
      mocks.poolQuery.mockImplementation(
        async (statement: string, values: readonly unknown[] = []) => {
          const sql = statement.replace(/\s+/gu, " ").trim();
          if (sql.startsWith("SELECT id FROM assets")) {
            return { rows: [{ id: 71 }], rowCount: 1 };
          }
          if (sql.startsWith("SELECT '/api/images/'")) {
            return { rows: [{ alias }], rowCount: 1 };
          }
          if (sql.startsWith("SELECT product_scope, storage_backend FROM assets")) {
            return {
              rows: [{ product_scope: "nabuflow", storage_backend: "r2" }],
              rowCount: 1,
            };
          }
          if (sql.startsWith("WITH durable_reference_rows")) {
            const includesAccountRows = sql.includes(
              "($1::integer IS NULL OR image_row.project_id IS DISTINCT FROM $1)",
            );
            const exactAccountScope = sql.includes(
              "OR reference_row.reference_product_scope IS DISTINCT FROM authority.product_scope",
            );
            const candidates = images.filter(
              (row) =>
                row.deleted_at === null &&
                (row.project_id !== values[0] || (values[0] === null && includesAccountRows)) &&
                [row.file_url, row.thumbnail_url].some((url) => url?.includes(alias)),
            );
            const forbidden = candidates.some(
              (row) =>
                (row.product_scope !== null && row.product_scope !== "nabuflow") ||
                (row.project_id === null &&
                  (row.user_id !== "owner" ||
                    (exactAccountScope && row.product_scope !== "nabuflow"))),
            );
            return { rows: [{ allowed: !forbidden }], rowCount: 1 };
          }
          if (sql.startsWith("UPDATE generated_images SET file_url=")) {
            const liveOnly = sql.includes("generated_images.deleted_at IS NULL");
            const scopeGuard = sql.includes(
              "generated_images.product_scope=authority.product_scope",
            );
            const ownerGuard = sql.includes("generated_images.user_id=authority.owner_user_id");
            let rowCount = 0;
            for (const row of images) {
              if (
                (values[0] !== null && row.project_id === values[0]) ||
                (liveOnly && row.deleted_at !== null) ||
                (scopeGuard && row.product_scope !== "nabuflow") ||
                (ownerGuard && row.project_id === null && row.user_id !== "owner") ||
                ![row.file_url, row.thumbnail_url].some((url) => url?.includes(alias))
              ) {
                continue;
              }
              row.file_url = row.file_url?.replaceAll(String(values[1]), String(values[2])) ?? null;
              row.thumbnail_url =
                row.thumbnail_url?.replaceAll(String(values[1]), String(values[2])) ?? null;
              row.updated_at = "rewritten";
              rowCount++;
            }
            return { rows: [], rowCount };
          }
          if (sql.startsWith("UPDATE generated_images SET deleted_at=")) {
            images[0]!.deleted_at = "hidden";
            images[0]!.updated_at = "hidden";
            return { rows: [{ id: 7 }], rowCount: 1 };
          }
          if (sql.startsWith("DELETE FROM asset_usage")) usageRemoved = true;
          return { rows: [], rowCount: 0 };
        },
      );

      const response = await request(appAsOwner()).delete("/api/images/7");
      const statements = mocks.poolQuery.mock.calls.map(([sql]) =>
        String(sql).replace(/\s+/gu, " ").trim(),
      );
      expect(response.status).toBe(allowed ? 200 : 500);
      expect(mocks.canonicalizeSurvivingAssetAliases).toHaveBeenCalledWith(
        expect.any(Object),
        null,
        71,
      );
      expect(statements[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(statements[1]).toContain("owner_user_id=$2 AND state='ready'");
      expect(statements[1]).toContain("FOR UPDATE");
      expect(mocks.poolRelease).toHaveBeenCalledOnce();
      expect(mocks.transaction).not.toHaveBeenCalled();
      expect(mocks.deleteTrackedAssetStorageObjects).not.toHaveBeenCalled();
      expect(mocks.recordAssetDeleted).not.toHaveBeenCalled();
      expect(usageRemoved).toBe(allowed);
      if (allowed) {
        expect(response.body).toEqual({
          success: true,
          storageCleanup: "retained-while-referenced",
        });
        expect(images[0]!.deleted_at).toBe("hidden");
        expect(images[1]).toEqual({ ...before[1], file_url: canonical, updated_at: "rewritten" });
        expect(images[2]).toEqual({
          ...before[2],
          thumbnail_url: canonical,
          updated_at: "rewritten",
        });
        expect(images[3]).toEqual(before[3]);
        expect(statements.at(-1)).toBe("COMMIT");
        expect(
          statements.findIndex((sql) => sql.startsWith("WITH durable_reference_rows")),
        ).toBeLessThan(
          statements.findIndex((sql) => sql.startsWith("UPDATE generated_images SET file_url=")),
        );
        expect(
          statements.findIndex((sql) => sql.startsWith("UPDATE generated_images SET file_url=")),
        ).toBeLessThan(
          statements.findIndex((sql) => sql.startsWith("UPDATE generated_images SET deleted_at=")),
        );
      } else {
        expect(images).toEqual(before);
        expect(statements.some((sql) => /^(UPDATE|DELETE|INSERT) /u.test(sql))).toBe(false);
        expect(statements.at(-1)).toBe("ROLLBACK");
        expect(statements).not.toContain("COMMIT");
      }
    },
  );

  it.each(["transcript", "attachments", "subject"] as const)(
    "keeps the Nabu source gallery row live when a historical Ora ticket retains its %s alias",
    async (field) => {
      const actual = await vi.importActual<typeof import("../lib/project-purge-resources")>(
        "../lib/project-purge-resources",
      );
      mocks.canonicalizeSurvivingAssetAliases.mockImplementationOnce(
        actual.canonicalizeSurvivingAssetAliases,
      );
      mocks.deleteReadyAsset.mockRejectedValueOnce(
        new mocks.AssetAdmissionError("asset_referenced", 409),
      );
      const alias = "/api/images/7/file";
      const ticket = {
        id: 201,
        user_id: "owner",
        project_id: field === "attachments" ? 51 : null,
        status: "resolved",
        subject: field === "subject" ? alias : "Historical support request",
        transcript: field === "transcript" ? [{ role: "user", content: alias }] : [],
        attachments: field === "attachments" ? [{ url: alias }] : [],
      };
      const before = JSON.stringify(ticket);
      let sourceHidden = false;
      let usageRemoved = false;
      // Real route/canonicalizer with a SQL-contract substitute, not a live DB.
      mocks.poolQuery.mockImplementation(
        async (statement: string, values: readonly unknown[] = []) => {
          const sql = statement.replace(/\s+/gu, " ").trim();
          if (sql.startsWith("SELECT id FROM assets")) {
            return { rows: [{ id: 71 }], rowCount: 1 };
          }
          if (sql.startsWith("SELECT '/api/images/'")) {
            return { rows: [{ alias }], rowCount: 1 };
          }
          if (sql.startsWith("SELECT product_scope, storage_backend FROM assets")) {
            return { rows: [{ product_scope: "nabuflow", storage_backend: "r2" }], rowCount: 1 };
          }
          if (sql.startsWith("WITH durable_reference_rows")) {
            const observesOraAccountTicket = sql.includes(
              "SELECT NULL::integer, ticket_row.user_id, 'ora'::text, to_jsonb(ticket_row)::text",
            );
            const survives = values[0] === null || ticket.project_id !== values[0];
            return {
              rows: [{ allowed: !(observesOraAccountTicket && survives) }],
              rowCount: 1,
            };
          }
          if (sql.startsWith("UPDATE generated_images SET deleted_at=")) {
            sourceHidden = true;
            return { rows: [{ id: 7 }], rowCount: 1 };
          }
          if (sql.startsWith("DELETE FROM asset_usage")) usageRemoved = true;
          return { rows: [], rowCount: 0 };
        },
      );

      const response = await request(appAsOwner()).delete("/api/images/7");
      const statements = mocks.poolQuery.mock.calls.map(([statement]) =>
        String(statement).replace(/\s+/gu, " ").trim(),
      );
      expect(response.status).toBe(500);
      expect(mocks.canonicalizeSurvivingAssetAliases).toHaveBeenCalledWith(
        expect.any(Object),
        null,
        71,
      );
      expect(sourceHidden).toBe(false);
      expect(usageRemoved).toBe(false);
      expect(JSON.stringify(ticket)).toBe(before);
      expect(statements[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
      expect(statements[1]).toContain("FOR UPDATE");
      expect(statements.some((sql) => /^(UPDATE|DELETE|INSERT) /u.test(sql))).toBe(false);
      expect(statements.at(-1)).toBe("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(mocks.poolRelease).toHaveBeenCalledOnce();
      expect(mocks.deleteTrackedAssetStorageObjects).not.toHaveBeenCalled();
      expect(mocks.recordAssetDeleted).not.toHaveBeenCalled();
    },
  );

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
