import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export type FileSnapshotEntry = {
  path: string;
  content: string;
  mimeType: string;
};

export type AuditFinding = {
  category: "accessibility" | "seo" | "performance" | "security";
  severity: "error" | "warning" | "info";
  file: string;
  message: string;
  suggestion: string;
};

export type AuditScore = {
  category: "accessibility" | "seo" | "performance" | "security";
  label: string;
  pass: number;
  warnings: number;
  failures: number;
  score: number;
};

export type AuditReport = {
  findings: AuditFinding[];
  scores: AuditScore[];
  auditedAt: string;
  fileCount: number;
};

export const projectVersionsTable = pgTable("project_versions", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  label: text("label").notNull(),
  note: text("note"),
  changelogEntry: text("changelog_entry"),
  filesSnapshot: jsonb("files_snapshot").$type<FileSnapshotEntry[]>(),
  planSnapshot: jsonb("plan_snapshot").$type<Record<string, unknown>>(),
  auditReport: jsonb("audit_report").$type<AuditReport>(),
  // Persisted validation outcome for the snapshot. "passed" = all required
  // checks succeeded; "failed" = produced by the agentic builder with one or
  // more required checks failing (snapshot saved anyway for inspection).
  // Null = legacy snapshots written before this column existed.
  validationStatus: text("validation_status").$type<
    "passed" | "failed" | "completed_with_errors"
  >(),
  // ogImageUrl: URL of the generated Open Graph image for this snapshot.
  // Set at publish time; served via the public route's <head> injection.
  ogImageUrl: text("og_image_url"),
  // environment: which environment slot this version was published to.
  // "production" = live public URL, "staging" = staging URL, "preview" = ephemeral per-build URL.
  // Null = legacy build snapshot (no environment slot assigned).
  environment: text("environment").$type<"production" | "staging" | "preview">(),
  // Task #767 — Testing approval gate.
  // testingApprovedAt: when a reviewer approved this version for production promotion.
  // Null = not yet approved. Required for agentic projects to publish to production.
  testingApprovedAt: timestamp("testing_approved_at", { withTimezone: true }),
  // testingApprovedBy: the Clerk userId of the reviewer who approved this version.
  testingApprovedBy: text("testing_approved_by"),
  // migrationStatus: lifecycle of the DB migration associated with this version.
  // null = no migration defined. "pending" | "running" | "passed" | "failed"
  migrationStatus: text("migration_status").$type<"pending" | "running" | "passed" | "failed">(),
  // migrationLog: captured output from running the migration (stdout + stderr).
  migrationLog: text("migration_log"),
  // testingSkipped: when true the approval gate was explicitly bypassed by an admin.
  testingSkipped: boolean("testing_skipped").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── preview_snapshots — ephemeral per-build preview URLs ─────────────────────
// Created after every successful build. Expire after PREVIEW_EXPIRY_DAYS (default 7).
// The preview URL pattern is: {slug}-preview-{taskId}.mustaflow.app
export const previewSnapshotsTable = pgTable(
  "preview_snapshots",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    // versionId: the project_versions row that holds the frozen snapshot files.
    versionId: integer("version_id").notNull(),
    // taskId: the agent task that produced this build (used in preview URL slug).
    taskId: integer("task_id"),
    // previewSlug: the full URL subdomain label, e.g. "myapp-abc123-preview-42"
    previewSlug: text("preview_slug").notNull(),
    // expiresAt: when this preview URL should be considered stale and purged.
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("preview_snapshots_slug_unique").on(t.previewSlug)],
);

export type ProjectVersion = typeof projectVersionsTable.$inferSelect;
export type InsertProjectVersion = typeof projectVersionsTable.$inferInsert;
export type PreviewSnapshot = typeof previewSnapshotsTable.$inferSelect;
export type InsertPreviewSnapshot = typeof previewSnapshotsTable.$inferInsert;
