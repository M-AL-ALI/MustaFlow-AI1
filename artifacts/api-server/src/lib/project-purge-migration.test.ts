import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/db", () => ({ pool: {} }));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

import { applyProjectPurgeOperationsMigration } from "./startup-migrations";

const readyObservation = {
  table_ready: true,
  columns_ready: true,
  constraints_ready: true,
  indexes_ready: true,
  notification_index_ready: true,
  foreign_key_count: "0",
};

function migrationClient(observation = readyObservation) {
  const statements: string[] = [];
  const query = vi.fn(async (sql: string) => {
    statements.push(sql.replace(/\s+/gu, " ").trim());
    if (sql.includes("AS table_ready")) return { rows: [observation] };
    return { rows: [] };
  });
  return { client: { query } as never, query, statements };
}

describe("project purge operations migration", () => {
  it("records the generated-image reservation guard correction as startup migration 155", () => {
    const source = readFileSync(new URL("./startup-migrations.ts", import.meta.url), "utf8");
    const migrationSteps = source.slice(
      source.indexOf("const MIGRATION_STEPS"),
      source.indexOf("\n];", source.indexOf("const MIGRATION_STEPS")),
    );
    const names = [...migrationSteps.matchAll(/^\s{4}name: "([^"]+)",$/gmu)].map(
      (match) => match[1],
    );

    expect(names).toHaveLength(155);
    expect(
      names.filter((name) => name === "migrate-durable-asset-reference-guards-v2"),
    ).toHaveLength(1);
    expect(migrationSteps).toContain(
      'name: "migrate-durable-asset-reference-guards-v2",\n    async run(client) {\n      await applyUnifiedAssetRegistryMigration(client);',
    );
    expect(
      names.filter((name) => name === "migrate-durable-asset-reference-guards-v3"),
    ).toHaveLength(1);
    expect(migrationSteps).toContain(
      'name: "migrate-durable-asset-reference-guards-v3",\n    async run(client) {\n      await applyUnifiedAssetRegistryMigration(client);',
    );
  });

  it("is additive and idempotent, preserves its receipt, and adds milestone dedupe", async () => {
    const { client, statements } = migrationClient();

    await applyProjectPurgeOperationsMigration(client);
    await applyProjectPurgeOperationsMigration(client);

    const sql = statements.join("\n");
    expect(sql.match(/CREATE TABLE IF NOT EXISTS project_purge_operations/gu)).toHaveLength(2);
    expect(sql).toContain("project_id INTEGER NOT NULL");
    expect(sql).not.toMatch(/project_purge_operations[\s\S]*?REFERENCES projects/iu);
    expect(sql).toContain("retirement_operation_id_hash TEXT NOT NULL");
    expect(sql).toContain("idempotency_key_hash TEXT NOT NULL");
    expect(sql).toContain("resource_progress JSONB NOT NULL DEFAULT '{}'::jsonb");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS resource_progress");
    expect(sql).toContain("DEFAULT (NOW() + INTERVAL '30 days')");
    expect(sql).toContain("project_purge_operations_terminal_check");
    expect(sql).toContain("project_purge_operations_requester_check");
    expect(sql).toContain("trigger = 'expiry' OR requested_by_hash IS NOT NULL");
    expect(sql).toContain("project_purge_operations_active_project_uq");
    expect(sql).toContain("notifications_project_purge_milestone_uq");
    expect(sql).toContain("WHERE resource_type = 'project_purge'");
    expect(statements.filter((statement) => statement === "COMMIT")).toHaveLength(2);
    expect(statements).not.toContain("ROLLBACK");
  });

  it("fails closed and rolls back when catalog proof is incomplete", async () => {
    const { client, statements } = migrationClient({
      ...readyObservation,
      foreign_key_count: "1",
    });

    await expect(applyProjectPurgeOperationsMigration(client)).rejects.toThrow(
      "project_purge_operations_schema_incomplete",
    );
    expect(statements.at(-1)).toBe("ROLLBACK");
    expect(statements).not.toContain("COMMIT");
  });

  it("keeps the Drizzle schema exported and structurally free of a project foreign key", () => {
    const schema = readFileSync(
      new URL("../../../../lib/db/src/schema/project-purge-operations.ts", import.meta.url),
      "utf8",
    );
    const barrel = readFileSync(
      new URL("../../../../lib/db/src/schema/index.ts", import.meta.url),
      "utf8",
    );
    const notifications = readFileSync(
      new URL("../../../../lib/db/src/schema/notifications.ts", import.meta.url),
      "utf8",
    );

    expect(schema).toContain('pgTable(\n  "project_purge_operations"');
    expect(schema).not.toContain("projectsTable");
    expect(schema).not.toContain(".references(");
    expect(barrel).toContain('export * from "./project-purge-operations"');
    expect(notifications).toContain("notifications_project_purge_milestone_uq");
  });
});
