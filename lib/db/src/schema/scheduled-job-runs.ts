import { pgTable, serial, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { deploymentSchedulesTable } from "./deployment-schedules";
import { projectsTable } from "./projects";

export const JOB_RUN_STATUSES = ["running", "success", "failed", "timed_out"] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

export const scheduledJobRunsTable = pgTable(
  "scheduled_job_runs",
  {
    id: serial("id").primaryKey(),
    scheduleId: integer("schedule_id")
      .notNull()
      .references(() => deploymentSchedulesTable.id, { onDelete: "cascade" }),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("running"),
    exitCode: integer("exit_code"),
    output: text("output"),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    triggeredBy: text("triggered_by").notNull().default("cron"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("scheduled_job_runs_schedule_idx").on(t.scheduleId),
    index("scheduled_job_runs_project_idx").on(t.projectId),
    index("scheduled_job_runs_started_idx").on(t.startedAt),
  ],
);

export type ScheduledJobRun = typeof scheduledJobRunsTable.$inferSelect;
export type InsertScheduledJobRun = typeof scheduledJobRunsTable.$inferInsert;
