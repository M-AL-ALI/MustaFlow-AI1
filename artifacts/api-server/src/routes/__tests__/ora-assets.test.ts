import { describe, it, expect, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import {
  accountAssetQuotaTable,
  assetsTable,
  db,
  oraAssetsTable,
  oraFileContextsTable,
} from "@workspace/db";
import oraAssetsRouter from "../ora-assets";
import { persistOraAsset, getNextVersionLineage } from "../../lib/ora-assets";
import { relinkFileContextAfterRestore } from "../../lib/public-ai/file-context-store";
import {
  extractIfStatementByCondition,
  extractNamedFunction,
} from "../../lib/source-ast-test-helper";

const assetObjects = vi.hoisted(() => new Map<string, Buffer>());
vi.mock("../../lib/asset-r2", () => ({
  putAssetBuffer: vi.fn(async (input: { key: string; body: Buffer }) => {
    assetObjects.set(input.key, Buffer.from(input.body));
  }),
  readAssetBuffer: vi.fn(async (key: string) => assetObjects.get(key) ?? null),
  deleteAssetObject: vi.fn(async (key: string) => {
    assetObjects.delete(key);
  }),
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Acceptance tests for the durable Ora asset library (Task #1278).
 *
 * Mounts the real router with a stub auth middleware that sets req.userId (the
 * same contract the production auth wall provides), exercising the routes
 * against the real dev DB. Two distinct users prove ownership scoping.
 */

const USER_A = `test-ora-assets-a-${Date.now()}`;
const USER_B = `test-ora-assets-b-${Date.now()}`;

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(oraAssetsRouter);
  return app;
}

// A tiny known payload: "hello" → base64
const HELLO_B64 = Buffer.from("hello").toString("base64");

afterAll(async () => {
  const linked = await db
    .select({ assetId: oraAssetsTable.assetId })
    .from(oraAssetsTable)
    .where(inArray(oraAssetsTable.userId, [USER_A, USER_B]));
  await db.delete(oraAssetsTable).where(inArray(oraAssetsTable.userId, [USER_A, USER_B]));
  await db
    .delete(oraFileContextsTable)
    .where(inArray(oraFileContextsTable.userId, [USER_A, USER_B]));
  const ids = linked.flatMap((row) => (row.assetId === null ? [] : [row.assetId]));
  if (ids.length > 0) await db.delete(assetsTable).where(inArray(assetsTable.id, ids));
  await db
    .delete(accountAssetQuotaTable)
    .where(inArray(accountAssetQuotaTable.userId, [USER_A, USER_B]));
});

describe("persistOraAsset", () => {
  it("stores an asset and returns its id", async () => {
    const id = await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "report.csv",
      mimeType: "text/csv",
      format: "csv",
      prompt: "make a csv",
      base64: HELLO_B64,
    });
    expect(id).toBeTypeOf("number");
    const [row] = await db.select().from(oraAssetsTable).where(eq(oraAssetsTable.id, id!));
    expect(row.sizeBytes).toBe(5);
    expect(row.data).toBeNull();
    expect(row.assetId).toBeTypeOf("number");
    expect(row.storageKey).toMatch(/^assets\//);
  });

  it("skips empty payloads", async () => {
    const id = await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "empty.txt",
      mimeType: "text/plain",
      base64: "",
    });
    expect(id).toBeNull();
  });
});

describe("GET /ora/assets", () => {
  it("lists the user's assets without the data blob, newest first", async () => {
    await persistOraAsset({
      userId: USER_A,
      kind: "image",
      fileName: "pic.png",
      mimeType: "image/png",
      format: "png",
      base64: HELLO_B64,
    });
    const res = await request(appAs(USER_A)).get("/ora/assets");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.assets)).toBe(true);
    expect(res.body.assets.length).toBeGreaterThanOrEqual(2);
    // Newest first
    expect(res.body.assets[0].fileName).toBe("pic.png");
    // Never leaks the base64 blob
    for (const a of res.body.assets) {
      expect(a.data).toBeUndefined();
      expect(a).toHaveProperty("sizeBytes");
      expect(a).toHaveProperty("createdAt");
    }
  });

  it("scopes the list to the requesting user", async () => {
    const res = await request(appAs(USER_B)).get("/ora/assets");
    expect(res.status).toBe(200);
    expect(res.body.assets).toHaveLength(0);
  });
});

