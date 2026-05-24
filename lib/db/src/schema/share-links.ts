import { pgTable, serial, text, timestamp, integer, boolean } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const shareLinksTable = pgTable("share_links", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  // token: URL-safe random token (32 bytes → 44 base64url chars)
  token: text("token").notNull().unique(),
  // label: user-provided label for the link (e.g. "Client review")
  label: text("label"),
  // createdByUserId: Clerk user ID of the link creator
  createdByUserId: text("created_by_user_id").notNull(),
  // scope: draft = current live files; snapshot = a specific frozen version
  scope: text("scope").notNull().default("draft"),
  // snapshotVersionId: the project_versions row to serve for scope=snapshot
  snapshotVersionId: integer("snapshot_version_id"),
  // password: optional bcrypt hash for password-protected links
  passwordHash: text("password_hash"),
  // expiresAt: null = never expires
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  // revoked: soft revoke; token stops working immediately
  revoked: boolean("revoked").notNull().default(false),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  // viewCount: incremented on each GET /share/:token (best-effort)
  viewCount: integer("view_count").notNull().default(0),
  lastViewedAt: timestamp("last_viewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ShareLink = typeof shareLinksTable.$inferSelect;
export type InsertShareLink = typeof shareLinksTable.$inferInsert;
