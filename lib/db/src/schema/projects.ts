import { pgTable, serial, text, timestamp, integer } from "drizzle-orm/pg-core";

export const projectsTable = pgTable("projects", {
  id: serial("id").primaryKey(),
  ownerId: text("owner_id").notNull().default("demo-user"),
  name: text("name").notNull(),
  description: text("description"),
  kind: text("kind").notNull().default("web"),
  status: text("status").notNull().default("draft"),
  agentMode: text("agent_mode").notNull().default("eco"),
  lastTaskSummary: text("last_task_summary"),
  summary: text("summary"),
  // publishedSnapshotId: the project_versions row that is currently live.
  // When set, the public route serves files from that snapshot instead of live files.
  // Null = not published. Updated on every publish, cleared on unpublish.
  publishedSnapshotId: integer("published_snapshot_id"),
  // deletedAt: soft-delete timestamp. Null = active. Non-null = deleted.
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Project = typeof projectsTable.$inferSelect;
export type InsertProject = typeof projectsTable.$inferInsert;
