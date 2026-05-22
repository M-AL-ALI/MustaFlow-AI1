import { pgTable, serial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { agentTasksTable } from "./tasks";
import type { TestResult } from "./tasks";

export const appTestRunsTable = pgTable(
  "app_test_runs",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => agentTasksTable.id, { onDelete: "set null" }),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
    testScript: text("test_script"),
    results: jsonb("results").$type<TestResult[]>().notNull().default([]),
    passed: integer("passed").notNull().default(0),
    failed: integer("failed").notNull().default(0),
  },
  (table) => [
    index("app_test_runs_project_id_ran_at_idx").on(table.projectId, table.ranAt),
    index("app_test_runs_task_id_idx").on(table.taskId),
  ],
);

export type AppTestRun = typeof appTestRunsTable.$inferSelect;
export type InsertAppTestRun = typeof appTestRunsTable.$inferInsert;
