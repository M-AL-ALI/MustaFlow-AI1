import { pgTable, serial, integer, text, timestamp } from "drizzle-orm/pg-core";

export const projectGithubConnectionsTable = pgTable("project_github_connections", {
  id: serial("id").primaryKey(),
  projectId: integer("project_id").notNull(),
  ownerId: text("owner_id").notNull(),
  githubAccountName: text("github_account_name").notNull(),
  repositoryOwner: text("repository_owner"),
  repositoryName: text("repository_name"),
  defaultBranch: text("default_branch").notNull().default("main"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  syncStatus: text("sync_status").notNull().default("idle"),
  encryptedToken: text("encrypted_token").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
