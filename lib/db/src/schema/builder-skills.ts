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
});

export type BuilderSkillRow = typeof builderSkillsTable.$inferSelect;
export type InsertBuilderSkillRow = typeof builderSkillsTable.$inferInsert;
