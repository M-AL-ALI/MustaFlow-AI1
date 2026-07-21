import { describe, it, expect, afterAll, beforeAll } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  db,
  knowledgeEntriesTable,
  oraAssetsTable,
  oraConversationsTable,
  oraProjectsTable,
} from "@workspace/db";
import oraConversationsRouter from "../ora-conversations";
import oraAssetsRouter from "../ora-assets";
import { persistOraAsset } from "../../lib/ora-assets";

/**
 * Phase 6 "Project Spaces" acceptance tests.
 *
 * Covers the durable contracts the website + mobile clients rely on:
 *  1. GET /ora/projects hides archived projects by default and exposes them
 *     (with archivedAt) via ?includeArchived=true.
 *  2. DELETE /ora/projects/:id archives (never destroys) the project and its
 *     Ora memories; POST /ora/projects/:id/restore brings both back — while
 *     memories the user archived earlier stay archived.
 *  3. GET /ora/assets tri-state ?projectId= filter: absent = everything,
 *     "personal" = unfiled only, <id> = that project only; junk → 400.
 *  4. persistOraAsset files assets under the requested project.
 *
 * Mounts the real routers with a stub auth middleware that sets req.userId
 * (the production auth-wall contract) against the real dev DB.
 */

const USER_A = `test-ora-projspace-a-${Date.now()}`;
const USER_B = `test-ora-projspace-b-${Date.now()}`;

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(oraConversationsRouter);
  app.use(oraAssetsRouter);
  return app;
}

const HELLO_B64 = Buffer.from("hello").toString("base64");

let projectId: number;

beforeAll(async () => {
  const res = await request(appAs(USER_A)).post("/ora/projects").send({ name: "Trip planning" });
  expect(res.status).toBe(201);
  projectId = res.body.project.id;
});

afterAll(async () => {
  const users = [USER_A, USER_B];
  await db.delete(oraAssetsTable).where(inArray(oraAssetsTable.userId, users));
  await db.delete(knowledgeEntriesTable).where(inArray(knowledgeEntriesTable.userId, users));
  await db.delete(oraConversationsTable).where(inArray(oraConversationsTable.userId, users));
  await db.delete(oraProjectsTable).where(inArray(oraProjectsTable.userId, users));
});

describe("GET /ora/assets tri-state projectId filter", () => {
  let personalAssetId: number;
  let projectAssetId: number;

  beforeAll(async () => {
    personalAssetId = (await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "personal.csv",
      mimeType: "text/csv",
      format: "csv",
      prompt: "personal file",
      base64: HELLO_B64,
    }))!;
    projectAssetId = (await persistOraAsset({
      userId: USER_A,
      kind: "file",
      fileName: "project.csv",
      mimeType: "text/csv",
      format: "csv",
      prompt: "project file",
      base64: HELLO_B64,
      oraProjectId: projectId,
    }))!;
  });

  it("persistOraAsset stores the project anchor", async () => {
    const [row] = await db
      .select({ oraProjectId: oraAssetsTable.oraProjectId })
      .from(oraAssetsTable)
      .where(eq(oraAssetsTable.id, projectAssetId));
    expect(row.oraProjectId).toBe(projectId);
  });

  it("returns everything when the filter is absent", async () => {
    const res = await request(appAs(USER_A)).get("/ora/assets");
    expect(res.status).toBe(200);
    const ids = res.body.assets.map((a: { id: number }) => a.id);
    expect(ids).toContain(personalAssetId);
    expect(ids).toContain(projectAssetId);
  });

  it("?projectId=personal returns only unfiled assets", async () => {
    const res = await request(appAs(USER_A)).get("/ora/assets?projectId=personal");
    expect(res.status).toBe(200);
    const ids = res.body.assets.map((a: { id: number }) => a.id);
    expect(ids).toContain(personalAssetId);
    expect(ids).not.toContain(projectAssetId);
  });

  it("?projectId=<id> returns only that project's assets", async () => {
    const res = await request(appAs(USER_A)).get(`/ora/assets?projectId=${projectId}`);
    expect(res.status).toBe(200);
    const ids = res.body.assets.map((a: { id: number }) => a.id);
    expect(ids).toEqual([projectAssetId]);
    expect(res.body.assets[0].oraProjectId).toBe(projectId);
  });

  it("rejects a junk projectId filter", async () => {
    const res = await request(appAs(USER_A)).get("/ora/assets?projectId=banana");
    expect(res.status).toBe(400);
  });
});

