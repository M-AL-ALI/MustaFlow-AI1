import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { checkRunsTable } from "./check-runs";

export type SecurityFindingStatus = "open" | "dismissed" | "fixed";
export type SecurityFindingSeverity = "critical" | "high" | "medium" | "low" | "info";

export const securityFindingsTable = pgTable(
  "security_findings",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    checkRunId: integer("check_run_id").references(() => checkRunsTable.id, {
      onDelete: "set null",
    }),
    checkType: text("check_type").notNull(),
    severity: text("severity").notNull().$type<SecurityFindingSeverity>(),
    fingerprint: text("fingerprint").notNull(),
    message: text("message").notNull(),
    file: text("file"),
    line: integer("line"),
    status: text("status").notNull().default("open").$type<SecurityFindingStatus>(),
    dismissedBy: text("dismissed_by"),
    dismissedAt: timestamp("dismissed_at", { withTimezone: true }),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("security_findings_project_fingerprint_idx").on(table.projectId, table.fingerprint),
    index("security_findings_project_id_idx").on(table.projectId),
    index("security_findings_status_idx").on(table.status),
  ],
);

export type SecurityFinding = typeof securityFindingsTable.$inferSelect;
export type InsertSecurityFinding = typeof securityFindingsTable.$inferInsert;
