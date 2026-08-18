import {
  index,
  integer,
  pgEnum,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

export const WORKSPACE_MEMBER_ROLES = ["owner", "admin", "builder", "viewer", "billing"] as const;
export type WorkspaceMemberRole = (typeof WORKSPACE_MEMBER_ROLES)[number];

export const workspaceMemberRoleEnum = pgEnum("workspace_member_role", WORKSPACE_MEMBER_ROLES);

export const workspacesTable = pgTable(
  "workspaces",
  {
    id: serial("id").primaryKey(),
    ownerUserId: text("owner_user_id").notNull(),
    /** Stable machine identity for governed system workspaces; display names remain labels. */
    systemKey: text("system_key"),
    name: text("name").notNull(),
    description: text("description"),
    type: text("type").notNull().default("personal"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workspaces_owner_user_idx").on(t.ownerUserId),
    uniqueIndex("workspaces_system_key_unique")
      .on(t.systemKey)
      .where(sql`${t.systemKey} IS NOT NULL`),
  ],
);

export const workspaceMembersTable = pgTable(
  "workspace_members",
  {
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: workspaceMemberRoleEnum("role").notNull(),
    /** Actor that established the membership; owners created by signup/backfill self-attest. */
    invitedBy: text("invited_by").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId], name: "workspace_members_pk" }),
    index("workspace_members_user_idx").on(t.userId),
    index("workspace_members_workspace_role_idx").on(t.workspaceId, t.role),
  ],
);

export type Workspace = typeof workspacesTable.$inferSelect;
export type InsertWorkspace = typeof workspacesTable.$inferInsert;
export type WorkspaceMember = typeof workspaceMembersTable.$inferSelect;
export type InsertWorkspaceMember = typeof workspaceMembersTable.$inferInsert;