describe("project archive / restore lifecycle", () => {
  let lifecycleProjectId: number;
  let preArchivedMemoryId: number;
  let activeMemoryId: number;

  beforeAll(async () => {
    const res = await request(appAs(USER_A)).post("/ora/projects").send({ name: "Archive me" });
    lifecycleProjectId = res.body.project.id;

    // One memory the user archived BEFORE the project archive (must stay
    // archived after restore) and one active project memory.
    const [pre] = await db
      .insert(knowledgeEntriesTable)
      .values({
        title: "Old memory",
        content: "archived earlier by the user",
        userId: USER_A,
        origin: "ora",
        scope: "user",
        oraProjectId: lifecycleProjectId,
        archivedAt: new Date(Date.now() - 60_000),
      })
      .returning({ id: knowledgeEntriesTable.id });
    preArchivedMemoryId = pre.id;
    const [active] = await db
      .insert(knowledgeEntriesTable)
      .values({
        title: "Active memory",
        content: "attached to the project",
        userId: USER_A,
        origin: "ora",
        scope: "user",
        oraProjectId: lifecycleProjectId,
      })
      .returning({ id: knowledgeEntriesTable.id });
    activeMemoryId = active.id;
  });

  it("archives the project and its active memories on DELETE", async () => {
    const res = await request(appAs(USER_A)).delete(`/ora/projects/${lifecycleProjectId}`);
    expect(res.status).toBe(200);

    const [proj] = await db
      .select({ archivedAt: oraProjectsTable.archivedAt })
      .from(oraProjectsTable)
      .where(eq(oraProjectsTable.id, lifecycleProjectId));
    expect(proj.archivedAt).not.toBeNull();

    const [mem] = await db
      .select({ archivedAt: knowledgeEntriesTable.archivedAt })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, activeMemoryId));
    expect(mem.archivedAt).not.toBeNull();
  });

  it("hides archived projects from the default list, shows them with includeArchived", async () => {
    const def = await request(appAs(USER_A)).get("/ora/projects");
    expect(def.status).toBe(200);
    const defIds = def.body.projects.map((p: { id: number }) => p.id);
    expect(defIds).not.toContain(lifecycleProjectId);

    const all = await request(appAs(USER_A)).get("/ora/projects?includeArchived=true");
    expect(all.status).toBe(200);
    const archived = all.body.projects.find((p: { id: number }) => p.id === lifecycleProjectId);
    expect(archived).toBeDefined();
    expect(archived.archivedAt).not.toBeNull();
  });

  it("blocks attaching a conversation to an archived project", async () => {
    const res = await request(appAs(USER_A))
      .post("/ora/conversations")
      .send({ title: "Should fail", projectId: lifecycleProjectId });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it("restore un-archives the project and its project-archived memories only", async () => {
    const res = await request(appAs(USER_A)).post(`/ora/projects/${lifecycleProjectId}/restore`);
    expect(res.status).toBe(200);
    expect(res.body.project.archivedAt).toBeNull();

    const [restoredMem] = await db
      .select({ archivedAt: knowledgeEntriesTable.archivedAt })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, activeMemoryId));
    expect(restoredMem.archivedAt).toBeNull();

    // The memory the user archived earlier must remain archived.
    const [oldMem] = await db
      .select({ archivedAt: knowledgeEntriesTable.archivedAt })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, preArchivedMemoryId));
    expect(oldMem.archivedAt).not.toBeNull();
  });

  it("returns 400 when restoring a project that is not archived", async () => {
    const res = await request(appAs(USER_A)).post(`/ora/projects/${lifecycleProjectId}/restore`);
    expect(res.status).toBe(400);
  });

  it("scopes archive/restore to the owning user", async () => {
    const del = await request(appAs(USER_B)).delete(`/ora/projects/${lifecycleProjectId}`);
    expect(del.status).toBe(404);
    const restore = await request(appAs(USER_B)).post(
      `/ora/projects/${lifecycleProjectId}/restore`,
    );
    expect(restore.status).toBe(404);

    // USER_A's project is untouched by USER_B's attempts.
    const [proj] = await db
      .select({ archivedAt: oraProjectsTable.archivedAt })
      .from(oraProjectsTable)
      .where(and(eq(oraProjectsTable.id, lifecycleProjectId), isNull(oraProjectsTable.archivedAt)));
    expect(proj).toBeDefined();
  });
});
