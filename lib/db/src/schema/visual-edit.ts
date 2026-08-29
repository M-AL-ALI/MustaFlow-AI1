import { index, integer, jsonb, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { projectVersionsTable } from "./versions";

export type VisualEditIntent = {
  schema: "visual-edit-intent-v1";
  kind: "text" | "color" | "style" | "attribute" | "delete" | "reorder";
  target: string;
  reason: string;
};

export const visualEditSessionsTable = pgTable(
  "visual_edit_sessions",
  {
    id: text("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    status: text("status").notNull().$type<"open" | "closed" | "cancelled">(),
    summary: text("summary"),
    versionId: integer("version_id").references(() => projectVersionsTable.id, {
      onDelete: "set null",
    }),
    openedAt: timestamp("opened_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [index("visual_edit_sessions_project_status_idx").on(table.projectId, table.status)],
);

export const visualEditChangesTable = pgTable(
  "visual_edit_changes",
  {
    id: serial("id").primaryKey(),
    sessionId: text("session_id")
      .notNull()
      .references(() => visualEditSessionsTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    actorUserId: text("actor_user_id").notNull(),
    fileId: integer("file_id").notNull(),
    filePath: text("file_path").notNull(),
    intentReceiptId: integer("intent_receipt_id").notNull(),
    intent: jsonb("intent").notNull().$type<VisualEditIntent>(),
    beforeContent: text("before_content").notNull(),
    afterContent: text("after_content").notNull(),
    status: text("status").notNull().default("applied").$type<"applied" | "undone">(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    undoneAt: timestamp("undone_at", { withTimezone: true }),
  },
  (table) => [
    index("visual_edit_changes_session_idx").on(table.sessionId, table.id),
    index("visual_edit_changes_project_idx").on(table.projectId, table.createdAt),
  ],
);
