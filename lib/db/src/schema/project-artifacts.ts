import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * project_artifacts (Task #544 — Multi-artifact Projects)
 *
 * A single MustaFlow project can hold ≥1 artifact (web, mobile, api, slides,
 * data-app). Each artifact owns its own files (project_files.artifactId),
 * its own kind/stack, and — in future iterations — its own preview, publish,
 * and container. The cross-product is the "project".
 *
 * Backfill: every existing project gets one artifact row marked isPrimary=true
 * whose kind/name/stack/platform mirror the legacy project columns. New
 * project_files rows are stamped with the active artifact's id; existing
 * rows are updated to the primary artifact's id during the migration.
 */
export const projectArtifactsTable = pgTable(
  "project_artifacts",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    // kind: web | mobile-cross | mobile-ios | mobile-android | api | slides | data-app
    kind: text("kind").notNull().default("web"),
    // platform: web | ios | android | cross | server | none
    platform: text("platform").notNull().default("web"),
    // projectFormat: static-html | react-vite | nextjs | node-api | python-flask | python-fastapi | expo | slides | data-app
    projectFormat: text("project_format").notNull().default("static-html"),
    // stack: same enum as projects.stack
    stack: text("stack").notNull().default("react-vite"),
    // Human-readable name shown in the artifact tab strip ("Web app", "Mobile", "API").
    name: text("name").notNull(),
    // URL-safe slug, unique per project. Used in agent tool calls (artifact_slug) and in URLs.
    slug: text("slug").notNull(),
    // The one artifact that legacy single-artifact endpoints default to when no
    // artifactId is provided. Exactly one per project should have this set.
    isPrimary: boolean("is_primary").notNull().default(false),
    status: text("status").notNull().default("draft"),
    // Per-artifact summary shown in the workspace ("Built a recipe tracker…").
    lastTaskSummary: text("last_task_summary"),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    slugUniq: uniqueIndex("project_artifacts_project_slug_unique").on(t.projectId, t.slug),
  }),
);

export type ProjectArtifact = typeof projectArtifactsTable.$inferSelect;
export type InsertProjectArtifact = typeof projectArtifactsTable.$inferInsert;
