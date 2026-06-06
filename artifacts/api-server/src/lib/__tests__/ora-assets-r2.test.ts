import { describe, it, expect, afterAll, beforeEach, vi } from "vitest";

// Mock the R2 layer so we can drive offload success/failure deterministically
// without touching real object storage. r2Enabled() returns true so the offload
// branch is exercised; r2PutObject is controlled per-test.
vi.mock("../cloudflare", () => ({
  r2Enabled: vi.fn(() => true),
  r2PutObject: vi.fn(),
  r2GetObject: vi.fn(),
}));

import { eq } from "drizzle-orm";
import { db, oraAssetsTable } from "@workspace/db";
import { persistOraAsset } from "../ora-assets";
import * as cloudflare from "../cloudflare";

/**
 * Acceptance tests for R2 offload of Ora library assets (Phase 6 T005).
 *
 * Verifies the three guarantees that are hard to cover via the DB-only path:
 *   - R2 success → bytes live in R2 (data null, storageKey set)
 *   - R2 failure (returned false OR thrown) → DB fallback (data set, no key)
 *   - the DB enforces the data/storageKey XOR invariant
 */

const HELLO_B64 = Buffer.from("hello").toString("base64");
const USER = `test-ora-r2-${Date.now()}`;

afterAll(async () => {
  await db.delete(oraAssetsTable).where(eq(oraAssetsTable.userId, USER));
  delete process.env.ORA_ASSETS_R2_ENABLED;
});

beforeEach(() => {
  vi.mocked(cloudflare.r2PutObject).mockReset();
  process.env.ORA_ASSETS_R2_ENABLED = "true";
});

async function rowFor(id: number) {
  const [row] = await db.select().from(oraAssetsTable).where(eq(oraAssetsTable.id, id));
  return row;
}

describe("persistOraAsset R2 offload", () => {
  it("offloads to R2 on success: data null, storageKey set", async () => {
    vi.mocked(cloudflare.r2PutObject).mockResolvedValue(true);
    const id = await persistOraAsset({
      userId: USER,
      kind: "image",
      fileName: "pic.png",
      mimeType: "image/png",
      format: "png",
      base64: HELLO_B64,
    });
    expect(id).toBeTypeOf("number");
    const row = await rowFor(id!);
    expect(row.data).toBeNull();
    expect(row.storageKey).toMatch(/^ora-assets\/.+\.png$/);
    expect(cloudflare.r2PutObject).toHaveBeenCalledOnce();
  });

  it("falls back to DB when R2 returns false", async () => {
    vi.mocked(cloudflare.r2PutObject).mockResolvedValue(false);
    const id = await persistOraAsset({
      userId: USER,
      kind: "file",
      fileName: "a.csv",
      mimeType: "text/csv",
      format: "csv",
      base64: HELLO_B64,
    });
    const row = await rowFor(id!);
    expect(row.data).toBe(HELLO_B64);
    expect(row.storageKey).toBeNull();
  });

  it("falls back to DB when R2 throws", async () => {
    vi.mocked(cloudflare.r2PutObject).mockRejectedValue(new Error("boom"));
    const id = await persistOraAsset({
      userId: USER,
      kind: "file",
      fileName: "b.csv",
      mimeType: "text/csv",
      format: "csv",
      base64: HELLO_B64,
    });
    const row = await rowFor(id!);
    expect(row.data).toBe(HELLO_B64);
    expect(row.storageKey).toBeNull();
  });

  it("uses the DB path when the offload flag is off", async () => {
    delete process.env.ORA_ASSETS_R2_ENABLED;
    const id = await persistOraAsset({
      userId: USER,
      kind: "file",
      fileName: "c.txt",
      mimeType: "text/plain",
      base64: HELLO_B64,
    });
    const row = await rowFor(id!);
    expect(row.data).toBe(HELLO_B64);
    expect(row.storageKey).toBeNull();
    expect(cloudflare.r2PutObject).not.toHaveBeenCalled();
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

  it("rejects a row with both data and storageKey", async () => {
    await expect(
      db.insert(oraAssetsTable).values({
        userId: USER,
        kind: "file",
        fileName: "bad2.txt",
        mimeType: "text/plain",
        data: HELLO_B64,
        storageKey: "ora-assets/x/y.txt",
        sizeBytes: 5,
      }),
    ).rejects.toThrow();
  });
});
