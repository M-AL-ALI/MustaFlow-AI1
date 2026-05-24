import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const projectFilesTable = pgTable(
  "project_files",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    // artifactId: which artifact (within the project) this file belongs to.
    // Nullable for backward compat with rows written before Task #544; the migration
    // backfills every legacy row to the project's primary artifact. New writes
    // should always stamp this field. Reads that omit artifactId scope to the
    // primary artifact via a JOIN on project_artifacts.is_primary = true.
    artifactId: integer("artifact_id"),
    path: text("path").notNull(),
    content: text("content").notNull(),
    mimeType: text("mime_type").notNull().default("text/html"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pathUniq: uniqueIndex("project_files_project_path_unique").on(t.projectId, t.path),
  }),
);

export type ProjectFile = typeof projectFilesTable.$inferSelect;
export type InsertProjectFile = typeof projectFilesTable.$inferInsert;
