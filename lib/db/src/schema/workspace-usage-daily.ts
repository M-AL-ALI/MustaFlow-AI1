import {
  pgTable,
  serial,
  integer,
  text,
  bigint,
  date,
  uniqueIndex,
  timestamp,
} from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

// Daily bandwidth + request rollup per workspace, aggregated from domain_serve_events.
// Populated by the daily aggregation job in workspace-domains routes.
export const workspaceUsageDailyTable = pgTable(
  "workspace_usage_daily",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    // date: day this row covers (UTC), stored as DATE
    date: date("date").notNull(),
    // hostname: which custom domain generated this traffic.
    // '' (empty string) represents platform traffic with no custom domain.
    // NOT NULL — rollupUsage normalises source NULL hostnames → '' before insert.
    // This ensures the unique index on (workspace_id, date, hostname) works
    // correctly (SQL NULLs are not equal, so a nullable column would allow
    // duplicate platform-traffic rows on repeated rollup runs).
    hostname: text("hostname").notNull().default(""),
    // requestCount: number of served requests that day
    requestCount: bigint("request_count", { mode: "number" }).notNull().default(0),
    // bandwidthBytes: total bytes served that day
    bandwidthBytes: bigint("bandwidth_bytes", { mode: "number" }).notNull().default(0),
    // stripeMeterReportedAt: when this row was last flushed to Stripe metered billing.
    // Null = not yet reported.
    stripeMeterReportedAt: timestamp("stripe_meter_reported_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_usage_daily_workspace_date_host_unique").on(
      t.workspaceId,
      t.date,
      t.hostname,
    ),
  ],
);

// Org-level domain audit log — every role change and domain mutation
export const workspaceDomainAuditTable = pgTable("workspace_domain_audit", {
  id: serial("id").primaryKey(),
  workspaceId: integer("workspace_id")
    .notNull()
    .references(() => workspacesTable.id, { onDelete: "cascade" }),
  workspaceDomainId: integer("workspace_domain_id"),
  userId: text("user_id").notNull(),
  action: text("action").notNull(),
  hostname: text("hostname"),
  // payload: JSON snapshot of before/after state or role assignment details
  payload: text("payload"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type WorkspaceUsageDaily = typeof workspaceUsageDailyTable.$inferSelect;
export type InsertWorkspaceUsageDaily = typeof workspaceUsageDailyTable.$inferInsert;
export type WorkspaceDomainAudit = typeof workspaceDomainAuditTable.$inferSelect;
export type InsertWorkspaceDomainAudit = typeof workspaceDomainAuditTable.$inferInsert;
