import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQuery = vi.hoisted(() => vi.fn());
const clientQuery = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());
const connect = vi.hoisted(() => vi.fn(async () => ({ query: clientQuery, release })));

vi.mock("@workspace/db", () => ({
  pool: { query: poolQuery, connect },
}));
vi.mock("./asset-r2", () => ({ headAssetObject: vi.fn() }));

import {
  ASSET_STORAGE_RECONCILIATION_LIMIT,
  reconcileUnmeasuredR2AssetObjects,
  runDurableAssetStorageReconciliation,
} from "./asset-storage-reconciliation";

function candidate(id: number, role = "primary") {
  return {
    object_id: id,
    asset_id: 100 + id,
    storage_key: `accounts/owner/assets/${id}.bin`,
    storage_backend: "r2",
    role,
  };
}

describe("unmeasured asset storage reconciliation", () => {
  beforeEach(() => {
    poolQuery.mockReset();
    clientQuery.mockReset();
    connect.mockClear();
    release.mockReset();
  });

  it("clamps the candidate batch and therefore provider HEAD work to the bounded limit", async () => {
    const rows = Array.from({ length: ASSET_STORAGE_RECONCILIATION_LIMIT }, (_, index) =>
      candidate(index + 1),
    );
    poolQuery
      .mockResolvedValueOnce({ rowCount: rows.length, rows })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "50" }] });
    const headObject = vi.fn(async () => null);

    const receipt = await reconcileUnmeasuredR2AssetObjects({
      limit: ASSET_STORAGE_RECONCILIATION_LIMIT * 20,
      headObject,
    });

    expect(poolQuery.mock.calls[0]?.[1]).toEqual([ASSET_STORAGE_RECONCILIATION_LIMIT]);
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain("LIMIT $1");
    expect(headObject).toHaveBeenCalledTimes(ASSET_STORAGE_RECONCILIATION_LIMIT);
    expect(receipt.inspected).toBe(ASSET_STORAGE_RECONCILIATION_LIMIT);
    expect(receipt).toMatchObject({ remainingUnmeasured: 50, admissionUnlocked: false });
    expect(connect).not.toHaveBeenCalled();
  });

  it("moves quota by the exact asset-total delta, not by the observed object size", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(7)] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });
    clientQuery
      .mockResolvedValueOnce({}) // BEGIN
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ owner_user_id: "owner", size_bytes: "90" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 }) // physical-object receipt
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_bytes: "130" }] })
      .mockResolvedValueOnce({ rowCount: 1 }) // asset total
      .mockResolvedValueOnce({ rowCount: 1 }) // quota receipt
      .mockResolvedValueOnce({}); // COMMIT

    await expect(
      reconcileUnmeasuredR2AssetObjects({ headObject: vi.fn(async () => ({ sizeBytes: 100 })) }),
    ).resolves.toMatchObject({
      measured: 1,
      measuredBytes: 100,
      remainingUnmeasured: 0,
      admissionUnlocked: true,
    });

    const quotaCall = clientQuery.mock.calls.find(([statement]) =>
      String(statement).includes("UPDATE account_asset_quota"),
    );
    expect(quotaCall?.[1]).toEqual(["owner", 40]);
    expect(String(quotaCall?.[0])).toContain("used_bytes+$2");
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("records an observed zero-byte object as measured so it cannot deadlock admission", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(8)] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ owner_user_id: "owner", size_bytes: "0" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_bytes: "0" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(
      reconcileUnmeasuredR2AssetObjects({ headObject: vi.fn(async () => ({ sizeBytes: 0 })) }),
    ).resolves.toMatchObject({
      measured: 1,
      measuredBytes: 0,
      remainingUnmeasured: 0,
      admissionUnlocked: true,
    });

    const measuredCall = clientQuery.mock.calls.find(([statement]) =>
      String(statement).includes("UPDATE asset_storage_objects SET size_bytes"),
    );
    expect(String(measuredCall?.[0])).toContain("size_measured_at=NOW()");
    expect(String(measuredCall?.[0])).toContain("size_measured_at IS NULL");
  });

  it("marks an absent thumbnail deleted and clears its generated-image URL", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(9, "thumbnail")] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(
      reconcileUnmeasuredR2AssetObjects({ headObject: vi.fn(async () => null) }),
    ).resolves.toEqual({
      inspected: 1,
      measured: 0,
      measuredBytes: 0,
      absentThumbnails: 1,
      remainingUnmeasured: 0,
      admissionUnlocked: true,
      terminals: [],
    });

    expect(String(clientQuery.mock.calls[1]?.[0])).toContain("SET state='deleted'");
    expect(String(clientQuery.mock.calls[2]?.[0])).toContain("thumbnail_url=NULL");
    expect(clientQuery.mock.calls[2]?.[1]).toEqual([109]);
    expect(clientQuery.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("reports a missing primary as terminal without mutating metadata", async () => {
    poolQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [candidate(11)] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "1" }] });

    await expect(
      reconcileUnmeasuredR2AssetObjects({ headObject: vi.fn(async () => null) }),
    ).resolves.toEqual({
      inspected: 1,
      measured: 0,
      measuredBytes: 0,
      absentThumbnails: 0,
      remainingUnmeasured: 1,
      admissionUnlocked: false,
      terminals: [{ assetId: 111, objectId: 11, role: "primary", outcome: "primary-missing" }],
    });
    expect(connect).not.toHaveBeenCalled();
  });

  it("measures legacy-object metadata through the same bounded candidate contract", async () => {
    poolQuery
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...candidate(12), storage_backend: "legacy-object" }],
      })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ remaining: "0" }] });
    clientQuery
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ owner_user_id: "owner", size_bytes: "0" }],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ total_bytes: "25" }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const headObject = vi.fn(async () => ({ sizeBytes: 25 }));

    await expect(reconcileUnmeasuredR2AssetObjects({ headObject })).resolves.toMatchObject({
      measured: 1,
      remainingUnmeasured: 0,
      admissionUnlocked: true,
    });
    expect(headObject).toHaveBeenCalledWith("accounts/owner/assets/12.bin", "legacy-object");
  });

  it("persists a typed terminal when another governed reconciliation holds the lock", async () => {
    clientQuery
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ request_id: "request-1" }] })
      .mockResolvedValueOnce({ rowCount: 1, rows: [{ acquired: false }] })
      .mockResolvedValueOnce({ rowCount: 1 });

    await expect(
      runDurableAssetStorageReconciliation({ requestId: "request-1", limit: 1 }),
    ).rejects.toMatchObject({
      code: "asset_storage_reconciliation_failed",
      terminal: { retryable: true, errorClass: "database" },
    });

    expect(String(clientQuery.mock.calls[0]?.[0])).toContain("ON CONFLICT (request_id) DO NOTHING");
    expect(String(clientQuery.mock.calls[2]?.[0])).toContain("state='failed'");
    expect(release).toHaveBeenCalledOnce();
  });
});
