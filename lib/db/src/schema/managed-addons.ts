import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const ADDON_KINDS = ["redis_kv", "vector_db", "object_storage"] as const;
export type AddonKind = (typeof ADDON_KINDS)[number];

export const ADDON_STATUSES = [
  "provisioning",
  "active",
  "error",
  "deprovisioning",
  "removed",
] as const;
export type AddonStatus = (typeof ADDON_STATUSES)[number];

/**
 * Per-project managed add-ons:
 *   redis_kv      — Upstash Redis (or equivalent KV store); injects REDIS_URL
 *   vector_db     — pgvector extension on project DB, or separate vector store; injects VECTOR_DB_URL
 *   object_storage — R2-compatible bucket per project; injects OBJECT_STORAGE_* vars
 */
export const managedAddonsTable = pgTable(
  "managed_addons",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    status: text("status").notNull().default("provisioning"),
    // Provider-specific external ID (bucket name, Upstash DB ID, etc.)
    externalId: text("external_id"),
    // Connection details surfaced in the UI (keys injected as project secrets, not stored here)
    connectionInfo: jsonb("connection_info").$type<Record<string, string>>(),
    // Which env var name(s) were injected as project secrets
    injectedEnvKeys: jsonb("injected_env_keys").$type<string[]>().default([]),
    // Plan / tier for metering
    plan: text("plan").notNull().default("free"),
    // Usage metrics (periodically updated by metering sweep)
    usageBytes: integer("usage_bytes"),
    usageOps: integer("usage_ops"),
    lastMeteredAt: timestamp("last_metered_at", { withTimezone: true }),
    notes: text("notes"),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
  },
  (t) => [
    index("managed_addons_project_idx").on(t.projectId),
    index("managed_addons_kind_idx").on(t.kind),
    unique("managed_addons_project_kind_unique").on(t.projectId, t.kind),
  ],
);

export type ManagedAddon = typeof managedAddonsTable.$inferSelect;
export type InsertManagedAddon = typeof managedAddonsTable.$inferInsert;
