/**
 * Task #598 — Make DNS records editable without Cloudflare.
 *
 * Stores DNS record intent locally so teams managing DNS at registrars other
 * than Cloudflare (Route 53, Namecheap, GoDaddy, …) can still draft, organise,
 * and export their records from inside MustaFlow.
 *
 * When CF is configured, the existing CF-backed routes remain authoritative
 * for the zone. Local rows can be pushed up via the "Sync to Cloudflare"
 * action, which creates them in CF and removes them from this table.
 */
import { pgTable, serial, integer, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { projectDomainsTable } from "./domains";

export const DNS_RECORD_SOURCES = ["local", "cloudflare"] as const;
export type DnsRecordSource = (typeof DNS_RECORD_SOURCES)[number];

export const dnsRecordsTable = pgTable(
  "dns_records",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    domainId: integer("domain_id")
      .notNull()
      .references(() => projectDomainsTable.id, { onDelete: "cascade" }),
    // Hostname this record belongs to — denormalised from domains.hostname so
    // exports and history lookups don't need a join.
    hostname: text("hostname").notNull(),
    // Record fields — same shape used by the CF API client.
    name: text("name").notNull(),
    type: text("type").notNull(),
    content: text("content"),
    priority: integer("priority"),
    ttl: integer("ttl").notNull().default(1),
    proxied: boolean("proxied").notNull().default(false),
    // SRV / CAA structured payload — mirrors CfDnsRecordInput.data.
    data: text("data"),
    // 'local'  — drafted in the DB, not yet pushed anywhere
    // 'cloudflare' — was synced to CF (kept for audit / undo)
    source: text("source").$type<DnsRecordSource>().notNull().default("local"),
    // CF record id, populated after a successful sync.
    cfRecordId: text("cf_record_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("dns_records_domain_idx").on(t.domainId)],
);

export type DnsRecordRow = typeof dnsRecordsTable.$inferSelect;
export type InsertDnsRecord = typeof dnsRecordsTable.$inferInsert;
