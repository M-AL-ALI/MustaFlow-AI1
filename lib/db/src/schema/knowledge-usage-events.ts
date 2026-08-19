import { bigserial, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Durable knowledge-selection receipts. The physical table predates this
 * declaration and is created idempotently by the API startup migration.
 */
export const knowledgeUsageEventsTable = pgTable(
  "knowledge_usage_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: text("user_id").notNull(),
    query: text("query").notNull(),
    reportType: text("report_type").notNull().default("knowledge-report"),
    selectedEntryIds: integer("selected_entry_ids").array().notNull().default([]),
    selectedEntryVersions: integer("selected_entry_versions").array().notNull().default([]),
    entryCount: integer("entry_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("idx_kue_user_id").on(table.userId),
    index("idx_kue_created_at").on(table.createdAt),
  ],
);

export type KnowledgeUsageEvent = typeof knowledgeUsageEventsTable.$inferSelect;
export type InsertKnowledgeUsageEvent = typeof knowledgeUsageEventsTable.$inferInsert;
