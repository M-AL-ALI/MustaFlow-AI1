import { pgTable, serial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

/**
 * Ora projects — lightweight folders that group related conversations.
 * A conversation may belong to one project or be standalone (one-off chat).
 * Soft-deleted via `archivedAt`.
 */
export const oraProjectsTable = pgTable(
  "ora_projects",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [index("ora_projects_user_id_idx").on(t.userId)],
);

/**
 * Ora conversations — individual chat threads. Each conversation owns its own
 * message history (stored as a JSONB array, matching the legacy single-transcript
 * shape). `projectId` is null for standalone/one-off chats.
 * Soft-deleted via `archivedAt`.
 */
export const oraConversationsTable = pgTable(
  "ora_conversations",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    projectId: integer("project_id"),
    title: text("title"),
    messages: jsonb("messages").notNull().default([]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("ora_conversations_user_id_idx").on(t.userId),
    index("ora_conversations_project_id_idx").on(t.projectId),
  ],
);

export type OraProject = typeof oraProjectsTable.$inferSelect;
export type InsertOraProject = typeof oraProjectsTable.$inferInsert;
export type OraConversation = typeof oraConversationsTable.$inferSelect;
export type InsertOraConversation = typeof oraConversationsTable.$inferInsert;
