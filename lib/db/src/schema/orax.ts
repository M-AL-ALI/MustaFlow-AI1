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

export const ORAX_APPROVAL_ACTIONS = ["read_files"] as const;
export type OraxApprovalAction = (typeof ORAX_APPROVAL_ACTIONS)[number];

export const ORAX_APPROVAL_STATUSES = [
  "pending",
  "approved",
  "denied",
  "completed",
  "failed",
] as const;
export type OraxApprovalStatus = (typeof ORAX_APPROVAL_STATUSES)[number];

/**
 * ORAX repositories are user-scoped code targets. Provider tokens are stored
 * encrypted and are only used for read-only metadata/tree scans until the
 * approval-gated execution layer is implemented.
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
    githubAccountName: text("github_account_name"),
    tokenScopes: text("token_scopes"),
    encryptedToken: text("encrypted_token"),
    connectedAt: timestamp("connected_at", { withTimezone: true }),
    lastScanAt: timestamp("last_scan_at", { withTimezone: true }),
    scanStatus: text("scan_status").notNull().default("idle"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    index("orax_repositories_user_id_idx").on(t.userId),
    index("orax_repositories_provider_idx").on(t.provider, t.owner, t.name),
  ],
);

export const oraxRepositoryScansTable = pgTable(
  "orax_repository_scans",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    repositoryId: integer("repository_id").notNull(),
    status: text("status").notNull().default("completed"),
    branch: text("branch").notNull(),
    commitSha: text("commit_sha"),
    fileCount: integer("file_count").notNull().default(0),
    directoryCount: integer("directory_count").notNull().default(0),
    totalBytes: integer("total_bytes").notNull().default(0),
    summary: jsonb("summary").notNull().default({}),
    error: text("error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("orax_repository_scans_user_id_idx").on(t.userId, t.createdAt),
    index("orax_repository_scans_repository_id_idx").on(t.repositoryId, t.createdAt),
  ],
);

export const oraxTaskApprovalsTable = pgTable(
  "orax_task_approvals",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    repositoryId: integer("repository_id").notNull(),
    taskId: integer("task_id").notNull(),
    action: text("action").notNull().default("read_files"),
    status: text("status").notNull().default("pending"),
    request: jsonb("request").notNull().default({}),
    result: jsonb("result").notNull().default({}),
    riskSummary: text("risk_summary"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (t) => [
    index("orax_task_approvals_user_id_idx").on(t.userId, t.createdAt),
    index("orax_task_approvals_task_id_idx").on(t.taskId, t.createdAt),
    index("orax_task_approvals_status_idx").on(t.status),
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
export type OraxRepositoryScan = typeof oraxRepositoryScansTable.$inferSelect;
export type InsertOraxRepositoryScan = typeof oraxRepositoryScansTable.$inferInsert;
export type OraxTaskApproval = typeof oraxTaskApprovalsTable.$inferSelect;
export type InsertOraxTaskApproval = typeof oraxTaskApprovalsTable.$inferInsert;
export type OraxTask = typeof oraxTasksTable.$inferSelect;
export type InsertOraxTask = typeof oraxTasksTable.$inferInsert;
