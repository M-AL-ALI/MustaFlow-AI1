import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";

export const knowledgeEntriesTable = pgTable("knowledge_entries", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  category: text("category").notNull().default("note"),
  content: text("content").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KnowledgeEntry = typeof knowledgeEntriesTable.$inferSelect;
export type InsertKnowledgeEntry = typeof knowledgeEntriesTable.$inferInsert;
