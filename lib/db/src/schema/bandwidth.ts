import {
  pgTable,
  serial,
  integer,
  text,
  bigint,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * Per-project monthly bandwidth metering (Task #624).
 *
 * One row per project per calendar month ("YYYY-MM"). Incremented atomically
 * on every snapshot-served response via the in-memory accumulator in
 * serveSnapshot.ts. Resets automatically when a new month key is inserted.
 */
export const projectBandwidthTable = pgTable(
  "project_bandwidth",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /** Calendar month in "YYYY-MM" format, e.g. "2026-05". */
    month: text("month").notNull(),
    /** Total bytes served from the snapshot for this project this month. */
    bytesServed: bigint("bytes_served", { mode: "number" }).notNull().default(0),
    /** Total HTTP requests served from the snapshot this month. */
    requestCount: integer("request_count").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("project_bandwidth_project_month_idx").on(table.projectId, table.month)],
);

export type ProjectBandwidth = typeof projectBandwidthTable.$inferSelect;
export type InsertProjectBandwidth = typeof projectBandwidthTable.$inferInsert;
