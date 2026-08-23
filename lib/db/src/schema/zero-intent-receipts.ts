import {
  check,
  doublePrecision,
  foreignKey,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { chatMessagesTable } from "./messages";
import { projectsTable } from "./projects";

export const zeroIntentReceiptsTable = pgTable(
  "zero_intent_receipts",
  {
    id: serial("id").primaryKey(),
    requestId: text("request_id").notNull(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    sourceMessageId: integer("source_message_id"),
    intent: text("intent").$type<"answer" | "clarify" | "plan" | "mutate" | "observe">().notNull(),
    decidingSource: text("deciding_source")
      .$type<
        | "user_explicit"
        | "plan_approved"
        | "deterministic_rule"
        | "classifier"
        | "classifier_fallback"
        | "snapshot_control"
        | "queue_promoted"
        | "system_action"
        | "scheduled_action"
      >()
      .notNull(),
    confidence: doublePrecision("confidence"),
    reasonCode: text("reason_code")
      .$type<
        | "question"
        | "ambiguous_request"
        | "plan_request"
        | "change_request"
        | "diagnostic_request"
        | "snapshot_request"
        | "media_generation_request"
        | "approved_plan_step"
        | "explicit_control"
        | "classifier_unavailable"
        | "system_maintenance"
        | "scheduled_run"
      >()
      .notNull(),
    decidedAt: timestamp("decided_at", { withTimezone: true }).notNull().defaultNow(),
    consumedAt: timestamp("consumed_at", { withTimezone: true }),
  },
  (table) => [
    // Migration 144 (migrate-zero-intent-receipts) is the historical DDL owner;
    // its schema-completeness probe is the contract for these named constraints.
    unique("zero_intent_receipts_project_request_uq").on(table.projectId, table.requestId),
    check(
      "zero_intent_receipts_intent_check",
      sql`intent IN ('answer', 'clarify', 'plan', 'mutate', 'observe')`,
    ),
    check(
      "zero_intent_receipts_source_check",
      sql`deciding_source IN (
            'user_explicit', 'plan_approved', 'deterministic_rule', 'classifier',
            'classifier_fallback', 'snapshot_control', 'queue_promoted',
            'system_action', 'scheduled_action'
          )`,
    ),
    check(
      "zero_intent_receipts_confidence_check",
      sql`confidence IS NULL OR (confidence >= 0 AND confidence <= 1)`,
    ),
    foreignKey({
      name: "zero_intent_receipts_source_message_fk",
      columns: [table.sourceMessageId],
      foreignColumns: [chatMessagesTable.id],
    }).onDelete("set null"),
    index("zero_intent_receipts_project_decided_idx").on(table.projectId, table.decidedAt),
    index("zero_intent_receipts_admission_idx").on(table.projectId, table.intent, table.consumedAt),
  ],
);

export type ZeroIntentReceiptRow = typeof zeroIntentReceiptsTable.$inferSelect;
export type InsertZeroIntentReceiptRow = typeof zeroIntentReceiptsTable.$inferInsert;
