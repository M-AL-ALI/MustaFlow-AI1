import { pgTable, serial, integer, text, timestamp, boolean, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

export const DEPLOYMENT_TYPES = ["static", "autoscale", "reserved_vm"] as const;
export type DeploymentType = (typeof DEPLOYMENT_TYPES)[number];

export const SCHEDULE_KINDS = ["redeploy", "task_run", "health_probe"] as const;
export type ScheduleKind = (typeof SCHEDULE_KINDS)[number];

export const deploymentSchedulesTable = pgTable(
  "deployment_schedules",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    kind: text("kind").notNull().default("task_run"),
    cronExpr: text("cron_expr").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    note: text("note"),
    lastRunAt: timestamp("last_run_at", { withTimezone: true }),
    lastRunStatus: text("last_run_status"),
    lastRunMessage: text("last_run_message"),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("deployment_schedules_project_idx").on(t.projectId),
    index("deployment_schedules_next_run_idx").on(t.nextRunAt),
  ],
);

export type DeploymentSchedule = typeof deploymentSchedulesTable.$inferSelect;
export type InsertDeploymentSchedule = typeof deploymentSchedulesTable.$inferInsert;
