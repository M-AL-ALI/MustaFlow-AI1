import { pgTable, serial, integer, text, timestamp, numeric, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const USAGE_EVENT_KINDS = [
  "container_start",
  "container_stop",
  "container_hour",
  "storage_gb_mo",
  "kv_op",
  "vector_query",
  "job_run",
  "bandwidth_gb",
] as const;
export type UsageEventKind = (typeof USAGE_EVENT_KINDS)[number];

/**
 * Metering events — one row per measurable unit consumed.
 * Aggregated daily by the metering sweep into workspace_usage_daily.
 *
 * quantity uses numeric(18,6) so fractional GB/hours are preserved.
 */
export const usageEventsTable = pgTable(
  "usage_events",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    quantity: numeric("quantity", { precision: 18, scale: 6 }).notNull().default("1"),
    // Optional reference to the resource that produced this event
    resourceType: text("resource_type"),
    resourceId: text("resource_id"),
    // Unit label for display (hours, GB, ops, etc.)
    unit: text("unit").notNull().default("units"),
    recordedAt: timestamp("recorded_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("usage_events_project_idx").on(t.projectId),
    index("usage_events_user_idx").on(t.userId),
    index("usage_events_kind_idx").on(t.kind),
    index("usage_events_recorded_at_idx").on(t.recordedAt),
  ],
);

export type UsageEvent = typeof usageEventsTable.$inferSelect;
export type InsertUsageEvent = typeof usageEventsTable.$inferInsert;
