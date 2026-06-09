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
    description: text("description"),
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
/**
 * `surface` separates normal Ora chats ("normal") from Help Center support
 * conversations ("support"). Support conversations must NEVER appear in the
 * normal Ora sidebar/history and vice versa — every query is filtered by this
 * column. Existing rows are backfilled to "normal" in the migration.
 */
export const ORA_CONVERSATION_SURFACES = ["normal", "support"] as const;
export type OraConversationSurface = (typeof ORA_CONVERSATION_SURFACES)[number];

export const oraConversationsTable = pgTable(
  "ora_conversations",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    projectId: integer("project_id"),
    title: text("title"),
    surface: text("surface").notNull().default("normal"),
    messages: jsonb("messages").notNull().default([]),
    // Rolling, model-generated gist of this conversation. Persisted (best-effort,
    // throttled) on message save and read back by Ora's cross-conversation recall
    // so a fact mentioned in one conversation can surface in another. Null until
    // the conversation has enough turns to summarise.
    summary: text("summary"),
    // Number of (non-empty) turns reflected in `summary` — used to throttle
    // re-summarisation (only regenerate once enough new turns accumulate).
    summaryMsgCount: integer("summary_msg_count").notNull().default(0),
    summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    lastMessageAt: timestamp("last_message_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("ora_conversations_user_id_idx").on(t.userId),
    index("ora_conversations_project_id_idx").on(t.projectId),
    index("ora_conversations_surface_idx").on(t.userId, t.surface),
  ],
);

export type OraProject = typeof oraProjectsTable.$inferSelect;
export type InsertOraProject = typeof oraProjectsTable.$inferInsert;
export type OraConversation = typeof oraConversationsTable.$inferSelect;
export type InsertOraConversation = typeof oraConversationsTable.$inferInsert;
