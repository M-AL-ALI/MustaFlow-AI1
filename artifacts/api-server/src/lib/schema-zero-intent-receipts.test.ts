import { describe, expect, it } from "vitest";
import { getTableName, type SQL } from "drizzle-orm";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { zeroIntentReceiptsTable } from "../../../../lib/db/src/schema/zero-intent-receipts";

const dialect = new PgDialect();

describe("zero intent receipt schema", () => {
  it("owns the historical check constraints with their exact expressions", () => {
    const checks = new Map(
      getTableConfig(zeroIntentReceiptsTable).checks.map((entry) => [
        entry.name,
        dialect.sqlToQuery(entry.value as SQL).sql,
      ]),
    );

    expect(checks).toEqual(
      new Map([
        [
          "zero_intent_receipts_intent_check",
          "intent IN ('answer', 'clarify', 'plan', 'mutate', 'observe')",
        ],
        [
          "zero_intent_receipts_source_check",
          `deciding_source IN (
            'user_explicit', 'plan_approved', 'deterministic_rule', 'classifier',
            'classifier_fallback', 'snapshot_control', 'queue_promoted',
            'system_action', 'scheduled_action'
          )`,
        ],
        [
          "zero_intent_receipts_confidence_check",
          "confidence IS NULL OR (confidence >= 0 AND confidence <= 1)",
        ],
      ]),
    );
  });

  it("owns the project request pair as a named constraint rather than an index", () => {
    const config = getTableConfig(zeroIntentReceiptsTable);
    const constraint = config.uniqueConstraints.find(
      (entry) => entry.getName() === "zero_intent_receipts_project_request_uq",
    );

    expect(constraint?.columns.map((column) => column.name)).toEqual(["project_id", "request_id"]);
    expect(config.indexes.map((entry) => entry.config.name)).not.toContain(
      "zero_intent_receipts_project_request_uq",
    );
  });

  it("owns the named source-message foreign key and delete action", () => {
    const foreignKey = getTableConfig(zeroIntentReceiptsTable).foreignKeys.find(
      (entry) => entry.getName() === "zero_intent_receipts_source_message_fk",
    );
    const reference = foreignKey?.reference();

    expect(reference?.columns.map((column) => column.name)).toEqual(["source_message_id"]);
    expect(reference?.foreignColumns.map((column) => column.name)).toEqual(["id"]);
    expect(reference && getTableName(reference.foreignTable)).toBe("chat_messages");
    expect(foreignKey?.onDelete).toBe("set null");
  });
});
