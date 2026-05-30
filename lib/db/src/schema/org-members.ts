import { pgTable, serial, text, timestamp, integer, unique, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

// Roles in ascending privilege order:
//   viewer  — read-only: can view project files, preview, comments
//   member  — can chat with builder, edit files, create builds
//   admin   — member + can manage members, invites, project settings
//   owner   — full control including billing and org deletion
export const orgMembersTable = pgTable(
  "org_members",
  {
    id: serial("id").primaryKey(),
    organizationId: integer("organization_id")
      .notNull()
      .references(() => organizationsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: text("role").notNull().default("member"),
    // displayName / email cached from Clerk for display without Clerk API calls
    displayName: text("display_name"),
    email: text("email"),
    avatarUrl: text("avatar_url"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("org_members_unique_user").on(t.organizationId, t.userId),
    index("org_members_user_idx").on(t.userId),
    index("org_members_org_idx").on(t.organizationId),
  ],
);

export type OrgMember = typeof orgMembersTable.$inferSelect;
export type InsertOrgMember = typeof orgMembersTable.$inferInsert;
