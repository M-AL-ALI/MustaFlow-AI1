import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express, { type Express } from "express";
import type { Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db, knowledgeEntriesTable, oraProjectsTable } from "@workspace/db";

/**
 * Phase 7 — Memory Upgrades. Real-router + dev-DB integration tests for the
 * new API surface:
 *
 *  1. GET /ora/memories?scope=all — returns global AND project memories in one
 *     list (each row carries oraProjectId), while the default and
 *     ?oraProjectId=<id> forms keep their original single-tier behavior.
 *  2. POST /public-ai/remember-document with oraProjectId — anchors a document
 *     memory to an owned Ora project; rejects foreign/archived projects with a
 *     404 (never silently downgrades to a global save).
 *
 * The AI summarizer is the only mocked step in the remember-document flow —
 * auth/spend-cap are stubbed via the same module-mock pattern as
 * export-file.test.ts; project ownership, the file store, and the insert all
 * run for real against the dev DB.
 */

process.env.ORA_SESSION_SECRET ??= "test-secret-at-least-32-chars-long-ok";

const authState = vi.hoisted(() => ({
  user: null as null | { userId: string; tier: string; isPaid: boolean },
}));

vi.mock("../../lib/public-ai/authed-user", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/public-ai/authed-user")>()),
  resolveAuthedOraUser: vi.fn(async () => authState.user),
}));

vi.mock("../../lib/public-ai/ora-spend-cap", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/public-ai/ora-spend-cap")>()),
  checkOraSpendCapAsync: vi.fn(async () => ({ allowed: true as const })),
}));

vi.mock("../../lib/public-ai/orchestrator", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/public-ai/orchestrator")>()),
  summarizeDocumentForMemory: vi.fn(
    async () => "Planning document covering roadmap priorities and team goals.",
  ),
}));

const SCOPE_USER = `test-ora-scopeall-${Date.now()}`;
const DOC_USER = `test-ora-docscope-${Date.now()}`;
const OTHER_USER = `test-ora-docscope-other-${Date.now()}`;

async function cleanupUser(userId: string) {
  await db.delete(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.userId, userId));
  await db.delete(oraProjectsTable).where(eq(oraProjectsTable.userId, userId));
}

function memoriesAppAs(userId: string, router: express.Router): Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    req.userId = userId;
    next();
  });
  app.use(router);
  return app;
}

afterAll(async () => {
  if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
  await cleanupUser(SCOPE_USER);
  await cleanupUser(DOC_USER);
  await cleanupUser(OTHER_USER);
});

// ─── 1. GET /ora/memories?scope=all ──────────────────────────────────────────

describe.skipIf(process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true")(
  "GET /ora/memories scope handling (Phase 7)",
  () => {
    let app: Express;
    let projectId: number;

    beforeAll(async () => {
      if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
      const memoriesRouter = (await import("../ora-memories")).default;
      app = memoriesAppAs(SCOPE_USER, memoriesRouter);
      await cleanupUser(SCOPE_USER);

      const [project] = await db
        .insert(oraProjectsTable)
        .values({ userId: SCOPE_USER, name: "Scope Project" })
        .returning({ id: oraProjectsTable.id });
      projectId = project.id;

      const baseRow = {
        type: "note" as const,
        category: "preference",
        severity: "info" as const,
        scope: "user" as const,
        origin: "ora" as const,
        userId: SCOPE_USER,
        projectId: null,
        enabled: true,
        approvedForReuse: false,
      };
      await db.insert(knowledgeEntriesTable).values([
        { ...baseRow, title: "GlobalFact", content: "global", oraProjectId: null },
        { ...baseRow, title: "ProjectFact", content: "project", oraProjectId: projectId },
      ]);
    }, 30000);

    it("default listing returns ONLY user-level memories", async () => {
      const res = await request(app).get("/ora/memories");
      expect(res.status).toBe(200);
      const titles = res.body.memories.map((m: { title: string }) => m.title);
      expect(titles).toContain("GlobalFact");
      expect(titles).not.toContain("ProjectFact");
    });

    it("?oraProjectId=<id> returns ONLY that project's memories", async () => {
      const res = await request(app).get(`/ora/memories?oraProjectId=${projectId}`);
      expect(res.status).toBe(200);
      const titles = res.body.memories.map((m: { title: string }) => m.title);
      expect(titles).toEqual(["ProjectFact"]);
    });

    it("?scope=all returns BOTH tiers, each row carrying its oraProjectId", async () => {
      const res = await request(app).get("/ora/memories?scope=all");
      expect(res.status).toBe(200);
      const byTitle = new Map<string, { oraProjectId: number | null }>(
        res.body.memories.map((m: { title: string; oraProjectId: number | null }) => [m.title, m]),
      );
      expect(byTitle.get("GlobalFact")?.oraProjectId).toBeNull();
      expect(byTitle.get("ProjectFact")?.oraProjectId).toBe(projectId);
    });

    it("?scope=all never leaks another user's memories", async () => {
      const strangerRouter = (await import("../ora-memories")).default;
      const strangerApp = memoriesAppAs(`${SCOPE_USER}-stranger`, strangerRouter);
      const res = await request(strangerApp).get("/ora/memories?scope=all");
      expect(res.status).toBe(200);
      expect(res.body.memories).toEqual([]);
    });
  },
);

