import {
  pgTable,
  serial,
  integer,
  boolean,
  text,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { projectsTable } from "./projects";
import { zeroIntentReceiptsTable } from "./zero-intent-receipts";
import type { ZERO_TERMINAL_SEMANTICS, ZeroTerminalV1 } from "@workspace/ora-contracts";

export type TestResult = {
  name: string;
  passed: boolean;
  message: string;
  screenshotBase64?: string | null;
  durationMs: number;
};

export type AgentTaskCompletionKind =
  | "finalized"
  | "step_cap"
  | "wall_clock"
  | "repeated_error"
  | "model_stopped"
  | "aborted"
  | "checks_failed"
  | "check_blocked"
  | "rate_limited"
  | "admission_blocked"
  | "admission_unavailable"
  | "container_unavailable";

export type TaskReport = {
  /** Canonical terminal receipt; projections resolve the terminal from the task row. */
  terminalRef?: {
    kind: "zero_terminal";
    schema: typeof ZERO_TERMINAL_SEMANTICS;
    taskId: number;
  };
  userRequest: string;
  blueprint?: Record<string, unknown> | null;
  filesCreated: string[];
  filesChanged: string[];
  filesRemoved: string[];
  previewUpdated: boolean;
  /**
   * Set when the preview sync was queued successfully (static projects).
   * Distinguishes "queued but not yet visible" from "already visible".
   */
  previewSyncQueued?: boolean;
  /**
   * Set when the preview could not be synced (e.g. container not reachable).
   * The build itself succeeded; only the live preview update failed.
   */
  previewSyncFailed?: boolean;
  warnings: string[];
  /** Sanitized typed evidence for a terminal platform failure. */
  failureEvidence?: {
    code: string;
    message: string;
    evidence: Readonly<Record<string, unknown>> | null;
  };
  /** Non-required checks that failed. Present when versionValidationStatus=passed_with_warnings. */
  warningChecks?: Array<{ id: string; label: string; message: string }>;
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
  /**
   * Structured record of a SAST or npm-audit gate that blocked an Apply.
   * Populated by applyTaskAgentStaging when the gate fails so the UI can render
   * an expandable list of findings instead of just a plain error string.
   */
  securityFindings?: {
    kind: "sast" | "npm_audit";
    blocked: boolean;
    message: string;
    fixPrompt?: string;
    sast?: Array<{
      file: string;
      line: number | null;
      message: string;
      detail?: string | null;
      severity: "error" | "warning" | "info";
      remediation?: string | null;
    }>;
    npmAudit?: {
      critical: number;
      high: number;
      parsed: boolean;
      packages: Array<{ name: string; severity: string }>;
      remediation?: string | null;
    };
  } | null;
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
    /** True when the critique call itself failed (timeout, API error, context overflow) */
    critiqueFailed?: boolean;
    /** Human-readable reason the critique failed, if it failed */
    critiqueFailureReason?: string;
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
    /** Effective cap for this run (may be lower for a bounded self-heal pass). */
    stepCap?: number;
    wallClockElapsedMs?: number;
    wallClockBudgetMs?: number;
    totalToolCalls: number;
    totalTokens: number;
    terminationReason: string;
    completionKind: AgentTaskCompletionKind;
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
  /**
   * Result of the autonomous headless-browser QA pass that runs BEFORE the
   * "completed" event so steps are streamed while the EventSource is open.
   * Populated for static-html and react-vite builds only.
   */
  qaResult?: {
    passed: boolean;
    errors: string[];
    stepsRun: number;
    timedOut?: boolean;
    ranAt?: string;
  } | null;
  /**
   * One-shot post-boot runtime repair. `attempted` can only be true once per
   * task; verification never starts another repair cycle.
   */
  previewSelfHeal?: {
    detectedIssues: Array<{
      kind: string;
      source: string;
      message: string;
    }>;
    attempted: boolean;
    repaired: boolean;
    filesChanged: string[];
    stepsUsed: number;
    stepBudget: number;
    wallClockBudgetMs: number;
    remainingIssues: Array<{
      kind: string;
      source: string;
      message: string;
    }>;
    skippedReason?: "disabled" | "no_budget" | "no_agent_loop" | null;
  } | null;
  /**
   * Result of the mandatory quality gate that runs after the agent loop
   * writes its staging snapshot (TypeScript, ESLint, server startup smoke test).
   * Only populated for container-based JS/TS stacks.
   */
  qualityGate?: {
    /** True when all executed checks passed (skipped checks don't count). */
    passed: boolean;
    /** True only when every applicable check ran AND passed — no skips, no failures. */
    allPassed: boolean;
    checks: Array<{
      id: string;
      label: string;
      passed: boolean;
      /** True when the check's binary was not found — not a failure, not a pass. */
      skipped: boolean;
      skipReason?: string;
      output: string;
      durationMs: number;
    }>;
  } | null;
  /**
   * Environment variables referenced via `process.env.FOO` in the generated
   * JS/TS files that are not declared in the project's secrets list.
   * Each entry names the variable and the first file where it was found.
   */
  undeclaredEnvVars?: Array<{ varName: string; file: string }> | null;
  /**
   * True when all quality gate checks passed AND the architect review found
   * no critical issues. Used to display the "All checks passed" banner in
   * the staging review card.
   */
  allChecksPassed?: boolean | null;
  /**
   * Populated when the agentic repair loop (Phase 2A) attempted to fix TypeScript
   * errors after a check-failed build/refine. Null when not triggered.
   */
  repairLoop?: {
    attempts: Array<{
      attempt: number;
      succeeded: boolean;
      filesChanged: string[];
    }>;
    totalAttempts: number;
    maxAttempts: number;
    /** "passed" = all errors fixed before the limit; "exhausted" = gave up. */
    finalStatus: "passed" | "exhausted";
  } | null;
  /**
   * True when the task completed but the TypeScript repair loop was exhausted —
   * the snapshot was saved with remaining validation errors. UI shows amber warning.
   */
  completedWithErrors?: boolean | null;
  /**
   * Lightweight pre-review checks that run server-side on the staging snapshot
   * before the task reaches "needs_review". Checks JSON syntax, relative import
   * resolution, and E2E spec presence. Does not require a container.
   */
  preReviewChecks?: {
    checks: Array<{
      id: string;
      label: string;
      passed: boolean;
      skipped: boolean;
      errorCount: number;
      errors: string[];
      durationMs: number;
    }>;
    allPassed: boolean;
    anyFailed: boolean;
    ranAt: string;
  } | null;
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
    // First-class agent-loop outcome. Nullable for legacy rows and non-agentic
    // tasks; null means unknown and must never be interpreted as finalized.
    completionKind: text("completion_kind").$type<AgentTaskCompletionKind>(),
    // Durable terminal truth. Nullable for every pre-B3 writer and historical
    // row; readers must preserve their legacy behavior until a typed terminal
    // exists, and must parse a present value before trusting it.
    terminal: jsonb("terminal").$type<ZeroTerminalV1>(),
    // agentIdentity: visible executor for this task.
    // "planning" = Planner, "main" = Main Agent. "task" is retained only for
    // legacy staging rows so old apply/discard flows remain readable.
    agentIdentity: text("agent_identity").notNull().default("main"),
    // origin: source surface that created the task. Mirrors chat_messages.origin
    // so queued/background task reports can be written back to the same thread.
    origin: text("origin"),
    intentReceiptId: integer("intent_receipt_id").references(() => zeroIntentReceiptsTable.id, {
      onDelete: "set null",
    }),
    // stagingSnapshot: legacy staged files awaiting user approval. Null for
    // Main Agent rows because files are written directly to project_files.
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
    // Agent mode frozen at task-creation time so queued tasks always execute at the
    // mode the user intended, even if project.agentMode changes before the task drains.
    // Nullable: NULL means "read from project.agentMode at execution time" (legacy rows).
    taskAgentMode: text("task_agent_mode"),
    deepReasoning: boolean("deep_reasoning").notNull().default(false),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    discardedAt: timestamp("discarded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    // Total LLM tokens consumed by this task (prompt + completion across all AI calls).
    // Accumulated from streaming deltas in emitTokenEvent; written on task completion.
    // Null for tasks completed before Task #806 migration.
    tokenCount: integer("token_count"),
    hasBrainstormContext: boolean("has_brainstorm_context").notNull().default(false),
    brainstormTurnCount: integer("brainstorm_turn_count"),
    // Developer-mode runtime tracking (Task #1182)
    // Updated by the agent loop every ~30 s to detect stuck runs.
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }),
    // Human-readable failure reason written on terminal failure so the frontend
    // can surface it without parsing the full task report.
    failureReason: text("failure_reason"),
    // Current tool step — updated at every tool dispatch so stuck-run detection
    // can distinguish a genuinely stuck build from one that is just slow.
    currentStep: integer("current_step"),
  },
  (table) => [
    index("agent_tasks_project_id_created_at_idx").on(table.projectId, table.createdAt),
    index("agent_tasks_queue_batch_id_idx").on(table.queueBatchId),
    index("agent_tasks_run_mode_status_idx").on(table.runMode, table.status),
    index("agent_tasks_intent_receipt_id_idx").on(table.intentReceiptId),
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
