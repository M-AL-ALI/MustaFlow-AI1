import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const CONTAINER_LOG_LEVELS = ["stdout", "stderr", "system"] as const;
export type ContainerLogLevel = (typeof CONTAINER_LOG_LEVELS)[number];

export const containerLogsTable = pgTable("container_logs", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id")
    .notNull()
    .references(() => projectsTable.id, { onDelete: "cascade" }),
  level: text("level").notNull().default("stdout"),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ContainerLog = typeof containerLogsTable.$inferSelect;
export type InsertContainerLog = typeof containerLogsTable.$inferInsert;
