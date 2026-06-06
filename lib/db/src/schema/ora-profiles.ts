import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

/**
 * Per-user Ora profile — the "About you" / custom-instructions block that
 * personalizes Ora's replies. Strictly an Ora concept: it is injected only
 * into the standalone Ora assistant's system prompt, never into the AI
 * Builder. One row per user (user_id is unique).
 */
export const oraProfilesTable = pgTable("ora_profiles", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  // What Ora should call the user.
  preferredName: text("preferred_name"),
  occupation: text("occupation"),
  industry: text("industry"),
  // Free-text: what the user is trying to achieve with Ora.
  goals: text("goals"),
  // e.g. "beginner" | "intermediate" | "advanced" (free text — not enum-locked).
  skillLevel: text("skill_level"),
  // Preferred response language hint (free text, e.g. "English", "Español").
  preferredLanguage: text("preferred_language"),
  // How Ora should respond: tone/length preferences (free text).
  responseStyle: text("response_style"),
  // Things Ora should avoid doing or topics to steer clear of.
  avoid: text("avoid"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OraProfile = typeof oraProfilesTable.$inferSelect;
export type InsertOraProfile = typeof oraProfilesTable.$inferInsert;
