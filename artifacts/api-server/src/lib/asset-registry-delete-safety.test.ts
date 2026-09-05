import { beforeEach, describe, expect, it, vi } from "vitest";
const query = vi.hoisted(() => vi.fn());
const release = vi.hoisted(() => vi.fn());
vi.mock("@workspace/db", () => ({
  pool: { connect: vi.fn(async () => ({ query, release })), query: vi.fn() },
}));
import { deleteReadyAsset } from "./asset-registry";

const ready = {
  storage_key: "generated/owned-primary.webp",
  storage_backend: "r2",
  size_bytes: "42",
  state: "ready",
  version_id: null,
  task_id: null,
  message_id: null,
  product_scope: "nabuflow",
};
let row = { ...ready };
let firstReference: boolean | undefined;
let finalReference: boolean | undefined;
let onKeyLock: (() => void) | undefined;
let references: number;

function lastStatementIndex(statements: readonly string[], needle: string): number {
  for (let index = statements.length - 1; index >= 0; index -= 1) {
    if (statements[index]?.includes(needle)) return index;
  }
  return -1;
}

function installQuery() {
  query.mockImplementation(async (statement: string) => {
    if (statement.includes("SELECT storage_key, storage_backend, size_bytes, state")) {
      return { rowCount: 1, rows: [row] };
    }
    if (statement.includes("durable_asset_reference_exists")) {
      references++;
      const referenced = references === 1 ? firstReference : finalReference;
      return { rows: referenced === undefined ? [] : [{ referenced }] };
    }
    if (statement.includes("FROM asset_storage_objects")) {
      return {
        rows:
          row.storage_backend === "legacy-url"
            ? []
            : [
                {
                  storage_key: row.storage_key,
                  storage_backend: row.storage_backend,
                  size_bytes: "42",
                },
                {
                  storage_key: "generated/owned-thumbnail.webp",
                  storage_backend: "r2",
                  size_bytes: "8",
                },
              ],
      };
    }
    if (statement.includes("pg_advisory_xact_lock")) onKeyLock?.();
    return { rowCount: 1, rows: [] };
  });
}
describe("asset deletion reference proof", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    row = { ...ready };
    firstReference = false;
    finalReference = false;
    references = 0;
    onKeyLock = undefined;
    installQuery();
  });
  it("keeps reverse-scan proof indexes exact without a newer array target", () => {
    expect(lastStatementIndex([], "read")).toBe(-1);
    expect(lastStatementIndex(["lock"], "read")).toBe(-1);
    expect(lastStatementIndex(["read", "lock", "read", "claim"], "read")).toBe(2);
    expect(lastStatementIndex(["read"], "read")).toBe(0);
  });
  it("refuses any existing durable consumer before provider work", async () => {
    firstReference = true;
    await expect(deleteReadyAsset({ assetId: 17, userId: "owner" })).rejects.toMatchObject({
      code: "asset_referenced",
      status: 409,
    });
    expect(query.mock.calls[0]?.[0]).toBe("BEGIN ISOLATION LEVEL READ COMMITTED");
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    expect(
      query.mock.calls.some(([s]) =>
        String(s).includes("INSERT INTO durable_asset_deletion_claims"),
      ),
    ).toBe(false);
  });
  it("fails closed without affirmative reference absence", async () => {
    firstReference = undefined;
    await expect(deleteReadyAsset({ assetId: 17, userId: "owner" })).rejects.toMatchObject({
      code: "asset_referenced",
    });
  });
  it("rechecks after every physical key lock before committing a deletion claim", async () => {
    const result = await deleteReadyAsset({
      assetId: 17,
      userId: "owner",
      productScope: "nabuflow",
    });
    expect(result.storageObjects).toHaveLength(2);
    expect(references).toBe(2);
    const statements = query.mock.calls.map(([s]) => String(s));
    const lastLock = lastStatementIndex(statements, "pg_advisory_xact_lock");
    const finalRead = lastStatementIndex(statements, "durable_asset_reference_exists");
    const claim = statements.findIndex((s) =>
      s.includes("INSERT INTO durable_asset_deletion_claims"),
    );
    expect(finalRead).toBeGreaterThan(lastLock);
    expect(claim).toBeGreaterThan(finalRead);
    expect(statements.at(-1)).toBe("COMMIT");
  });
  it("retains raw-key bytes when a writer commits while key acquisition waits", async () => {
    onKeyLock = () => {
      finalReference = true;
    };
    await expect(deleteReadyAsset({ assetId: 17, userId: "owner" })).rejects.toMatchObject({
      code: "asset_referenced",
    });
    expect(references).toBe(2);
    expect(
      query.mock.calls.some(([s]) =>
        String(s).includes("INSERT INTO durable_asset_deletion_claims"),
      ),
    ).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("does not treat an inconclusive post-wait query as absence", async () => {
    finalReference = undefined;
    await expect(deleteReadyAsset({ assetId: 17, userId: "owner" })).rejects.toMatchObject({
      code: "asset_referenced",
    });
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("resumes a durable deleting claim without a second ready transition", async () => {
    row.state = "deleting";
    await expect(deleteReadyAsset({ assetId: 17, userId: "owner" })).resolves.toMatchObject({
      storageKey: row.storage_key,
    });
    expect(
      query.mock.calls.some(([s]) => String(s).includes("UPDATE assets SET state='deleting'")),
    ).toBe(false);
  });
  it("keeps governed URL-only metadata cleanup distinct from library admission", async () => {
    row.storage_backend = "legacy-url";
    row.storage_key = "legacy-generated/9";
    await expect(deleteReadyAsset({ assetId: 17, userId: "owner" })).resolves.toMatchObject({
      storageObjects: [],
    });
    expect(references).toBe(2);
  });
  it("excludes only the exact gallery row on BOTH reference queries", async () => {
    await deleteReadyAsset({ assetId: 17, userId: "owner", generatedImageIdBeingDeleted: 91 });
    const reads = query.mock.calls.filter(([s]) =>
      String(s).includes("durable_asset_reference_exists"),
    );
    expect(reads).toHaveLength(2);
    expect(reads.every(([, args]) => JSON.stringify(args) === JSON.stringify([17, 91]))).toBe(true);
  });
  it("excludes only the requested upload on both fresh reference checks", async () => {
    await deleteReadyAsset({
      assetId: 17,
      userId: "owner",
      productScope: "nabuflow",
      projectUploadIdBeingDeleted: 91,
    });
    const reads = query.mock.calls.filter(([s]) =>
      String(s).includes("durable_asset_reference_exists"),
    );
    expect(reads).toHaveLength(2);
    for (const [sql, args] of reads) {
      expect(sql).toContain("durable_asset_reference_exists_excluding_upload");
      expect(args).toEqual([17, null, 91]);
    }
  });
  it("keeps an upload when a genuine reference appears while acquiring physical locks", async () => {
    onKeyLock = () => {
      finalReference = true;
    };
    await expect(
      deleteReadyAsset({ assetId: 17, userId: "owner", projectUploadIdBeingDeleted: 91 }),
    ).rejects.toMatchObject({ code: "asset_referenced", status: 409 });
    expect(references).toBe(2);
    expect(
      query.mock.calls.some(([s]) =>
        String(s).includes("INSERT INTO durable_asset_deletion_claims"),
      ),
    ).toBe(false);
    expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it.each([0, -1, 1.5, 2147483648, NaN, Infinity])(
    "rejects invalid upload exclusion ID %s",
    async (uploadId) => {
      await expect(
        deleteReadyAsset({ assetId: 17, userId: "owner", projectUploadIdBeingDeleted: uploadId }),
      ).rejects.toMatchObject({ code: "asset_not_found", status: 404 });
      expect(references).toBe(0);
      expect(query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    },
  );

  it.each(["ora", null])(
    "denies wrong/unknown product %s before reference/provider work",
    async (scope) => {
      row = { ...ready, product_scope: scope } as typeof ready;
      await expect(
        deleteReadyAsset({ assetId: 17, userId: "owner", productScope: "nabuflow" }),
      ).rejects.toMatchObject({ code: "asset_not_found", status: 404 });
      expect(references).toBe(0);
    },
  );
});
