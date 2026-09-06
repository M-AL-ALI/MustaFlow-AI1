import { describe, it, expect, afterAll } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq } from "drizzle-orm";
import { db, knowledgeEntriesTable } from "@workspace/db";
import oraMemoriesRouter from "../ora-memories";
import { buildMemoryContext } from "../public-ai/chat";

/**
 * Integration tests for the Ora memory consolidation flow (Task #1390).
 *
 * The overlap-detection rule (findMemoriesToSupersede) is unit-tested in
 * lib/public-ai/memory-consolidation.test.ts. These tests exercise the actual
 * API + DB behaviour end-to-end against a real (test) DB:
 *
 *  - POST /api/ora/memories supersedes an overlapping existing memory (old row
 *    disabled + tagged superseded_by = the new row's id).
 *  - POST /api/ora/memories/:id/restore clears superseded_by and re-enables.
 *  - buildMemoryContext (what Ora actually sees) excludes superseded rows.
 */

const USER = `test-ora-memcon-${Date.now()}`;

function appAs(userId: string) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use(oraMemoriesRouter);
  return app;
}

async function createMemory(
  app: express.Express,
  title: string,
  content: string,
): Promise<{ id: number; supersededIds: number[] }> {
  const res = await request(app).post("/ora/memories").send({ title, content });
  expect(res.status).toBe(201);
  return { id: res.body.memory.id as number, supersededIds: res.body.supersededIds as number[] };
}

async function getRow(id: number) {
  const [row] = await db
    .select({
      id: knowledgeEntriesTable.id,
      enabled: knowledgeEntriesTable.enabled,
      supersededBy: knowledgeEntriesTable.supersededBy,
    })
    .from(knowledgeEntriesTable)
    .where(eq(knowledgeEntriesTable.id, id));
  return row;
}

