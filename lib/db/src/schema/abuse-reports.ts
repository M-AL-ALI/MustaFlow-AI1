import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { projectDomainsTable } from "./domains";

export const ABUSE_CATEGORIES = [
  "phishing",
  "malware",
  "spam",
  "impersonation",
  "illegal_content",
  "other",
] as const;
export type AbuseCategory = (typeof ABUSE_CATEGORIES)[number];

export const ABUSE_STATUSES = ["open", "dismissed", "resolved"] as const;
export type AbuseStatus = (typeof ABUSE_STATUSES)[number];

export const abuseReportsTable = pgTable(
  "abuse_reports",
  {
    id: serial("id").primaryKey(),
    // domainId: FK to project_domains. Nullable because a report can name a hostname
    // that is not (or no longer) in project_domains.
    domainId: integer("domain_id").references(() => projectDomainsTable.id, {
      onDelete: "set null",
    }),
    // The reported hostname — stored denormalised so it survives domain deletion.
    hostname: text("hostname").notNull(),
    // category: what kind of abuse is being reported.
    category: text("category").notNull().default("other"),
    // reason: short free-text description from the reporter.
    reason: text("reason").notNull(),
    // details: optional longer description or evidence URL.
    details: text("details"),
    // reporterEmail: optional contact address for follow-up.
    reporterEmail: text("reporter_email"),
    // reporterIp: stored hashed (SHA-256 hex) for privacy.
    reporterIp: text("reporter_ip"),
    // status: open | dismissed | resolved
    status: text("status").notNull().default("open"),
    // resolvedBy / resolvedAt: who closed the report and when.
    resolvedBy: text("resolved_by"),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("abuse_reports_status_idx").on(t.status),
    index("abuse_reports_hostname_idx").on(t.hostname),
    index("abuse_reports_domain_id_idx").on(t.domainId),
  ],
);

export type AbuseReport = typeof abuseReportsTable.$inferSelect;
export type InsertAbuseReport = typeof abuseReportsTable.$inferInsert;
