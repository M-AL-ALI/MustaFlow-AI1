import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const ENVIRONMENT_NAMES = ["development", "staging", "production"] as const;
export type EnvironmentName = (typeof ENVIRONMENT_NAMES)[number];

export const PROMOTION_STATUSES = [
  "pending",
  "in_progress",
  "succeeded",
  "failed",
  "rolled_back",
] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/**
 * Per-project named environments (dev / staging / prod).
 * Each environment tracks its own snapshot (for promotion flow), status,
 * and any environment-level overrides.
 *
 * Secrets stored in `secrets` table carry an optional `environmentId` FK
 * (added via migration) so they can be scoped to a specific environment.
 *
 * Promotion flow:
 *   dev → staging: copy current dev files snapshot to staging env
 *   staging → prod: promote staging snapshot → update publishedSnapshotId
 */
export const projectEnvironmentsTable = pgTable(
  "project_environments",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // snapshotVersionId: the project_versions row currently deployed in this env
    snapshotVersionId: integer("snapshot_version_id"),
    // status: idle | deploying | deployed | failed
    status: text("status").notNull().default("idle"),
    // url: public URL for this env (null for dev, filled for staging/prod)
    url: text("url"),
    // autoPromote: when true, successful staging deploys auto-promote to prod
    autoPromote: boolean("auto_promote").notNull().default(false),
    // protection: when true, require manual approval before promotion
    protected: boolean("protected").notNull().default(false),
    // deployedBy: userId who last triggered a deploy/promote
    deployedBy: text("deployed_by"),
    deployedAt: timestamp("deployed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("project_environments_project_idx").on(t.projectId),
    unique("project_environments_project_name_unique").on(t.projectId, t.name),
  ],
);

/**
 * Promotion log — records every promote action between environments.
 */
export const environmentPromotionsTable = pgTable(
  "environment_promotions",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    fromEnvironment: text("from_environment").notNull(),
    toEnvironment: text("to_environment").notNull(),
    snapshotVersionId: integer("snapshot_version_id"),
    status: text("status").notNull().default("pending"),
    notes: text("notes"),
    triggeredBy: text("triggered_by"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [index("environment_promotions_project_idx").on(t.projectId)],
);

export type ProjectEnvironment = typeof projectEnvironmentsTable.$inferSelect;
export type InsertProjectEnvironment = typeof projectEnvironmentsTable.$inferInsert;
export type EnvironmentPromotion = typeof environmentPromotionsTable.$inferSelect;
