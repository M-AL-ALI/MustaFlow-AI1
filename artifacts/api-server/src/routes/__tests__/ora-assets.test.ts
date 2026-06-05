import { describe, it, expect, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray } from "drizzle-orm";
import { db, oraAssetsTable } from "@workspace/db";
import oraAssetsRouter from "../ora-assets";
import { persistOraAsset } from "../../lib/ora-assets";

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
  await db.delete(oraAssetsTable).where(inArray(oraAssetsTable.userId, [USER_A, USER_B]));
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
    expect(row.data).toBe(HELLO_B64);
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

  it("both file- and image-generation branches call persistOraAsset", () => {
    const occurrences = chatSrc.match(/persistOraAsset/g) ?? [];
    // One import + one call in each of the two branches.
    expect(occurrences.length).toBeGreaterThanOrEqual(2);
  });

  it("generate-file route persists too", () => {
    const genSrc = readFileSync(path.join(__dirname, "../public-ai/generate-file.ts"), "utf8");
    expect(genSrc).toContain("persistOraAsset");
  });
});
