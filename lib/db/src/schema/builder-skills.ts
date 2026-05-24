import { pgTable, text, boolean, integer, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-skill settings & telemetry for the per-task skills system.
 * Skill content lives on disk (skills/<name>/SKILL.md); this table tracks
 * admin enable/disable and load counts so we can analyze which skills the
 * agent loop is actually invoking.
 */
export const builderSkillsTable = pgTable("builder_skills", {
  name: text("name").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  loadCount: integer("load_count").notNull().default(0),
  lastLoadedAt: timestamp("last_loaded_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /**
   * Agent-authored skill drafts (Task #536). Drafts are stored on disk under
   * `skills/_drafts/<slug>/SKILL.md` and never appear in the loop's index or
   * `load_skill` results until an admin approves them. Approval moves the
   * file to `skills/<slug>/SKILL.md` and sets `draft = false`.
   */
  draft: boolean("draft").notNull().default(false),
  authoredBy: text("authored_by"),
  authoredAt: timestamp("authored_at", { withTimezone: true }),
  authoringContext: text("authoring_context"),
});

export type BuilderSkillRow = typeof builderSkillsTable.$inferSelect;
export type InsertBuilderSkillRow = typeof builderSkillsTable.$inferInsert;
