/**
 * Ora ↔ AI Builder memory isolation — regression guard.
 *
 * Ora memories (origin="ora") and the AI Builder Knowledge Vault
 * (origin="builder") share the single `knowledge_entries` table and are kept
 * apart ONLY by hand-written query filters scattered across several readers.
 * That separation is easy to silently break when a new query is added later,
 * which would leak personal Ora memories into builds (or vice-versa).
 *
 * This suite seeds one origin="ora" user-scope row and one origin="builder"
 * user-scope row (plus the rows needed for the recovery-migration case) into a
 * REAL database, then exercises every reader against them:
 *
 *   1. loadKnowledgeContext  — the build-prompt knowledge reader (jobs.ts)
 *   2. GET /api/knowledge    — the Builder Knowledge Vault list (routes/knowledge.ts)
 *   3. writeKnowledge        — Builder write/dedup (lib/knowledge.ts)
 *   4. GET /api/ora/memories — the Ora Memory Center list (routes/ora-memories.ts)
 *
 * It also covers the recovery migration (scripts/src/migrate-recover-ora-memories.ts):
 * a (scope=user, origin=builder, type=note, project_id NULL) row is re-tagged to
 * "ora", while a type="style_memory" row is left untouched.
 *
 * Embeddings are mocked so `writeKnowledge`'s dedup path runs deterministically
 * (high similarity) WITHOUT any network call — proving the dedup candidate query
 * still refuses to merge a Builder write into an Ora row even when the texts are
 * near-identical.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";

// Deterministic embeddings: every input maps to the same vector and any two
// vectors are "identical" — so dedup WOULD merge if the isolation filter were
// removed. No OpenAI calls.
vi.mock("../embeddings", () => ({
  generateEmbedding: vi.fn().mockResolvedValue(Array.from({ length: 1536 }, () => 0.1)),
  cosineSimilarity: vi.fn().mockReturnValue(0.99),
  buildEmbeddingInput: (title: string, content: string, tags: string | null) =>
    `${title} ${content} ${tags ?? ""}`,
}));

const FIXED_VECTOR = Array.from({ length: 1536 }, () => 0.1);

import { db, knowledgeEntriesTable, projectsTable, pool, workspacesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { loadKnowledgeContext } from "../jobs";
import { writeKnowledge } from "../knowledge";
import knowledgeRouter from "../../routes/knowledge";
import oraMemoriesRouter from "../../routes/ora-memories";
import { createOwnedWorkspace } from "../workspace-foundation";

// Unique owner per run so seeded rows never collide with real data or a
// previous run, and cleanup is a single delete-by-userId.
const TEST_USER = `test-ora-iso-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

// Unique content markers so assertions are exact-substring, not fuzzy.
const ORA_MARKER = `ORA_SECRET_${TEST_USER}`;
const BUILDER_MARKER = `BUILDER_LESSON_${TEST_USER}`;

let projectId: number;
let workspaceId: number;

// Express apps mounting the REAL routers with a fake auth shim that sets
// req.userId — mirrors how attachUser populates it in production.
function mountRouter(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.userId = TEST_USER;
    next();
  });
  app.use("/api", router);
  return app;
}

const knowledgeApp = mountRouter(knowledgeRouter);
const oraApp = mountRouter(oraMemoriesRouter);

async function seedKnowledgeRow(values: Partial<typeof knowledgeEntriesTable.$inferInsert>) {
  const [row] = await db
    .insert(knowledgeEntriesTable)
    .values({
      title: "seed",
      content: "seed",
      type: "note",
      category: "note",
      severity: "info",
      scope: "user",
      userId: TEST_USER,
      projectId: null,
      ...values,
    })
    .returning({ id: knowledgeEntriesTable.id });
  return row!.id;
}

beforeAll(async () => {
  const workspace = await createOwnedWorkspace({
    ownerUserId: TEST_USER,
    name: `Isolation workspace ${TEST_USER}`,
    type: "personal",
  });
  workspaceId = workspace.id;
  // A project owned by the test user — loadKnowledgeContext pulls the owner's
  // user-scope entries via the project's ownerId.
  const [project] = await db
    .insert(projectsTable)
    .values({ name: `iso-test-${TEST_USER}`, ownerId: TEST_USER, workspaceId })
    .returning({ id: projectsTable.id });
  projectId = project!.id;
});

afterAll(async () => {
  // Clean up everything this suite created.
  await db.delete(knowledgeEntriesTable).where(eq(knowledgeEntriesTable.userId, TEST_USER));
  await db.delete(projectsTable).where(eq(projectsTable.ownerId, TEST_USER));
  await db.delete(workspacesTable).where(eq(workspacesTable.id, workspaceId));
});

describe("Ora ↔ Builder memory isolation", () => {
  it("loadKnowledgeContext never includes the Ora row but does include the Builder row", async () => {
    await seedKnowledgeRow({
      title: "Ora memory",
      content: ORA_MARKER,
      origin: "ora",
    });
    const builderId = await seedKnowledgeRow({
      title: "Builder lesson",
      content: BUILDER_MARKER,
      origin: "builder",
    });

    // No userPrompt → skips the embedding/TF-IDF ranking, exercises the plain
    // eligibility query + reverse-leak guard directly.
    const { context, applied } = await loadKnowledgeContext(projectId);

    expect(context).toContain(BUILDER_MARKER);
    expect(context).not.toContain(ORA_MARKER);
    expect(applied.some((a) => a.title === "Builder lesson")).toBe(true);
    expect(applied.some((a) => a.title === "Ora memory")).toBe(false);

    await loadKnowledgeContext(projectId);
    const [builderAfterRepeatedReads] = await db
      .select({ usageCount: knowledgeEntriesTable.usageCount })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, builderId));
    expect(builderAfterRepeatedReads!.usageCount).toBe(0);
  });

  it("GET /api/knowledge never returns the Ora row", async () => {
    const res = await request(knowledgeApp).get("/api/knowledge").query({ scope: "user" });
    expect(res.status).toBe(200);
    const rows = res.body as Array<{ content: string }>;
    expect(rows.some((r) => r.content.includes(BUILDER_MARKER))).toBe(true);
    expect(rows.some((r) => r.content.includes(ORA_MARKER))).toBe(false);
  });

  it("writeKnowledge dedup never merges a Builder write into the Ora row", async () => {
    // Seed an Ora row that carries an embedding and content near-identical to
    // the upcoming Builder write. With cosineSimilarity mocked to 0.99 this row
    // WOULD be a merge target if the isolation guard were removed.
    const oraId = await seedKnowledgeRow({
      title: "Ora memory to protect",
      content: ORA_MARKER,
      origin: "ora",
      embedding: FIXED_VECTOR,
    });

    // Builder write via the user-scope (projectId-less) dedup branch.
    await writeKnowledge({
      title: "Ora memory to protect",
      content: ORA_MARKER,
      type: "note",
      userId: TEST_USER,
    });

    // The Ora row must be untouched: content unchanged, never reinforced.
    const [oraAfter] = await db
      .select({
        content: knowledgeEntriesTable.content,
        reinforcedCount: knowledgeEntriesTable.reinforcedCount,
      })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, oraId));
    expect(oraAfter!.content).toBe(ORA_MARKER);
    expect(oraAfter!.reinforcedCount).toBe(0);

    // The Builder write must have landed as its own origin="builder" row.
    const builderRows = await db
      .select({ id: knowledgeEntriesTable.id })
      .from(knowledgeEntriesTable)
      .where(
        and(
          eq(knowledgeEntriesTable.userId, TEST_USER),
          eq(knowledgeEntriesTable.origin, "builder"),
          eq(knowledgeEntriesTable.content, ORA_MARKER),
        ),
      );
    expect(builderRows.length).toBe(1);
  });

  it("GET /api/ora/memories returns only the Ora row", async () => {
    const res = await request(oraApp).get("/api/ora/memories");
    expect(res.status).toBe(200);
    const memories = (res.body as { memories: Array<{ content: string }> }).memories;
    // Every returned row is an Ora memory…
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.every((m) => m.content.includes(ORA_MARKER))).toBe(true);
    // …and the Builder lesson is never present.
    expect(memories.some((m) => m.content.includes(BUILDER_MARKER))).toBe(false);
  });
});

describe("recover-ora-memories migration", () => {
  // Mirrors scripts/src/migrate-recover-ora-memories.ts exactly. Keep in sync
  // with that script — both re-tag misfiled Ora saves and must leave legitimate
  // Builder user-scope data (style_memory) untouched.
  const RECOVERY_SQL = `UPDATE knowledge_entries
          SET origin = 'ora'
        WHERE scope = 'user'
          AND origin = 'builder'
          AND type = 'note'
          AND type <> 'style_memory'
          AND project_id IS NULL
          AND user_id = $1`;

  it("re-tags a misfiled (scope=user, origin=builder, type=note, project_id NULL) row to ora and leaves style_memory untouched", async () => {
    const misfiledId = await seedKnowledgeRow({
      title: "Misfiled Ora save",
      content: `MISFILED_${TEST_USER}`,
      type: "note",
      origin: "builder",
    });
    const styleId = await seedKnowledgeRow({
      title: "Inferred style",
      content: `STYLE_${TEST_USER}`,
      type: "style_memory",
      origin: "builder",
    });

    await pool.query(RECOVERY_SQL, [TEST_USER]);

    const [misfiledAfter] = await db
      .select({ origin: knowledgeEntriesTable.origin })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, misfiledId));
    expect(misfiledAfter!.origin).toBe("ora");

    const [styleAfter] = await db
      .select({ origin: knowledgeEntriesTable.origin })
      .from(knowledgeEntriesTable)
      .where(eq(knowledgeEntriesTable.id, styleId));
    expect(styleAfter!.origin).toBe("builder");
  });
});
