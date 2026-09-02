import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

process.env.ENCRYPTION_KEY = process.env.ENCRYPTION_KEY ?? Buffer.alloc(32, 7).toString("base64");
process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgres://test:test@127.0.0.1:1/test";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function typescriptFiles(root: string): string[] {
  return readdirSync(root).flatMap((name) => {
    const path = join(root, name);
    return statSync(path).isDirectory()
      ? typescriptFiles(path)
      : path.endsWith(".ts") && !path.endsWith(".test.ts")
        ? [path]
        : [];
  });
}

function countProjectSummaryWriterFields(text: string, field: string): number {
  return text
    .split("\n")
    .filter((line) => line.includes(`${field}:`) && !line.includes(`${field}: project.`)).length;
}

describe("Zero provenance schema completion", () => {
  it("adds the four named memory-truth boot steps and keeps both historical usage step names", () => {
    const migration = source("./startup-migrations.ts");
    expect(migration.match(/^\s{4}name:/gm)).toHaveLength(174);
    expect(migration).toContain('name: "knowledge_usage_events"');
    expect(migration).toContain('name: "migrate-knowledge-usage-events"');
    expect(migration).toContain('name: "migrate-knowledge-provenance"');
    expect(migration).toContain('name: "migrate-zero-memory-version-lineage"');
    expect(migration).toContain('name: "migrate-project-summary-provenance"');
    expect(migration).toContain('name: "migrate-plan-snapshot-provenance"');
  });

  it("makes version lineage and memory binding idempotent without deleting history", async () => {
    const { applyMemoryVersionLineageMigration } = await import("./startup-migrations");
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement.replace(/\s+/g, " ").trim());
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof applyMemoryVersionLineageMigration>[0];

    await applyMemoryVersionLineageMigration(client);
    const first = [...statements];
    statements.length = 0;
    await applyMemoryVersionLineageMigration(client);

    expect(statements).toEqual(first);
    expect(first.join("\n")).toContain("ADD COLUMN IF NOT EXISTS parent_version_id INTEGER");
    expect(first.join("\n")).toContain("VALIDATE CONSTRAINT project_versions_parent_version_fk");
    expect(first.join("\n")).toContain("CREATE TRIGGER project_versions_set_parent");
    expect(first.join("\n")).toContain("CREATE TRIGGER project_versions_bind_first_memory");
    expect(first.join("\n")).not.toMatch(/(TRUNCATE|DELETE FROM)\s/i);
  });

  it("runs every new migration twice without changing its SQL shape", async () => {
    const {
      applyKnowledgeProvenanceMigration,
      applyPlanSnapshotProvenanceMigration,
      applyProjectSummaryProvenanceMigration,
      applyZeroPromptQueuePersistenceMigration,
      ensureKnowledgeUsageEventsSchema,
    } = await import("./startup-migrations");
    const statements: string[] = [];
    const client = {
      query: async (statement: string) => {
        statements.push(statement.replace(/\s+/g, " ").trim());
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Parameters<typeof ensureKnowledgeUsageEventsSchema>[0];
    const run = async () => {
      await ensureKnowledgeUsageEventsSchema(client);
      await applyKnowledgeProvenanceMigration(client);
      await applyProjectSummaryProvenanceMigration(client);
      await applyPlanSnapshotProvenanceMigration(client);
      await applyZeroPromptQueuePersistenceMigration(client);
    };
    await run();
    const first = [...statements];
    statements.length = 0;
    await run();
    expect(statements).toEqual(first);
    expect(first.join("\n")).not.toMatch(/UPDATE\s+(knowledge|projects|project_versions)/i);
    expect(first.join("\n")).toContain(
      "VALIDATE CONSTRAINT knowledge_provenance_events_claim_kind_check",
    );
    expect(first.join("\n")).toContain("CREATE TABLE IF NOT EXISTS zero_prompt_queue_items");
    expect(first.join("\n")).not.toMatch(/(DROP|TRUNCATE)\s/i);
  });

  it("records every project-summary writer beside the content mutation", () => {
    for (const relative of [
      "../routes/messages.ts",
      "../routes/projects.ts",
      "../routes/checkpoints.ts",
      "../routes/duplicate.ts",
      "../routes/suggestions.ts",
      "../routes/queue.ts",
      "../routes/tasks.ts",
      "../routes/v1/builds.ts",
      "../routes/versions.ts",
      "./jobs.ts",
    ]) {
      const text = source(relative);
      expect(countProjectSummaryWriterFields(text, "lastTaskSummary"), relative).toBe(
        countProjectSummaryWriterFields(text, "lastTaskSummaryProvenance"),
      );
    }
    const jobs = source("./jobs.ts");
    expect(jobs.match(/summary: assistantSummary,/g)).toHaveLength(2);
    expect(jobs.match(/summaryProvenance: projectSummaryProvenance/g)).toHaveLength(2);
  });

  it("binds conversation summaries and plan snapshots to their exact source rows", () => {
    const messages = source("../routes/messages.ts");
    expect(messages).toContain("sourceMessageStartId");
    expect(messages).toContain("sourceMessageEndId");
    expect(messages).toContain("Conversation summary knowledge provenance recorded");

    const jobs = source("./jobs.ts");
    expect(jobs.match(/planSnapshot: planSnapshot\?\.plan/g)).toHaveLength(2);
    expect(jobs.match(/planSourceMessageId: planSnapshot\?\.sourceMessageId/g)).toHaveLength(2);
    expect(source("../routes/checkpoints.ts")).toContain(
      "planSourceMessageId: target.planSourceMessageId",
    );
    expect(source("../routes/versions.ts")).toContain(
      "planSourceMessageId: version.planSourceMessageId",
    );
  });

  it("keeps provenance events append-only and atomic with semantic writes", () => {
    const apiRoot = fileURLToPath(new URL("../", import.meta.url));
    const application = typescriptFiles(apiRoot)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    expect(application).not.toContain("update(knowledgeProvenanceEventsTable)");
    expect(application).not.toContain("delete(knowledgeProvenanceEventsTable)");
    expect(application).not.toMatch(/UPDATE\s+knowledge_provenance_events/i);
    expect(application).not.toMatch(/DELETE\s+FROM\s+knowledge_provenance_events/i);

    const knowledge = source("./knowledge.ts");
    expect(knowledge).toContain("db.transaction");
    expect(knowledge.match(/insert\(knowledgeProvenanceEventsTable\)/g)).toHaveLength(1);
    expect(application.match(/insert\(knowledgeProvenanceEventsTable\)/g)).toHaveLength(1);
    expect(knowledge).toContain("appendKnowledgeProvenanceReceipt(tx");
    expect(knowledge).toContain("Knowledge task provenance does not belong to the project");
    expect(knowledge).toContain("Knowledge version provenance does not belong to the project");
    expect(knowledge).toContain("Knowledge message provenance does not belong to the project");
    expect(knowledge).toContain('outcome: "inserted"');
    expect(knowledge).toContain('outcome: "reinforced"');
    expect(knowledge).toContain('claimKind: opts.claimKind ?? "observed"');
    expect(knowledge).toContain("buildKnowledgeProvenanceReceipt");
  });

  it("adds the closed provenance classes without guessing historical rows", () => {
    const migration = source("./startup-migrations.ts");
    const schema = source("../../../../lib/db/src/schema/knowledge-provenance-events.ts");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS claim_kind TEXT");
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS actor_user_id TEXT");
    expect(migration).toContain(
      "claim_kind IS NULL OR claim_kind IN ('stated', 'observed', 'inferred')",
    );
    expect(migration).toContain("VALIDATE CONSTRAINT knowledge_provenance_events_claim_kind_check");
    expect(migration).not.toMatch(
      /knowledge_provenance_events_claim_kind_check[\s\S]{0,240}NOT VALID/,
    );
    expect(migration).not.toMatch(/UPDATE\s+knowledge_provenance_events/i);
    expect(schema).toContain('"knowledge-provenance-v2"');
    expect(schema).toContain('claimKind: text("claim_kind")');
    expect(schema).toContain('actorUserId: text("actor_user_id")');
    expect(source("../routes/knowledge.ts")).toContain(
      "selectDistinctOn([knowledgeProvenanceEventsTable.knowledgeEntryId]",
    );
    expect(source("./jobs.ts")).toContain(
      "selectDistinctOn([knowledgeProvenanceEventsTable.knowledgeEntryId]",
    );
  });

  it("pins deletion effects and prevents startup backfill", () => {
    const migration = source("./startup-migrations.ts");
    expect(migration).toContain("knowledge_provenance_events_entry_fk");
    expect(migration).toContain("knowledge_provenance_events_project_fk");
    expect(migration).toContain(
      "FOREIGN KEY (knowledge_entry_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE",
    );
    expect(migration).toContain(
      "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL",
    );
    expect(source("../../../../lib/db/src/schema/knowledge-provenance-events.ts")).toContain(
      'onDelete: "set null"',
    );
    expect(migration).not.toMatch(/UPDATE\s+knowledge_provenance_events/i);
  });
});
