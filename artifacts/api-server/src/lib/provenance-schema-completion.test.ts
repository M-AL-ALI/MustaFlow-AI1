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

describe("Zero provenance schema completion", () => {
  it("adds exactly three named boot steps and keeps both historical usage step names", () => {
    const migration = source("./startup-migrations.ts");
    expect(migration.match(/^\s{4}name:/gm)).toHaveLength(142);
    expect(migration).toContain('name: "knowledge_usage_events"');
    expect(migration).toContain('name: "migrate-knowledge-usage-events"');
    expect(migration).toContain('name: "migrate-knowledge-provenance"');
    expect(migration).toContain('name: "migrate-project-summary-provenance"');
    expect(migration).toContain('name: "migrate-plan-snapshot-provenance"');
  });

  it("runs every new migration twice without changing its SQL shape", async () => {
    const {
      applyKnowledgeProvenanceMigration,
      applyPlanSnapshotProvenanceMigration,
      applyProjectSummaryProvenanceMigration,
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
    };
    await run();
    const first = [...statements];
    statements.length = 0;
    await run();
    expect(statements).toEqual(first);
    expect(first.join("\n")).not.toMatch(/UPDATE\s+(knowledge|projects|project_versions)/i);
    expect(first.join("\n")).not.toContain("VALIDATE CONSTRAINT");
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
      expect(text.match(/lastTaskSummary:/g)?.length ?? 0, relative).toBe(
        text.match(/lastTaskSummaryProvenance:/g)?.length ?? 0,
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
    expect(knowledge.match(/insert\(knowledgeProvenanceEventsTable\)/g)).toHaveLength(2);
    expect(knowledge).toContain("Knowledge task provenance does not belong to the project");
    expect(knowledge).toContain("Knowledge version provenance does not belong to the project");
    expect(knowledge).toContain("Knowledge message provenance does not belong to the project");
    expect(knowledge).toContain('outcome: "inserted"');
    expect(knowledge).toContain('outcome: "reinforced"');
  });

  it("pins deletion effects and prevents startup backfill or constraint validation", () => {
    const migration = source("./startup-migrations.ts");
    expect(migration).toContain("knowledge_provenance_events_entry_fk");
    expect(migration).toContain("knowledge_provenance_events_project_fk");
    expect(migration.match(/ON DELETE CASCADE/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(migration.match(/ON DELETE SET NULL/g)?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(migration).not.toContain("VALIDATE CONSTRAINT");
  });
});
