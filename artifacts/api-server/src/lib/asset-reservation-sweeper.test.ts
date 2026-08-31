import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQuery = vi.hoisted(() => vi.fn());
const clientQuery = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  pool: {
    query: poolQuery,
    connect: vi.fn(async () => ({ query: clientQuery, release })),
  },
}));
vi.mock("./asset-r2", () => ({
  assetR2Configured: vi.fn(() => true),
}));
vi.mock("./asset-storage-cleanup", () => ({
  deleteTrackedAssetStorageObjects: vi.fn(),
}));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import {
  ASSET_RESERVATION_SWEEP_LIMIT,
  sweepExpiredAssetReservations,
} from "./asset-reservation-sweeper";

const claim = {
  id: 17,
  owner_user_id: "owner",
  size_bytes: "42",
  quota_bucket: "reserved" as const,
};
const storageObject = {
  storage_key: "accounts/owner/assets/17.bin",
  storage_backend: "r2",
};

describe("expired asset reservation sweeper", () => {
  beforeEach(() => {
    poolQuery.mockReset();
    clientQuery.mockReset();
    release.mockReset();
  });

  it("claims a bounded batch before provider cleanup and releases quota once", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [claim] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [storageObject] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ ...claim, ready_at: null }] })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({});
    const deleteStorageObjects = vi.fn(async () => undefined);

    await expect(sweepExpiredAssetReservations({ deleteStorageObjects })).resolves.toEqual({
      claimed: 1,
      expired: 1,
      pendingProviderCleanup: 0,
    });
    const claimSql = String(poolQuery.mock.calls[0]?.[0]);
    expect(claimSql).toContain("FOR UPDATE SKIP LOCKED");
    expect(claimSql).toContain("state='reserved'");
    expect(claimSql).toContain("state='uploading'");
    expect(claimSql).toContain("state='deleting'");
    expect(poolQuery.mock.calls[0]?.[1]?.[2]).toBe(ASSET_RESERVATION_SWEEP_LIMIT);
    expect(deleteStorageObjects).toHaveBeenCalledWith([
      { storageKey: storageObject.storage_key, storageBackend: storageObject.storage_backend },
    ]);
    expect(String(clientQuery.mock.calls[2]?.[0])).toContain("state=CASE");
    expect(String(clientQuery.mock.calls[4]?.[0])).toContain("reserved_bytes=GREATEST");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("leaves the durable deleting claim retryable when provider cleanup fails", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [claim] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [storageObject] });
    const deleteStorageObjects = vi.fn(async () => {
      throw new Error("provider unavailable");
    });

    await expect(sweepExpiredAssetReservations({ deleteStorageObjects })).resolves.toEqual({
      claimed: 1,
      expired: 0,
      pendingProviderCleanup: 1,
    });
    expect(clientQuery).not.toHaveBeenCalled();
  });

  it("is idempotent when a concurrent completion already won the row", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [claim] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [storageObject] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({});

    await expect(
      sweepExpiredAssetReservations({ deleteStorageObjects: vi.fn(async () => undefined) }),
    ).resolves.toEqual({ claimed: 1, expired: 0, pendingProviderCleanup: 0 });
    expect(
      clientQuery.mock.calls.some(([statement]) => String(statement).includes("reserved_bytes")),
    ).toBe(false);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("expires an abandoned uploading asset against reserved quota", async () => {
    const uploadingClaim = { ...claim, id: 18, quota_bucket: "reserved" as const };
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [uploadingClaim] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [storageObject] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...uploadingClaim, ready_at: null }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(
      sweepExpiredAssetReservations({ deleteStorageObjects: vi.fn(async () => undefined) }),
    ).resolves.toEqual({ claimed: 1, expired: 1, pendingProviderCleanup: 0 });

    const claimSql = String(poolQuery.mock.calls[0]?.[0]);
    expect(claimSql).toContain("state='uploading'");
    expect(claimSql).toContain("upload_started_at <");
    expect(String(clientQuery.mock.calls[4]?.[0])).toContain("reserved_bytes=GREATEST");
    expect(clientQuery.mock.calls[4]?.[1]).toEqual(["owner", 42]);
  });

  it("finishes rejected-object cleanup without releasing quota a second time", async () => {
    const rejectedClaim = { ...claim, id: 19, quota_bucket: "none" as const };
    const deleteStorageObjects = vi.fn(async () => undefined);
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [rejectedClaim] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [storageObject] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0, rows: [] })
      .mockResolvedValueOnce({});

    await expect(sweepExpiredAssetReservations({ deleteStorageObjects })).resolves.toEqual({
      claimed: 1,
      expired: 0,
      pendingProviderCleanup: 0,
    });

    expect(String(poolQuery.mock.calls[0]?.[0])).toContain("state='rejected'");
    expect(deleteStorageObjects).toHaveBeenCalledOnce();
    expect(String(clientQuery.mock.calls[1]?.[0])).toContain("state='deleted'");
    expect(
      clientQuery.mock.calls.some(([statement]) =>
        String(statement).includes("UPDATE account_asset_quota"),
      ),
    ).toBe(false);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("finishes a ready deleting asset against used quota", async () => {
    const readyDeletingClaim = { ...claim, id: 20, quota_bucket: "used" as const };
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyDeletingClaim] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [storageObject] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...readyDeletingClaim, ready_at: new Date("2026-08-30T00:00:00Z") }],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(
      sweepExpiredAssetReservations({ deleteStorageObjects: vi.fn(async () => undefined) }),
    ).resolves.toEqual({ claimed: 1, expired: 1, pendingProviderCleanup: 0 });

    const claimSql = String(poolQuery.mock.calls[0]?.[0]);
    expect(claimSql).toContain("state='deleting'");
    expect(claimSql).toContain("ready_at IS NOT NULL");
    expect(String(clientQuery.mock.calls[2]?.[0])).toContain("ELSE 'deleted'");
    expect(String(clientQuery.mock.calls[4]?.[0])).toContain("used_bytes=GREATEST");
    expect(clientQuery.mock.calls[4]?.[1]).toEqual(["owner", 42]);
  });
});
