import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projectsTable } from "./projects";
import { projectVersionsTable } from "./versions";

export const chatMessagesTable = pgTable(
  "chat_messages",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    role: text("role").notNull(),
    content: text("content").notNull(),
    agentMode: text("agent_mode").notNull().default("eco"),
    planMode: boolean("plan_mode").notNull().default(false),
    plan: jsonb("plan"),
    attachments: jsonb("attachments"),
    // checkpointId: project_versions row this message is anchored to.
    // Set on assistant/system messages that announce a successful build/refine,
    // so the chat UI can offer "Rewind to here" → restore files + db + truncate
    // chat back to this point.
    checkpointId: integer("checkpoint_id").references(() => projectVersionsTable.id, {
      onDelete: "set null",
    }),
    // origin: identifies which panel/surface sent this message.
    // 'zero' = Zero agent panel; null = main builder chat or other sources.
    origin: text("origin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("chat_messages_project_id_created_at_idx").on(table.projectId, table.createdAt),
    index("chat_messages_checkpoint_id_idx")
      .on(table.checkpointId)
      .where(sql`checkpoint_id IS NOT NULL`),
  ],
);

export type ChatMessage = typeof chatMessagesTable.$inferSelect;
export type InsertChatMessage = typeof chatMessagesTable.$inferInsert;
