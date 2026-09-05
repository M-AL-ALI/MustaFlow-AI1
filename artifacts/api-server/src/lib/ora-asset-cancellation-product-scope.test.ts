import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rows: [] as unknown[][],
  select: vi.fn(),
  reject: vi.fn(),
  cleanup: vi.fn(),
  put: vi.fn(),
  complete: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  db: { select: mocks.select },
  assetsTable: {
    id: "id",
    ownerUserId: "owner_user_id",
    actorUserId: "actor_user_id",
    productScope: "product_scope",
    state: "state",
    storageBackend: "storage_backend",
    storageKey: "storage_key",
    deletedAt: "deleted_at",
  },
  oraAssetsTable: {},
  oraFileContextsTable: {},
  pool: { connect: vi.fn() },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("./asset-r2", () => ({
  readAssetBuffer: vi.fn(),
  putAssetBuffer: mocks.put,
}));
vi.mock("./asset-storage-cleanup", () => ({
  deleteTrackedAssetStorageObjects: mocks.cleanup,
}));
vi.mock("./asset-platform-scope", () => ({
  isOwnedReadyAssetForProduct: vi.fn(),
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
  beginAssetUpload: vi.fn(),
  completeAsset: mocks.complete,
  deleteReadyAsset: vi.fn(),
  getQuota: vi.fn(),
  recordAssetDeleted: vi.fn(),
  rejectReservedAsset: mocks.reject,
  reserveAsset: vi.fn(),
  reserveAssetAgainstAvailableQuota: vi.fn(),
}));

import {
  cancelOraGeneratedAsset,
  completeOraGeneratedAsset,
  type OraGeneratedAssetReservation,
} from "./ora-assets";

const userId = "ora-cancellation-owner";
const storageKey = "assets/owner/account/reservation/image.webp";
const reservation = { id: 81, storageKey } as OraGeneratedAssetReservation;
const canonical = {
  ownerUserId: userId,
  actorUserId: userId,
  productScope: "ora",
  state: "uploading",
  storageBackend: "r2",
  storageKey,
  deletedAt: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rows.length = 0;
  mocks.select.mockImplementation(() => ({
    from: () => ({
      where: () => ({ limit: async () => mocks.rows.shift() ?? [] }),
    }),
  }));
  mocks.reject.mockReset().mockResolvedValue(undefined);
  mocks.cleanup.mockReset().mockResolvedValue(undefined);
});

describe("Ora cancellation requires canonical provenance and rejection", () => {
  it.each([null, undefined, "nabuflow"])(
    "preserves bytes after completion denial followed by cancellation: %s",
    async (productScope) => {
      mocks.rows.push([], [{ ...canonical, productScope }]);
      await expect(
        completeOraGeneratedAsset({
          reservation,
          asset: { userId, kind: "image", fileName: "image.webp", mimeType: "image/webp" },
          base64: "aW1hZ2U=",
        }),
      ).rejects.toMatchObject({ code: "asset_not_found" });

      // This is the realtime caller's existing completion-failure path.
      await cancelOraGeneratedAsset(reservation, userId);
      expect(mocks.reject).not.toHaveBeenCalled();
      expect(mocks.cleanup).not.toHaveBeenCalled();
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.complete).not.toHaveBeenCalled();
    },
  );

  it.each([
    { ownerUserId: "another-owner" },
    { actorUserId: "another-actor" },
    { productScope: null },
    { productScope: "nabuflow" },
    { storageBackend: "other" },
    { storageKey: "assets/another/key.webp" },
    { state: "ready" },
    { state: "deleting" },
    { state: "deleted" },
    { deletedAt: new Date(0) },
  ])("rejects a mismatched or non-cancellable canonical reservation: %j", async (change) => {
    mocks.rows.push([{ ...canonical, ...change }]);
    await cancelOraGeneratedAsset(reservation, userId);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it.each([
    { state: "ready" },
    { state: "uploading" },
    { state: "rejected", productScope: null },
    { state: "rejected", ownerUserId: "another-owner" },
    { state: "rejected", storageKey: "assets/changed/key.webp" },
  ])("preserves a completion winner or changed row after rejection: %j", async (change) => {
    mocks.rows.push([{ ...canonical }], [{ ...canonical, ...change }]);
    await cancelOraGeneratedAsset(reservation, userId);
    expect(mocks.reject).toHaveBeenCalledOnce();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("cleans only the matching canonical key after confirmed rejection", async () => {
    mocks.rows.push(
      [{ ...canonical }],
      [{ ...canonical, state: "rejected", deletedAt: new Date(0) }],
    );
    await cancelOraGeneratedAsset(reservation, userId);
    expect(mocks.reject).toHaveBeenCalledWith({
      assetId: reservation.id,
      ownerUserId: userId,
      actorUserId: userId,
      code: "asset_storage_unavailable",
    });
    expect(mocks.cleanup).toHaveBeenCalledWith([{ storageBackend: "r2", storageKey }]);
  });

  it("permits an idempotent cleanup retry only for the same known rejected reservation", async () => {
    const rejected = { ...canonical, state: "rejected", deletedAt: new Date(0) };
    mocks.rows.push([rejected], [rejected]);
    await cancelOraGeneratedAsset(reservation, userId);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledWith([{ storageBackend: "r2", storageKey }]);
  });

  it("does not clean up when the rejection call fails", async () => {
    mocks.rows.push([{ ...canonical }]);
    mocks.reject.mockRejectedValueOnce(new Error("rejection unavailable"));
    await cancelOraGeneratedAsset(reservation, userId);
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });

  it("does not mutate anything when canonical admission is unavailable", async () => {
    mocks.select.mockImplementationOnce(() => {
      throw new Error("database unavailable");
    });
    await cancelOraGeneratedAsset(reservation, userId);
    expect(mocks.reject).not.toHaveBeenCalled();
    expect(mocks.cleanup).not.toHaveBeenCalled();
  });
});
