import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const userPreferencesTable = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  dismissedOnboarding: boolean("dismissed_onboarding").notNull().default(false),
  preferredMode: text("preferred_mode").$type<"builder" | "developer" | "ora">(),
  voiceLang: text("voice_lang"),
  // GDPR erasure lifecycle — set when DELETE /api/me is called.
  // erasureJobId: pg-boss job ID for the scheduled hard-erasure. Allows cancellation within 30 days.
  // erasureRequestedAt: when the erasure was initiated (for display in the UI).
  erasureJobId: text("erasure_job_id"),
  erasureRequestedAt: timestamp("erasure_requested_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserPreferences = typeof userPreferencesTable.$inferSelect;
export type InsertUserPreferences = typeof userPreferencesTable.$inferInsert;
