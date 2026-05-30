import { pgTable, serial, text, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const oraTranscriptsTable = pgTable(
  "ora_transcripts",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    messages: jsonb("messages").notNull().default([]),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ora_transcripts_user_id_idx").on(t.userId)],
);

export type OraTranscript = typeof oraTranscriptsTable.$inferSelect;
export type InsertOraTranscript = typeof oraTranscriptsTable.$inferInsert;
