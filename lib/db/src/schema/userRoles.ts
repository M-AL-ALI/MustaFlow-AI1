import { index, integer, pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const STAFF_ROLES = ["owner", "operator", "support", "analyst"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

export const USER_ROLES = ["user", ...STAFF_ROLES] as const;
export type UserRole = (typeof USER_ROLES)[number];

// Per-user role. userId is unique — one role per user.
// Bootstrap: users listed in ADMIN_USER_IDS env var are always admin regardless of this table.
export const userRolesTable = pgTable("user_roles", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  role: text("role").notNull().default("user"),
  grantedBy: text("granted_by"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserRoleEntry = typeof userRolesTable.$inferSelect;

// The Admin Page reads platform truth from existing sources. This ledger only
// records access to that truth and actions taken through the console itself.
export const adminAccessReceiptsTable = pgTable(
  "admin_access_receipts",
  {
    id: serial("id").primaryKey(),
    actorUserId: text("actor_user_id").notNull(),
    actorRole: text("actor_role").notNull(),
    kind: text("kind").notNull(),
    action: text("action").notNull(),
    targetUserId: text("target_user_id"),
    targetWorkspaceId: integer("target_workspace_id"),
    previousRole: text("previous_role"),
    nextRole: text("next_role"),
    outcome: text("outcome").notNull(),
    requestMethod: text("request_method"),
    requestPath: text("request_path"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("admin_access_receipts_actor_created_idx").on(table.actorUserId, table.createdAt),
    index("admin_access_receipts_target_user_created_idx").on(table.targetUserId, table.createdAt),
    index("admin_access_receipts_workspace_created_idx").on(
      table.targetWorkspaceId,
      table.createdAt,
    ),
  ],
);

export type AdminAccessReceipt = typeof adminAccessReceiptsTable.$inferSelect;