afterAll(async () => {
  if (process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true") return;
  await db
    .delete(knowledgeEntriesTable)
    .where(and(eq(knowledgeEntriesTable.userId, USER), eq(knowledgeEntriesTable.scope, "user")));
});

describe.skipIf(process.env.NABUFLOW_VITEST_DATABASE_ENABLED !== "true")(
  "Ora memory consolidation (API + DB)",
  () => {
    it("supersedes an overlapping memory: old row disabled + tagged with the new id", async () => {
      const app = appAs(USER);

      // Save an initial preference, then a contradicting update that overlaps it.
      const first = await createMemory(app, "I prefer dark mode", "always use dark mode");
      expect(first.supersededIds).toEqual([]);

      const second = await createMemory(app, "I prefer light mode", "always use light mode");

      // The new save reports it superseded the first one.
      expect(second.supersededIds).toContain(first.id);

      // DB: the OLD row is disabled and points at the NEW row.
      const oldRow = await getRow(first.id);
      expect(oldRow.enabled).toBe(false);
      expect(oldRow.supersededBy).toBe(second.id);

      // The NEW row stays active and is itself not superseded.
      const newRow = await getRow(second.id);
      expect(newRow.enabled).toBe(true);
      expect(newRow.supersededBy).toBeNull();
    });

    it("does NOT supersede a genuinely distinct memory", async () => {
      const app = appAs(USER);

      const coffee = await createMemory(app, "I like coffee", "espresso in the morning");
      const tea = await createMemory(app, "I enjoy tea", "green tea in the evening");

      // Distinct facts → no supersession; both remain active.
      expect(tea.supersededIds).not.toContain(coffee.id);
      const coffeeRow = await getRow(coffee.id);
      expect(coffeeRow.enabled).toBe(true);
      expect(coffeeRow.supersededBy).toBeNull();
    });

    it("restore clears superseded_by and re-enables the row", async () => {
      const app = appAs(USER);

      const first = await createMemory(app, "my budget is 5000 dollars", "monthly budget");
      const second = await createMemory(app, "my budget is 8000 dollars", "monthly budget");
      expect(second.supersededIds).toContain(first.id);

      // Sanity: the old row is currently superseded.
      let oldRow = await getRow(first.id);
      expect(oldRow.enabled).toBe(false);
      expect(oldRow.supersededBy).toBe(second.id);

      const restore = await request(app).post(`/ora/memories/${first.id}/restore`).send();
      expect(restore.status).toBe(200);
      expect(restore.body.memory.enabled).toBe(true);
      expect(restore.body.memory.supersededBy).toBeNull();

      // DB reflects the restore.
      oldRow = await getRow(first.id);
      expect(oldRow.enabled).toBe(true);
      expect(oldRow.supersededBy).toBeNull();
    });

    it("buildMemoryContext excludes superseded rows from what Ora sees", async () => {
      const ctxUser = `${USER}-ctx`;
      const app = appAs(ctxUser);

      const first = await createMemory(app, "I prefer dark mode", "always use dark mode");
      const second = await createMemory(app, "I prefer light mode", "always use light mode");
      expect(second.supersededIds).toContain(first.id);

      const ctx = await buildMemoryContext(ctxUser);

      // Only the current (superseding) memory reaches Ora's context.
      const usedIds = ctx.used.map((u) => u.id);
      expect(usedIds).toContain(second.id);
      expect(usedIds).not.toContain(first.id);

      expect(ctx.text).toContain("light mode");
      expect(ctx.text).not.toContain("dark mode");

      // Cleanup this test's user rows.
      await db
        .delete(knowledgeEntriesTable)
        .where(
          and(eq(knowledgeEntriesTable.userId, ctxUser), eq(knowledgeEntriesTable.scope, "user")),
        );
    });

    it("multi-session lifecycle: teach three facts, recall, update, and delete through API + DB", async () => {
      const ctxUser = `${USER}-lifecycle`;
      const app = appAs(ctxUser);

      const codename = await createMemory(
        app,
        "my audit codename is Cobalt Finch 805",
        "Audit codename is Cobalt Finch 805",
      );
      const beverage = await createMemory(
        app,
        "my preferred audit beverage is lapsang souchong",
        "Preferred audit beverage is lapsang souchong",
      );
      const city = await createMemory(app, "my audit city is Boise", "Audit city is Boise");

      const firstRecall = await buildMemoryContext(ctxUser, null, "What do you know about me?");
      expect(firstRecall.used.map((u) => u.id)).toEqual(
        expect.arrayContaining([codename.id, beverage.id, city.id]),
      );
      expect(firstRecall.text).toContain("Cobalt Finch 805");
      expect(firstRecall.text).toContain("lapsang souchong");
      expect(firstRecall.text).toContain("Boise");

      const updatedCity = await createMemory(
        app,
        "my audit city is Portland",
        "Audit city is Portland",
      );
      expect(updatedCity.supersededIds).toContain(city.id);

      const updatedRecall = await buildMemoryContext(ctxUser, null, "What do you know about me?");
      expect(updatedRecall.used.map((u) => u.id)).toContain(updatedCity.id);
      expect(updatedRecall.used.map((u) => u.id)).not.toContain(city.id);
      expect(updatedRecall.text).toContain("Portland");
      expect(updatedRecall.text).not.toContain("Boise");
      expect(updatedRecall.text).toContain("Cobalt Finch 805");

      const deleted = await request(app).delete(`/ora/memories/${beverage.id}`).send();
      expect(deleted.status).toBe(200);

      const afterDeleteRecall = await buildMemoryContext(
        ctxUser,
        null,
        "What do you know about me?",
      );
      expect(afterDeleteRecall.used.map((u) => u.id)).not.toContain(beverage.id);
      expect(afterDeleteRecall.text).not.toContain("lapsang souchong");
      expect(afterDeleteRecall.text).toContain("Cobalt Finch 805");
      expect(afterDeleteRecall.text).toContain("Portland");

      await db
        .delete(knowledgeEntriesTable)
        .where(
          and(eq(knowledgeEntriesTable.userId, ctxUser), eq(knowledgeEntriesTable.scope, "user")),
        );
    });
  },
);
