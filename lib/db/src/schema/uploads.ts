import { pgTable, serial, integer, text, timestamp, bigint, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const projectUploadsTable = pgTable(
  "project_uploads",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    uploaderId: text("uploader_id"),
    filename: text("filename").notNull(),
    mimeType: text("mime_type").notNull().default("application/octet-stream"),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    objectPath: text("object_path").notNull(),
    textPreview: text("text_preview"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("project_uploads_project_id_idx").on(t.projectId)],
);

export type ProjectUpload = typeof projectUploadsTable.$inferSelect;
export type InsertProjectUpload = typeof projectUploadsTable.$inferInsert;
