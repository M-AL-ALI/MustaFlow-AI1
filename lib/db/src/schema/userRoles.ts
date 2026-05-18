import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const USER_ROLES = ["user", "admin", "owner"] as const;
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
