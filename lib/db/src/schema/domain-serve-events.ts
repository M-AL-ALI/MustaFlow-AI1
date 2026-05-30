import { pgTable, serial, integer, text, timestamp, bigint, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const domainServeEventsTable = pgTable(
  "domain_serve_events",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    domainId: integer("domain_id"),
    snapshotId: integer("snapshot_id"),
    hostname: text("hostname"),
    bytesServed: bigint("bytes_served", { mode: "number" }),
    ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_domain_serve_events_domain").on(t.domainId, t.ts),
    index("idx_domain_serve_events_project").on(t.projectId, t.ts),
  ],
);

export type DomainServeEvent = typeof domainServeEventsTable.$inferSelect;
export type InsertDomainServeEvent = typeof domainServeEventsTable.$inferInsert;
