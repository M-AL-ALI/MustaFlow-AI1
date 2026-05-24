import { pgTable, serial, integer, text, timestamp, bigint } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const domainServeEventsTable = pgTable("domain_serve_events", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  domainId: integer("domain_id"),
  snapshotId: integer("snapshot_id"),
  hostname: text("hostname"),
  bytesServed: bigint("bytes_served", { mode: "number" }),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
});

export type DomainServeEvent = typeof domainServeEventsTable.$inferSelect;
export type InsertDomainServeEvent = typeof domainServeEventsTable.$inferInsert;
