import { pgTable, serial, integer, text, timestamp, bigint } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const projectUploadsTable = pgTable("project_uploads", {
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
});

export type ProjectUpload = typeof projectUploadsTable.$inferSelect;
export type InsertProjectUpload = typeof projectUploadsTable.$inferInsert;
