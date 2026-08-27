import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { supportTicketsTable } from "./support-tickets";

export const SUPPORT_GRANT_STATUSES = [
  "pending",
  "active",
  "declined",
  "revoked",
  "expired",
  "closed",
] as const;
export type SupportGrantStatus = (typeof SUPPORT_GRANT_STATUSES)[number];

export const supportAccessGrantsTable = pgTable(
  "support_access_grants",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => supportTicketsTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict" }),
    ownerUserId: text("owner_user_id").notNull(),
    staffUserId: text("staff_user_id").notNull(),
    requestedBy: text("requested_by").notNull(),
    reason: text("reason").notNull(),
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (table) => [
    index("support_access_grants_owner_status_idx").on(table.ownerUserId, table.status),
    index("support_access_grants_staff_status_idx").on(table.staffUserId, table.status),
    index("support_access_grants_project_status_idx").on(table.projectId, table.status),
    uniqueIndex("support_access_grants_one_open_per_ticket_uq")
      .on(table.ticketId)
      .where(sql`${table.status} IN ('pending', 'active')`),
    check(
      "support_access_grants_status_check",
      sql`${table.status} IN ('pending','active','declined','revoked','expired','closed')`,
    ),
  ],
);

export const supportGrantEventsTable = pgTable(
  "support_grant_events",
  {
    id: serial("id").primaryKey(),
    grantId: integer("grant_id")
      .notNull()
      .references(() => supportAccessGrantsTable.id, { onDelete: "cascade" }),
    ticketId: integer("ticket_id").notNull(),
    projectId: integer("project_id").notNull(),
    actorUserId: text("actor_user_id").notNull(),
    actorDisplayName: text("actor_display_name"),
    event: text("event").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("support_grant_events_grant_created_idx").on(table.grantId, table.createdAt),
    index("support_grant_events_project_created_idx").on(table.projectId, table.createdAt),
  ],
);

export const supportZeroSessionsTable = pgTable(
  "support_zero_sessions",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => supportTicketsTable.id, { onDelete: "cascade" }),
    grantId: integer("grant_id")
      .notNull()
      .references(() => supportAccessGrantsTable.id, { onDelete: "restrict" }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "restrict" }),
    staffUserId: text("staff_user_id").notNull(),
    status: text("status").notNull().default("diagnosing"),
    evidenceBundle: jsonb("evidence_bundle").$type<Record<string, unknown>>().notNull(),
    proposal: jsonb("proposal").$type<Record<string, unknown>>().notNull(),
    approvedBy: text("approved_by"),
    declinedBy: text("declined_by"),
    taskId: integer("task_id"),
    appliedVersionId: integer("applied_version_id"),
    terminal: jsonb("terminal").$type<Record<string, unknown>>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("support_zero_sessions_ticket_created_idx").on(table.ticketId, table.createdAt),
    index("support_zero_sessions_grant_created_idx").on(table.grantId, table.createdAt),
    check(
      "support_zero_sessions_status_check",
      sql`${table.status} IN ('diagnosing','proposal_ready','approved','declined','applying','applied','interrupted')`,
    ),
  ],
);

export const platformDefectsTable = pgTable(
  "platform_defects",
  {
    id: serial("id").primaryKey(),
    fingerprint: text("fingerprint").notNull().unique(),
    title: text("title").notNull(),
    status: text("status").notNull().default("open"),
    evidence: jsonb("evidence").$type<Record<string, unknown>>().notNull().default({}),
    createdBy: text("created_by").notNull(),
    shippedVersion: text("shipped_version"),
    shippedAt: timestamp("shipped_at", { withTimezone: true }),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("platform_defects_status_updated_idx").on(table.status, table.updatedAt),
    check(
      "platform_defects_status_check",
      sql`${table.status} IN ('open','fixing','shipped','verified')`,
    ),
  ],
);

export const supportTicketDefectLinksTable = pgTable(
  "support_ticket_defect_links",
  {
    id: serial("id").primaryKey(),
    ticketId: integer("ticket_id")
      .notNull()
      .references(() => supportTicketsTable.id, { onDelete: "cascade" }),
    defectId: integer("defect_id")
      .notNull()
      .references(() => platformDefectsTable.id, { onDelete: "restrict" }),
    linkedBy: text("linked_by").notNull(),
    linkedAt: timestamp("linked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("support_ticket_defect_link_uq").on(table.ticketId, table.defectId)],
);

export const sharedProfileMigrationReceiptsTable = pgTable(
  "shared_profile_migration_receipts",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().unique(),
    source: text("source").notNull(),
    outcome: text("outcome").notNull(),
    migratedAt: timestamp("migrated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("shared_profile_migration_outcome_idx").on(table.outcome, table.migratedAt)],
);

export type SupportAccessGrant = typeof supportAccessGrantsTable.$inferSelect;
export type SupportGrantEvent = typeof supportGrantEventsTable.$inferSelect;
export type SupportZeroSession = typeof supportZeroSessionsTable.$inferSelect;
export type PlatformDefect = typeof platformDefectsTable.$inferSelect;
