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
