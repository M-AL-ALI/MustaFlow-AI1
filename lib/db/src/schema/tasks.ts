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
  knowledgeApplied?: Array<{ title: string; category: string }>;
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
    prompt: text("prompt"),
    result: text("result"),
    report: jsonb("report").$type<TaskReport>(),
    userFeedback: text("user_feedback"),
    queueBatchId: text("queue_batch_id"),
    queueIndex: integer("queue_index"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
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
