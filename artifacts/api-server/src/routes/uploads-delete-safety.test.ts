import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
const h = vi.hoisted(() => ({
  routes: new Map<string, unknown[]>(),
  selection: [] as unknown[][],
  events: [] as string[],
  owner: vi.fn(),
  query: vi.fn(),
  select: vi.fn(),
  remove: vi.fn(),
  claim: vi.fn(),
  absent: vi.fn(),
  record: vi.fn(),
  eq: vi.fn(),
  openAsset: vi.fn(),
}));
vi.mock("express", () => ({
  Router: () => ({
    get: vi.fn(),
    post: vi.fn(),
    delete: (path: string, ...handlers: unknown[]) => h.routes.set(path, handlers),
  }),
}));
vi.mock("@workspace/db", () => ({
  assetsTable: {
    id: "asset.id",
    state: "asset.state",
    projectId: "asset.project",
    source: "asset.source",
    storageKey: "asset.key",
    productScope: "asset.product",
    ownerUserId: "asset.owner",
    storageBackend: "asset.backend",
  },
  projectUploadsTable: { id: "upload.id", objectPath: "upload.key", projectId: "upload.project" },
  projectsTable: {},
  pool: { query: h.query },
  db: { select: h.select, delete: () => ({ where: h.remove }) },
}));
vi.mock("drizzle-orm", () => ({
  and: (...args: unknown[]) => args,
  eq: h.eq,
  desc: vi.fn(),
  isNull: vi.fn(),
}));
vi.mock("../lib/auth", () => ({ requireProjectOwnership: h.owner }));
vi.mock("../lib/objectStorage", () => ({ ObjectStorageService: class {} }));
vi.mock("../lib/asset-r2", () => ({ openAsset: h.openAsset }));
vi.mock("../lib/asset-registry", () => ({
  AssetAdmissionError: class extends Error {
    constructor(
      readonly code: string,
      readonly status: number,
      message = "This asset is still in use.",
    ) {
      super(message);
    }
  },
  deleteReadyAsset: h.claim,
  recordAssetDeleted: h.record,
}));
vi.mock("../lib/asset-storage-cleanup", () => ({ deleteTrackedAssetStorageObjects: h.absent }));
import { AssetAdmissionError } from "../lib/asset-registry";
import "./uploads";
const key = "/objects/uploads/11111111-1111-4111-8111-111111111111";
const pending = {
  storageKey: key,
  storageBackend: "legacy-object",
  sizeBytes: 1,
  storageObjects: [{ storageKey: key, storageBackend: "legacy-object", sizeBytes: 1 }],
};
const handlers = h.routes.get("/projects/:id/uploads/:uploadId")!;
const handler = handlers[1] as (req: Request, res: Response) => Promise<void>;
async function request(uploadId = "7") {
  const response = { status: vi.fn(), json: vi.fn() };
  response.status.mockReturnValue(response);
  await handler(
    {
      params: { id: "23", uploadId },
      userId: "owner",
      log: { warn: vi.fn() },
    } as unknown as Request,
    response as unknown as Response,
  );
  return response;
}
describe("legacy upload deletion boundary (mocked provider)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.events.length = 0;
    h.selection = [
      [{ id: 7, objectPath: key }],
      [{ id: 19, state: "ready", storageBackend: "legacy-object" }],
    ];
    h.query.mockResolvedValue({ rows: [{ referenced: false }] });
    h.select.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => h.selection.shift() ?? [] }) }),
    }));
    h.eq.mockImplementation((left, right) => [left, right]);
    h.claim.mockImplementation(async () => {
      h.events.push("claim");
      return pending;
    });
    h.absent.mockImplementation(async () => {
      h.events.push("provider-absence");
    });
    h.record.mockImplementation(async () => {
      h.events.push("record-deleted");
    });
    h.remove.mockImplementation(async () => {
      h.events.push("remove-alias");
    });
  });
  it("keeps the project-owner middleware before the deletion handler", () => {
    expect(handlers).toHaveLength(2);
    expect(handlers[0]).toBe(h.owner);
  });
  it.each(["ready", "deleting"])(
    "deletes or resumes %s using one exact NabuFlow alias exclusion",
    async (state) => {
      h.selection[1] = [{ id: 19, state, storageBackend: "legacy-object" }];
      const response = await request();
      expect(h.claim).toHaveBeenCalledWith({
        assetId: 19,
        userId: "owner",
        storageBackend: "legacy-object",
        productScope: "nabuflow",
        projectUploadIdBeingDeleted: 7,
      });
      expect(h.eq).toHaveBeenCalledWith("asset.product", "nabuflow");
      expect(h.events).toEqual(["claim", "provider-absence", "record-deleted", "remove-alias"]);
      expect(h.remove).toHaveBeenCalledWith([
        ["upload.id", 7],
        ["upload.project", 23],
        ["upload.key", key],
      ]);
      expect(response.json).toHaveBeenCalledWith({ deleted: true });
    },
  );
  it("deletes a migrated R2 upload through the same final-reference coordinator", async () => {
    const migratedKey =
      "assets/0123456789abcdef01234567/account/00000000-0000-5000-8000-000000000001/file.webp";
    const migrated = {
      storageKey: migratedKey,
      storageBackend: "r2",
      sizeBytes: 1,
      storageObjects: [{ storageKey: migratedKey, storageBackend: "r2", sizeBytes: 1 }],
    };
    h.selection = [
      [{ id: 7, objectPath: migratedKey }],
      [{ id: 19, state: "ready", storageBackend: "r2" }],
    ];
    h.claim.mockResolvedValueOnce(migrated);
    const response = await request();
    expect(h.claim).toHaveBeenCalledWith({
      assetId: 19,
      userId: "owner",
      storageBackend: "r2",
      productScope: "nabuflow",
      projectUploadIdBeingDeleted: 7,
    });
    expect(h.events).toEqual(["provider-absence", "record-deleted", "remove-alias"]);
    expect(response.json).toHaveBeenCalledWith({ deleted: true });
  });

  it("keeps migrated upload delivery owner-scoped and private", () => {
    const source = readFileSync(new URL("./uploads.ts", import.meta.url), "utf8");
    expect(source).toContain('if (row.objectPath.startsWith("assets/"))');
    expect(source).toContain("asset.owner_user_id=$2");
    expect(source).toContain("asset.product_scope='nabuflow'");
    expect(source).toContain('res.setHeader("Cache-Control", "private, no-store")');
    expect(source).toContain("const opened = await openAsset(row.objectPath)");
  });

  it("preserves both metadata records when provider absence is inconclusive", async () => {
    h.absent.mockRejectedValueOnce(new Error("temporary provider failure"));
    const response = await request();
    expect(response.status).toHaveBeenCalledWith(503);
    expect(h.record).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it("returns a plain reference denial and never calls storage", async () => {
    h.claim.mockRejectedValueOnce(new AssetAdmissionError("asset_referenced", 409));
    const response = await request();
    expect(response.status).toHaveBeenCalledWith(409);
    expect(response.json).toHaveBeenCalledWith({ error: "This asset is still in use." });
    expect(h.absent).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it("keeps genuinely referenced uploads before the claim boundary", async () => {
    h.query.mockResolvedValueOnce({ rows: [{ referenced: true }] });
    const response = await request();
    expect(response.status).toHaveBeenCalledWith(409);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
  it("does not reveal or mutate an upload outside the owned project lookup", async () => {
    h.selection = [[]];
    const response = await request();
    expect(response.status).toHaveBeenCalledWith(404);
    expect(h.claim).not.toHaveBeenCalled();
    expect(h.absent).not.toHaveBeenCalled();
  });
  it.each(["0", "-1", "1.5", "2147483648", "not-an-id"])(
    "rejects hostile upload ID %s without querying metadata",
    async (id) => {
      const response = await request(id);
      expect(response.status).toHaveBeenCalledWith(404);
      expect(h.select).not.toHaveBeenCalled();
      expect(h.claim).not.toHaveBeenCalled();
    },
  );
});
