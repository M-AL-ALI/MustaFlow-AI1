import {
  pgTable,
  serial,
  integer,
  text,
  boolean,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const buildAnalyticsTable = pgTable(
  "build_analytics",
  {
    id: serial("id").primaryKey(),
    taskId: integer("task_id").notNull(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    userId: text("user_id"),
    model: text("model").notNull(),
    agentMode: text("agent_mode").notNull(),
    kind: text("kind").notNull(),
    durationMs: integer("duration_ms").notNull(),
    correctionPasses: integer("correction_passes").notNull().default(0),
    escalated: boolean("escalated").notNull().default(false),
    outcome: text("outcome").notNull(),
    primaryErrorCategory: text("primary_error_category"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("build_analytics_project_id_idx").on(table.projectId),
    index("build_analytics_created_at_idx").on(table.createdAt),
  ],
);

export type BuildAnalytic = typeof buildAnalyticsTable.$inferSelect;
export type InsertBuildAnalytic = typeof buildAnalyticsTable.$inferInsert;
