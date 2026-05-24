import { pgTable, serial, integer, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

export const WORKSPACE_DOMAIN_STATUSES = ["pending_verification", "verified", "failed"] as const;
export type WorkspaceDomainStatus = (typeof WORKSPACE_DOMAIN_STATUSES)[number];

export const workspaceDomainsTable = pgTable(
  "workspace_domains",
  {
    id: serial("id").primaryKey(),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    hostname: text("hostname").notNull(),
    // recordType: 'a' for apex domains, 'cname' for subdomains
    recordType: text("record_type").notNull().default("cname"),
    // verificationToken: random hex token for TXT-based ownership proof.
    // TXT record: _mustaflow-org.<domain> = mustaflow-org-verify=<token>
    verificationToken: text("verification_token").notNull(),
    // status: pending_verification | verified | failed
    status: text("status").notNull().default("pending_verification"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("workspace_domains_hostname_unique").on(t.hostname)],
);

export type WorkspaceDomain = typeof workspaceDomainsTable.$inferSelect;
export type InsertWorkspaceDomain = typeof workspaceDomainsTable.$inferInsert;
