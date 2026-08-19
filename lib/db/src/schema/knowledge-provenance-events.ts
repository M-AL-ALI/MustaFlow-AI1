import { bigserial, index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { knowledgeEntriesTable } from "./knowledge";
import { projectsTable } from "./projects";
import { chatMessagesTable } from "./messages";
import { agentTasksTable } from "./tasks";
import { projectVersionsTable } from "./versions";

export const KNOWLEDGE_PROVENANCE_SEMANTICS = "knowledge-provenance-v1" as const;

/**
 * Append-only receipt for every successful Builder knowledge insert or reinforcement.
 * Application code may insert/select these rows, never update or delete them.
 */
export const knowledgeProvenanceEventsTable = pgTable(
  "knowledge_provenance_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    knowledgeEntryId: integer("knowledge_entry_id")
      .notNull()
      .references(() => knowledgeEntriesTable.id, { onDelete: "cascade" }),
    outcome: text("outcome").$type<"inserted" | "reinforced">().notNull(),
    projectId: integer("project_id").references(() => projectsTable.id, {
      onDelete: "set null",
    }),
    sourceMessageStartId: integer("source_message_start_id").references(
      () => chatMessagesTable.id,
      { onDelete: "set null" },
    ),
    sourceMessageEndId: integer("source_message_end_id").references(() => chatMessagesTable.id, {
      onDelete: "set null",
    }),
    sourceTaskId: integer("source_task_id").references(() => agentTasksTable.id, {
      onDelete: "set null",
    }),
    sourceVersionId: integer("source_version_id").references(() => projectVersionsTable.id, {
      onDelete: "set null",
    }),
    semantics: text("semantics").notNull().default(KNOWLEDGE_PROVENANCE_SEMANTICS),
    contributedContentSha256: text("contributed_content_sha256").notNull(),
    resultingContentSha256: text("resulting_content_sha256").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("knowledge_provenance_entry_idx").on(table.knowledgeEntryId, table.createdAt),
    index("knowledge_provenance_project_idx").on(table.projectId, table.createdAt),
  ],
);

export type KnowledgeProvenanceEvent = typeof knowledgeProvenanceEventsTable.$inferSelect;
export type InsertKnowledgeProvenanceEvent = typeof knowledgeProvenanceEventsTable.$inferInsert;
