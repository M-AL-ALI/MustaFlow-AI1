import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const SECRET_AUDIT_ACTIONS = [
  "created",
  "updated",
  "deleted",
  "accessed",
  "verified",
  "verification_failed",
] as const;
export type SecretAuditAction = (typeof SECRET_AUDIT_ACTIONS)[number];

export const secretAuditLogTable = pgTable("secret_audit_log", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  secretId: integer("secret_id"),
  secretName: text("secret_name").notNull(),
  action: text("action").notNull(),
  actorId: text("actor_id").notNull(),
  metadata: jsonb("metadata"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SecretAuditLog = typeof secretAuditLogTable.$inferSelect;
export type InsertSecretAuditLog = typeof secretAuditLogTable.$inferInsert;
