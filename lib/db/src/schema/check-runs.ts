import { pgTable, serial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";
import { agentTasksTable } from "./tasks";

export type CheckFinding = {
  file: string;
  line?: number;
  message: string;
  detail?: string;
  severity: "error" | "warning" | "info";
};

export type CheckRunStatus = "pass" | "warning" | "fail" | "skipped";

export const checkRunsTable = pgTable(
  "check_runs",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    taskId: integer("task_id").references(() => agentTasksTable.id, { onDelete: "cascade" }),
    checkName: text("check_name").notNull(),
    status: text("status").notNull().$type<CheckRunStatus>(),
    findings: jsonb("findings").$type<CheckFinding[]>().default([]),
    aiReason: text("ai_reason"),
    ranAt: timestamp("ran_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("check_runs_project_id_task_id_idx").on(table.projectId, table.taskId),
    index("check_runs_task_id_idx").on(table.taskId),
  ],
);

export type CheckRun = typeof checkRunsTable.$inferSelect;
export type InsertCheckRun = typeof checkRunsTable.$inferInsert;
