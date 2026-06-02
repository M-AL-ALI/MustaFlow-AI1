import { pgTable, serial, integer, text, timestamp, jsonb } from "drizzle-orm/pg-core";
import { agentTasksTable } from "./tasks";

export const taskEventsTable = pgTable("task_events", {
  id: serial("id").primaryKey(),
  taskId: integer("task_id")
    .notNull()
    .references(() => agentTasksTable.id, { onDelete: "cascade" }),
  eventType: text("event_type").notNull(),
  message: text("message").notNull(),
  filePath: text("file_path"),
  data: jsonb("data").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type TaskEvent = typeof taskEventsTable.$inferSelect;
export type InsertTaskEvent = typeof taskEventsTable.$inferInsert;