describe("GET /ora/assets/:id/download", () => {
  it("returns the raw bytes for the owner (inline by default)", async () => {
    const id = await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "doc.txt",
      mimeType: "text/plain",
      base64: HELLO_B64,
    });
    const res = await request(appAs(USER_A)).get(`/ora/assets/${id}/download`);
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.headers["content-disposition"]).toContain("inline");
    expect(res.text).toBe("hello");
  });

  it("forces attachment with ?download=1", async () => {
    const id = await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "doc2.txt",
      mimeType: "text/plain",
      base64: HELLO_B64,
    });
    const res = await request(appAs(USER_A)).get(`/ora/assets/${id}/download?download=1`);
    expect(res.headers["content-disposition"]).toContain("attachment");
  });

  it("404s when another user requests it (ownership)", async () => {
    const id = await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "secret.txt",
      mimeType: "text/plain",
      base64: HELLO_B64,
    });
    const res = await request(appAs(USER_B)).get(`/ora/assets/${id}/download`);
    expect(res.status).toBe(404);
  });

  it("400s on an invalid id", async () => {
    const res = await request(appAs(USER_A)).get(`/ora/assets/abc/download`);
    expect(res.status).toBe(400);
  });
});

describe("DELETE /ora/assets/:id", () => {
  it("soft-deletes and removes it from the list", async () => {
    const id = await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "trash.txt",
      mimeType: "text/plain",
      base64: HELLO_B64,
    });
    const del = await request(appAs(USER_A)).delete(`/ora/assets/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    // Soft-deleted: excluded from list and download
    const list = await request(appAs(USER_A)).get("/ora/assets");
    expect(list.body.assets.find((a: { id: number }) => a.id === id)).toBeUndefined();
    const dl = await request(appAs(USER_A)).get(`/ora/assets/${id}/download`);
    expect(dl.status).toBe(404);

    // Row still present with deletedAt set (soft, not hard)
    const [row] = await db.select().from(oraAssetsTable).where(eq(oraAssetsTable.id, id!));
    expect(row.deletedAt).not.toBeNull();
  });

  it("404s when another user tries to delete (ownership)", async () => {
    const id = await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "mine.txt",
      mimeType: "text/plain",
      base64: HELLO_B64,
    });
    const del = await request(appAs(USER_B)).delete(`/ora/assets/${id}`);
    expect(del.status).toBe(404);
    // Still alive for the owner
    const [row] = await db
      .select()
      .from(oraAssetsTable)
      .where(and(eq(oraAssetsTable.id, id!), eq(oraAssetsTable.userId, USER_A)));
    expect(row.deletedAt).toBeNull();
  });
});

/**
 * Regression guard: the chat handler has heavy AI/session dependencies (the
 * repo convention is static source assertions for it). Both the file- and
 * image-generation branches must persist generated outputs to the durable
 * library for signed-in users — a previous version persisted images but not
 * files, silently breaking the durable-library promise for documents.
 */
describe("chat.ts persists generated outputs to the asset library", () => {
  const chatSrc = readFileSync(path.join(__dirname, "../public-ai/chat.ts"), "utf8");

  it("the file_generation branch persists generated files", () => {
    const fileBranch = extractIfStatementByCondition(
      chatSrc,
      'decision.tool === "file_generation" && decision.fileFormat',
    );
    expect(fileBranch).toContain("persistOraAsset");
    expect(fileBranch).toContain('kind: "file"');
  });

  it("the image_generation branch persists generated images", () => {
    const imageBranch = extractIfStatementByCondition(
      chatSrc,
      'decision.tool === "image_generation"',
    );
    expect(imageBranch).toContain("persistOraAsset");
    expect(imageBranch).toContain('kind: "image"');
  });

  it("generate-file route persists too", () => {
    const genSrc = readFileSync(path.join(__dirname, "../public-ai/generate-file.ts"), "utf8");
    expect(genSrc).toContain("persistOraAsset");
  });
});

/**
 * Regression guard: Ora-origin inline image *edits* run as a background job
 * (heavy provider/storage deps), so the repo convention is a static source
 * assertion. The successful-edit branch must mirror the edited result into the
 * durable Ora asset library so it shows up under Library — and only for
 * Ora-billed edits (Image Studio edits already live in generated_images).
 */
describe("image-generation-jobs.ts persists Ora-edited images to the asset library", () => {
  const jobsSrc = readFileSync(path.join(__dirname, "../../lib/image-generation-jobs.ts"), "utf8");

  it("the edit-success path persists Ora edits to the library", () => {
    const body = extractNamedFunction(jobsSrc, "runImageEditJob");
    expect(body).toContain('opts.billingMode === "ora"');
    expect(body).toContain("persistOraAsset");
    expect(body).toContain('kind: "image"');
  });
});

/**
 * Phase 2: File Revision History. Version chains are identified by their v1
 * root (`COALESCE(root_asset_id, id)`); every edit/restore appends a NEW head
 * row — history is never rewritten.
 */
const WORLD_B64 = Buffer.from("world").toString("base64");

async function makeChain(userId: string, fileRef: string | null) {
  const v1 = await persistOraAsset({
    userId,
    kind: "file",
    fileName: "chain.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    format: "docx",
    base64: HELLO_B64,
    sourceFileRef: fileRef,
  });
  const v2 = await persistOraAsset({
    userId,
    kind: "file",
    fileName: "chain.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    format: "docx",
    base64: WORLD_B64,
    rootAssetId: v1,
    parentAssetId: v1,
    versionNumber: 2,
    sourceFileRef: fileRef,
    editSummary: "Replaced hello with world",
  });
  return { v1: v1!, v2: v2! };
}

describe("persistOraAsset version lineage", () => {
  it("round-trips lineage fields and defaults to a standalone v1", async () => {
    const { v1, v2 } = await makeChain(USER_A, null);
    const [r1] = await db.select().from(oraAssetsTable).where(eq(oraAssetsTable.id, v1));
    expect(r1.rootAssetId).toBeNull();
    expect(r1.parentAssetId).toBeNull();
    expect(r1.versionNumber).toBe(1);
    const [r2] = await db.select().from(oraAssetsTable).where(eq(oraAssetsTable.id, v2));
    expect(r2.rootAssetId).toBe(v1);
    expect(r2.parentAssetId).toBe(v1);
    expect(r2.versionNumber).toBe(2);
    expect(r2.editSummary).toBe("Replaced hello with world");
  });
});

describe("getNextVersionLineage", () => {
  it("returns null when no durable context links the fileRef", async () => {
    expect(await getNextVersionLineage(USER_A, crypto.randomUUID())).toBeNull();
  });

  it("derives parent/root/version from the linked chain head", async () => {
    const fileRef = crypto.randomUUID();
    const { v1, v2 } = await makeChain(USER_A, fileRef);
    await db.insert(oraFileContextsTable).values({
      userId: USER_A,
      fileRef,
      sessionId: "test-session",
      filename: "chain.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileType: "docx",
      extractedText: "hello",
      charCount: 5,
      assetId: v2,
    });
    const lineage = await getNextVersionLineage(USER_A, fileRef);
    // oraProjectId mirrors the chain head's project (null here) so new
    // versions inherit it and a chain never splits across projects.
    expect(lineage).toEqual({
      parentAssetId: v2,
      rootAssetId: v1,
      versionNumber: 3,
      oraProjectId: null,
    });
    // Another user cannot piggyback on the same fileRef
    expect(await getNextVersionLineage(USER_B, fileRef)).toBeNull();
  });
});

describe("GET /ora/assets/:id/versions", () => {
  it("returns the full chain from any anchor, oldest first, head marked current", async () => {
    const { v1, v2 } = await makeChain(USER_A, null);
    for (const anchor of [v1, v2]) {
      const res = await request(appAs(USER_A)).get(`/ora/assets/${anchor}/versions`);
      expect(res.status).toBe(200);
      expect(res.body.rootAssetId).toBe(v1);
      expect(res.body.currentAssetId).toBe(v2);
      expect(res.body.versions.map((v: { id: number }) => v.id)).toEqual([v1, v2]);
      expect(res.body.versions[0].isCurrent).toBe(false);
      expect(res.body.versions[1].isCurrent).toBe(true);
      expect(res.body.versions[1].editSummary).toBe("Replaced hello with world");
      // Metadata only — never the blob
      for (const v of res.body.versions) expect(v.data).toBeUndefined();
    }
  });

  it("returns a single-entry chain for a standalone asset", async () => {
    const id = await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "solo.txt",
      mimeType: "text/plain",
      base64: HELLO_B64,
    });
    const res = await request(appAs(USER_A)).get(`/ora/assets/${id}/versions`);
    expect(res.status).toBe(200);
    expect(res.body.versions).toHaveLength(1);
    expect(res.body.versions[0].isCurrent).toBe(true);
  });

  it("404s for another user's asset (ownership)", async () => {
    const { v1 } = await makeChain(USER_A, null);
    const res = await request(appAs(USER_B)).get(`/ora/assets/${v1}/versions`);
    expect(res.status).toBe(404);
  });
});

describe("POST /ora/assets/:id/restore", () => {
  it("appends the old version's bytes as a NEW head (append-only)", async () => {
    const { v1, v2 } = await makeChain(USER_A, null);
    const res = await request(appAs(USER_A)).post(`/ora/assets/${v1}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.versionNumber).toBe(3);
    expect(res.body.restoredFromVersion).toBe(1);

    const [v3] = await db
      .select()
      .from(oraAssetsTable)
      .where(eq(oraAssetsTable.id, res.body.assetId));
    expect(v3.rootAssetId).toBe(v1);
    expect(v3.parentAssetId).toBe(v2);
    expect(v3.versionNumber).toBe(3);
    expect(v3.editSummary).toBe("Restored version 1");
    // Bytes copied from v1 into a new unified asset, never a shared pointer.
    expect(v3.data).toBeNull();
    expect(v3.assetId).toBeTypeOf("number");
    expect(v3.storageKey).not.toBeNull();

    // History intact: chain now shows all three, new head current
    const chain = await request(appAs(USER_A)).get(`/ora/assets/${v1}/versions`);
    expect(chain.body.versions).toHaveLength(3);
    expect(chain.body.currentAssetId).toBe(res.body.assetId);
    // Old versions still downloadable
    const dl = await request(appAs(USER_A)).get(`/ora/assets/${v2}/download`);
    expect(dl.text).toBe("world");
  });

  it("repoints the durable file context at the restored asset", async () => {
    const fileRef = crypto.randomUUID();
    const { v1, v2 } = await makeChain(USER_A, fileRef);
    await db.insert(oraFileContextsTable).values({
      userId: USER_A,
      fileRef,
      sessionId: "test-session",
      filename: "chain.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      fileType: "txt", // avoid docx re-extraction on fake bytes
      extractedText: "world",
      charCount: 5,
      assetId: v2,
    });
    const res = await request(appAs(USER_A)).post(`/ora/assets/${v1}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.relinked).toBe(true);
    const [ctx] = await db
      .select()
      .from(oraFileContextsTable)
      .where(
        and(eq(oraFileContextsTable.userId, USER_A), eq(oraFileContextsTable.fileRef, fileRef)),
      );
    expect(ctx.assetId).toBe(res.body.assetId);
    // Follow-up edits would now chain onto the restored head
    const lineage = await getNextVersionLineage(USER_A, fileRef);
    expect(lineage).toEqual({
      parentAssetId: res.body.assetId,
      rootAssetId: v1,
      versionNumber: 4,
      oraProjectId: null,
    });
  });

  it("409s when restoring the current head", async () => {
    const { v2 } = await makeChain(USER_A, null);
    const res = await request(appAs(USER_A)).post(`/ora/assets/${v2}/restore`);
    expect(res.status).toBe(409);
  });

  it("404s for another user's asset (ownership)", async () => {
    const { v1 } = await makeChain(USER_A, null);
    const res = await request(appAs(USER_B)).post(`/ora/assets/${v1}/restore`);
    expect(res.status).toBe(404);
  });

  it("400s on an invalid id", async () => {
    const res = await request(appAs(USER_A)).post(`/ora/assets/abc/restore`);
    expect(res.status).toBe(400);
  });
});

describe("relinkFileContextAfterRestore", () => {
  it("returns false when no durable context row exists", async () => {
    const ok = await relinkFileContextAfterRestore({
      userId: USER_A,
      fileRef: crypto.randomUUID(),
      assetId: 1,
      bytes: Buffer.from("hello"),
    });
    expect(ok).toBe(false);
  });
});

/**
 * Regression guard (static source assertions, repo convention for the heavy
 * chat/generate-file handlers): the edited-file persist paths must derive
 * version lineage and surface the persisted version id on the quality card.
 */
describe("edited-file persist paths chain version lineage", () => {
  const chatSrc = readFileSync(path.join(__dirname, "../public-ai/chat.ts"), "utf8");
  const genSrc = readFileSync(path.join(__dirname, "../public-ai/generate-file.ts"), "utf8");

  it("chat.ts derives lineage for in-place edits and emits versionId", () => {
    expect(chatSrc).toContain("getNextVersionLineage");
    expect(chatSrc).toContain("result.editQuality.versionId = assetId");
  });

  it("generate-file.ts derives lineage for in-place edits and emits versionId", () => {
    expect(genSrc).toContain("getNextVersionLineage");
    expect(genSrc).toContain("result.editQuality.versionId = assetId");
  });

  it("upload.ts marks uploaded assets as v1 chain roots via sourceFileRef", () => {
    const uploadSrc = readFileSync(path.join(__dirname, "../public-ai/upload.ts"), "utf8");
    expect(uploadSrc.split("sourceFileRef: fileRef").length - 1).toBe(2);
  });
});
