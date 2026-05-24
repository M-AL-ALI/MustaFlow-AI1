import { pgTable, serial, text, timestamp, integer, jsonb } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

// Append-only activity log for meaningful project events.
// Event types: build | publish | unpublish | file_edit | comment | member_join |
//              member_leave | rollback | duplicate | export | share_link_created |
//              share_link_revoked | domain_connected | version_pinned
export const projectActivityTable = pgTable("project_activity", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  // actorId: Clerk user ID of the person who triggered the event (null = system)
  actorId: text("actor_id"),
  actorName: text("actor_name"),
  actorAvatar: text("actor_avatar"),
  // eventType: build | publish | comment | file_edit | etc.
  eventType: text("event_type").notNull(),
  // summary: human-readable one-liner
  summary: text("summary").notNull(),
  // metadata: event-specific data (build id, file path, comment id, etc.)
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ProjectActivity = typeof projectActivityTable.$inferSelect;
export type InsertProjectActivity = typeof projectActivityTable.$inferInsert;

// Helper exported for use by other route handlers that want to log activity
// without importing the full route file.
export const PROJECT_ACTIVITY_TYPES = [
  "build",
  "publish",
  "unpublish",
  "file_edit",
  "comment",
  "member_join",
  "member_leave",
  "rollback",
  "duplicate",
  "export",
  "share_link_created",
  "share_link_revoked",
  "domain_connected",
  "version_pinned",
  "build_failed",
] as const;

export type ProjectActivityType = (typeof PROJECT_ACTIVITY_TYPES)[number];
