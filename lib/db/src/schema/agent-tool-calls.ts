import { pgTable, serial, integer, text, boolean, timestamp, index } from "drizzle-orm/pg-core";
import { projectsTable } from "./projects";

/**
 * Comprehensive per-tool-call audit log for the agentic builder loop.
 *
 * Records EVERY tool call the agent makes (read_file, write_file, run_command,
 * pkg_install, run_e2e, list_files, search, etc.) so admins and users can
 * review agent behaviour, and so the per-project hourly rate limiter can
 * count recent calls without a separate counter table.
 *
 * This is intentionally broader than the existing tool_audit table, which only
 * captures run_command and pkg_install. The two tables coexist: tool_audit
 * retains the detailed blocked/policy fields for command-execution auditing;
 * agent_tool_calls provides the full picture for rate limiting and the UI
 * "Agent Audit" sub-tab in the Logs view.
 */
export const agentToolCallsTable = pgTable(
  "agent_tool_calls",
  {
    id: serial("id").primaryKey(),
    /** Owning project (cascade-delete with project). */
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    /** Owning task (agent_tasks.id). Nullable for system-initiated calls. */
    taskId: integer("task_id"),
    /** Tool name: read_file, write_file, run_command, pkg_install, run_e2e, etc. */
    toolName: text("tool_name").notNull(),
    /**
     * Truncated JSON summary of the tool arguments (first 500 chars).
     * Secret values are redacted before storage (the redactArgs helper is used
     * in the loop before recording).
     */
    argsSummary: text("args_summary"),
    /**
     * First 400 chars of the observation returned to the model (stdout/stderr,
     * file content preview, command output, etc.).
     */
    stdoutPreview: text("stdout_preview"),
    /**
     * Process exit code. Only meaningful for run_command / pkg_install / run_e2e.
     * Null for informational tools (read_file, list_files, etc.).
     */
    exitCode: integer("exit_code"),
    /** True when the tool call returned ok=true. */
    ok: boolean("ok").notNull().default(true),
    /** Wall-clock duration of the tool call in milliseconds. */
    durationMs: integer("duration_ms").notNull().default(0),
    /** When the call completed (used for rate-limit window queries). */
    calledAt: timestamp("called_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_tool_calls_project_called_idx").on(t.projectId, t.calledAt),
    index("agent_tool_calls_task_idx").on(t.taskId),
  ],
);

export type AgentToolCallRow = typeof agentToolCallsTable.$inferSelect;
export type InsertAgentToolCallRow = typeof agentToolCallsTable.$inferInsert;
