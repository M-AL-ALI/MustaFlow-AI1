import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projectsTable } from "./projects";

export type TestResult = {
  name: string;
  passed: boolean;
  message: string;
  screenshotBase64?: string | null;
  durationMs: number;
};

export type TaskReport = {
  userRequest: string;
  blueprint?: Record<string, unknown> | null;
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
  previewUpdated: boolean;
  warnings: string[];
  suggestions?: string[];
  integrationsNeeded: Array<{
    name: string;
    why: string;
    keysNeeded: string[];
    environment: "test" | "production";
  }>;
  versionId?: number | null;
  nextRecommendation?: string;
  knowledgeApplied?: Array<{ id: number; title: string; category: string }>;
  nativeFeatures?: string[];
  modulesWired?: Array<{ id: string; name: string; secretsConsumed: string[] }>;
  codeSmells?: string[];
  cdnUpgrades?: string[];
  securityNotices?: Array<{
    packageName: string;
    description: string;
    upgradeTo: string;
    severity: "error" | "warning";
    cve?: string;
  }>;
  auditReport?: {
    findings: Array<{
      category: "accessibility" | "seo" | "performance" | "security";
      severity: "error" | "warning" | "info";
      file: string;
      message: string;
      suggestion: string;
    }>;
    scores: Array<{
      category: "accessibility" | "seo" | "performance" | "security";
      label: string;
      pass: number;
      warnings: number;
      failures: number;
      score: number;
    }>;
    auditedAt: string;
    fileCount: number;
  } | null;
  filesUnchanged?: string[];
  checkSummary?: string;
  checkRunsSummary?: {
    passed: number;
    warnings: number;
    failed: number;
    skipped: number;
    failedChecks: string[];
    warnChecks: string[];
  };
  testResults?: TestResult[] | null;
  testScript?: string | null;
  testRanAt?: string | null;
  syntaxValid?: boolean;
  cveAutoProtect?: {
    findingId: number;
    packageName: string;
    cveId: string | null;
    severity: string;
    patchReady: boolean;
    typecheckPassed: boolean | null;
  } | null;
  summary?: string;
  autoFixSummary?: {
    filesScanned: number;
    filesFixed: number;
    fixedCount: number;
    remainingCount: number;
  } | null;
  /** Populated when a Power/Pro critique pass runs after the build */
  critiquePass?: {
    /** Human-readable list of issues the critique identified */
    issuesFound: string[];
    /** True if the critique returned patched files that were applied */
    autoFixed: boolean;
  } | null;
  /**
   * Structured record of the structural/per-file validation cycle.
   * Populated for every build or refine that triggered validation.
   */
  /**
   * Downloadable assets the agent explicitly presented to the user via the
   * `present_asset` tool. Rendered as inline asset cards in the chat with
   * direct-download links to the preview/raw file route.
   */
  assets?: Array<{
    path: string;
    name: string;
    sizeBytes: number;
    mimeType: string;
    description?: string;
  }>;
  validationReport?: {
    /** Critical errors found in the initial pass (before any fix-up) */
    initialIssues: string[];
    /** True if a correction pass was attempted */
    fixupAttempted: boolean;
    /** Critical errors still present after the correction pass (empty = all fixed) */
    remainingIssues: string[];
    /** True when no critical errors remain in the final output */
    passed: boolean;
  } | null;
  /**
   * Populated when the agentic builder loop (tool-calling) handled the task.
   * Captures every tool call, command run, and check result for the run report
   * card. Absent for legacy single-shot builds.
   */
  /**
   * Populated when the architect review subagent runs after a successful
   * build/refine. The architect is a second-opinion deep-review pass that
   * inspects the user request + plan + diff + commands and returns a structured
   * verdict + severity-ranked findings. Critical/fail verdicts trigger one
   * auto-fix turn (a follow-up refine task with the findings as the prompt).
   */
  architectReview?: {
    /** Overall verdict from the architect */
    verdict: "pass" | "partial" | "fail";
    /** One-line architect summary shown next to the verdict badge */
    summary: string;
    /** Severity-ranked findings (critical first) */
    findings: Array<{
      severity: "critical" | "high" | "medium" | "low";
      title: string;
      detail: string;
      file?: string | null;
    }>;
    /** Concrete next actions the architect recommends */
    nextActions: string[];
    /** True if a follow-up auto-fix task was queued in response */
    autoFixQueued: boolean;
    /** Follow-up task id (when autoFixQueued is true) */
    autoFixTaskId?: number | null;
    /** Credits actually charged for this architect review (0 if skipped) */
    creditsCharged: number;
    /** ISO timestamp when the review completed */
    reviewedAt: string;
    /** Model used for the architect call */
    model: string;
    /** True if the review was skipped (e.g. project disabled, no diff, insufficient credits) */
    skipped?: boolean;
    /** Human-readable skip reason when skipped is true */
    skipReason?: string;
    /** True when this review was the second pass after an architect-triggered auto-fix */
    isReReview?: boolean;
    /** True when re-review still reported critical/fail — surfaced as a warning, no further fixes */
    completedWithWarnings?: boolean;
  } | null;
  agentLoop?: {
    stack: string;
    steps: number;
    totalToolCalls: number;
    totalTokens: number;
    terminationReason: string;
    toolCalls: Array<{
      step: number;
      tool: string;
      args: Record<string, unknown>;
      ok: boolean;
      durationMs: number;
      preview: string;
    }>;
    commandsRun: Array<{
      step: number;
      argv: string[];
      exitCode: number;
      durationMs: number;
      stdoutPreview: string;
      stderrPreview: string;
    }>;
    checkResults: Array<{
      id: string;
      label: string;
      passed: boolean;
      durationMs: number;
      message: string;
    }>;
    /**
     * Per-task skills loaded during this build (Task #506). Empty array when
     * the model did not invoke `load_skill`. Each entry is a skill name from
     * the registry.
     */
    skillsLoaded?: string[];
    e2eResults?: E2eRunSummary | null;
    /**
     * Per-task "Agent Senses" usage counters (Task #529). Tracks how many
     * times the agent invoked each sense tool. Drives post-loop credit
     * accounting (1 credit per 5 web sense calls) and admin reporting.
     */
    senseCalls?: {
      screenshot: number;
      webFetch: number;
      webSearch: number;
      branding: number;
      diagnostics: number;
    };
    /**
     * Per-task "Agent Creative Pack" usage counters (Task #530). Tracks how
     * many times the agent invoked each media-generation tool. Each
     * successful call is metered as one `credit_transactions.type="creative"`
     * row (image=1, video=3, audio=2, bgRemoval=1).
     */
    creativeCalls?: {
      image: number;
      video: number;
      audio: number;
      bgRemoval: number;
    };
  } | null;
  /**
   * Populated when Playwright end-to-end scenarios ran against the live preview
   * (either via the agentic builder's `run_e2e` tool, the auto-smoke pass after
   * a successful build, or a user-triggered re-run).
   */
  e2eResults?: E2eRunSummary | null;
};

