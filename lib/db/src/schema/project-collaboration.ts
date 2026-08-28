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
import { projectsTable } from "./projects";
import { workspacesTable } from "./workspaces";

export const PROJECT_COLLABORATOR_ROLES = ["owner", "publisher", "editor", "viewer"] as const;
export type ProjectCollaboratorRole = (typeof PROJECT_COLLABORATOR_ROLES)[number];
export const projectCollaboratorRoleEnum = pgEnum(
  "project_collaborator_role",
  PROJECT_COLLABORATOR_ROLES,
);

export const PROJECT_INVITE_STATES = ["pending", "accepted", "revoked", "expired"] as const;
export type ProjectInviteState = (typeof PROJECT_INVITE_STATES)[number];
export const projectInviteStateEnum = pgEnum("project_invite_state", PROJECT_INVITE_STATES);

/**
 * Explicit, project-scoped access. The workspace remains the tenancy/billing
 * boundary; this row is the minimum grant needed to open one named project.
 */
export const projectCollaboratorsTable = pgTable(
  "project_collaborators",
  {
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    role: projectCollaboratorRoleEnum("role").notNull(),
    invitedBy: text("invited_by").notNull(),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    primaryKey({
      columns: [table.projectId, table.userId],
      name: "project_collaborators_pk",
    }),
    index("project_collaborators_user_idx").on(table.userId),
    index("project_collaborators_workspace_idx").on(table.workspaceId),
    index("project_collaborators_project_role_idx").on(table.projectId, table.role),
  ],
);

/**
 * Invitation tokens are never persisted in plaintext. Only their SHA-256
 * digest is stored; the one-time token appears solely in the invitation URL.
 */
export const projectInvitesTable = pgTable(
  "project_invites",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    workspaceId: integer("workspace_id")
      .notNull()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    email: text("email"),
    tokenHash: text("token_hash").notNull(),
    role: projectCollaboratorRoleEnum("role").notNull(),
    status: projectInviteStateEnum("status").notNull().default("pending"),
    invitedBy: text("invited_by").notNull(),
    acceptedBy: text("accepted_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("accepted_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("project_invites_token_hash_uq").on(table.tokenHash),
    index("project_invites_project_status_idx").on(table.projectId, table.status),
    index("project_invites_email_idx").on(table.email),
    uniqueIndex("project_invites_pending_email_uq")
      .on(table.projectId, table.email)
      .where(sql`${table.status} = 'pending' AND ${table.email} IS NOT NULL`),
  ],
);

export type ProjectCollaborator = typeof projectCollaboratorsTable.$inferSelect;
export type ProjectInvite = typeof projectInvitesTable.$inferSelect;
