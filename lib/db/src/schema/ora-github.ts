import { pgTable, serial, text, integer, timestamp, index } from "drizzle-orm/pg-core";

// ── ora_github_connections ─────────────────────────────────────────────────────
// One GitHub OAuth connection per Ora user. The access token is encrypted at
// rest (AES-256-GCM via the api-server EncryptionService) and is never sent to
// any client. Ora's GitHub access is READ-ONLY at the tool layer: no code path
// that consumes this token may write, commit, push, or mutate a repository.
// This is intentionally separate from the Builder's project-scoped GitHub
// OAuth and from all Orax machinery.

export const oraGithubConnectionsTable = pgTable(
  "ora_github_connections",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    encryptedToken: text("encrypted_token").notNull(),
    githubLogin: text("github_login").notNull(),
    scopes: text("scopes").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("ora_github_connections_user_id_idx").on(t.userId)],
);

// ── ora_repo_sessions ──────────────────────────────────────────────────────────
// A repo the user selected for analysis. The extracted tarball workspace on
// disk is ephemeral (TTL-swept); this row lets the workspace be lazily
// re-materialized after a restart or cleanup. status: active | detached.

export const oraRepoSessionsTable = pgTable(
  "ora_repo_sessions",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    conversationId: text("conversation_id"),
    owner: text("owner").notNull(),
    repo: text("repo").notNull(),
    ref: text("ref").notNull().default(""),
    defaultBranch: text("default_branch").notNull().default("main"),
    branchSha: text("branch_sha"),
    treeSha: text("tree_sha"),
    status: text("status").notNull().default("active"),
    fileCount: integer("file_count"),
    totalBytes: integer("total_bytes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ora_repo_sessions_user_id_idx").on(t.userId),
    index("ora_repo_sessions_user_status_idx").on(t.userId, t.status),
    index("ora_repo_sessions_conversation_idx").on(t.conversationId),
  ],
);

export type OraGithubConnectionRow = typeof oraGithubConnectionsTable.$inferSelect;
export type OraRepoSessionRow = typeof oraRepoSessionsTable.$inferSelect;
