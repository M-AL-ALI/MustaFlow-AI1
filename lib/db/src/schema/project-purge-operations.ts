import type { ProjectPurgeTerminalEvidence } from "@workspace/ora-contracts";
import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

/**
 * Durable, privacy-minimal deletion receipt. `projectId` intentionally has no
 * foreign key: the receipt must survive removal of the project row it proves.
 */
export const projectPurgeOperationsTable = pgTable(
  "project_purge_operations",
  {
    id: text("id").primaryKey(),
    projectId: integer("project_id").notNull(),
    retirementOperationIdHash: text("retirement_operation_id_hash").notNull(),
    trigger: text("trigger").notNull(),
    state: text("state").notNull().default("scheduled"),
    stage: text("stage").notNull().default("verify"),
    idempotencyKeyHash: text("idempotency_key_hash").notNull(),
    requestedByHash: text("requested_by_hash"),
    attemptCount: integer("attempt_count").notNull().default(0),
    leaseVersion: integer("lease_version").notNull().default(0),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    dueAt: timestamp("due_at", { withTimezone: true })
      .notNull()
      .default(sql`now() + interval '30 days'`),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    failureCode: text("failure_code"),
    failureRetryable: boolean("failure_retryable"),
    resourceProgress: jsonb("resource_progress")
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    terminalEvidence: jsonb("terminal_evidence").$type<ProjectPurgeTerminalEvidence | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    terminalAt: timestamp("terminal_at", { withTimezone: true }),
  },
  (table) => [
    check("project_purge_operations_trigger_check", sql`${table.trigger} IN ('manual','expiry')`),
    check(
      "project_purge_operations_state_check",
      sql`${table.state} IN ('scheduled','accepted','running','failed','completed','canceled')`,
    ),
    check(
      "project_purge_operations_stage_check",
      sql`${table.stage} IN ('verify','inventory','assets','snapshots','database','addons','runtime','relational','absence')`,
    ),
    check(
      "project_purge_operations_failure_code_check",
      sql`${table.failureCode} IS NULL OR ${table.failureCode} IN (
        'project_purge_owner_required',
        'project_purge_reverification_required',
        'project_purge_name_mismatch',
        'project_purge_project_active',
        'project_purge_retirement_incomplete',
        'project_purge_operation_conflict',
        'project_purge_inventory_unavailable',
        'project_purge_asset_release_failed',
        'project_purge_snapshot_release_failed',
        'project_purge_database_release_failed',
        'project_purge_addon_release_failed',
        'project_purge_runtime_release_failed',
        'project_purge_relational_delete_failed',
        'project_purge_absence_unverified',
        'project_purge_attempts_exhausted',
        'project_purge_operation_unavailable'
      )`,
    ),
    check("project_purge_operations_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("project_purge_operations_lease_version_check", sql`${table.leaseVersion} >= 0`),
    check(
      "project_purge_operations_hashes_check",
      sql`${table.retirementOperationIdHash} ~ '^[0-9a-f]{64}$'
        AND ${table.idempotencyKeyHash} ~ '^[0-9a-f]{64}$'
        AND (${table.requestedByHash} IS NULL OR ${table.requestedByHash} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      "project_purge_operations_requester_check",
      sql`${table.trigger} = 'expiry' OR ${table.requestedByHash} IS NOT NULL`,
    ),
    check(
      "project_purge_operations_terminal_check",
      sql`(
        ${table.state} IN ('scheduled','accepted','running')
        AND ${table.failureCode} IS NULL
        AND ${table.failureRetryable} IS NULL
        AND ${table.terminalEvidence} IS NULL
        AND ${table.terminalAt} IS NULL
      ) OR (
        ${table.state} = 'failed'
        AND ${table.failureCode} IS NOT NULL
        AND ${table.failureRetryable} IS NOT NULL
        AND ${table.terminalEvidence} IS NOT NULL
        AND ${table.terminalAt} IS NOT NULL
      ) OR (
        ${table.state} IN ('completed','canceled')
        AND ${table.failureCode} IS NULL
        AND ${table.failureRetryable} IS NULL
        AND ${table.terminalEvidence} IS NOT NULL
        AND ${table.terminalAt} IS NOT NULL
      )`,
    ),
    index("project_purge_operations_project_idx").on(table.projectId, table.createdAt),
    index("project_purge_operations_due_idx").on(table.state, table.dueAt, table.nextAttemptAt),
    uniqueIndex("project_purge_operations_idempotency_uq").on(table.idempotencyKeyHash),
    uniqueIndex("project_purge_operations_retirement_uq").on(
      table.projectId,
      table.retirementOperationIdHash,
    ),
    uniqueIndex("project_purge_operations_active_project_uq")
      .on(table.projectId)
      .where(sql`state IN ('scheduled','accepted','running','failed')`),
  ],
);

export type ProjectPurgeOperation = typeof projectPurgeOperationsTable.$inferSelect;
export type InsertProjectPurgeOperation = typeof projectPurgeOperationsTable.$inferInsert;
