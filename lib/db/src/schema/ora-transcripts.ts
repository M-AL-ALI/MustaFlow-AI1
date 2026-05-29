import { pgTable, serial, text, jsonb, timestamp } from "drizzle-orm/pg-core";

export const oraTranscriptsTable = pgTable("ora_transcripts", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  messages: jsonb("messages").notNull().default([]),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type OraTranscript = typeof oraTranscriptsTable.$inferSelect;
export type InsertOraTranscript = typeof oraTranscriptsTable.$inferInsert;
