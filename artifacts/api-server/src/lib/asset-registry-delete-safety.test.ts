import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());

vi.mock("@workspace/db", () => ({
  pool: {
    connect: vi.fn(async () => ({ query, release })),
    query: vi.fn(),
  },
}));

import { AssetAdmissionError, deleteReadyAsset } from "./asset-registry";

const readyRow = {
  storage_key: "accounts/owner/projects/51/asset.png",
  storage_backend: "r2",
  size_bytes: "42",
  state: "ready",
  version_id: null,
  task_id: null,
  message_id: null,
};

describe("asset deletion reference proof", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
  });

  it("refuses deletion when any durable consumer still points at the asset", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] })
      .mockResolvedValueOnce({ rows: [{ referenced: true }] })
      .mockResolvedValueOnce({});

    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", storageBackend: "r2" }),
    ).rejects.toMatchObject({
      code: "asset_referenced",
      status: 409,
    } satisfies Partial<AssetAdmissionError>);

    expect(query.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "public.durable_asset_reference_exists($1, NULL, $2)",
    );
    expect(query.mock.calls[2]?.[1]).toEqual([17, null]);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("fails closed when the shared durable-reference predicate returns no proof", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [readyRow],
      })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", storageBackend: "r2" }),
    ).rejects.toMatchObject({ code: "asset_referenced" });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });

  it("returns provider deletion material only after every durable reference is absent", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            storage_key: readyRow.storage_key,
            storage_backend: readyRow.storage_backend,
            size_bytes: readyRow.size_bytes,
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", storageBackend: "r2" }),
    ).resolves.toEqual({
      storageKey: readyRow.storage_key,
      storageBackend: "r2",
      sizeBytes: 42,
      storageObjects: [{ storageKey: readyRow.storage_key, storageBackend: "r2", sizeBytes: 42 }],
    });
    expect(String(query.mock.calls[3]?.[0])).toContain("SET state='deleting'");
    expect(String(query.mock.calls.at(-3)?.[0])).toContain("pg_advisory_xact_lock");
    expect(String(query.mock.calls.at(-2)?.[0])).toContain(
      "INSERT INTO durable_asset_deletion_claims",
    );
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("resumes an interrupted provider deletion from its durable deleting claim", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...readyRow, state: "deleting" }],
      })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({
        rows: [
          {
            storage_key: readyRow.storage_key,
            storage_backend: readyRow.storage_backend,
            size_bytes: readyRow.size_bytes,
          },
        ],
      })
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});

    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", storageBackend: "r2" }),
    ).resolves.toEqual({
      storageKey: readyRow.storage_key,
      storageBackend: "r2",
      sizeBytes: 42,
      storageObjects: [{ storageKey: readyRow.storage_key, storageBackend: "r2", sizeBytes: 42 }],
    });
    expect(
      query.mock.calls.some(
        ([statement]) =>
          String(statement).includes("UPDATE assets SET state='deleting'") &&
          String(statement).includes("state='ready'"),
      ),
    ).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("treats a historical URL-only asset as metadata-only deletion work", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rowCount: 1,
        rows: [{ ...readyRow, storage_backend: "legacy-url", storage_key: "legacy-generated/9" }],
      })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 0 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    await expect(deleteReadyAsset({ assetId: 17, userId: "owner" })).resolves.toMatchObject({
      storageBackend: "legacy-url",
      storageObjects: [],
    });
    expect(query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });

  it("can exclude only the owned gallery row being deleted while claiming storage", async () => {
    query
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ rowCount: 1, rows: [readyRow] })
      .mockResolvedValueOnce({ rows: [{ referenced: false }] })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({});

    await deleteReadyAsset({
      assetId: 17,
      userId: "owner",
      generatedImageIdBeingDeleted: 91,
    });
    expect(String(query.mock.calls[2]?.[0])).toContain(
      "public.durable_asset_reference_exists($1, NULL, $2)",
    );
    expect(query.mock.calls[2]?.[1]).toEqual([17, 91]);
  });
});
