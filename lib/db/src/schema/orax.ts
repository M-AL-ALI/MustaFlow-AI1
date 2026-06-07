import { pgTable, serial, integer, text, jsonb, timestamp, index } from "drizzle-orm/pg-core";

export const ORAX_PROVIDERS = ["github", "gitlab", "bitbucket", "azure-devops", "other"] as const;
export type OraxProvider = (typeof ORAX_PROVIDERS)[number];

export const ORAX_TASK_KINDS = ["analyze", "plan", "review", "fix"] as const;
export type OraxTaskKind = (typeof ORAX_TASK_KINDS)[number];

export const ORAX_TASK_STATUSES = [
  "planned",
  "awaiting_approval",
  "running",
  "completed",
  "blocked",
  "failed",
] as const;
export type OraxTaskStatus = (typeof ORAX_TASK_STATUSES)[number];

/**
 * ORAX repositories are user-scoped code targets. Phase 1 stores metadata only:
 * no personal access token, installation secret, or webhook secret is persisted
 * here. Provider auth will be added behind explicit approval gates.
 */
export const oraxRepositoriesTable = pgTable(
  "orax_repositories",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    provider: text("provider").notNull().default("github"),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    repositoryUrl: text("repository_url").notNull(),
    defaultBranch: text("default_branch").notNull().default("main"),
    connectionStatus: text("connection_status").notNull().default("metadata_only"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("orax_repositories_user_id_idx").on(t.userId),
    index("orax_repositories_provider_idx").on(t.provider, t.owner, t.name),
  ],
);

/**
 * ORAX tasks are isolated from Ora conversations and AI Builder tasks. They
 * record coding-agent intent, plans, results, and future approval/checkpoint
 * history without leaking into either product surface.
 */
export const oraxTasksTable = pgTable(
  "orax_tasks",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    repositoryId: integer("repository_id").notNull(),
    kind: text("kind").notNull().default("analyze"),
    status: text("status").notNull().default("planned"),
    title: text("title").notNull(),
    prompt: text("prompt").notNull(),
    plan: jsonb("plan").notNull().default({}),
    result: jsonb("result").notNull().default({}),
    approvalRequired: text("approval_required").notNull().default("write_and_push"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("orax_tasks_user_id_idx").on(t.userId, t.createdAt),
    index("orax_tasks_repository_id_idx").on(t.repositoryId),
    index("orax_tasks_status_idx").on(t.status),
  ],
);

export type OraxRepository = typeof oraxRepositoriesTable.$inferSelect;
export type InsertOraxRepository = typeof oraxRepositoriesTable.$inferInsert;
export type OraxTask = typeof oraxTasksTable.$inferSelect;
export type InsertOraxTask = typeof oraxTasksTable.$inferInsert;