/**
 * One Playwright scenario execution.
 * `screenshotBase64` is a thumbnail captured on failure only (~PNG, capped at
 * roughly 200KB per scenario; total per task budget is 5 MB).
 */
export type E2eScenarioResult = {
  name: string;
  /** "smoke" = built-in scenario; "user" = discovered from tests/e2e/*.spec.ts. */
  source: "smoke" | "user";
  passed: boolean;
  durationMs: number;
  message: string;
  consoleErrors: string[];
  networkFailures: Array<{ url: string; status: number | null; message: string }>;
  screenshotBase64?: string | null;
};

export type E2eRunSummary = {
  targetUrl: string | null;
  ranAt: string;
  totalDurationMs: number;
  passed: number;
  failed: number;
  skipped: number;
  /** Reason the run was skipped (no preview URL, disabled, etc.). */
  skippedReason?: string | null;
  /** True when a budget cap (60s / 10 scenarios / 5MB screenshots) trimmed the run. */
  budgetExceeded: boolean;
  scenarios: E2eScenarioResult[];
  /** True if an auto-fix turn was attempted after this run. */
  autoFixAttempted: boolean;
};

export const agentTasksTable = pgTable(
  "agent_tasks",
  {
    id: serial("id").primaryKey(),
    projectId: integer("project_id")
      .notNull()
      .references(() => projectsTable.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    kind: text("kind").notNull().default("main"),
    status: text("status").notNull().default("queued"),
    // agentIdentity: which of the three agents handled this task.
    // "planning" = Planning Agent (plan mode), "task" = Task Agent (staging gate),
    // "main" = Main Agent (direct fast edit). Default "main" for backward compat.
    agentIdentity: text("agent_identity").notNull().default("main"),
    // stagingSnapshot: Task Agent stores generated files here before the user
    // approves. Null for Main Agent (files are written directly). Promoted to
    // project_files on Apply; discarded on Discard.
    stagingSnapshot:
      jsonb("staging_snapshot").$type<Array<{ path: string; content: string; mimeType: string }>>(),
    prompt: text("prompt"),
    // Image attachments uploaded with the prompt that created this task. Persisted
    // here so queued tasks (status="queued") can hand their images off to the
    // builder pipelines when the queue eventually drains. Stored as object-storage
    // refs (url + alt), not data URIs, to keep rows small.
    attachments: jsonb("attachments").$type<Array<{ url: string; alt?: string }>>(),
    result: text("result"),
    report: jsonb("report").$type<TaskReport>(),
    userFeedback: text("user_feedback"),
    queueBatchId: text("queue_batch_id"),
    queueIndex: integer("queue_index"),
    // Task #509 — long-running background workflows.
    // "foreground" = blocks the chat HTTP request until it returns.
    // "background" = enqueued via setImmediate; the chat unblocks immediately;
    // the user reviews/applies/discards the result from a global panel.
    runMode: text("run_mode").notNull().default("foreground"),
    // Per-mode wall-clock cap (ms). Overrides the default AGENTIC_BUILDER_WALL_CLOCK_MS
    // for this specific job. Background jobs may run up to 30 min.
    wallClockCapMs: integer("wall_clock_cap_ms"),
    // Credits reserved at enqueue for a background job. Held until apply (finalises),
    // discard/cancel (refund), or terminal failure (refund).
    creditsReserved: integer("credits_reserved"),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    index("agent_tasks_project_id_created_at_idx").on(table.projectId, table.createdAt),
    index("agent_tasks_queue_batch_id_idx").on(table.queueBatchId),
    // Partial unique index: prevents more than one active background auto-fix task
    // with the same title from being queued for the same project simultaneously.
    // Rows that have transitioned to done/failed/canceled fall outside the index,
    // so a new auto-fix can be enqueued once the previous one has resolved.
    uniqueIndex("agent_tasks_active_background_title_idx")
      .on(table.projectId, table.title)
      .where(sql`kind = 'background' AND status IN ('queued', 'building', 'planning')`),
  ],
);

export type AgentTask = typeof agentTasksTable.$inferSelect;
export type InsertAgentTask = typeof agentTasksTable.$inferInsert;
