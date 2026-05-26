import { pgTable, serial, text, boolean, timestamp } from "drizzle-orm/pg-core";

export const userPreferencesTable = pgTable("user_preferences", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  dismissedOnboarding: boolean("dismissed_onboarding").notNull().default(false),
  preferredMode: text("preferred_mode").$type<"builder" | "developer">(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserPreferences = typeof userPreferencesTable.$inferSelect;
export type InsertUserPreferences = typeof userPreferencesTable.$inferInsert;
