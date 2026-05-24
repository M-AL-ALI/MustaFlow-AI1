import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const projectCommentsTable = pgTable("project_comments", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  // authorId: Clerk user ID
  authorId: text("author_id").notNull(),
  authorName: text("author_name"),
  authorAvatar: text("author_avatar"),
  // parentId: null = top-level comment; non-null = reply in a thread
  parentId: integer("parent_id"),
  // Anchor: where the comment is attached
  // filePath + lineStart/lineEnd = inline code comment
  // buildResultId = comment on a specific AI build task
  // null anchor = general project comment
  filePath: text("file_path"),
  lineStart: integer("line_start"),
  lineEnd: integer("line_end"),
  buildResultId: integer("build_result_id"),
  body: text("body").notNull(),
  // resolved: top-level comments can be marked resolved; threads collapse
  resolved: boolean("resolved").notNull().default(false),
  resolvedByUserId: text("resolved_by_user_id"),
  resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  // editedAt: set when the author edits the body
  editedAt: timestamp("edited_at", { withTimezone: true }),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectComment = typeof projectCommentsTable.$inferSelect;
export type InsertProjectComment = typeof projectCommentsTable.$inferInsert;
