import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const notificationsTable = pgTable(
  "notifications",
  {
    id: serial("id").primaryKey(),
    // recipientId: Clerk user ID of the notification recipient
    recipientId: text("recipient_id").notNull(),
    // type: comment_mention | comment_reply | comment_resolved | org_invite |
    //        build_complete | build_failed | member_joined | member_removed |
    //        share_link_viewed | project_published
    type: text("type").notNull(),
    // title: short display title
    title: text("title").notNull(),
    body: text("body"),
    // actorId: Clerk user ID of the person who triggered this notification
    actorId: text("actor_id"),
    actorName: text("actor_name"),
    // resourceType: project | comment | org_invite | build
    resourceType: text("resource_type"),
    // resourceId: the ID of the resource (stringified for flexibility)
    resourceId: text("resource_id"),
    // projectId: optional project context for deep-linking
    projectId: integer("project_id"),
    // metadata: arbitrary extra data (e.g., file path, line number, comment excerpt)
    metadata: jsonb("metadata"),
    read: boolean("read").notNull().default(false),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notifications_recipient_idx").on(t.recipientId, t.createdAt),
    index("notifications_unread_idx")
      .on(t.recipientId, t.read)
      .where(sql`read = false`),
  ],
);

export type Notification = typeof notificationsTable.$inferSelect;
export type InsertNotification = typeof notificationsTable.$inferInsert;
