import { describe, it, expect, beforeAll, afterAll } from "vitest";
import express, { type Express } from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db, knowledgeEntriesTable, oraProjectsTable } from "@workspace/db";

/**
 * Real integration tests for the Ora-memory enhancements:
 *  - T4 capacity meter: GET /ora/memories/usage, 409 "memory_full" at cap, and
 *    the ATOMIC cap (concurrent saves can never overshoot the limit — the count
 *    check + insert run under a per-user advisory lock).
 *  - T5 project isolation: buildMemoryContext injects ONLY the active tier
 *    (project-only inside a project chat, user-only in a general chat).
 *
 * The cap is read from ORA_MEMORY_MAX at module load, so the route is imported
 * DYNAMICALLY after the env is set. buildMemoryContext doesn't depend on it, but
 * is imported the same way for consistency.
 */

const CAP = 3;
process.env.ORA_MEMORY_MAX = String(CAP);

const CAP_USER = `test-ora-cap-${Date.now()}`;
const ISO_USER = `test-ora-iso-${Date.now()}`;

let capApp: Express;
let buildMemoryContext: (
  userId: string,
  oraProjectId?: number | null,
  currentMessage?: string,
) => Promise<{ text: string; used: { id: number; title: string }[] }>;

function appAs(userId: string, router: express.Router): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(router);
  return app;
}

async function clearMemories(userId: string) {
  await db.delete(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.userId, userId));
}

beforeAll(async () => {
  const memoriesRouter = (await import("../ora-memories")).default;
  capApp = appAs(CAP_USER, memoriesRouter);
  ({ buildMemoryContext } = await import("../public-ai/chat"));
  await clearMemories(CAP_USER);
  await clearMemories(ISO_USER);
}, 30000);

afterAll(async () => {
  await clearMemories(CAP_USER);
  await clearMemories(ISO_USER);
  await db.delete(oraProjectsTable).where(eq(oraProjectsTable.userId, ISO_USER));
});

describe("T4 — Ora memory capacity meter + atomic cap", () => {
  it("reports usage, blocks at cap with a 409 'memory_full', and never overshoots under concurrency", async () => {
    // Fill to one below the cap.
    for (let i = 0; i < CAP - 1; i++) {
      const r = await request(capApp)
        .post("/ora/memories")
        .send({ title: `fact ${i}`, content: `value ${i}` });
      expect(r.status).toBe(201);
    }

    // Usage endpoint reflects the current count + configured limit.
    const usage = await request(capApp).get("/ora/memories/usage");
    expect(usage.status).toBe(200);
    expect(usage.body).toMatchObject({ count: CAP - 1, limit: CAP });

    // Fire many concurrent saves from the last free slot. With a correct atomic
    // cap exactly ONE may succeed; the rest must be rejected with a 409.
    const burst = await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        request(capApp)
          .post("/ora/memories")
          .send({ title: `race ${i}`, content: `v${i}` }),
      ),
    );
    const created = burst.filter((r) => r.status === 201);
    const full = burst.filter((r) => r.status === 409);
    expect(created).toHaveLength(1);
    expect(full).toHaveLength(5);
    for (const r of full) {
      expect(r.body.code).toBe("memory_full");
      expect(r.body.limit).toBe(CAP);
    }

    // The hard guarantee: the table never exceeded the cap.
    const finalUsage = await request(capApp).get("/ora/memories/usage");
    expect(finalUsage.body.count).toBe(CAP);

    // A further save is still cleanly rejected.
    const over = await request(capApp)
      .post("/ora/memories")
      .send({ title: "one too many", content: "x" });
    expect(over.status).toBe(409);
    expect(over.body.code).toBe("memory_full");
  }, 30000);
});

describe("T5 — Ora memory project isolation (buildMemoryContext)", () => {
  it("injects ONLY the active tier (project chat → project memories; general chat → user memories)", async () => {
    const [project] = await db
      .insert(oraProjectsTable)
      .values({ userId: ISO_USER, name: "Isolation Project" })
      .returning({ id: oraProjectsTable.id });

    const baseRow = {
      type: "note" as const,
      category: "preference",
      severity: "info" as const,
      scope: "user" as const,
      origin: "ora" as const,
      userId: ISO_USER,
      projectId: null,
      enabled: true,
      approvedForReuse: false,
    };

    await db.insert(knowledgeEntriesTable).values([
      { ...baseRow, title: "UserLevelFact", content: "general scope", oraProjectId: null },
      {
        ...baseRow,
        title: "ProjectScopedFact",
        content: "project scope",
        oraProjectId: project.id,
      },
    ]);

    // General (standalone) chat: only the user-level fact, never the project one.
    const general = await buildMemoryContext(ISO_USER, null);
    expect(general.text).toContain("UserLevelFact");
    expect(general.text).not.toContain("ProjectScopedFact");
    expect(general.used.map((u) => u.title)).toEqual(["UserLevelFact"]);

    // Project chat: only the project fact, never the general one.
    const inProject = await buildMemoryContext(ISO_USER, project.id);
    expect(inProject.text).toContain("ProjectScopedFact");
    expect(inProject.text).not.toContain("UserLevelFact");
    expect(inProject.used.map((u) => u.title)).toEqual(["ProjectScopedFact"]);

    // A project the user does NOT own injects nothing (ownership-gated).
    const foreign = await buildMemoryContext(ISO_USER, project.id + 999_999);
    expect(foreign.text).toBe("");
    expect(foreign.used).toEqual([]);
  }, 30000);
});
