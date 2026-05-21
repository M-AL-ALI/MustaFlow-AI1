import { pgTable, serial, integer, text, boolean, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { projectVersionsTable } from "./versions";

export const dbSnapshotsTable = pgTable("db_snapshots", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  versionId: integer("version_id").references(() => projectVersionsTable.id, {
    onDelete: "set null",
  }),
  label: text("label").notNull(),
  provider: text("provider").notNull(),
  /**
   * Inline dump content — used when GCS object storage is not configured (dev).
   * Null when objectKey is set (blob is in GCS).
   */
  dumpContent: text("dump_content"),
  /**
   * GCS object key for the snapshot blob. Preferred storage path.
   * Format: db-snapshots/{projectId}/{uuid}.sql
   */
  objectKey: text("object_key"),
  /**
   * True when the snapshot was truncated (some tables hit the per-table row
   * limit). Partial snapshots are not suitable for guaranteed rollback restore
   * of large datasets; the restore endpoint will surface a warning.
   */
  isPartial: boolean("is_partial").notNull().default(false),
  sizeBytes: integer("size_bytes").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DbSnapshot = typeof dbSnapshotsTable.$inferSelect;
export type InsertDbSnapshot = typeof dbSnapshotsTable.$inferInsert;
