import {
  pgTable,
  serial,
  integer,
  text,
  jsonb,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
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
};

export const agentTasksTable = pgTable("agent_tasks", {
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
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
}, (table) => [
  index("agent_tasks_project_id_created_at_idx").on(table.projectId, table.createdAt),
  index("agent_tasks_queue_batch_id_idx").on(table.queueBatchId),
]);

export type AgentTask = typeof agentTasksTable.$inferSelect;
export type InsertAgentTask = typeof agentTasksTable.$inferInsert;
