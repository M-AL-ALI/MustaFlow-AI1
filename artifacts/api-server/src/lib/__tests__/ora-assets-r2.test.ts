import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { accountAssetQuotaTable, assetsTable, db, oraAssetsTable } from "@workspace/db";
import { AssetAdmissionError } from "../asset-registry";
import { persistOraAssetStrict } from "../ora-assets";
import * as assetR2 from "../asset-r2";

const objects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../asset-r2", () => ({
  putAssetBuffer: vi.fn(async (input: { key: string; body: Buffer }) => {
    objects.set(input.key, Buffer.from(input.body));
  }),
  readAssetBuffer: vi.fn(async (key: string) => objects.get(key) ?? null),
  deleteAssetObject: vi.fn(async (key: string) => {
    objects.delete(key);
  }),
}));

const HELLO_B64 = Buffer.from("hello").toString("base64");
const USER = `test-ora-unified-${Date.now()}`;

afterAll(async () => {
  const links = await db
    .select({ assetId: oraAssetsTable.assetId })
    .from(oraAssetsTable)
    .where(eq(oraAssetsTable.userId, USER));
  await db.delete(oraAssetsTable).where(eq(oraAssetsTable.userId, USER));
  const ids = links.flatMap((row) => (row.assetId === null ? [] : [row.assetId]));
  if (ids.length > 0) await db.delete(assetsTable).where(inArray(assetsTable.id, ids));
  await db.delete(accountAssetQuotaTable).where(eq(accountAssetQuotaTable.userId, USER));
});

beforeEach(() => {
  objects.clear();
  vi.clearAllMocks();
});

describe("Ora unified asset persistence", () => {
  it("admits once, writes one private object, and stores only metadata in ora_assets", async () => {
    const id = await persistOraAssetStrict({
      userId: USER,
      kind: "image",
      fileName: "pic.png",
      mimeType: "image/png",
      format: "png",
      base64: HELLO_B64,
    });
    const [row] = await db.select().from(oraAssetsTable).where(eq(oraAssetsTable.id, id));
    expect(row.assetId).toBeTypeOf("number");
    expect(row.data).toBeNull();
    expect(row.storageKey).toMatch(/^assets\//);
    expect(assetR2.putAssetBuffer).toHaveBeenCalledTimes(1);
  });

  it("links an already-ready unified asset without a duplicate R2 write", async () => {
    const firstId = await persistOraAssetStrict({
      userId: USER,
      kind: "file",
      fileName: "one.txt",
      mimeType: "text/plain",
      base64: HELLO_B64,
    });
    const [first] = await db.select().from(oraAssetsTable).where(eq(oraAssetsTable.id, firstId));
    const linkedId = await persistOraAssetStrict({
      userId: USER,
      kind: "file",
      fileName: "one.txt",
      mimeType: "text/plain",
      unifiedAssetId: first.assetId!,
    });
    expect(linkedId).toBe(firstId);
    expect(assetR2.putAssetBuffer).toHaveBeenCalledTimes(1);
  });

  it("refuses at quota admission before writing provider bytes", async () => {
    await db
      .insert(accountAssetQuotaTable)
      .values({ userId: USER, usedBytes: 500 * 1024 * 1024 })
      .onConflictDoUpdate({
        target: accountAssetQuotaTable.userId,
        set: { usedBytes: 500 * 1024 * 1024, reservedBytes: 0 },
      });
    await expect(
      persistOraAssetStrict({
        userId: USER,
        kind: "file",
        fileName: "full.txt",
        mimeType: "text/plain",
        base64: HELLO_B64,
      }),
    ).rejects.toMatchObject({
      code: "asset_quota_exceeded",
    } satisfies Partial<AssetAdmissionError>);
    expect(assetR2.putAssetBuffer).not.toHaveBeenCalled();
  });
});

describe("ora_assets storage XOR constraint", () => {
  it("rejects a row with neither data nor storageKey", async () => {
    await expect(
      db.insert(oraAssetsTable).values({
        userId: USER,
        kind: "file",
        fileName: "bad.txt",
        mimeType: "text/plain",
        data: null,
        storageKey: null,
        sizeBytes: 0,
      }),
    ).rejects.toThrow();
  });
});