// ─── 2. POST /public-ai/remember-document with oraProjectId ─────────────────

describe.skipIf(process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true")(
  "POST /public-ai/remember-document project scoping (Phase 7)",
  () => {
    let app: Express;
    let sessionCookie: string;
    let sessionId: string;
    let ownedProjectId: number;
    let foreignProjectId: number;
    let archivedProjectId: number;
    let storeFile: typeof import("../../lib/public-ai/file-store").storeFile;

    function seedFile(): string {
      return storeFile({
        sessionId,
        filename: "roadmap.txt",
        mimeType: "text/plain",
        extractedText: "Quarterly roadmap priorities and team goals for the design group.",
        charCount: 66,
      });
    }

    beforeAll(async () => {
      if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
      const rememberDocumentRouter = (await import("../public-ai/remember-document")).default;
      const { createSession } = await import("../../lib/public-ai/session");
      ({ storeFile } = await import("../../lib/public-ai/file-store"));

      const session = createSession();
      sessionCookie = `ora-session=${session.token}`;
      sessionId = session.payload.sessionId;

      const app_ = express();
      app_.use(express.json());
      app_.use(cookieParser());
      app_.use(rememberDocumentRouter);
      app = app_;

      await cleanupUser(DOC_USER);
      await cleanupUser(OTHER_USER);
      const [owned] = await db
        .insert(oraProjectsTable)
        .values({ userId: DOC_USER, name: "Doc Project" })
        .returning({ id: oraProjectsTable.id });
      ownedProjectId = owned.id;
      const [foreign] = await db
        .insert(oraProjectsTable)
        .values({ userId: OTHER_USER, name: "Foreign Project" })
        .returning({ id: oraProjectsTable.id });
      foreignProjectId = foreign.id;
      const [archived] = await db
        .insert(oraProjectsTable)
        .values({ userId: DOC_USER, name: "Archived Project", archivedAt: new Date() })
        .returning({ id: oraProjectsTable.id });
      archivedProjectId = archived.id;

      authState.user = { userId: DOC_USER, tier: "free", isPaid: false };
    }, 30000);

    it("rejects a project the caller does not own with 404 (no silent global save)", async () => {
      const fileRef = seedFile();
      const res = await request(app)
        .post("/public-ai/remember-document")
        .set("Cookie", sessionCookie)
        .send({ fileRef, oraProjectId: foreignProjectId });
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/project not found/i);
      const rows = await db
        .select({ id: knowledgeEntriesTable.id })
        .from(knowledgeEntriesTable)
        .where(eq(knowledgeEntriesTable.userId, DOC_USER));
      expect(rows).toEqual([]);
    });

    it("rejects an archived project with 404", async () => {
      const fileRef = seedFile();
      const res = await request(app)
        .post("/public-ai/remember-document")
        .set("Cookie", sessionCookie)
        .send({ fileRef, oraProjectId: archivedProjectId });
      expect(res.status).toBe(404);
    });

    it("saves a project-anchored document memory for an OWNED project", async () => {
      const fileRef = seedFile();
      const res = await request(app)
        .post("/public-ai/remember-document")
        .set("Cookie", sessionCookie)
        .send({ fileRef, oraProjectId: ownedProjectId });
      expect(res.status).toBe(201);
      expect(res.body.saved).toBe(true);
      expect(res.body.memory.oraProjectId).toBe(ownedProjectId);

      const [row] = await db
        .select({
          oraProjectId: knowledgeEntriesTable.oraProjectId,
          category: knowledgeEntriesTable.category,
          origin: knowledgeEntriesTable.origin,
          scope: knowledgeEntriesTable.scope,
        })
        .from(knowledgeEntriesTable)
        .where(eq(knowledgeEntriesTable.id, res.body.memory.id));
      expect(row).toMatchObject({
        oraProjectId: ownedProjectId,
        category: "document",
        origin: "ora",
        scope: "user",
      });
    });

    it("omitting oraProjectId still saves a GLOBAL document memory", async () => {
      const fileRef = seedFile();
      const res = await request(app)
        .post("/public-ai/remember-document")
        .set("Cookie", sessionCookie)
        .send({ fileRef });
      expect(res.status).toBe(201);
      expect(res.body.memory.oraProjectId).toBeNull();
    });
  },
);
