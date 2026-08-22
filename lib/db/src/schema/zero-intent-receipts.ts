import {
  doublePrecision,
  index,
  integer,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
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
    uniqueIndex("zero_intent_receipts_project_request_uq").on(table.projectId, table.requestId),
    index("zero_intent_receipts_project_decided_idx").on(table.projectId, table.decidedAt),
    index("zero_intent_receipts_admission_idx").on(table.projectId, table.intent, table.consumedAt),
  ],
);

export type ZeroIntentReceiptRow = typeof zeroIntentReceiptsTable.$inferSelect;
export type InsertZeroIntentReceiptRow = typeof zeroIntentReceiptsTable.$inferInsert;
