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
import { projectsTable } from "./projects";

/**
 * Per-tool-call audit log for the agentic builder loop.
 *
 * Captures every `run_command` and `pkg_install` invocation (including blocked
 * ones) so admins can review what the agent has been asked to do.
 *
 * `blocked=true` rows are policy violations: the command never ran, but we
 * record them so the admin dashboard can surface noisy projects.
 */
export const toolAuditTable = pgTable(
  "tool_audit",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /** Owning task (agent_tasks.id). Nullable for system-initiated audits. */
    taskId: integer("task_id"),
    /** Tool name: "run_command" | "pkg_install". */
    toolName: text("tool_name").notNull(),
    /** Stack id at the time of the call (e.g. "react-vite"). */
    stack: text("stack"),
    /** Argv that was attempted (or synthesized for pkg_install). */
    argv: jsonb("argv").$type<string[]>().notNull(),
    /** Process exit code. 126 by convention when blocked, 124 on timeout. */
    exitCode: integer("exit_code"),
    /** Last ~400 chars of stdout. */
    stdoutTail: text("stdout_tail"),
    /** Last ~400 chars of stderr. */
    stderrTail: text("stderr_tail"),
    /** Wall-clock duration in ms. 0 when blocked. */
    durationMs: integer("duration_ms").notNull().default(0),
    /** True when the policy refused to run the command. */
    blocked: boolean("blocked").notNull().default(false),
    /** Human-readable block reason ("blocked pattern: rm -rf /", etc.). Null when not blocked. */
    blockReason: text("block_reason"),
    /** Policy strictness in effect (safe|standard|permissive). */
    policyStrictness: text("policy_strictness").notNull().default("standard"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectIdx: index("tool_audit_project_idx").on(t.projectId, t.createdAt),
    blockedIdx: index("tool_audit_blocked_idx").on(t.blocked, t.createdAt),
  }),
);

export type ToolAuditRow = typeof toolAuditTable.$inferSelect;
export type InsertToolAuditRow = typeof toolAuditTable.$inferInsert;
