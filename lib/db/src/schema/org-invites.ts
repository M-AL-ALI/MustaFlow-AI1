import { pgTable, serial, text, timestamp, integer, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const orgInvitesTable = pgTable(
  "org_invites",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    // token: cryptographically random invite token (URL-safe base64, 32 bytes)
    token: text("token").notNull().unique(),
    email: text("email").notNull(),
    role: text("role").notNull().default("member"),
    // invitedByUserId: Clerk user ID of the person who sent the invite
    invitedByUserId: text("invited_by_user_id").notNull(),
    // status: pending | accepted | revoked | expired
    status: text("status").notNull().default("pending"),
    // acceptedByUserId: Clerk user ID of the person who accepted (set on accept)
    acceptedByUserId: text("accepted_by_user_id"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("org_invites_org_idx").on(t.organizationId),
    index("org_invites_email_idx").on(t.email),
  ],
);

export type OrgInvite = typeof orgInvitesTable.$inferSelect;
export type InsertOrgInvite = typeof orgInvitesTable.$inferInsert;
