import { pgTable, serial, integer, text, timestamp, boolean, jsonb, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const chatMessagesTable = pgTable("chat_messages", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull().references(() => projectsTable.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  agentMode: text("agent_mode").notNull().default("eco"),
  planMode: boolean("plan_mode").notNull().default(false),
  plan: jsonb("plan"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("chat_messages_project_id_created_at_idx").on(table.projectId, table.createdAt),
]);

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type InsertChatMessage = typeof chatMessagesTable.$inferInsert;
