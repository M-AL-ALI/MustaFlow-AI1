// ─────────────────────────────────────────────────────────────────────────────
// Production log capture (Task #511 — post-deploy observability).
//
// prod_logs:        raw rows — one per request, browser error, or health probe.
// prod_error_groups: rolled-up errors grouped by signature (normalized message
//                   + first stack frame).
// prod_health_checks: outcome of the synthetic post-publish health check.
// ─────────────────────────────────────────────────────────────────────────────

import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const PROD_LOG_KINDS = ["request", "browser", "server", "health"] as const;
export type ProdLogKind = (typeof PROD_LOG_KINDS)[number];

export const prodLogsTable = pgTable(
  "prod_logs",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    snapshotId: integer("snapshot_id"),
    kind: text("kind").notNull(),
    // Request fields
    method: text("method"),
    path: text("path"),
    status: integer("status"),
    latencyMs: integer("latency_ms"),
    requestId: text("request_id"),
    ipHash: text("ip_hash"),
    userAgent: text("user_agent"),
    // Error fields
    errorClass: text("error_class"),
    message: text("message"),
    stack: text("stack"),
    signature: text("signature"),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("prod_logs_project_ts_idx").on(t.projectId, t.ts),
    index("prod_logs_signature_idx").on(t.signature),
    index("prod_logs_kind_idx").on(t.kind),
  ],
);

export type ProdLog = typeof prodLogsTable.$inferSelect;
export type InsertProdLog = typeof prodLogsTable.$inferInsert;

export const prodErrorGroupsTable = pgTable(
  "prod_error_groups",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    signature: text("signature").notNull(),
    sampleMessage: text("sample_message").notNull(),
    sampleStack: text("sample_stack"),
    kind: text("kind").notNull().default("browser"),
    count: integer("count").notNull().default(1),
    firstSeen: timestamp("first_seen", { withTimezone: true }).notNull().defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("prod_error_groups_project_signature_idx").on(t.projectId, t.signature),
    index("prod_error_groups_last_seen_idx").on(t.lastSeen),
  ],
);

export type ProdErrorGroup = typeof prodErrorGroupsTable.$inferSelect;
export type InsertProdErrorGroup = typeof prodErrorGroupsTable.$inferInsert;

export const prodHealthChecksTable = pgTable(
  "prod_health_checks",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    snapshotId: integer("snapshot_id"),
    publicSlug: text("public_slug"),
    status: text("status").notNull(), // "passed" | "failed" | "partial"
    rootStatus: integer("root_status"),
    rootLatencyMs: integer("root_latency_ms"),
    routesChecked: integer("routes_checked").notNull().default(0),
    routesFailed: integer("routes_failed").notNull().default(0),
    failureSummary: text("failure_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("prod_health_checks_project_idx").on(t.projectId, t.createdAt)],
);

export type ProdHealthCheck = typeof prodHealthChecksTable.$inferSelect;
export type InsertProdHealthCheck = typeof prodHealthChecksTable.$inferInsert;
