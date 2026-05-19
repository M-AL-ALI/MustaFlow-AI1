import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const DEPLOYMENT_ENVS = ["testing", "production", "ios", "android"] as const;
export type DeploymentEnv = (typeof DEPLOYMENT_ENVS)[number];

export const DEPLOYMENT_STATUSES = ["started", "queued", "building", "passed", "failed", "unpublished", "submitting", "submitted"] as const;
export type DeploymentStatus = (typeof DEPLOYMENT_STATUSES)[number];

export const deploymentLogsTable = pgTable("deployment_logs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  env: text("env").notNull().default("testing"),
  status: text("status").notNull().default("passed"),
  publicSlug: text("public_slug"),
  publicUrl: text("public_url"),
  filesCount: integer("files_count"),
  snapshotVersionId: integer("snapshot_version_id"),
  checksResult: jsonb("checks_result"),
  note: text("note"),
  // Mobile / EAS build columns
  buildId: text("build_id"),
  platform: text("platform"),
  downloadUrl: text("download_url"),
  testflightUrl: text("testflight_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type DeploymentLog = typeof deploymentLogsTable.$inferSelect;
export type InsertDeploymentLog = typeof deploymentLogsTable.$inferInsert;
