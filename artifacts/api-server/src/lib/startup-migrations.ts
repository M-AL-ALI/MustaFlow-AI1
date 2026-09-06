/**
 * Startup migration runner — Task #859
 *
 * Runs all outstanding schema migrations inline at server startup using the
 * shared DB pool. No subprocess spawning, no `pool.end()`.
 *
 * Every SQL statement uses IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so the
 * entire runner is idempotent and safe to execute on every boot.
 *
 * Migrations run in the same dependency order as migrate-all-outstanding.ts.
 * Each step is isolated in its own try/catch so a single failure never
 * prevents subsequent migrations from running.
 */

import { pool } from "@workspace/db";
import { ensureProductionDatabaseAdmissionSchema } from "./production-database-admission-schema";
import { logger } from "./logger";
import { encryptionService, isEncryptedValue, type EncryptionService } from "./encryption";
import { assessDeploymentRuntimeSchema } from "./deployment-runtime-schema";

type MigrationStep = {
  name: string;
  run: (client: import("pg").PoolClient) => Promise<void>;
};

type MigrationClient = Pick<import("pg").PoolClient, "query">;

type RetirementColumnState = {
  column_name: string;
  data_type: string;
  is_nullable: "YES" | "NO";
  column_default: string | null;
};

type RetirementConstraintState = {
  constraint_name: string;
  constraint_type: "c" | "f" | "p";
  definition: string;
};

type RetirementIndexState = {
  index_name: string;
  index_definition: string;
};

const RETIREMENT_PROGRESS_REPAIR_SQL = `'{
  "route":{"state":"pending","failureCode":null,"hostnames":[],"cache":{"state":"pending"}},
  "tasks":{"state":"pending","count":0,"terminalized":0,"creditsRefunded":0,"telemetryFlushed":0},
  "domains":[],"retainedLegacyRuntimePointers":[],"runtimes":[]
}'::jsonb`;

const RETIREMENT_COLUMNS = [
  { name: "id", type: "TEXT", dataType: "text", required: true, defaultSql: null },
  {
    name: "project_id",
    type: "INTEGER",
    dataType: "integer",
    required: true,
    defaultSql: null,
  },
  {
    name: "requested_by",
    type: "TEXT",
    dataType: "text",
    required: true,
    defaultSql: null,
  },
  {
    name: "state",
    type: "TEXT",
    dataType: "text",
    required: true,
    defaultSql: "'accepted'",
  },
  {
    name: "attempt_count",
    type: "INTEGER",
    dataType: "integer",
    required: true,
    defaultSql: "0",
  },
  {
    name: "lease_version",
    type: "INTEGER",
    dataType: "integer",
    required: true,
    defaultSql: "0",
  },
  {
    name: "lease_expires_at",
    type: "TIMESTAMPTZ",
    dataType: "timestamp with time zone",
    required: false,
    defaultSql: null,
  },
  {
    name: "progress",
    type: "JSONB",
    dataType: "jsonb",
    required: true,
    defaultSql: null,
  },
  {
    name: "failure_code",
    type: "TEXT",
    dataType: "text",
    required: false,
    defaultSql: null,
  },
  {
    name: "failure_target",
    type: "JSONB",
    dataType: "jsonb",
    required: false,
    defaultSql: null,
  },
  {
    name: "created_at",
    type: "TIMESTAMPTZ",
    dataType: "timestamp with time zone",
    required: true,
    defaultSql: "NOW()",
  },
  {
    name: "started_at",
    type: "TIMESTAMPTZ",
    dataType: "timestamp with time zone",
    required: false,
    defaultSql: null,
  },
  {
    name: "completed_at",
    type: "TIMESTAMPTZ",
    dataType: "timestamp with time zone",
    required: false,
    defaultSql: null,
  },
  {
    name: "updated_at",
    type: "TIMESTAMPTZ",
    dataType: "timestamp with time zone",
    required: true,
    defaultSql: "NOW()",
  },
] as const;

function normalizeRetirementDefinition(value: string): string {
  return value
    .toLowerCase()
    .replaceAll('"', "")
    .replace(/::[a-z_]+(?:\[\])?/gu, "")
    .replace(/\b[a-z_][a-z0-9_]*\./gu, "")
    .replace(/\s+/gu, "")
    .replaceAll("usingbtree", "")
    .replace(/[();]/gu, "")
    .replaceAll("[", "")
    .replaceAll("]", "");
}

function retirementDefaultMatches(actual: string | null, expected: string | null): boolean {
  if (expected === null) return true;
  if (actual === null) return false;
  const normalized = normalizeRetirementDefinition(actual);
  if (expected === "'accepted'") return normalized === "'accepted'";
  if (expected === "0") return normalized === "0";
  return normalized === "now" || normalized === "current_timestamp";
}

function retirementConstraintMatches(name: string, definition: string): boolean {
  const normalized = normalizeRetirementDefinition(definition);
  if (name === "project_retirement_operations_pkey") return normalized === "primarykeyid";
  if (name === "project_retirement_operations_attempt_count_check") {
    return normalized === "checkattempt_count>=0";
  }
  if (name === "project_retirement_operations_lease_version_check") {
    return normalized === "checklease_version>=0";
  }
  if (name === "project_retirement_operations_project_id_fkey") {
    return normalized === "foreignkeyproject_idreferencesprojectsidondeletecascade";
  }
  if (name === "project_retirement_operations_state_check") {
    return (
      normalized === "checkstatein'accepted','running','failed','completed','canceled'" ||
      normalized === "checkstate=anyarray'accepted','running','failed','completed','canceled'"
    );
  }
  return false;
}

const RETIREMENT_CONSTRAINTS = [
  {
    name: "project_retirement_operations_state_check",
    type: "c",
    sql: "CHECK (state IN ('accepted','running','failed','completed','canceled'))",
  },
  {
    name: "project_retirement_operations_attempt_count_check",
    type: "c",
    sql: "CHECK (attempt_count >= 0)",
  },
  {
    name: "project_retirement_operations_lease_version_check",
    type: "c",
    sql: "CHECK (lease_version >= 0)",
  },
  {
    name: "project_retirement_operations_project_id_fkey",
    type: "f",
    sql: "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE",
  },
] as const;

const RETIREMENT_INDEXES = [
  {
    name: "project_retirement_operations_project_idx",
    sql: "CREATE INDEX IF NOT EXISTS project_retirement_operations_project_idx ON project_retirement_operations(project_id, created_at)",
    normalized:
      "createindexproject_retirement_operations_project_idxonproject_retirement_operationsproject_id,created_at",
  },
  {
    name: "project_retirement_operations_state_idx",
    sql: "CREATE INDEX IF NOT EXISTS project_retirement_operations_state_idx ON project_retirement_operations(state, updated_at)",
    normalized:
      "createindexproject_retirement_operations_state_idxonproject_retirement_operationsstate,updated_at",
  },
  {
    name: "project_retirement_operations_active_project_uq",
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS project_retirement_operations_active_project_uq ON project_retirement_operations(project_id) WHERE state IN ('accepted','running') OR (state = 'failed' AND completed_at IS NULL)",
    normalized:
      "createuniqueindexproject_retirement_operations_active_project_uqonproject_retirement_operationsproject_idwherestatein'accepted','running'orstate='failed'andcompleted_atisnull",
    alternateNormalized:
      "createuniqueindexproject_retirement_operations_active_project_uqonproject_retirement_operationsproject_idwherestate=anyarray'accepted','running'orstate='failed'andcompleted_atisnull",
  },
] as const;

function quoteMigrationIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

export async function applyProjectRetirementOperationsMigration(
  client: MigrationClient,
): Promise<void> {
  await client.query("BEGIN");
  try {
    const tableState = await client.query<{ table_exists: boolean }>(`
      SELECT to_regclass('project_retirement_operations') IS NOT NULL AS table_exists
    `);
    if (!tableState.rows[0]?.table_exists) {
      await client.query(`
      CREATE TABLE IF NOT EXISTS project_retirement_operations (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        requested_by TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'accepted',
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_version INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TIMESTAMPTZ,
        progress JSONB NOT NULL,
        failure_code TEXT,
        failure_target JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT project_retirement_operations_state_check
          CHECK (state IN ('accepted','running','failed','completed','canceled')),
        CONSTRAINT project_retirement_operations_attempt_count_check CHECK (attempt_count >= 0),
        CONSTRAINT project_retirement_operations_lease_version_check CHECK (lease_version >= 0),
        CONSTRAINT project_retirement_operations_project_id_fkey
          FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      )
    `);
      for (const index of RETIREMENT_INDEXES) await client.query(index.sql);
      await client.query("COMMIT");
      return;
    }

    const columnResult = await client.query<RetirementColumnState>(`
      SELECT column_name, data_type, is_nullable, column_default
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'project_retirement_operations'
    `);
    const columns = new Map(columnResult.rows.map((column) => [column.column_name, column]));
    const missing = RETIREMENT_COLUMNS.filter((column) => !columns.has(column.name));
    if (missing.length > 0) {
      await client.query(
        `ALTER TABLE project_retirement_operations ${missing
          .map((column) => `ADD COLUMN ${column.name} ${column.type}`)
          .join(", ")}`,
      );
    }
    for (const column of RETIREMENT_COLUMNS) {
      const existing = columns.get(column.name);
      if (existing !== undefined && existing.data_type !== column.dataType) {
        throw new Error(`project_retirement_column_type_mismatch:${column.name}`);
      }
    }

    const potentiallyNullable = RETIREMENT_COLUMNS.some(
      (column) =>
        column.required &&
        (columns.get(column.name)?.is_nullable === "YES" || !columns.has(column.name)),
    );
    if (potentiallyNullable) {
      const repairState = await client.query<{ repair_needed: boolean }>(`
        SELECT EXISTS (
          SELECT 1 FROM project_retirement_operations
           WHERE requested_by IS NULL OR state IS NULL OR attempt_count IS NULL
              OR lease_version IS NULL OR progress IS NULL OR created_at IS NULL
              OR updated_at IS NULL
        ) AS repair_needed
      `);
      if (repairState.rows[0]?.repair_needed) {
        await client.query(`
      UPDATE project_retirement_operations
         SET requested_by = COALESCE(requested_by, 'system:migration-repair'),
             state = COALESCE(state, 'accepted'),
             attempt_count = COALESCE(attempt_count, 0),
             lease_version = COALESCE(lease_version, 0),
             progress = COALESCE(progress, ${RETIREMENT_PROGRESS_REPAIR_SQL}),
             created_at = COALESCE(created_at, NOW()),
             updated_at = COALESCE(updated_at, NOW())
       WHERE requested_by IS NULL OR state IS NULL OR attempt_count IS NULL
          OR lease_version IS NULL OR progress IS NULL OR created_at IS NULL OR updated_at IS NULL
    `);
      }
    }

    const columnRepairs: string[] = [];
    for (const column of RETIREMENT_COLUMNS) {
      const existing = columns.get(column.name);
      if (
        column.defaultSql !== null &&
        !retirementDefaultMatches(existing?.column_default ?? null, column.defaultSql)
      ) {
        columnRepairs.push(`ALTER COLUMN ${column.name} SET DEFAULT ${column.defaultSql}`);
      }
      if (column.required && existing?.is_nullable !== "NO") {
        columnRepairs.push(`ALTER COLUMN ${column.name} SET NOT NULL`);
      }
    }
    if (columnRepairs.length > 0) {
      await client.query(`ALTER TABLE project_retirement_operations ${columnRepairs.join(", ")}`);
    }

    const constraintResult = await client.query<RetirementConstraintState>(`
      SELECT conname AS constraint_name, contype AS constraint_type,
             pg_get_constraintdef(oid) AS definition
        FROM pg_constraint
       WHERE conrelid = 'project_retirement_operations'::regclass
    `);
    const primaryKeys = constraintResult.rows.filter(
      (constraint) => constraint.constraint_type === "p",
    );
    const canonicalPrimaryKey = primaryKeys.find(
      (constraint) =>
        constraint.constraint_name === "project_retirement_operations_pkey" &&
        retirementConstraintMatches("project_retirement_operations_pkey", constraint.definition),
    );
    if (!canonicalPrimaryKey) {
      const equivalentPrimaryKey = primaryKeys.find((constraint) =>
        retirementConstraintMatches("project_retirement_operations_pkey", constraint.definition),
      );
      const incorrectlyNamedCanonical = primaryKeys.find(
        (constraint) => constraint.constraint_name === "project_retirement_operations_pkey",
      );
      if (incorrectlyNamedCanonical) {
        await client.query(
          `ALTER TABLE project_retirement_operations DROP CONSTRAINT ${quoteMigrationIdentifier(incorrectlyNamedCanonical.constraint_name)}`,
        );
      }
      if (
        equivalentPrimaryKey &&
        equivalentPrimaryKey.constraint_name !== incorrectlyNamedCanonical?.constraint_name
      ) {
        await client.query(
          `ALTER TABLE project_retirement_operations RENAME CONSTRAINT ${quoteMigrationIdentifier(equivalentPrimaryKey.constraint_name)} TO project_retirement_operations_pkey`,
        );
      } else {
        for (const primaryKey of primaryKeys) {
          if (primaryKey.constraint_name === incorrectlyNamedCanonical?.constraint_name) continue;
          await client.query(
            `ALTER TABLE project_retirement_operations DROP CONSTRAINT ${quoteMigrationIdentifier(primaryKey.constraint_name)}`,
          );
        }
        await client.query(
          `ALTER TABLE project_retirement_operations ADD CONSTRAINT project_retirement_operations_pkey PRIMARY KEY (id)`,
        );
      }
    }
    for (const expected of RETIREMENT_CONSTRAINTS) {
      const named = constraintResult.rows.find(
        (constraint) => constraint.constraint_name === expected.name,
      );
      const namedCanonical =
        named !== undefined &&
        named.constraint_type === expected.type &&
        retirementConstraintMatches(expected.name, named.definition);
      if (namedCanonical) continue;
      if (named !== undefined) {
        await client.query(
          `ALTER TABLE project_retirement_operations DROP CONSTRAINT ${quoteMigrationIdentifier(named.constraint_name)}`,
        );
      }
      const equivalentAlias = constraintResult.rows.find(
        (constraint) =>
          constraint.constraint_name !== expected.name &&
          constraint.constraint_type === expected.type &&
          retirementConstraintMatches(expected.name, constraint.definition),
      );
      if (equivalentAlias) {
        await client.query(
          `ALTER TABLE project_retirement_operations RENAME CONSTRAINT ${quoteMigrationIdentifier(equivalentAlias.constraint_name)} TO ${quoteMigrationIdentifier(expected.name)}`,
        );
      } else {
        await client.query(
          `ALTER TABLE project_retirement_operations ADD CONSTRAINT ${expected.name} ${expected.sql}`,
        );
      }
    }

    const indexResult = await client.query<RetirementIndexState>(`
      SELECT indexname AS index_name, indexdef AS index_definition
        FROM pg_indexes
       WHERE schemaname = current_schema()
         AND tablename = 'project_retirement_operations'
    `);
    for (const expected of RETIREMENT_INDEXES) {
      const existing = indexResult.rows.find((index) => index.index_name === expected.name);
      const normalized =
        existing === undefined ? null : normalizeRetirementDefinition(existing.index_definition);
      const canonical =
        normalized === expected.normalized ||
        ("alternateNormalized" in expected && normalized === expected.alternateNormalized);
      if (existing !== undefined && !canonical) {
        await client.query(`DROP INDEX ${quoteMigrationIdentifier(existing.index_name)}`);
      }
      if (!canonical) await client.query(expected.sql);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/**
 * Add the durable project-purge receipt. It intentionally has no foreign key
 * to projects: completed evidence must remain after the project row is gone.
 */
export async function applyProjectPurgeOperationsMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_purge_operations (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL,
        retirement_operation_id_hash TEXT NOT NULL,
        trigger TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'scheduled',
        stage TEXT NOT NULL DEFAULT 'verify',
        idempotency_key_hash TEXT NOT NULL,
        requested_by_hash TEXT,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        lease_version INTEGER NOT NULL DEFAULT 0,
        lease_expires_at TIMESTAMPTZ,
        due_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '30 days'),
        next_attempt_at TIMESTAMPTZ,
        failure_code TEXT,
        failure_retryable BOOLEAN,
        resource_progress JSONB NOT NULL DEFAULT '{}'::jsonb,
        terminal_evidence JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        started_at TIMESTAMPTZ,
        terminal_at TIMESTAMPTZ,
        CONSTRAINT project_purge_operations_trigger_check
          CHECK (trigger IN ('manual','expiry')),
        CONSTRAINT project_purge_operations_state_check
          CHECK (state IN ('scheduled','accepted','running','failed','completed','canceled')),
        CONSTRAINT project_purge_operations_stage_check
          CHECK (stage IN ('verify','inventory','assets','snapshots','database','addons','runtime','relational','absence')),
        CONSTRAINT project_purge_operations_failure_code_check
          CHECK (failure_code IS NULL OR failure_code IN (
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
          )),
        CONSTRAINT project_purge_operations_attempt_count_check CHECK (attempt_count >= 0),
        CONSTRAINT project_purge_operations_lease_version_check CHECK (lease_version >= 0),
        CONSTRAINT project_purge_operations_hashes_check CHECK (
          retirement_operation_id_hash ~ '^[0-9a-f]{64}$'
          AND idempotency_key_hash ~ '^[0-9a-f]{64}$'
          AND (requested_by_hash IS NULL OR requested_by_hash ~ '^[0-9a-f]{64}$')
        ),
        CONSTRAINT project_purge_operations_requester_check CHECK (
          trigger = 'expiry' OR requested_by_hash IS NOT NULL
        ),
        CONSTRAINT project_purge_operations_terminal_check CHECK (
          (state IN ('scheduled','accepted','running')
            AND failure_code IS NULL AND failure_retryable IS NULL
            AND terminal_evidence IS NULL AND terminal_at IS NULL)
          OR (state = 'failed'
            AND failure_code IS NOT NULL AND failure_retryable IS NOT NULL
            AND terminal_evidence IS NOT NULL AND terminal_at IS NOT NULL)
          OR (state IN ('completed','canceled')
            AND failure_code IS NULL AND failure_retryable IS NULL
            AND terminal_evidence IS NOT NULL AND terminal_at IS NOT NULL)
        )
      )
    `);
    await client.query(
      `ALTER TABLE project_purge_operations
         ADD COLUMN IF NOT EXISTS resource_progress JSONB NOT NULL DEFAULT '{}'::jsonb`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS project_purge_operations_project_idx
         ON project_purge_operations(project_id, created_at)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS project_purge_operations_due_idx
         ON project_purge_operations(state, due_at, next_attempt_at)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS project_purge_operations_idempotency_uq
         ON project_purge_operations(idempotency_key_hash)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS project_purge_operations_retirement_uq
         ON project_purge_operations(project_id, retirement_operation_id_hash)`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS project_purge_operations_active_project_uq
         ON project_purge_operations(project_id)
         WHERE state IN ('scheduled','accepted','running','failed')`,
    );
    await client.query(
      `CREATE UNIQUE INDEX IF NOT EXISTS notifications_project_purge_milestone_uq
         ON notifications(resource_type, resource_id, recipient_id)
         WHERE resource_type = 'project_purge'`,
    );

    const verification = await client.query<{
      table_ready: boolean;
      columns_ready: boolean;
      constraints_ready: boolean;
      indexes_ready: boolean;
      notification_index_ready: boolean;
      foreign_key_count: string;
    }>(`
      SELECT
        to_regclass('project_purge_operations') IS NOT NULL AS table_ready,
        (SELECT COUNT(*) = 21
           FROM information_schema.columns
          WHERE table_schema = current_schema()
            AND table_name = 'project_purge_operations') AS columns_ready,
        (SELECT COUNT(*) = 10
                AND bool_and(
                  CASE conname
                    WHEN 'project_purge_operations_pkey' THEN
                      contype = 'p' AND pg_get_constraintdef(oid) = 'PRIMARY KEY (id)'
                    WHEN 'project_purge_operations_trigger_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%trigger%manual%expiry%'
                    WHEN 'project_purge_operations_state_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%state%scheduled%accepted%running%failed%completed%canceled%'
                    WHEN 'project_purge_operations_stage_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%stage%verify%inventory%assets%snapshots%database%addons%runtime%relational%absence%'
                    WHEN 'project_purge_operations_failure_code_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%failure_code%project_purge_absence_unverified%project_purge_operation_unavailable%'
                    WHEN 'project_purge_operations_attempt_count_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%attempt_count%>= 0%'
                    WHEN 'project_purge_operations_lease_version_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%lease_version%>= 0%'
                    WHEN 'project_purge_operations_hashes_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%retirement_operation_id_hash%idempotency_key_hash%requested_by_hash%'
                    WHEN 'project_purge_operations_requester_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%trigger%expiry%requested_by_hash%IS NOT NULL%'
                    WHEN 'project_purge_operations_terminal_check' THEN
                      contype = 'c' AND pg_get_constraintdef(oid) LIKE '%terminal_evidence%terminal_at%'
                    ELSE FALSE
                  END
                )
           FROM pg_constraint
          WHERE conrelid = 'project_purge_operations'::regclass
            AND convalidated
            AND conname IN (
              'project_purge_operations_pkey',
              'project_purge_operations_trigger_check',
              'project_purge_operations_state_check',
              'project_purge_operations_stage_check',
              'project_purge_operations_failure_code_check',
              'project_purge_operations_attempt_count_check',
              'project_purge_operations_lease_version_check',
              'project_purge_operations_hashes_check',
              'project_purge_operations_requester_check',
              'project_purge_operations_terminal_check'
            )) AS constraints_ready,
        (SELECT COUNT(*) = 6
                AND bool_and(index_row.indisvalid AND index_row.indisready)
                AND bool_and(
                  CASE index_relation.relname
                    WHEN 'project_purge_operations_pkey' THEN index_row.indisunique
                    WHEN 'project_purge_operations_project_idx' THEN
                      pg_get_indexdef(index_row.indexrelid) LIKE '%(project_id, created_at)%'
                    WHEN 'project_purge_operations_due_idx' THEN
                      pg_get_indexdef(index_row.indexrelid) LIKE '%(state, due_at, next_attempt_at)%'
                    WHEN 'project_purge_operations_idempotency_uq' THEN
                      index_row.indisunique AND pg_get_indexdef(index_row.indexrelid) LIKE '%(idempotency_key_hash)%'
                    WHEN 'project_purge_operations_retirement_uq' THEN
                      index_row.indisunique AND pg_get_indexdef(index_row.indexrelid) LIKE '%(project_id, retirement_operation_id_hash)%'
                    WHEN 'project_purge_operations_active_project_uq' THEN
                      index_row.indisunique
                      AND pg_get_indexdef(index_row.indexrelid) LIKE '%(project_id)%'
                      AND pg_get_expr(index_row.indpred, index_row.indrelid) LIKE '%scheduled%accepted%running%failed%'
                    ELSE FALSE
                  END
                )
           FROM pg_index index_row
           JOIN pg_class index_relation ON index_relation.oid=index_row.indexrelid
           JOIN pg_class table_relation ON table_relation.oid=index_row.indrelid
           JOIN pg_namespace namespace_row ON namespace_row.oid=table_relation.relnamespace
          WHERE namespace_row.nspname = current_schema()
            AND table_relation.relname = 'project_purge_operations'
            AND index_relation.relname IN (
              'project_purge_operations_pkey',
              'project_purge_operations_project_idx',
              'project_purge_operations_due_idx',
              'project_purge_operations_idempotency_uq',
              'project_purge_operations_retirement_uq',
              'project_purge_operations_active_project_uq'
            )) AS indexes_ready,
        EXISTS (
          SELECT 1
            FROM pg_index index_row
            JOIN pg_class index_relation ON index_relation.oid=index_row.indexrelid
            JOIN pg_class table_relation ON table_relation.oid=index_row.indrelid
            JOIN pg_namespace namespace_row ON namespace_row.oid=table_relation.relnamespace
           WHERE namespace_row.nspname=current_schema()
             AND table_relation.relname='notifications'
             AND index_relation.relname='notifications_project_purge_milestone_uq'
             AND index_row.indisunique AND index_row.indisvalid AND index_row.indisready
             AND pg_get_indexdef(index_row.indexrelid)
                   LIKE '%(resource_type, resource_id, recipient_id)%'
             AND pg_get_expr(index_row.indpred, index_row.indrelid)
                   LIKE '%resource_type%project_purge%'
        ) AS notification_index_ready,
        (SELECT COUNT(*)::text
           FROM pg_constraint
          WHERE conrelid = 'project_purge_operations'::regclass
            AND contype = 'f') AS foreign_key_count
    `);
    const observation = verification.rows[0];
    if (
      observation?.table_ready !== true ||
      observation.columns_ready !== true ||
      observation.constraints_ready !== true ||
      observation.indexes_ready !== true ||
      observation.notification_index_ready !== true ||
      observation.foreign_key_count !== "0"
    ) {
      throw new Error("project_purge_operations_schema_incomplete");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function applyUnifiedAssetRegistryMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS account_asset_quota (
        user_id TEXT PRIMARY KEY,
        base_allowance_bytes BIGINT NOT NULL DEFAULT 524288000,
        purchased_allowance_bytes BIGINT NOT NULL DEFAULT 0,
        used_bytes BIGINT NOT NULL DEFAULT 0,
        reserved_bytes BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT account_asset_quota_nonnegative CHECK (
          base_allowance_bytes >= 0 AND purchased_allowance_bytes >= 0
          AND used_bytes >= 0 AND reserved_bytes >= 0
        )
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id SERIAL PRIMARY KEY,
        owner_user_id TEXT NOT NULL,
        actor_user_id TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        thread_key TEXT,
        scope TEXT NOT NULL CHECK (scope IN ('account', 'project', 'thread')),
        kind TEXT NOT NULL CHECK (kind IN ('image', 'file', 'snapshot', 'recording', 'generated')),
        source TEXT NOT NULL,
        filename TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        size_bytes BIGINT NOT NULL CHECK (size_bytes >= 0),
        sha256 TEXT,
        storage_backend TEXT NOT NULL DEFAULT 'r2',
        storage_key TEXT NOT NULL UNIQUE,
        state TEXT NOT NULL DEFAULT 'reserved'
          CHECK (state IN ('reserved', 'uploading', 'ready', 'deleting', 'rejected', 'deleted')),
        scan_state TEXT NOT NULL DEFAULT 'not-scanned'
          CHECK (scan_state IN ('not-required', 'not-scanned', 'clean', 'threat', 'failed')),
        rejection_code TEXT,
        text_preview TEXT,
        version_id INTEGER,
        task_id INTEGER,
        message_id INTEGER,
        context JSONB,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        upload_started_at TIMESTAMPTZ,
        ready_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ
      )
    `);
    // New writers stamp provenance. Historical rows are backfilled only when
    // an exact NabuFlow source relation proves their product namespace.
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS product_scope TEXT`);
    await client.query(`ALTER TABLE generated_images ADD COLUMN IF NOT EXISTS product_scope TEXT`);
    await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS asset_id INTEGER`);
    await client.query(`ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_product_scope_check`);
    await client.query(`ALTER TABLE assets ADD CONSTRAINT assets_product_scope_check
      CHECK (product_scope IN ('nabuflow','ora'))`);
    await client.query(
      `ALTER TABLE generated_images DROP CONSTRAINT IF EXISTS generated_images_product_scope_check`,
    );
    await client.query(`ALTER TABLE generated_images ADD CONSTRAINT generated_images_product_scope_check
      CHECK (product_scope IN ('nabuflow','ora'))`);
    await client.query(`
      CREATE OR REPLACE FUNCTION asset_has_verified_nabuflow_provenance(
        candidate_asset_id INTEGER
      ) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1
            FROM public.assets candidate
           WHERE candidate.id = candidate_asset_id
             AND (
               EXISTS (
                 SELECT 1
                   FROM public.project_uploads upload
                   JOIN public.projects project ON project.id = upload.project_id
                  WHERE candidate.source = 'legacy-project-upload'
                    AND candidate.storage_backend = 'legacy-object'
                    AND candidate.project_id = upload.project_id
                    AND candidate.storage_key = upload.object_path
                    AND candidate.owner_user_id = project.owner_id
                    AND NOT EXISTS (
                      SELECT 1
                        FROM public.project_uploads conflicting_upload
                        JOIN public.projects conflicting_project
                          ON conflicting_project.id = conflicting_upload.project_id
                       WHERE conflicting_upload.object_path = candidate.storage_key
                         AND conflicting_project.owner_id IS DISTINCT FROM candidate.owner_user_id
                    )
               )
               OR EXISTS (
                 SELECT 1
                   FROM public.generated_images image
                  WHERE image.product_scope = 'nabuflow'
                    AND image.user_id = candidate.owner_user_id
                    AND image.project_id IS NOT DISTINCT FROM candidate.project_id
                    AND image.source_type = candidate.source
                    AND COALESCE(image.storage_key, 'legacy-generated/' || image.id::text) =
                        candidate.storage_key
                    AND (image.asset_id IS NULL OR image.asset_id = candidate.id)
               )
             )
        )
      $$ LANGUAGE SQL STABLE STRICT SECURITY INVOKER
         SET search_path = pg_catalog, public
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION generated_image_has_verified_nabuflow_provenance(
        candidate_image_id INTEGER
      ) RETURNS BOOLEAN AS $$
        SELECT EXISTS (
          SELECT 1
            FROM public.generated_images image
            LEFT JOIN public.assets asset ON asset.id = image.asset_id
           WHERE image.id = candidate_image_id
             AND asset.id IS NOT NULL
             AND asset.product_scope = 'nabuflow'
             AND asset.owner_user_id = image.user_id
             AND asset.project_id IS NOT DISTINCT FROM image.project_id
        )
      $$ LANGUAGE SQL STABLE STRICT SECURITY INVOKER
         SET search_path = pg_catalog, public
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION prevent_asset_product_scope_change()
      RETURNS TRIGGER AS $$
      DECLARE
        verified_nabuflow_transition BOOLEAN := FALSE;
      BEGIN
        IF TG_OP='UPDATE' AND OLD.product_scope IS DISTINCT FROM NEW.product_scope THEN
          IF OLD.product_scope IS NULL
             AND NEW.product_scope = 'nabuflow'
             AND (to_jsonb(NEW) - 'product_scope') =
                 (to_jsonb(OLD) - 'product_scope') THEN
            verified_nabuflow_transition := CASE
              WHEN TG_TABLE_NAME = 'assets' THEN
                public.asset_has_verified_nabuflow_provenance(NEW.id)
              WHEN TG_TABLE_NAME = 'generated_images' THEN
                public.generated_image_has_verified_nabuflow_provenance(NEW.id)
              ELSE FALSE
            END;
          END IF;
          IF NOT verified_nabuflow_transition THEN
            RAISE EXCEPTION 'asset_product_scope_immutable' USING ERRCODE='55000';
          END IF;
        END IF;
        IF NEW.product_scope='ora' AND NEW.project_id IS NOT NULL THEN
          RAISE EXCEPTION 'asset_product_scope_namespace_mismatch' USING ERRCODE='42501';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public
    `);
    for (const table of ["assets", "generated_images"]) {
      await client.query(`DROP TRIGGER IF EXISTS ${table}_product_scope_guard ON ${table}`);
      await client.query(`CREATE TRIGGER ${table}_product_scope_guard
        BEFORE INSERT OR UPDATE OF product_scope, project_id ON ${table}
        FOR EACH ROW EXECUTE FUNCTION prevent_asset_product_scope_change()`);
    }
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS actor_user_id TEXT`);
    await client.query(`UPDATE assets SET actor_user_id=owner_user_id WHERE actor_user_id IS NULL`);
    await client.query(`ALTER TABLE assets ALTER COLUMN actor_user_id SET NOT NULL`);
    await client.query(
      `CREATE INDEX IF NOT EXISTS assets_owner_state_idx ON assets(owner_user_id, state)`,
    );
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS text_preview TEXT`);
    await client.query(`ALTER TABLE assets ADD COLUMN IF NOT EXISTS upload_started_at TIMESTAMPTZ`);
    await client.query(`
      DO $$
      DECLARE current_definition TEXT;
      BEGIN
        SELECT pg_get_constraintdef(oid)
          INTO current_definition
          FROM pg_constraint
         WHERE conrelid = 'assets'::regclass
           AND conname = 'assets_state_check';
        IF current_definition IS NULL OR current_definition NOT LIKE '%uploading%' THEN
          ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_state_check;
          ALTER TABLE assets
            ADD CONSTRAINT assets_state_check
            CHECK (state IN ('reserved', 'uploading', 'ready', 'deleting', 'rejected', 'deleted'));
        END IF;
      END $$
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS assets_project_created_idx ON assets(project_id, created_at DESC)`,
    );
    await client.query(
      `CREATE INDEX IF NOT EXISTS assets_thread_created_idx ON assets(thread_key, created_at DESC)`,
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_storage_objects (
        id SERIAL PRIMARY KEY,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        storage_backend TEXT NOT NULL,
        storage_key TEXT NOT NULL,
        role TEXT NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
        size_measured_at TIMESTAMPTZ,
        provider_generation TEXT,
        provider_checksum TEXT,
        state TEXT NOT NULL DEFAULT 'reserved'
          CHECK (state IN ('reserved', 'uploading', 'ready', 'deleting', 'deleted')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ready_at TIMESTAMPTZ,
        deleted_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      ALTER TABLE asset_storage_objects
        ADD COLUMN IF NOT EXISTS size_measured_at TIMESTAMPTZ
    `);
    await client.query(`
      ALTER TABLE asset_storage_objects
        ADD COLUMN IF NOT EXISTS provider_generation TEXT,
        ADD COLUMN IF NOT EXISTS provider_checksum TEXT
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS asset_storage_objects_key_uq
        ON asset_storage_objects(storage_key)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS asset_storage_objects_role_uq
        ON asset_storage_objects(asset_id, role)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS asset_storage_objects_asset_idx
        ON asset_storage_objects(asset_id, state)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS durable_asset_deletion_claims (
        storage_key TEXT PRIMARY KEY,
        claim_kind TEXT NOT NULL,
        retired_project_id INTEGER,
        retired_asset_id INTEGER,
        claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT durable_asset_deletion_claims_key_check CHECK (length(storage_key) > 0)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_usage (
        id SERIAL PRIMARY KEY,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        artifact_id INTEGER REFERENCES project_artifacts(id) ON DELETE CASCADE,
        version_id INTEGER,
        file_path TEXT,
        consumer TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS asset_usage_asset_idx ON asset_usage(asset_id)`);
    await client.query(`
      ALTER TABLE asset_usage
        ADD COLUMN IF NOT EXISTS artifact_id INTEGER REFERENCES project_artifacts(id) ON DELETE CASCADE
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS asset_usage_project_idx ON asset_usage(project_id)`,
    );
    await client.query(
      `ALTER TABLE asset_usage DROP CONSTRAINT IF EXISTS asset_usage_explicit_use_shape_check`,
    );
    await client.query(`ALTER TABLE asset_usage ADD CONSTRAINT asset_usage_explicit_use_shape_check CHECK (
      consumer <> 'explicit-project-use:v1' OR
      (project_id IS NOT NULL AND artifact_id IS NULL AND version_id IS NULL AND file_path IS NULL)
    )`);
    await client.query(`
      CREATE OR REPLACE FUNCTION require_explicit_asset_use_scope()
      RETURNS TRIGGER AS $$
      BEGIN
        IF NEW.consumer='explicit-project-use:v1' THEN
          PERFORM 1 FROM assets WHERE id=NEW.asset_id AND state='ready'
            AND product_scope='nabuflow' FOR SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'asset_reference_forbidden' USING ERRCODE='42501';
          END IF;
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public
    `);
    await client.query(`DROP TRIGGER IF EXISTS asset_usage_explicit_scope_guard ON asset_usage`);
    await client.query(`CREATE TRIGGER asset_usage_explicit_scope_guard
      BEFORE INSERT OR UPDATE OF consumer, asset_id, project_id ON asset_usage
      FOR EACH ROW EXECUTE FUNCTION require_explicit_asset_use_scope()`);
    await client.query(`
      DO $$
      DECLARE
        current_definition TEXT;
        normalized_definition TEXT;
      BEGIN
        SELECT indexdef
          INTO current_definition
          FROM pg_indexes
         WHERE schemaname = ANY(current_schemas(FALSE))
           AND indexname = 'asset_usage_identity_uq';
        normalized_definition := regexp_replace(
          lower(COALESCE(current_definition, '')),
          '[[:space:]]+',
          '',
          'g'
        );
        IF current_definition IS NULL
           OR position('coalesce(project_id,' IN normalized_definition) = 0
           OR position('coalesce(artifact_id,' IN normalized_definition) = 0
           OR position('coalesce(version_id,' IN normalized_definition) = 0
           OR position('coalesce(file_path,' IN normalized_definition) = 0 THEN
          DROP INDEX IF EXISTS asset_usage_identity_uq;
          CREATE UNIQUE INDEX asset_usage_identity_uq
            ON asset_usage(
              asset_id,
              COALESCE(project_id, -1),
              COALESCE(artifact_id, -1),
              COALESCE(version_id, -1),
              COALESCE(file_path, ''),
              consumer
            );
        END IF;
      END $$
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION require_attachable_asset_for_usage()
      RETURNS TRIGGER AS $$
      DECLARE current_state TEXT;
      BEGIN
        SELECT state INTO current_state
          FROM assets
         WHERE id = NEW.asset_id
         FOR SHARE;
        IF current_state IS DISTINCT FROM 'ready' THEN
          RAISE EXCEPTION 'asset_not_ready' USING ERRCODE = '55000';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);
    await client.query(`DROP TRIGGER IF EXISTS asset_usage_requires_ready_asset ON asset_usage`);
    await client.query(`
      CREATE TRIGGER asset_usage_requires_ready_asset
      BEFORE INSERT OR UPDATE OF asset_id, project_id ON asset_usage
      FOR EACH ROW EXECUTE FUNCTION require_attachable_asset_for_usage()
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS storage_addon_subscriptions (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        sku TEXT NOT NULL,
        allowance_bytes BIGINT NOT NULL CHECK (allowance_bytes > 0),
        stripe_subscription_id TEXT NOT NULL UNIQUE,
        stripe_item_id TEXT,
        status TEXT NOT NULL,
        current_period_end TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS storage_addons_user_status_idx
        ON storage_addon_subscriptions(user_id, status)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_analysis_events (
        id SERIAL PRIMARY KEY,
        user_id TEXT NOT NULL,
        project_id INTEGER REFERENCES projects(id) ON DELETE CASCADE,
        asset_id INTEGER NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        estimated_provider_cost_micros BIGINT NOT NULL DEFAULT 0,
        customer_credit_price INTEGER,
        status TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS asset_analysis_user_created_idx
        ON asset_analysis_events(user_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS asset_analysis_asset_idx
        ON asset_analysis_events(asset_id)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS asset_storage_reconciliation_runs (
        request_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
        receipt JSONB,
        terminal JSONB,
        started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS visual_edit_sessions (
        id TEXT PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        actor_user_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'cancelled')),
        summary TEXT,
        version_id INTEGER REFERENCES project_versions(id) ON DELETE SET NULL,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        closed_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS visual_edit_sessions_project_status_idx
        ON visual_edit_sessions(project_id, status)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS visual_edit_changes (
        id SERIAL PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES visual_edit_sessions(id) ON DELETE CASCADE,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        actor_user_id TEXT NOT NULL,
        file_id INTEGER NOT NULL,
        file_path TEXT NOT NULL,
        intent_receipt_id INTEGER NOT NULL REFERENCES zero_intent_receipts(id) ON DELETE RESTRICT,
        intent JSONB NOT NULL,
        before_content TEXT NOT NULL,
        after_content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'applied' CHECK (status IN ('applied', 'undone')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        undone_at TIMESTAMPTZ
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS visual_edit_changes_session_idx
        ON visual_edit_changes(session_id, id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS visual_edit_changes_project_idx
        ON visual_edit_changes(project_id, created_at)
    `);

    // Every durable surface that can carry an asset URL participates in the
    // same row-lock protocol as asset_usage. This makes the purge's final
    // reference scan serializable against a concurrent save. New untyped
    // /objects/ references are refused: legacy objects must first cross the
    // governed asset-adoption boundary.
    await client.query(`
      CREATE OR REPLACE FUNCTION extract_durable_asset_ids(row_json JSONB)
      RETURNS SETOF INTEGER AS $$
        WITH candidate AS (
          SELECT (match)[1]::bigint AS asset_id
            FROM regexp_matches(
              row_json::text,
              '/api/(?:assets|ora/canonical-assets)/([1-9][0-9]{0,9})/content([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
          UNION
          SELECT value::text::bigint
            FROM jsonb_path_query(row_json, 'lax $.**.assetId') value
           WHERE jsonb_typeof(value) = 'number'
             AND value::text ~ '^[1-9][0-9]{0,9}$'
          UNION
          SELECT value::text::bigint
            FROM jsonb_path_query(row_json, 'lax $.**.assetIds[*]') value
           WHERE jsonb_typeof(value) = 'number'
             AND value::text ~ '^[1-9][0-9]{0,9}$'
          UNION
          SELECT value::text::bigint
            FROM jsonb_path_query(row_json, 'lax $.**.originalAssetIds[*]') value
           WHERE jsonb_typeof(value) = 'number'
             AND value::text ~ '^[1-9][0-9]{0,9}$'
          UNION
          SELECT value::text::bigint
            FROM jsonb_path_query(row_json, 'lax $.**.logoAssetId') value
           WHERE jsonb_typeof(value) = 'number'
             AND value::text ~ '^[1-9][0-9]{0,9}$'
          UNION
          SELECT value::text::bigint
            FROM jsonb_path_query(row_json, 'lax $.**.asset_id') value
           WHERE jsonb_typeof(value) = 'number'
             AND value::text ~ '^[1-9][0-9]{0,9}$'
          UNION
          SELECT value::text::bigint
            FROM jsonb_path_query(row_json, 'lax $.**.asset_ids[*]') value
           WHERE jsonb_typeof(value) = 'number'
             AND value::text ~ '^[1-9][0-9]{0,9}$'
          UNION
          SELECT value::text::bigint
            FROM jsonb_path_query(row_json, 'lax $.**.original_asset_ids[*]') value
           WHERE jsonb_typeof(value) = 'number'
             AND value::text ~ '^[1-9][0-9]{0,9}$'
          UNION
          SELECT value::text::bigint
            FROM jsonb_path_query(row_json, 'lax $.**.logo_asset_id') value
           WHERE jsonb_typeof(value) = 'number'
             AND value::text ~ '^[1-9][0-9]{0,9}$'
        )
        SELECT DISTINCT asset_id::integer
          FROM candidate
         WHERE asset_id BETWEEN 1 AND 2147483647
      $$ LANGUAGE SQL IMMUTABLE STRICT
         SET search_path = pg_catalog, public
    `);
    // SQL literal escaping is shared by both identity and physical-key parsers.
    // Governed filenames cannot contain quotes; HTML/JS quote delimiters must
    // never become part of a storage key or escape its deletion claim.
    const durableStorageKeyToken = "[^\"''\\\\[:space:]?#<>(){},;`]+";
    await client.query(`
      CREATE OR REPLACE FUNCTION resolve_durable_asset_ids(row_json JSONB)
      RETURNS SETOF INTEGER AS $$
      DECLARE
        candidate_id INTEGER;
        route_match TEXT[];
        image_id BIGINT;
        route_project_id BIGINT;
        route_upload_id BIGINT;
        ora_asset_id BIGINT;
      BEGIN
        FOR candidate_id IN SELECT public.extract_durable_asset_ids(row_json)
        LOOP
          RETURN NEXT candidate_id;
        END LOOP;

        FOR route_match IN
          SELECT match
            FROM regexp_matches(
              row_json::text,
              '/api/ora/assets/([1-9][0-9]{0,9})/download([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        LOOP
          ora_asset_id := route_match[1]::bigint;
          IF ora_asset_id > 2147483647 THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          SELECT ora.asset_id INTO candidate_id
            FROM public.ora_assets ora
            JOIN public.assets asset
              ON asset.id = ora.asset_id
             AND asset.owner_user_id = ora.user_id
           WHERE ora.id = ora_asset_id::integer
             AND ora.deleted_at IS NULL;
          IF candidate_id IS NULL THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          RETURN NEXT candidate_id;
        END LOOP;

        FOR route_match IN
          SELECT match
            FROM regexp_matches(
              row_json::text,
              '/api/images/([1-9][0-9]{0,9})/file([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        LOOP
          image_id := route_match[1]::bigint;
          IF image_id > 2147483647 THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          SELECT image.asset_id INTO candidate_id
            FROM public.generated_images image
           WHERE image.id = image_id::integer
             AND image.deleted_at IS NULL;
          IF candidate_id IS NULL THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          RETURN NEXT candidate_id;
        END LOOP;

        FOR route_match IN
          SELECT match
            FROM regexp_matches(
              row_json::text,
              '/api/projects/([1-9][0-9]{0,9})/uploads/([1-9][0-9]{0,9})/content([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        LOOP
          route_project_id := route_match[1]::bigint;
          route_upload_id := route_match[2]::bigint;
          IF route_project_id NOT BETWEEN 1 AND 2147483647
             OR route_upload_id NOT BETWEEN 1 AND 2147483647 THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          SELECT asset.id INTO candidate_id
            FROM public.project_uploads upload
            JOIN public.assets asset
              ON asset.project_id = upload.project_id
             AND asset.source = 'legacy-project-upload'
             AND asset.storage_key = upload.object_path
           WHERE upload.project_id = route_project_id::integer
             AND upload.id = route_upload_id::integer;
          IF candidate_id IS NULL THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          RETURN NEXT candidate_id;
        END LOOP;

        FOR route_match IN
          SELECT match
            FROM regexp_matches(
              row_json::text,
              '(/objects/uploads/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        LOOP
          SELECT matched_asset.id INTO candidate_id
            FROM public.assets matched_asset
            LEFT JOIN public.asset_storage_objects storage_row
              ON storage_row.asset_id = matched_asset.id
             AND storage_row.storage_backend = 'legacy-object'
             AND storage_row.storage_key = route_match[1]
             AND storage_row.state <> 'deleted'
           WHERE matched_asset.source = 'legacy-project-upload'
             AND matched_asset.state <> 'deleted'
             AND (
               (
                 matched_asset.storage_backend = 'legacy-object'
                 AND matched_asset.storage_key = route_match[1]
               )
               OR storage_row.id IS NOT NULL
             )
           ORDER BY
             CASE WHEN matched_asset.storage_key = route_match[1] THEN 0 ELSE 1 END,
             matched_asset.id
           LIMIT 1;
          IF candidate_id IS NULL THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          RETURN NEXT candidate_id;
        END LOOP;

        -- Canonical provider keys can appear inside historical free-form rows
        -- and absolute private URLs. Resolve only the governed assets/... key
        -- shape, then let the shared row-lock guard serialize the writer with
        -- deletion. The storage-key index keeps this lookup bounded to the
        -- handful of keys extracted from the row instead of scanning storage.
        FOR candidate_id IN
          SELECT DISTINCT storage_row.asset_id
            FROM regexp_matches(
              row_json::text,
              '(assets/[^"[:space:]]+/[^"[:space:]]+/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/${durableStorageKeyToken})',
              'g'
            ) AS matched(storage_match)
            JOIN public.asset_storage_objects storage_row
              ON storage_row.storage_key = matched.storage_match[1]
             AND storage_row.state <> 'deleted'
        LOOP
          RETURN NEXT candidate_id;
        END LOOP;
      END;
      $$ LANGUAGE plpgsql STABLE STRICT SECURITY INVOKER
         SET search_path = pg_catalog, public
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION resolve_durable_storage_keys(row_json JSONB)
      RETURNS SETOF TEXT AS $$
        WITH raw_keys AS (
          SELECT (match)[1] AS storage_key
            FROM regexp_matches(
              row_json::text,
              '((?:assets|generated-images|uploaded-images|edited-images|db-snapshots|legacy-generated)/${durableStorageKeyToken})',
              'g'
            ) AS match
          UNION
          SELECT (match)[1] AS storage_key
            FROM regexp_matches(
              row_json::text,
              '(/objects/uploads/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        ),
        image_routes AS (
          SELECT (match)[1]::bigint AS image_id
            FROM regexp_matches(
              row_json::text,
              '/api/images/([1-9][0-9]{0,9})/file([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        ),
        ora_routes AS (
          SELECT (match)[1]::bigint AS ora_asset_id
            FROM regexp_matches(
              row_json::text,
              '/api/ora/assets/([1-9][0-9]{0,9})/download([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        ),
        upload_routes AS (
          SELECT (match)[1]::bigint AS project_id, (match)[2]::bigint AS upload_id
            FROM regexp_matches(
              row_json::text,
              '/api/projects/([1-9][0-9]{0,9})/uploads/([1-9][0-9]{0,9})/content([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        ),
        ora_keys AS (
          SELECT asset.storage_key
            FROM ora_routes route
            JOIN public.ora_assets ora
              ON ora.id::bigint = route.ora_asset_id
             AND ora.deleted_at IS NULL
            JOIN public.assets asset
              ON asset.id = ora.asset_id
             AND asset.owner_user_id = ora.user_id
           WHERE route.ora_asset_id BETWEEN 1 AND 2147483647
          UNION
          SELECT storage_row.storage_key
            FROM ora_routes route
            JOIN public.ora_assets ora
              ON ora.id::bigint = route.ora_asset_id
             AND ora.deleted_at IS NULL
            JOIN public.asset_storage_objects storage_row
              ON storage_row.asset_id = ora.asset_id
             AND storage_row.state <> 'deleted'
           WHERE route.ora_asset_id BETWEEN 1 AND 2147483647
        ),
        upload_keys AS (
          -- Alias expansion precedes the ordered physical-key locks. The
          -- trigger rechecks this mapping after every lock wait.
          SELECT upload.object_path AS storage_key
            FROM upload_routes route
            JOIN public.project_uploads upload
              ON upload.project_id=route.project_id
             AND upload.id=route.upload_id
           WHERE route.project_id BETWEEN 1 AND 2147483647
             AND route.upload_id BETWEEN 1 AND 2147483647
             AND upload.object_path IS NOT NULL
        ),
        image_keys AS (
          SELECT image.storage_key
            FROM image_routes route
            JOIN public.generated_images image
              ON route.image_id BETWEEN 1 AND 2147483647
             AND image.id=route.image_id::integer
           WHERE image.storage_key IS NOT NULL
          UNION
          SELECT regexp_replace(image.storage_key, '/full\\.webp$', '/thumb.webp')
            FROM image_routes route
            JOIN public.generated_images image
              ON route.image_id BETWEEN 1 AND 2147483647
             AND image.id=route.image_id::integer
           WHERE image.storage_key LIKE '%/full.webp'
        )
        SELECT DISTINCT candidate.storage_key
          FROM (
            SELECT storage_key FROM raw_keys
            UNION
            SELECT storage_key FROM image_keys
            UNION
            SELECT storage_key FROM ora_keys
            UNION
            SELECT storage_key FROM upload_keys
          ) candidate
         WHERE candidate.storage_key IS NOT NULL
           AND length(candidate.storage_key) > 0
      $$ LANGUAGE SQL STABLE STRICT SECURITY INVOKER
         SET search_path = pg_catalog, public
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION durable_asset_reference_exists_excluding_upload(
        candidate_asset_id INTEGER,
        excluded_project_id INTEGER,
        excluded_generated_image_id INTEGER,
        excluded_project_upload_id INTEGER
      ) RETURNS BOOLEAN AS $$
        WITH candidate AS (
          SELECT id, owner_user_id, project_id, storage_key, version_id, task_id, message_id, source
            FROM public.assets
           WHERE id = candidate_asset_id
        ),
        -- Alias keys establish retention only, never provider ownership or
        -- product visibility. Keep unknown/other-product/deleted alias metadata
        -- in this candidate closure while surviving rows still reference bytes.
        candidate_image_aliases AS (
          SELECT image.storage_key, image.file_url, image.thumbnail_url
            FROM public.generated_images image
           WHERE image.asset_id = candidate_asset_id
        ),
        candidate_raw_keys AS (
          SELECT storage_key
            FROM candidate
           WHERE storage_key IS NOT NULL
          UNION
          SELECT storage_row.storage_key
            FROM public.asset_storage_objects storage_row
           WHERE storage_row.asset_id = candidate_asset_id
             AND storage_row.state <> 'deleted'
          UNION
          SELECT image_alias.storage_key
            FROM candidate_image_aliases image_alias
           WHERE image_alias.storage_key IS NOT NULL
          UNION
          SELECT resolved.storage_key
            FROM candidate_image_aliases image_alias
            CROSS JOIN LATERAL public.resolve_durable_storage_keys(
              jsonb_build_object(
                'storage_key', image_alias.storage_key,
                'file_url', image_alias.file_url,
                'thumbnail_url', image_alias.thumbnail_url
              )
            ) AS resolved(storage_key)
        ),
        candidate_keys AS (
          SELECT raw_key.storage_key
            FROM candidate_raw_keys raw_key
           WHERE raw_key.storage_key IS NOT NULL
             AND length(raw_key.storage_key) > 0
          UNION
          SELECT regexp_replace(raw_key.storage_key, '/full\\.webp$', '/thumb.webp')
            FROM candidate_raw_keys raw_key
           WHERE raw_key.storage_key LIKE '%/full.webp'
        ),
        legacy_aliases AS (
          SELECT '/api/images/' || image.id::text || '/file' AS alias
            FROM public.generated_images image
           WHERE image.asset_id = candidate_asset_id
             AND image.deleted_at IS NULL
          UNION
          SELECT '/api/projects/' || upload.project_id::text || '/uploads/' || upload.id::text || '/content'
            FROM public.project_uploads upload
            JOIN candidate ON upload.object_path = candidate.storage_key
          UNION
          SELECT '/api/ora/assets/' || ora.id::text || '/download'
            FROM public.ora_assets ora
           WHERE ora.asset_id = candidate_asset_id
           -- A concurrent delete may soft-delete the library row before the
           -- authoritative post-lock reference check. Preserve the alias map so
           -- surviving durable rows still retain the underlying storage object.
        ),
        durable_rows(project_id, generated_image_id, row_json) AS (
          SELECT message.project_id, NULL::integer, to_jsonb(message) FROM public.chat_messages message
          UNION ALL SELECT task.project_id, NULL::integer, to_jsonb(task) FROM public.agent_tasks task
          UNION ALL
          SELECT tool_call.project_id, NULL::integer, to_jsonb(tool_call)
            FROM public.agent_tool_calls tool_call
          UNION ALL SELECT item.project_id, NULL::integer, to_jsonb(item) FROM public.zero_prompt_queue_items item
          UNION ALL SELECT entry.project_id, NULL::integer, to_jsonb(entry) FROM public.knowledge_entries entry
          UNION ALL SELECT file.project_id, NULL::integer, to_jsonb(file) FROM public.project_files file
          UNION ALL SELECT version.project_id, NULL::integer, to_jsonb(version) FROM public.project_versions version
          UNION ALL SELECT variant.project_id, NULL::integer, to_jsonb(variant) FROM public.canvas_variants variant
          -- Library and gallery rows survive source-project deletion, so they
          -- are deliberately global for exclusion purposes.
          UNION ALL SELECT NULL::integer, NULL::integer, to_jsonb(item) FROM public.canvas_variant_library item
          UNION ALL SELECT NULL::integer, NULL::integer, to_jsonb(template) FROM public.gallery_templates template
          UNION ALL SELECT inbox.project_id, NULL::integer, to_jsonb(inbox) FROM public.agent_inbox inbox
          UNION ALL
          SELECT task.project_id, NULL::integer, to_jsonb(event)
            FROM public.task_events event
            JOIN public.agent_tasks task ON task.id = event.task_id
          UNION ALL SELECT activity.project_id, NULL::integer, to_jsonb(activity) FROM public.project_activity activity
          UNION ALL SELECT edit.project_id, NULL::integer, to_jsonb(edit) FROM public.visual_edit_changes edit
          UNION ALL
          SELECT image.project_id, image.id, to_jsonb(image)
            FROM public.generated_images image
           WHERE image.deleted_at IS NULL
          UNION ALL
          SELECT ticket.project_id, NULL::integer, to_jsonb(ticket)
            FROM public.support_tickets ticket
        )
        SELECT
          EXISTS (
            SELECT 1
              FROM candidate
             WHERE (excluded_project_id IS NULL OR candidate.project_id IS DISTINCT FROM excluded_project_id)
               AND (candidate.version_id IS NOT NULL OR candidate.task_id IS NOT NULL OR candidate.message_id IS NOT NULL)
          )
          OR EXISTS (
            SELECT 1
              FROM public.asset_usage usage_row
             WHERE usage_row.asset_id = candidate_asset_id
               AND (excluded_project_id IS NULL OR usage_row.project_id IS DISTINCT FROM excluded_project_id)
               AND (
                 excluded_project_id IS NULL
                 OR usage_row.consumer IS DISTINCT FROM
                    'project-purge-preserved-direct:' || excluded_project_id::text
               )
               AND (
                 excluded_generated_image_id IS NULL
                 OR usage_row.consumer <> 'generated-image:' || excluded_generated_image_id::text
               )
          )
          OR EXISTS (
            SELECT 1
              FROM public.generated_images image
              JOIN candidate ON TRUE
             WHERE image.deleted_at IS NULL
               AND image.id <> COALESCE(excluded_generated_image_id, -1)
               AND (excluded_project_id IS NULL OR image.project_id IS DISTINCT FROM excluded_project_id)
               AND (
                 image.asset_id = candidate_asset_id
                 OR COALESCE(image.storage_key, 'legacy-generated/' || image.id::text) = candidate.storage_key
               )
          )
          OR EXISTS (
            SELECT 1
              FROM public.project_uploads upload
              JOIN candidate_keys ON upload.object_path = candidate_keys.storage_key
             WHERE (excluded_project_id IS NULL OR upload.project_id IS DISTINCT FROM excluded_project_id)
               AND (
                 excluded_project_upload_id IS NULL
                 OR upload.id IS DISTINCT FROM excluded_project_upload_id
                 OR NOT EXISTS (
                   SELECT 1 FROM candidate
                    WHERE candidate.source = 'legacy-project-upload'
                      AND candidate.project_id = upload.project_id
                      AND candidate.storage_key = upload.object_path
                 )
               )
          )
          OR EXISTS (
            SELECT 1
              FROM public.asset_analysis_events analysis
             WHERE analysis.asset_id = candidate_asset_id
               AND analysis.status IN ('queued', 'started')
               AND (excluded_project_id IS NULL OR analysis.project_id IS DISTINCT FROM excluded_project_id)
          )
          OR EXISTS (
            SELECT 1
              FROM public.assets derivative
             WHERE derivative.state IN ('reserved', 'uploading', 'ready', 'deleting')
               AND derivative.context ->> 'derivativeOfAssetId' = candidate_asset_id::text
               AND (excluded_project_id IS NULL OR derivative.project_id IS DISTINCT FROM excluded_project_id)
          )
          OR EXISTS (
            SELECT 1
             FROM durable_rows durable
              JOIN candidate ON TRUE
             WHERE (excluded_project_id IS NULL OR durable.project_id IS DISTINCT FROM excluded_project_id)
               AND (
                 excluded_generated_image_id IS NULL
                 OR durable.generated_image_id IS DISTINCT FROM excluded_generated_image_id
               )
               AND (
                 candidate_asset_id IN (
                   SELECT public.extract_durable_asset_ids(durable.row_json)
                 )
                 OR EXISTS (
                   SELECT 1
                     FROM candidate_keys candidate_key
                    WHERE position(candidate_key.storage_key in durable.row_json::text) > 0
                 )
                 OR EXISTS (
                   SELECT 1 FROM legacy_aliases alias_row
                    WHERE position(alias_row.alias in durable.row_json::text) > 0
                 )
               )
          )
      $$ LANGUAGE SQL STABLE SECURITY INVOKER
         SET search_path = pg_catalog, public
    `);
    await client.query(`
      -- Keep the established three-argument contract without a defaulted
      -- overload. Only the upload deletion boundary may exclude one mapped row.
      CREATE OR REPLACE FUNCTION durable_asset_reference_exists(
        candidate_asset_id INTEGER,
        excluded_project_id INTEGER,
        excluded_generated_image_id INTEGER
      ) RETURNS BOOLEAN AS $$
        SELECT public.durable_asset_reference_exists_excluding_upload(
          candidate_asset_id, excluded_project_id, excluded_generated_image_id, NULL
        )
      $$ LANGUAGE SQL STABLE SECURITY INVOKER
         SET search_path = pg_catalog, public
    `);

    await client.query(`
      UPDATE public.asset_usage legacy_usage
         SET consumer='project-purge-preserved-direct:' || asset_row.project_id::text
        FROM public.assets asset_row
       WHERE legacy_usage.asset_id=asset_row.id
         AND legacy_usage.consumer='project-purge-preserved-direct'
         AND asset_row.project_id IS NOT NULL;

      DELETE FROM public.asset_usage legacy_usage
       WHERE legacy_usage.consumer='project-purge-preserved-direct'
         AND NOT EXISTS (
           SELECT 1 FROM public.assets asset_row
            WHERE asset_row.id=legacy_usage.asset_id
              AND asset_row.project_id IS NOT NULL
         );
    `);
    await client.query(`
      CREATE OR REPLACE FUNCTION require_attachable_assets_in_durable_reference()
      RETURNS TRIGGER AS $$
      DECLARE
        row_json JSONB;
        row_text TEXT;
        candidate_id INTEGER;
        current_state TEXT;
        legacy_key TEXT;
        durable_key TEXT;
        route_match TEXT[];
        image_id BIGINT;
        reference_project_id INTEGER;
        reference_user_id TEXT;
        asset_project_id INTEGER;
        asset_owner_user_id TEXT;
        asset_kind TEXT;
        asset_context JSONB;
        existing_reference BOOLEAN;
        asset_product_scope TEXT;
        reference_product_scope TEXT;
        locked_asset_ids INTEGER[] := ARRAY[]::integer[];
        locked_storage_keys TEXT[] := ARRAY[]::text[];
        upload_project_id BIGINT;
        upload_id BIGINT;
        ora_asset_id BIGINT;
        rechecked_asset_id INTEGER;
        rechecked_storage_key TEXT;
      BEGIN
        row_json := to_jsonb(NEW);
        row_text := row_json::text;
        reference_product_scope := CASE
          WHEN TG_TABLE_NAME='generated_images' THEN row_json ->> 'product_scope'
          WHEN TG_TABLE_NAME='support_tickets' THEN 'ora'
          ELSE 'nabuflow'
        END;
        IF TG_TABLE_NAME = 'generated_images' AND TG_OP = 'UPDATE' THEN
          IF NULLIF(to_jsonb(OLD) ->> 'deleted_at', '') IS NULL
             AND NULLIF(row_json ->> 'deleted_at', '') IS NOT NULL
             AND (row_json - 'deleted_at' - 'updated_at') =
                 (to_jsonb(OLD) - 'deleted_at' - 'updated_at') THEN
            RETURN NEW;
          END IF;
        END IF;
        -- Old object URLs must cross the governed asset-adoption boundary.
        -- Match either an exact known key or the only production shape ever
        -- issued by the retired signer; ordinary application routes that
        -- merely contain the /objects/ segment remain valid source code.
        SELECT storage_row.storage_key INTO legacy_key
          FROM public.asset_storage_objects storage_row
         WHERE storage_row.storage_backend = 'legacy-object'
           AND position(storage_row.storage_key in row_text) > 0
         LIMIT 1;
        IF legacy_key IS NOT NULL
           OR row_text ~ '/objects/uploads/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}' THEN
          RAISE EXCEPTION 'legacy_object_reference_unavailable' USING ERRCODE = '55000';
        END IF;
        reference_project_id := CASE
          WHEN TG_TABLE_NAME IN ('canvas_variant_library', 'gallery_templates')
            THEN NULLIF(row_json ->> 'source_project_id', '')::integer
          WHEN TG_TABLE_NAME = 'support_tickets'
            THEN NULL
          WHEN TG_TABLE_NAME = 'task_events'
            THEN (SELECT task.project_id FROM public.agent_tasks task
                   WHERE task.id=NULLIF(row_json ->> 'task_id', '')::integer)
          ELSE NULLIF(row_json ->> 'project_id', '')::integer
        END;
        reference_user_id := COALESCE(row_json ->> 'user_id', row_json ->> 'author_id');
        FOR candidate_id IN
          SELECT DISTINCT resolved.asset_id
            FROM public.resolve_durable_asset_ids(row_json) resolved(asset_id)
           ORDER BY resolved.asset_id
        LOOP
          SELECT state, project_id, owner_user_id, kind, context, product_scope
            INTO current_state, asset_project_id, asset_owner_user_id, asset_kind, asset_context, asset_product_scope
            FROM public.assets
           WHERE id = candidate_id
           FOR SHARE;
          locked_asset_ids := array_append(locked_asset_ids, candidate_id);
          IF current_state IS DISTINCT FROM 'ready'
             AND NOT (
               TG_TABLE_NAME = 'generated_images'
               AND TG_OP = 'UPDATE'
               AND candidate_id = NULLIF(row_json ->> 'asset_id', '')::integer
               AND asset_kind = 'generated'
               AND asset_owner_user_id IS NOT DISTINCT FROM reference_user_id
               AND asset_project_id IS NOT DISTINCT FROM reference_project_id
               AND asset_context ->> 'generatedImageId' = row_json ->> 'id'
               AND NULLIF(row_json ->> 'storage_key', '') IS NULL
               AND NULLIF(row_json ->> 'file_url', '') IS NULL
               AND NULLIF(row_json ->> 'thumbnail_url', '') IS NULL
               AND (
                 (
                   current_state = 'reserved'
                   AND NULLIF(to_jsonb(OLD) ->> 'asset_id', '') IS NULL
                   AND row_json ->> 'status' = 'pending'
                   AND (row_json - 'asset_id' - 'updated_at') =
                       (to_jsonb(OLD) - 'asset_id' - 'updated_at')
                 )
                 OR (
                   current_state = 'uploading'
                   AND NULLIF(to_jsonb(OLD) ->> 'asset_id', '')::integer = candidate_id
                   AND to_jsonb(OLD) ->> 'status' = 'pending'
                   AND row_json ->> 'status' = 'generating'
                   AND (row_json - 'status' - 'updated_at') =
                       (to_jsonb(OLD) - 'status' - 'updated_at')
                 )
               )
             ) THEN
            RAISE EXCEPTION 'asset_not_ready' USING ERRCODE = '55000';
          END IF;
          existing_reference := FALSE;
          IF TG_OP = 'UPDATE' THEN
            existing_reference := candidate_id IN (
              SELECT public.resolve_durable_asset_ids(to_jsonb(OLD))
            ) AND (row_json ->> 'project_id') IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'project_id')
              AND (row_json ->> 'source_project_id') IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'source_project_id')
              AND (row_json ->> 'task_id') IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'task_id')
              AND (row_json ->> 'user_id') IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'user_id')
              AND (row_json ->> 'author_id') IS NOT DISTINCT FROM (to_jsonb(OLD) ->> 'author_id');
          END IF;
          IF TG_TABLE_NAME = 'support_tickets' THEN
            existing_reference := FALSE;
          END IF;
          IF NOT existing_reference AND
             (asset_product_scope IS NULL OR asset_product_scope IS DISTINCT FROM reference_product_scope) THEN
            RAISE EXCEPTION 'asset_reference_forbidden' USING ERRCODE='42501';
          END IF;
          IF reference_project_id IS NOT NULL
             AND asset_project_id IS DISTINCT FROM reference_project_id
             AND NOT existing_reference
             AND NOT EXISTS (
               SELECT 1 FROM public.asset_usage usage_row
                WHERE usage_row.asset_id=candidate_id
                  AND usage_row.project_id=reference_project_id
                  AND usage_row.consumer='explicit-project-use:v1'
                  AND usage_row.artifact_id IS NULL
                  AND usage_row.version_id IS NULL
                  AND usage_row.file_path IS NULL
             ) THEN
            RAISE EXCEPTION 'asset_reference_forbidden' USING ERRCODE = '42501';
          END IF;
          IF reference_project_id IS NULL
             AND reference_user_id IS NOT NULL
             AND asset_owner_user_id IS DISTINCT FROM reference_user_id
             AND NOT existing_reference THEN
            RAISE EXCEPTION 'asset_reference_forbidden' USING ERRCODE = '42501';
          END IF;
        END LOOP;
        FOR durable_key IN
          SELECT deduplicated.storage_key
            FROM (
              SELECT DISTINCT resolved.storage_key
                FROM public.resolve_durable_storage_keys(row_json) resolved(storage_key)
            ) AS deduplicated
           ORDER BY deduplicated.storage_key COLLATE "C"
        LOOP
          PERFORM pg_advisory_xact_lock_shared(
            hashtextextended('nabuflow:durable-object:' || durable_key, 0)
          );
          locked_storage_keys := array_append(locked_storage_keys, durable_key);
          IF EXISTS (
            SELECT 1 FROM public.durable_asset_deletion_claims claim
             WHERE claim.storage_key=durable_key
          ) THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
        END LOOP;
        FOR route_match IN
          SELECT match
            FROM regexp_matches(
              row_text,
              '/api/images/([1-9][0-9]{0,9})/file([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        LOOP
          image_id := route_match[1]::bigint;
          IF image_id > 2147483647 THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          PERFORM 1 FROM public.generated_images image
           WHERE image.id=image_id::integer AND image.deleted_at IS NULL
           FOR KEY SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
        END LOOP;
        FOR route_match IN
          SELECT match
            FROM regexp_matches(
              row_text,
              '/api/ora/assets/([1-9][0-9]{0,9})/download([^A-Za-z0-9_/-]|$)',
              'g'
            ) AS match
        LOOP
          ora_asset_id := route_match[1]::bigint;
          IF ora_asset_id > 2147483647 THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE='55000';
          END IF;
          SELECT asset.id, asset.storage_key
            INTO rechecked_asset_id, rechecked_storage_key
            FROM public.ora_assets ora
            JOIN public.assets asset
              ON asset.id = ora.asset_id
             AND asset.owner_user_id = ora.user_id
             AND asset.product_scope = 'ora'
           WHERE ora.id = ora_asset_id::integer
             AND ora.deleted_at IS NULL
             AND asset.state = 'ready'
           FOR SHARE OF ora, asset;
          IF NOT FOUND OR rechecked_asset_id IS NULL OR rechecked_storage_key IS NULL
             OR NOT (rechecked_asset_id=ANY(locked_asset_ids))
             OR NOT (rechecked_storage_key=ANY(locked_storage_keys)) THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE='55000';
          END IF;
        END LOOP;
        -- Resolve upload aliases again AFTER all asset/key waits. An old resolver
        -- result cannot authorize a row whose alias metadata was purged/remapped.
        FOR route_match IN
          SELECT match FROM regexp_matches(
            row_text,
            '/api/projects/([1-9][0-9]{0,9})/uploads/([1-9][0-9]{0,9})/content([^A-Za-z0-9_/-]|$)',
            'g'
          ) AS match
        LOOP
          upload_project_id := route_match[1]::bigint;
          upload_id := route_match[2]::bigint;
          IF upload_project_id > 2147483647 OR upload_id > 2147483647 THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE='55000';
          END IF;
          SELECT asset.id, upload.object_path
            INTO rechecked_asset_id, rechecked_storage_key
            FROM public.project_uploads upload
            JOIN public.assets asset
              ON asset.project_id=upload.project_id
             AND asset.source='legacy-project-upload'
             AND asset.storage_key=upload.object_path
           WHERE upload.project_id=upload_project_id::integer
             AND upload.id=upload_id::integer
             AND asset.state='ready'
           FOR SHARE OF upload;
          IF NOT FOUND OR rechecked_asset_id IS NULL OR rechecked_storage_key IS NULL
             OR NOT (rechecked_asset_id=ANY(locked_asset_ids))
             OR NOT (rechecked_storage_key=ANY(locked_storage_keys)) THEN
            RAISE EXCEPTION 'asset_reference_unavailable' USING ERRCODE='55000';
          END IF;
        END LOOP;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql SECURITY INVOKER
         SET search_path = pg_catalog, public
    `);
    await client.query(`
      DO $$
      DECLARE guard RECORD;
      BEGIN
        FOR guard IN
          SELECT * FROM (VALUES
            ('chat_messages', 'project_id, attachments'),
            ('agent_tasks', 'project_id, attachments, report, staging_snapshot'),
            ('agent_tool_calls', 'project_id, stdout_preview, args_summary'),
            ('zero_prompt_queue_items', 'project_id, asset_ids, current_text'),
            ('knowledge_entries', 'project_id, annotation'),
            ('project_files', 'project_id, content'),
            ('project_versions', 'project_id, files_snapshot'),
            ('canvas_variants', 'project_id, files'),
            ('canvas_variant_library', 'source_project_id, files'),
            ('gallery_templates', 'source_project_id, files_snapshot'),
            ('agent_inbox', 'project_id, screenshot_url'),
            ('task_events', 'task_id, message, data'),
            ('project_activity', 'project_id, metadata'),
            ('visual_edit_changes', 'project_id, before_content, after_content'),
            ('generated_images', 'project_id, user_id, asset_id, storage_key, file_url, thumbnail_url, deleted_at, status'),
            ('support_tickets', 'user_id, project_id, transcript, attachments')
          ) AS guards(table_name, column_list)
        LOOP
          EXECUTE format(
            'DROP TRIGGER IF EXISTS durable_asset_reference_guard_%I ON %I',
            guard.table_name,
            guard.table_name
          );
          EXECUTE format(
            'CREATE TRIGGER durable_asset_reference_guard_%I '
              || 'BEFORE INSERT OR UPDATE OF %s ON %I '
              || 'FOR EACH ROW EXECUTE FUNCTION require_attachable_assets_in_durable_reference()',
            guard.table_name,
            guard.column_list,
            guard.table_name
          );
        END LOOP;
      END $$
    `);
    const durableReferenceGuards = await client.query<{ guard_ready: boolean }>(`
      SELECT (
        (SELECT COUNT(*) = 16
           AND bool_and(NOT trigger_row.tgisinternal)
           AND bool_and(trigger_row.tgenabled = ANY(ARRAY['O', 'A']::"char"[]))
           AND bool_and(trigger_row.tgtype = 23)
           AND bool_and(trigger_row.tgqual IS NULL)
           AND bool_and(
             trigger_row.tgfoid =
               to_regprocedure('public.require_attachable_assets_in_durable_reference()')
           )
           AND bool_and(
             (SELECT string_agg(attribute.attname, ', ' ORDER BY trigger_column.ordinality)
                FROM unnest(trigger_row.tgattr::smallint[]) WITH ORDINALITY
                     AS trigger_column(attnum, ordinality)
                JOIN pg_catalog.pg_attribute attribute
                  ON attribute.attrelid=relation.oid
                 AND attribute.attnum=trigger_column.attnum) = expected.column_list
           )
          FROM (VALUES
            ('chat_messages', 'project_id, attachments'),
            ('agent_tasks', 'project_id, attachments, report, staging_snapshot'),
            ('agent_tool_calls', 'project_id, stdout_preview, args_summary'),
            ('zero_prompt_queue_items', 'project_id, asset_ids, current_text'),
            ('knowledge_entries', 'project_id, annotation'),
            ('project_files', 'project_id, content'),
            ('project_versions', 'project_id, files_snapshot'),
            ('canvas_variants', 'project_id, files'),
            ('canvas_variant_library', 'source_project_id, files'),
            ('gallery_templates', 'source_project_id, files_snapshot'),
            ('agent_inbox', 'project_id, screenshot_url'),
            ('task_events', 'task_id, message, data'),
            ('project_activity', 'project_id, metadata'),
            ('visual_edit_changes', 'project_id, before_content, after_content'),
            ('generated_images', 'project_id, user_id, asset_id, storage_key, file_url, thumbnail_url, deleted_at, status'),
            ('support_tickets', 'user_id, project_id, transcript, attachments')
          ) AS expected(table_name, column_list)
          JOIN pg_catalog.pg_class relation ON relation.relname = expected.table_name
          JOIN pg_catalog.pg_trigger trigger_row ON trigger_row.tgrelid = relation.oid
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname = 'public'
           AND trigger_row.tgname = 'durable_asset_reference_guard_' || relation.relname
           AND trigger_row.tgfoid =
               to_regprocedure('public.require_attachable_assets_in_durable_reference()'))
        AND to_regprocedure('public.extract_durable_asset_ids(jsonb)') IS NOT NULL
        AND to_regprocedure('public.resolve_durable_asset_ids(jsonb)') IS NOT NULL
        AND regexp_replace(
              lower(pg_get_functiondef(
                to_regprocedure('public.resolve_durable_asset_ids(jsonb)')
              )),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%join public.asset_storage_objects storage_row on storage_row.storage_key = matched.storage_match[1]%'
        AND pg_get_functiondef(
              to_regprocedure('public.resolve_durable_asset_ids(jsonb)')
            ) LIKE '%?#<>(){},;%'
        AND to_regclass('public.durable_asset_deletion_claims') IS NOT NULL
        AND to_regprocedure('public.resolve_durable_storage_keys(jsonb)') IS NOT NULL
        AND pg_get_functiondef(
              to_regprocedure('public.resolve_durable_storage_keys(jsonb)')
            ) LIKE '%?#<>(){},;%'
        AND regexp_replace(
              lower(pg_get_functiondef(
                to_regprocedure('public.require_attachable_assets_in_durable_reference()')
              )),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%pg_advisory_xact_lock_shared%'
        AND regexp_replace(
              lower(pg_get_functiondef(
                to_regprocedure('public.require_attachable_assets_in_durable_reference()')
              )),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%from public.durable_asset_deletion_claims%'
        AND regexp_replace(
              lower(pg_get_functiondef(
                to_regprocedure('public.require_attachable_assets_in_durable_reference()')
              )),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%asset_context ->> ''generatedimageid'' = row_json ->> ''id''%'
        AND regexp_replace(
              lower(pg_get_functiondef(
                to_regprocedure('public.require_attachable_assets_in_durable_reference()')
              )),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%row_json - ''asset_id'' - ''updated_at''%'
        AND regexp_replace(
              lower(pg_get_functiondef(
                to_regprocedure('public.require_attachable_assets_in_durable_reference()')
              )),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%row_json - ''status'' - ''updated_at''%'
        AND to_regprocedure(
              'public.durable_asset_reference_exists(integer,integer,integer)'
            ) IS NOT NULL
        AND regexp_replace(
              lower(pg_get_functiondef(to_regprocedure(
                'public.durable_asset_reference_exists_excluding_upload(integer,integer,integer,integer)'
              ))),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%from public.asset_storage_objects storage_row%'
        AND regexp_replace(
              lower(pg_get_functiondef(to_regprocedure(
                'public.durable_asset_reference_exists_excluding_upload(integer,integer,integer,integer)'
              ))),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%project-purge-preserved-direct:%'
        AND to_regprocedure('public.durable_asset_reference_exists_excluding_upload(integer,integer,integer,integer)') IS NOT NULL
        AND regexp_replace(
              lower(pg_get_functiondef(to_regprocedure(
                'public.durable_asset_reference_exists(integer,integer,integer)'
              ))),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%select public.durable_asset_reference_exists_excluding_upload( candidate_asset_id, excluded_project_id, excluded_generated_image_id, null )%'
        AND regexp_replace(
              lower(pg_get_functiondef(to_regprocedure(
                'public.durable_asset_reference_exists_excluding_upload(integer,integer,integer,integer)'
              ))),
              '[[:space:]]+', ' ', 'g'
            ) LIKE '%upload.id is distinct from excluded_project_upload_id%candidate.source = ''legacy-project-upload''%candidate.project_id = upload.project_id%candidate.storage_key = upload.object_path%'
      ) AS guard_ready
    `);
    if (durableReferenceGuards.rows[0]?.guard_ready !== true) {
      throw new Error("durable_asset_reference_guards_missing");
    }

    // Preserve existing metadata before new callers adopt the shared registry.
    // Generated image byte sizes are unknown in the legacy table and stay zero
    // until a governed provider-HEAD migration measures them.
    await client.query(`
      INSERT INTO assets (
        owner_user_id, actor_user_id, product_scope, project_id, scope, kind, source, filename, mime_type,
        size_bytes, storage_backend, storage_key, state, scan_state,
        created_at, ready_at, deleted_at
      )
      SELECT
        user_id,
        user_id,
        product_scope,
        project_id,
        CASE WHEN project_id IS NULL THEN 'account' ELSE 'project' END,
        CASE WHEN source_type = 'uploaded' THEN 'image' ELSE 'generated' END,
        source_type,
        'image-' || id || '.webp',
        'image/webp',
        0,
        CASE WHEN storage_key IS NULL THEN 'legacy-url' ELSE 'r2' END,
        COALESCE(storage_key, 'legacy-generated/' || id),
        CASE WHEN deleted_at IS NULL THEN 'ready' ELSE 'deleted' END,
        'not-scanned',
        created_at,
        CASE WHEN status = 'completed' THEN updated_at ELSE NULL END,
        deleted_at
      FROM generated_images
      WHERE status = 'completed'
      ON CONFLICT (storage_key) DO NOTHING
    `);
    await client.query(`
      UPDATE generated_images image
         SET product_scope = 'nabuflow'
        FROM assets asset
       WHERE image.product_scope IS NULL
         AND image.asset_id = asset.id
         AND asset.product_scope = 'nabuflow'
         AND asset.owner_user_id = image.user_id
         AND asset.project_id IS NOT DISTINCT FROM image.project_id
    `);
    await client.query(`
      UPDATE assets asset
         SET product_scope = 'nabuflow'
       WHERE asset.product_scope IS NULL
         AND public.asset_has_verified_nabuflow_provenance(asset.id)
    `);
    await client.query(`
      UPDATE generated_images image
         SET asset_id = asset.id,
             updated_at = NOW()
        FROM assets asset
       WHERE image.asset_id IS NULL
         AND image.status = 'completed'
         AND image.product_scope IS NOT NULL
         AND asset.product_scope IS NOT DISTINCT FROM image.product_scope
         AND asset.project_id IS NOT DISTINCT FROM image.project_id
         AND asset.state = 'ready'
         AND asset.storage_backend = 'r2'
         AND asset.owner_user_id = image.user_id
         AND asset.storage_key = COALESCE(image.storage_key, 'legacy-generated/' || image.id::text)
    `);
    await client.query(`
      INSERT INTO asset_storage_objects (
        asset_id, storage_backend, storage_key, role, size_bytes, state, ready_at, deleted_at
      )
      SELECT id,
             storage_backend,
             storage_key,
             'primary',
             size_bytes,
             CASE
               WHEN state IN ('reserved', 'uploading') THEN state
               WHEN state = 'ready' THEN 'ready'
               WHEN state = 'deleting' THEN 'deleting'
               ELSE 'deleted'
             END,
             ready_at,
             deleted_at
        FROM assets
       WHERE storage_backend IN ('r2', 'legacy-object')
      ON CONFLICT (storage_key) DO NOTHING
    `);
    // Historical Image Studio thumbnails were not individually metered.  Their
    // deterministic keys are made durable now; a governed provider-HEAD audit
    // fills their exact byte sizes without guessing during startup.
    await client.query(`
      INSERT INTO asset_storage_objects (
        asset_id, storage_backend, storage_key, role, size_bytes, state, ready_at, deleted_at
      )
      SELECT asset.id,
             'r2',
             regexp_replace(asset.storage_key, '/full\\.webp$', '/thumb.webp'),
             'thumbnail',
             0,
             CASE
               WHEN asset.state IN ('reserved', 'uploading') THEN asset.state
               WHEN asset.state = 'ready' THEN 'ready'
               WHEN asset.state = 'deleting' THEN 'deleting'
               ELSE 'deleted'
             END,
             asset.ready_at,
             asset.deleted_at
        FROM generated_images image
        JOIN assets asset ON asset.id = image.asset_id
       WHERE asset.storage_backend = 'r2'
         AND asset.storage_key ~ '/full\\.webp$'
         AND image.thumbnail_url IS NOT NULL
      ON CONFLICT (storage_key) DO NOTHING
    `);
    await client.query(`
      INSERT INTO assets (
        owner_user_id, actor_user_id, product_scope, project_id, scope, kind, source, filename, mime_type,
        size_bytes, storage_backend, storage_key, state, scan_state, text_preview, created_at, ready_at
      )
      SELECT
        p.owner_id,
        COALESCE(u.uploader_id, p.owner_id),
        'nabuflow',
        u.project_id,
        'project',
        CASE WHEN u.mime_type LIKE 'image/%' THEN 'image' ELSE 'file' END,
        'legacy-project-upload',
        u.filename,
        u.mime_type,
        u.size_bytes,
        'legacy-object',
        u.object_path,
        'ready',
        'not-scanned',
        u.text_preview,
        u.created_at,
        u.created_at
      FROM project_uploads u
      JOIN projects p ON p.id = u.project_id
      ON CONFLICT (storage_key) DO NOTHING
    `);
    await client.query(`
      UPDATE assets asset
         SET product_scope = 'nabuflow'
       WHERE asset.product_scope IS NULL
         AND public.asset_has_verified_nabuflow_provenance(asset.id)
    `);
    // The legacy upload mirror above can create assets during this very first
    // run.  Re-run the additive physical-object insert after the mirror so no
    // newly adopted object waits for a second boot to gain a deletion receipt.
    await client.query(`
      INSERT INTO asset_storage_objects (
        asset_id, storage_backend, storage_key, role, size_bytes, state, ready_at, deleted_at
      )
      SELECT id,
             storage_backend,
             storage_key,
             'primary',
             size_bytes,
             CASE
               WHEN state IN ('reserved', 'uploading') THEN state
               WHEN state = 'ready' THEN 'ready'
               WHEN state = 'deleting' THEN 'deleting'
               ELSE 'deleted'
             END,
             ready_at,
             deleted_at
        FROM assets
       WHERE storage_backend IN ('r2', 'legacy-object')
      ON CONFLICT (storage_key) DO NOTHING
    `);
    // Backfill every structured durable reference into one deletion ledger.
    // Each statement is additive and safe to replay; the direct-store checks in
    // deleteReadyAsset remain an independent belt-and-suspenders proof.
    await client.query(`
      INSERT INTO asset_usage (asset_id, project_id, version_id, consumer)
      SELECT id, project_id, version_id, 'asset-version:' || version_id::text
        FROM assets
       WHERE state = 'ready' AND version_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      INSERT INTO asset_usage (asset_id, project_id, consumer)
      SELECT id, project_id, 'asset-task:' || task_id::text
        FROM assets
       WHERE state = 'ready' AND task_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      WITH refs AS (
        SELECT activity.id AS activity_id,
               activity.project_id,
               asset_id
          FROM project_activity activity
          CROSS JOIN LATERAL (
            SELECT jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(activity.metadata -> 'assetIds') = 'array'
                  THEN activity.metadata -> 'assetIds'
                ELSE '[]'::jsonb
              END
            ) AS asset_id
            UNION
            SELECT jsonb_array_elements_text(
              CASE
                WHEN jsonb_typeof(activity.metadata -> 'originalAssetIds') = 'array'
                  THEN activity.metadata -> 'originalAssetIds'
                ELSE '[]'::jsonb
              END
            ) AS asset_id
          ) extracted
         WHERE extracted.asset_id ~ '^[1-9][0-9]*$'
      )
      INSERT INTO asset_usage (asset_id, project_id, consumer)
      SELECT refs.asset_id::integer,
             refs.project_id,
             'queue-provenance:' || refs.activity_id::text
        FROM refs
        JOIN assets a ON a.id = refs.asset_id::integer AND a.state = 'ready'
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      INSERT INTO asset_usage (asset_id, project_id, consumer)
      SELECT id, project_id, 'asset-message:' || message_id::text
        FROM assets
       WHERE state = 'ready' AND message_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      INSERT INTO asset_usage (asset_id, project_id, consumer)
      SELECT gi.asset_id, gi.project_id, 'generated-image:' || gi.id::text
        FROM generated_images gi
        JOIN assets a ON a.id = gi.asset_id AND a.state = 'ready'
       WHERE gi.asset_id IS NOT NULL AND gi.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      WITH extracted AS (
        SELECT cm.id AS message_id,
               cm.project_id,
               CASE
                 WHEN jsonb_typeof(item -> 'assetId') = 'number'
                   THEN (item ->> 'assetId')::integer
                 ELSE NULLIF(substring(item ->> 'url' FROM '^/api/assets/([0-9]+)/content$'), '')::integer
               END AS asset_id
          FROM chat_messages cm
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(cm.attachments) = 'array' THEN cm.attachments ELSE '[]'::jsonb END
          ) AS item
      )
      INSERT INTO asset_usage (asset_id, project_id, consumer)
      SELECT extracted.asset_id,
             extracted.project_id,
             'chat-message:' || extracted.message_id::text
        FROM extracted
        JOIN assets a ON a.id = extracted.asset_id AND a.state = 'ready'
       WHERE extracted.asset_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      WITH refs AS (
        SELECT file.project_id,
               file.artifact_id,
               file.path,
               (match)[1]::integer AS asset_id
          FROM project_files file
          CROSS JOIN LATERAL regexp_matches(
            file.content,
            '/api/assets/([1-9][0-9]*)/content',
            'g'
          ) AS match
      )
      INSERT INTO asset_usage (asset_id, project_id, artifact_id, file_path, consumer)
      SELECT refs.asset_id,
             refs.project_id,
             refs.artifact_id,
             refs.path,
             'project-file'
        FROM refs
        JOIN assets asset ON asset.id=refs.asset_id AND asset.state='ready'
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      WITH extracted AS (
        SELECT task.id AS task_id,
               task.project_id,
               NULLIF(substring(item ->> 'url' FROM '^/api/assets/([0-9]+)/content$'), '')::integer AS asset_id
          FROM agent_tasks task
          CROSS JOIN LATERAL jsonb_array_elements(
            CASE WHEN jsonb_typeof(task.attachments) = 'array' THEN task.attachments ELSE '[]'::jsonb END
          ) AS item
      )
      INSERT INTO asset_usage (asset_id, project_id, consumer)
      SELECT extracted.asset_id,
             extracted.project_id,
             'agent-task:' || extracted.task_id::text
        FROM extracted
        JOIN assets a ON a.id = extracted.asset_id AND a.state = 'ready'
       WHERE extracted.asset_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      WITH extracted AS (
        SELECT entry.id AS entry_id,
               NULLIF(
                 substring(entry.annotation FROM '"logoAssetId"[[:space:]]*:[[:space:]]*([0-9]+)'),
                 ''
               )::integer AS asset_id
          FROM knowledge_entries entry
         WHERE entry.type = 'style_memory'
           AND entry.category = 'brand_profile'
           AND entry.archived_at IS NULL
      )
      INSERT INTO asset_usage (asset_id, consumer)
      SELECT extracted.asset_id, 'brand-profile:' || extracted.entry_id::text
        FROM extracted
        JOIN assets a ON a.id = extracted.asset_id AND a.state = 'ready'
       WHERE extracted.asset_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      WITH derivative_refs AS (
        SELECT child.id,
               child.project_id,
               CASE
                 WHEN child.context ->> 'derivativeOfAssetId' ~ '^[1-9][0-9]*$'
                   THEN (child.context ->> 'derivativeOfAssetId')::integer
                 ELSE NULL
               END AS parent_asset_id
          FROM assets child
         WHERE child.state = 'ready'
      )
      INSERT INTO asset_usage (asset_id, project_id, consumer)
      SELECT derivative_refs.parent_asset_id,
             derivative_refs.project_id,
             'asset-derivative:' || derivative_refs.id::text
        FROM derivative_refs
        JOIN assets parent
          ON parent.id = derivative_refs.parent_asset_id
         AND parent.state = 'ready'
       WHERE derivative_refs.parent_asset_id IS NOT NULL
      ON CONFLICT DO NOTHING
    `);
    // Ora's durable Library is a metadata view over the same account-wide
    // asset registry. Adopt historical rows without copying bytes: R2 objects
    // keep their key, while old DB-backed blobs receive a typed legacy key and
    // remain readable through Ora's private compatibility path.
    await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS asset_id INTEGER`);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'ora_assets_asset_id_fkey'
        ) THEN
          ALTER TABLE ora_assets
            ADD CONSTRAINT ora_assets_asset_id_fkey
            FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE SET NULL;
        END IF;
      END $$
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS ora_assets_asset_id_uq
        ON ora_assets(asset_id) WHERE asset_id IS NOT NULL
    `);
    await client.query(`
      INSERT INTO account_asset_quota (user_id, used_bytes, reserved_bytes)
      SELECT owner_user_id,
             COALESCE(SUM(size_bytes) FILTER (WHERE state = 'ready'), 0),
             COALESCE(SUM(size_bytes) FILTER (WHERE state IN ('reserved', 'uploading')), 0)
        FROM assets
       GROUP BY owner_user_id
      ON CONFLICT (user_id) DO NOTHING
    `);
    await client.query(`
      WITH adopted AS (
        INSERT INTO assets (
          owner_user_id, actor_user_id, scope, kind, source, filename, mime_type,
          size_bytes, storage_backend, storage_key, state, scan_state,
          context, created_at, ready_at, deleted_at
        )
        SELECT
          ora.user_id,
          ora.user_id,
          'account',
          CASE WHEN ora.kind = 'image' THEN 'image' ELSE 'file' END,
          'ora-library-legacy',
          ora.file_name,
          ora.mime_type,
          ora.size_bytes,
          CASE WHEN ora.storage_key IS NULL THEN 'ora-db' ELSE 'r2' END,
          COALESCE(ora.storage_key, 'ora-db/' || ora.id::text),
          CASE WHEN ora.deleted_at IS NULL THEN 'ready' ELSE 'deleted' END,
          'not-required',
          jsonb_build_object('oraAssetId', ora.id, 'oraProjectId', ora.ora_project_id),
          ora.created_at,
          CASE WHEN ora.deleted_at IS NULL THEN ora.created_at ELSE NULL END,
          ora.deleted_at
        FROM ora_assets ora
        WHERE ora.asset_id IS NULL
        ON CONFLICT (storage_key) DO NOTHING
        RETURNING owner_user_id, size_bytes, state
      ), adoption_delta AS (
        SELECT owner_user_id,
               COALESCE(SUM(size_bytes) FILTER (WHERE state = 'ready'), 0) AS used_bytes,
               COALESCE(SUM(size_bytes) FILTER (WHERE state IN ('reserved', 'uploading')), 0)
                 AS reserved_bytes
          FROM adopted
         GROUP BY owner_user_id
      )
      UPDATE account_asset_quota quota
         SET used_bytes = quota.used_bytes + adoption_delta.used_bytes,
             reserved_bytes = quota.reserved_bytes + adoption_delta.reserved_bytes,
             updated_at = NOW()
        FROM adoption_delta
       WHERE quota.user_id = adoption_delta.owner_user_id
    `);
    await client.query(`
      UPDATE ora_assets ora
         SET asset_id = asset.id
        FROM assets asset
       WHERE ora.asset_id IS NULL
         AND asset.owner_user_id = ora.user_id
         AND asset.storage_key = COALESCE(ora.storage_key, 'ora-db/' || ora.id::text)
    `);
    await client.query(`
      INSERT INTO asset_storage_objects (
        asset_id, storage_backend, storage_key, role, size_bytes, state, ready_at, deleted_at
      )
      SELECT asset.id,
             asset.storage_backend,
             asset.storage_key,
             'primary',
             asset.size_bytes,
             CASE
               WHEN asset.state IN ('reserved', 'uploading') THEN asset.state
               WHEN asset.state = 'ready' THEN 'ready'
               WHEN asset.state = 'deleting' THEN 'deleting'
               ELSE 'deleted'
             END,
             asset.ready_at,
             asset.deleted_at
        FROM ora_assets ora
        JOIN assets asset ON asset.id = ora.asset_id
      ON CONFLICT (storage_key) DO NOTHING
    `);
    await client.query(`
      INSERT INTO asset_usage (asset_id, consumer)
      SELECT ora.asset_id, 'ora-library:' || ora.id::text
        FROM ora_assets ora
        JOIN assets asset ON asset.id = ora.asset_id AND asset.state = 'ready'
       WHERE ora.deleted_at IS NULL
      ON CONFLICT DO NOTHING
    `);
    await client.query(`
      INSERT INTO account_asset_quota (user_id, used_bytes, reserved_bytes)
      SELECT owner_user_id,
             COALESCE(SUM(size_bytes) FILTER (WHERE state = 'ready'), 0),
             COALESCE(SUM(size_bytes) FILTER (WHERE state IN ('reserved', 'uploading')), 0)
       FROM assets
       GROUP BY owner_user_id
      ON CONFLICT (user_id) DO NOTHING
    `);
    // Positive byte totals and legacy sources whose upload table already held
    // an exact size are measured facts. Adopted generated-image objects remain
    // NULL until the governed provider metadata reconciliation observes them;
    // this also distinguishes an observed, legitimate zero-byte object from an
    // unmeasured one.
    await client.query(`
      UPDATE asset_storage_objects object
         SET size_measured_at = COALESCE(object.ready_at, object.created_at, NOW())
        FROM assets asset
       WHERE asset.id=object.asset_id
         AND object.size_measured_at IS NULL
         AND (
           object.size_bytes > 0
           OR asset.source IN ('legacy-project-upload', 'ora-library-legacy')
         )
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function applyProjectCollaborationMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      DO $$
      BEGIN
        CREATE TYPE project_collaborator_role AS ENUM ('owner', 'publisher', 'editor', 'viewer');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`
      DO $$
      BEGIN
        CREATE TYPE project_invite_state AS ENUM ('pending', 'accepted', 'revoked', 'expired');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_collaborators (
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id      TEXT NOT NULL,
        role         project_collaborator_role NOT NULL,
        invited_by   TEXT NOT NULL,
        joined_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT project_collaborators_pk PRIMARY KEY (project_id, user_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_invites (
        id           SERIAL PRIMARY KEY,
        project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        email        TEXT,
        token_hash   TEXT NOT NULL UNIQUE,
        role         project_collaborator_role NOT NULL,
        status       project_invite_state NOT NULL DEFAULT 'pending',
        invited_by   TEXT NOT NULL,
        accepted_by  TEXT,
        expires_at   TIMESTAMPTZ NOT NULL,
        accepted_at  TIMESTAMPTZ,
        revoked_at   TIMESTAMPTZ,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_collaborators_user_idx
        ON project_collaborators(user_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_collaborators_workspace_idx
        ON project_collaborators(workspace_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_collaborators_project_role_idx
        ON project_collaborators(project_id, role)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_invites_project_status_idx
        ON project_invites(project_id, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_invites_email_idx
        ON project_invites(email)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS project_invites_pending_email_uq
        ON project_invites(project_id, email)
        WHERE status = 'pending' AND email IS NOT NULL
    `);
    // Every project owner is represented explicitly so the member list and
    // access predicate read the same source for legacy and new projects.
    await client.query(`
      INSERT INTO project_collaborators
        (project_id, workspace_id, user_id, role, invited_by, joined_at, updated_at)
      SELECT id, workspace_id, owner_id, 'owner', owner_id, created_at, NOW()
        FROM projects
      ON CONFLICT (project_id, user_id) DO UPDATE
        SET role = 'owner',
            workspace_id = EXCLUDED.workspace_id,
            updated_at = NOW()
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function applyAdminAccessFoundationMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_roles (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL UNIQUE,
        role        TEXT NOT NULL DEFAULT 'user',
        granted_by  TEXT,
        created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    // The former broad admin grant becomes the least-privileged operational role.
    await client.query(`UPDATE user_roles SET role = 'operator' WHERE role = 'admin'`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_access_receipts (
        id                  SERIAL PRIMARY KEY,
        actor_user_id       TEXT NOT NULL,
        actor_role          TEXT NOT NULL,
        kind                TEXT NOT NULL,
        action              TEXT NOT NULL,
        target_user_id      TEXT,
        target_workspace_id INTEGER,
        previous_role       TEXT,
        next_role           TEXT,
        reason              TEXT,
        outcome             TEXT NOT NULL,
        request_method      TEXT,
        request_path        TEXT,
        created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`ALTER TABLE admin_access_receipts ADD COLUMN IF NOT EXISTS reason TEXT`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS admin_access_receipts_actor_created_idx
        ON admin_access_receipts(actor_user_id, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS admin_access_receipts_target_user_created_idx
        ON admin_access_receipts(target_user_id, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS admin_access_receipts_workspace_created_idx
        ON admin_access_receipts(target_workspace_id, created_at)
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'user_roles_role_check'
             AND conrelid = 'user_roles'::regclass
        ) THEN
          ALTER TABLE user_roles
            ADD CONSTRAINT user_roles_role_check
            CHECK (role IN ('user', 'owner', 'operator', 'support', 'analyst'));
        END IF;
      END $$
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'admin_access_receipts_kind_check'
             AND conrelid = 'admin_access_receipts'::regclass
        ) THEN
          ALTER TABLE admin_access_receipts
            ADD CONSTRAINT admin_access_receipts_kind_check
            CHECK (kind IN ('access', 'action', 'role_change', 'refusal'));
        END IF;
      END $$
    `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function applySupportOperationsMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      ALTER TABLE support_tickets
        ADD COLUMN IF NOT EXISTS resolution_class TEXT,
        ADD COLUMN IF NOT EXISTS third_party_blocker TEXT,
        ADD COLUMN IF NOT EXISTS resolution_evidence JSONB,
        ADD COLUMN IF NOT EXISTS priority TEXT NOT NULL DEFAULT 'normal',
        ADD COLUMN IF NOT EXISTS assigned_to_user_id TEXT,
        ADD COLUMN IF NOT EXISTS resolved_by_user_id TEXT,
        ADD COLUMN IF NOT EXISTS resolved_by_role TEXT,
        ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ
    `);
    await client.query(`
      UPDATE support_tickets
         SET status = 'blocked_on_third_party'
       WHERE status = 'blocked'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_tickets_resolution_class_idx
        ON support_tickets(resolution_class, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_tickets_assignee_status_idx
        ON support_tickets(assigned_to_user_id, status, updated_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_tickets_priority_status_idx
        ON support_tickets(priority, status, updated_at)
    `);
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
           WHERE conname = 'support_tickets_priority_check'
             AND conrelid = 'support_tickets'::regclass
        ) THEN
          ALTER TABLE support_tickets
            ADD CONSTRAINT support_tickets_priority_check
            CHECK (priority IN ('low','normal','high','urgent'));
        END IF;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_access_grants (
        id            SERIAL PRIMARY KEY,
        ticket_id     INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        owner_user_id TEXT NOT NULL,
        staff_user_id TEXT NOT NULL,
        requested_by  TEXT NOT NULL,
        reason        TEXT NOT NULL,
        status        TEXT NOT NULL DEFAULT 'pending',
        requested_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at    TIMESTAMPTZ,
        expires_at    TIMESTAMPTZ,
        revoked_at    TIMESTAMPTZ,
        closed_at     TIMESTAMPTZ,
        CONSTRAINT support_access_grants_status_check
          CHECK (status IN ('pending','active','declined','revoked','expired','closed'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_access_grants_owner_status_idx
        ON support_access_grants(owner_user_id, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_access_grants_staff_status_idx
        ON support_access_grants(staff_user_id, status)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_access_grants_project_status_idx
        ON support_access_grants(project_id, status)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS support_access_grants_one_open_per_ticket_uq
        ON support_access_grants(ticket_id)
        WHERE status IN ('pending','active')
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_grant_events (
        id                 SERIAL PRIMARY KEY,
        grant_id           INTEGER NOT NULL REFERENCES support_access_grants(id) ON DELETE CASCADE,
        ticket_id          INTEGER NOT NULL,
        project_id         INTEGER NOT NULL,
        actor_user_id      TEXT NOT NULL,
        actor_display_name TEXT,
        event              TEXT NOT NULL,
        detail             JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_grant_events_grant_created_idx
        ON support_grant_events(grant_id, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_grant_events_project_created_idx
        ON support_grant_events(project_id, created_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_zero_sessions (
        id                 SERIAL PRIMARY KEY,
        ticket_id          INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        grant_id           INTEGER NOT NULL REFERENCES support_access_grants(id) ON DELETE RESTRICT,
        project_id         INTEGER NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
        staff_user_id      TEXT NOT NULL,
        status             TEXT NOT NULL DEFAULT 'diagnosing',
        evidence_bundle    JSONB NOT NULL,
        proposal           JSONB NOT NULL,
        approved_by        TEXT,
        declined_by        TEXT,
        task_id            INTEGER,
        applied_version_id INTEGER,
        terminal           JSONB,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        decided_at         TIMESTAMPTZ,
        completed_at       TIMESTAMPTZ,
        CONSTRAINT support_zero_sessions_status_check
          CHECK (status IN ('diagnosing','proposal_ready','approved','declined','applying','applied','interrupted'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_zero_sessions_ticket_created_idx
        ON support_zero_sessions(ticket_id, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_zero_sessions_grant_created_idx
        ON support_zero_sessions(grant_id, created_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS platform_defects (
        id              SERIAL PRIMARY KEY,
        fingerprint     TEXT NOT NULL UNIQUE,
        title           TEXT NOT NULL,
        status          TEXT NOT NULL DEFAULT 'open',
        evidence        JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_by      TEXT NOT NULL,
        shipped_version TEXT,
        shipped_at      TIMESTAMPTZ,
        verified_at     TIMESTAMPTZ,
        created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT platform_defects_status_check
          CHECK (status IN ('open','fixing','shipped','verified'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS platform_defects_status_updated_idx
        ON platform_defects(status, updated_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_ticket_defect_links (
        id        SERIAL PRIMARY KEY,
        ticket_id INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        defect_id INTEGER NOT NULL REFERENCES platform_defects(id) ON DELETE RESTRICT,
        linked_by TEXT NOT NULL,
        linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT support_ticket_defect_link_uq UNIQUE (ticket_id, defect_id)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS shared_profile_migration_receipts (
        id          SERIAL PRIMARY KEY,
        user_id     TEXT NOT NULL UNIQUE,
        source      TEXT NOT NULL,
        outcome     TEXT NOT NULL,
        migrated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS shared_profile_migration_outcome_idx
          ON shared_profile_migration_receipts(outcome, migrated_at)
      `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS support_user_deliveries (
        id                   SERIAL PRIMARY KEY,
        ticket_id            INTEGER NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
        project_id           INTEGER,
        recipient_user_id    TEXT NOT NULL,
        recipient_email      TEXT,
        kind                 TEXT NOT NULL,
        notification_id      INTEGER REFERENCES notifications(id) ON DELETE SET NULL,
        email_status         TEXT NOT NULL DEFAULT 'pending',
        email_failure_reason TEXT,
        created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        completed_at         TIMESTAMPTZ,
        CONSTRAINT support_user_deliveries_kind_check
          CHECK (kind IN ('access_request','proposal_ready','ticket_classified','ticket_reply','platform_fix_verified','project_fix_verified','external_guidance')),
        CONSTRAINT support_user_deliveries_email_status_check
          CHECK (email_status IN ('pending','sent','delivered','failed'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_user_deliveries_ticket_created_idx
        ON support_user_deliveries(ticket_id, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS support_user_deliveries_recipient_created_idx
        ON support_user_deliveries(recipient_user_id, created_at)
    `);
    await client.query(`
        ALTER TABLE chat_messages
          ADD COLUMN IF NOT EXISTS support_session_id INTEGER,
          ADD COLUMN IF NOT EXISTS provenance_actor_user_id TEXT
      `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS chat_messages_support_session_id_idx
          ON chat_messages(support_session_id) WHERE support_session_id IS NOT NULL
      `);
    await client.query(`
        ALTER TABLE agent_tasks
          ADD COLUMN IF NOT EXISTS support_session_id INTEGER,
          ADD COLUMN IF NOT EXISTS provenance_actor_user_id TEXT
      `);
    await client.query(`
        CREATE INDEX IF NOT EXISTS agent_tasks_support_session_id_idx
          ON agent_tasks(support_session_id) WHERE support_session_id IS NOT NULL
      `);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function applyZeroTerminalMigration(client: MigrationClient): Promise<void> {
  await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS terminal JSONB`);
  const verification = await client.query<{ terminal_ready: boolean }>(`
    SELECT EXISTS (
      SELECT 1
        FROM information_schema.columns
       WHERE table_schema = current_schema()
         AND table_name = 'agent_tasks'
         AND column_name = 'terminal'
         AND data_type = 'jsonb'
    ) AS terminal_ready
  `);
  if (verification.rows[0]?.terminal_ready !== true) {
    throw new Error("zero_terminal_schema_incomplete");
  }
}

export async function ensureKnowledgeUsageEventsSchema(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_usage_events (
      id                      BIGSERIAL   PRIMARY KEY,
      user_id                 TEXT        NOT NULL,
      query                   TEXT        NOT NULL,
      report_type             TEXT        NOT NULL DEFAULT 'knowledge-report',
      selected_entry_ids      INTEGER[]   NOT NULL DEFAULT '{}',
      selected_entry_versions INTEGER[]   NOT NULL DEFAULT '{}',
      entry_count             INTEGER     NOT NULL DEFAULT 0,
      created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_kue_user_id ON knowledge_usage_events (user_id)`,
  );
  await client.query(
    `CREATE INDEX IF NOT EXISTS idx_kue_created_at ON knowledge_usage_events (created_at)`,
  );
  await client.query("COMMIT");
}

async function addNotValidForeignKey(
  client: MigrationClient,
  tableName: string,
  constraintName: string,
  definition: string,
): Promise<void> {
  // Known Drizzle aliases require structural proof, not a name-only guess.
  const shape =
    /^FOREIGN KEY \(([a-z_]+)\) REFERENCES ([a-z_]+)\(([a-z_]+)\) ON DELETE (SET NULL|CASCADE)$/u.exec(
      definition,
    );
  if (!shape || !/^[a-z_]+$/u.test(tableName) || !/^[a-z_]+$/u.test(constraintName)) {
    throw new Error("startup_foreign_key_definition_unsupported");
  }
  const [, columnName, referencedTable, referencedColumn, deleteAction] = shape;
  const schemaConstraintName = `${tableName}_${columnName}_${referencedTable}_${referencedColumn}_fk`;
  await client.query(`
    LOCK TABLE public.${tableName} IN ACCESS EXCLUSIVE MODE;
    DO $$
    DECLARE
      candidate RECORD;
      retained_name NAME;
    BEGIN
      FOR candidate IN
        SELECT * FROM pg_constraint
         WHERE conrelid='public.${tableName}'::regclass
           AND conname IN ('${constraintName}'::name, '${schemaConstraintName}'::name)
      LOOP
        IF candidate.contype IS DISTINCT FROM 'f'
           OR candidate.conkey IS DISTINCT FROM ARRAY[(
             SELECT attnum FROM pg_attribute
              WHERE attrelid='public.${tableName}'::regclass
                AND attname='${columnName}' AND NOT attisdropped
           )]::smallint[]
           OR candidate.confrelid IS DISTINCT FROM 'public.${referencedTable}'::regclass
           OR candidate.confkey IS DISTINCT FROM ARRAY[(
             SELECT attnum FROM pg_attribute
              WHERE attrelid='public.${referencedTable}'::regclass
                AND attname='${referencedColumn}' AND NOT attisdropped
           )]::smallint[]
           OR candidate.confdeltype IS DISTINCT FROM '${deleteAction === "CASCADE" ? "c" : "n"}'
           OR candidate.confupdtype IS DISTINCT FROM 'a'
           OR candidate.confmatchtype IS DISTINCT FROM 's'
           OR candidate.confdelsetcols IS NOT NULL
           OR candidate.condeferrable OR candidate.condeferred
           OR NOT candidate.conislocal OR candidate.coninhcount <> 0
           OR candidate.conparentid <> 0 THEN
          RAISE EXCEPTION 'startup_foreign_key_definition_mismatch' USING ERRCODE='55000';
        END IF;
      END LOOP;
      SELECT conname INTO retained_name FROM pg_constraint
       WHERE conrelid='public.${tableName}'::regclass
         AND conname IN ('${constraintName}'::name, '${schemaConstraintName}'::name)
       ORDER BY convalidated DESC, (conname='${constraintName}'::name) DESC, conname
       LIMIT 1;
      IF retained_name IS NULL THEN
        ALTER TABLE public.${tableName}
          ADD CONSTRAINT ${constraintName} ${definition} NOT VALID;
      ELSE
        FOR candidate IN
          SELECT conname FROM pg_constraint
           WHERE conrelid='public.${tableName}'::regclass
             AND conname IN ('${constraintName}'::name, '${schemaConstraintName}'::name)
             AND conname <> retained_name
        LOOP
          EXECUTE format('ALTER TABLE public.%I DROP CONSTRAINT %I', '${tableName}', candidate.conname);
        END LOOP;
        IF retained_name IS DISTINCT FROM '${constraintName}'::name THEN
          EXECUTE format(
            'ALTER TABLE public.%I RENAME CONSTRAINT %I TO %I',
            '${tableName}',
            retained_name,
            '${constraintName}'
          );
        END IF;
      END IF;
    END $$
  `);
}

export async function applyKnowledgeProvenanceMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  await client.query(`
    ALTER TABLE knowledge_entries
      ADD COLUMN IF NOT EXISTS source_message_start_id INTEGER,
      ADD COLUMN IF NOT EXISTS source_message_end_id INTEGER
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_provenance_events (
      id                          BIGSERIAL PRIMARY KEY,
      knowledge_entry_id          INTEGER NOT NULL,
      outcome                     TEXT NOT NULL CHECK (outcome IN ('inserted', 'reinforced')),
      project_id                  INTEGER,
      source_message_start_id     INTEGER,
      source_message_end_id       INTEGER,
      source_task_id              INTEGER,
      source_version_id           INTEGER,
      claim_kind                  TEXT,
      actor_user_id               TEXT,
      semantics                   TEXT NOT NULL DEFAULT 'knowledge-provenance-v2',
      contributed_content_sha256  TEXT NOT NULL,
      resulting_content_sha256    TEXT NOT NULL,
      created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await client.query(`
    ALTER TABLE knowledge_provenance_events
      ADD COLUMN IF NOT EXISTS claim_kind TEXT,
      ADD COLUMN IF NOT EXISTS actor_user_id TEXT
  `);
  await client.query(`
    ALTER TABLE knowledge_provenance_events
      ALTER COLUMN semantics SET DEFAULT 'knowledge-provenance-v2'
  `);
  await client.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conname = 'knowledge_provenance_events_claim_kind_check'
           AND conrelid = 'knowledge_provenance_events'::regclass
      ) THEN
        ALTER TABLE knowledge_provenance_events
          ADD CONSTRAINT knowledge_provenance_events_claim_kind_check
          CHECK (claim_kind IS NULL OR claim_kind IN ('stated', 'observed', 'inferred'));
      END IF;
    END $$
  `);
  await client.query(`
    ALTER TABLE knowledge_provenance_events
      VALIDATE CONSTRAINT knowledge_provenance_events_claim_kind_check
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS knowledge_provenance_entry_idx
      ON knowledge_provenance_events (knowledge_entry_id, created_at)
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS knowledge_provenance_project_idx
      ON knowledge_provenance_events (project_id, created_at)
  `);
  await addNotValidForeignKey(
    client,
    "knowledge_entries",
    "knowledge_entries_source_message_start_fk",
    "FOREIGN KEY (source_message_start_id) REFERENCES chat_messages(id) ON DELETE SET NULL",
  );
  await addNotValidForeignKey(
    client,
    "knowledge_entries",
    "knowledge_entries_source_message_end_fk",
    "FOREIGN KEY (source_message_end_id) REFERENCES chat_messages(id) ON DELETE SET NULL",
  );
  await addNotValidForeignKey(
    client,
    "knowledge_provenance_events",
    "knowledge_provenance_events_entry_fk",
    "FOREIGN KEY (knowledge_entry_id) REFERENCES knowledge_entries(id) ON DELETE CASCADE",
  );
  await addNotValidForeignKey(
    client,
    "knowledge_provenance_events",
    "knowledge_provenance_events_project_fk",
    "FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL",
  );
  await addNotValidForeignKey(
    client,
    "knowledge_provenance_events",
    "knowledge_provenance_events_message_start_fk",
    "FOREIGN KEY (source_message_start_id) REFERENCES chat_messages(id) ON DELETE SET NULL",
  );
  await addNotValidForeignKey(
    client,
    "knowledge_provenance_events",
    "knowledge_provenance_events_message_end_fk",
    "FOREIGN KEY (source_message_end_id) REFERENCES chat_messages(id) ON DELETE SET NULL",
  );
  await addNotValidForeignKey(
    client,
    "knowledge_provenance_events",
    "knowledge_provenance_events_task_fk",
    "FOREIGN KEY (source_task_id) REFERENCES agent_tasks(id) ON DELETE SET NULL",
  );
  await addNotValidForeignKey(
    client,
    "knowledge_provenance_events",
    "knowledge_provenance_events_version_fk",
    "FOREIGN KEY (source_version_id) REFERENCES project_versions(id) ON DELETE SET NULL",
  );
  await client.query("COMMIT");
}

export async function applyMemoryVersionLineageMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  await client.query(`
    ALTER TABLE project_versions
      ADD COLUMN IF NOT EXISTS parent_version_id INTEGER
  `);
  await addNotValidForeignKey(
    client,
    "project_versions",
    "project_versions_parent_version_fk",
    "FOREIGN KEY (parent_version_id) REFERENCES project_versions(id) ON DELETE SET NULL",
  );
  await client.query(`
    WITH ordered AS (
      SELECT
        id,
        LAG(id) OVER (PARTITION BY project_id ORDER BY created_at, id) AS prior_version_id
      FROM project_versions
    )
    UPDATE project_versions AS version
       SET parent_version_id = ordered.prior_version_id
      FROM ordered
     WHERE version.id = ordered.id
       AND version.parent_version_id IS NULL
       AND ordered.prior_version_id IS NOT NULL
  `);
  await client.query(`
    ALTER TABLE project_versions
      VALIDATE CONSTRAINT project_versions_parent_version_fk
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS project_versions_project_parent_idx
      ON project_versions (project_id, parent_version_id)
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION set_project_version_parent()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.parent_version_id IS NULL THEN
        SELECT id
          INTO NEW.parent_version_id
          FROM project_versions
         WHERE project_id = NEW.project_id
         ORDER BY created_at DESC, id DESC
         LIMIT 1;
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS project_versions_set_parent ON project_versions
  `);
  await client.query(`
    CREATE TRIGGER project_versions_set_parent
    BEFORE INSERT ON project_versions
    FOR EACH ROW
    EXECUTE FUNCTION set_project_version_parent()
  `);
  await client.query(`
    WITH bindings AS (
      SELECT
        entry.id AS knowledge_entry_id,
        COALESCE(
          (
            SELECT version.id
              FROM project_versions AS version
             WHERE version.project_id = entry.project_id
               AND version.created_at <= entry.created_at
             ORDER BY version.created_at DESC, version.id DESC
             LIMIT 1
          ),
          (
            SELECT version.id
              FROM project_versions AS version
             WHERE version.project_id = entry.project_id
             ORDER BY version.created_at, version.id
             LIMIT 1
          )
        ) AS version_id
      FROM knowledge_entries AS entry
      WHERE entry.project_id IS NOT NULL
        AND entry.related_version_id IS NULL
        AND COALESCE(entry.origin, 'builder') <> 'ora'
    )
    UPDATE knowledge_entries AS entry
       SET related_version_id = bindings.version_id
      FROM bindings
     WHERE entry.id = bindings.knowledge_entry_id
       AND bindings.version_id IS NOT NULL
  `);
  await client.query(`
    CREATE OR REPLACE FUNCTION bind_first_project_version_memory()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF NEW.parent_version_id IS NULL THEN
        UPDATE knowledge_entries
           SET related_version_id = NEW.id
         WHERE project_id = NEW.project_id
           AND related_version_id IS NULL
           AND COALESCE(origin, 'builder') <> 'ora';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await client.query(`
    DROP TRIGGER IF EXISTS project_versions_bind_first_memory ON project_versions
  `);
  await client.query(`
    CREATE TRIGGER project_versions_bind_first_memory
    AFTER INSERT ON project_versions
    FOR EACH ROW
    EXECUTE FUNCTION bind_first_project_version_memory()
  `);
  await client.query("COMMIT");
}

export async function applyProjectSummaryProvenanceMigration(
  client: MigrationClient,
): Promise<void> {
  await client.query("BEGIN");
  await client.query(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS last_task_summary_provenance JSONB,
      ADD COLUMN IF NOT EXISTS summary_provenance JSONB
  `);
  await client.query("COMMIT");
}

export async function applyPlanSnapshotProvenanceMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  await client.query(`
    ALTER TABLE project_versions
      ADD COLUMN IF NOT EXISTS plan_source_message_id INTEGER
  `);
  await addNotValidForeignKey(
    client,
    "project_versions",
    "project_versions_plan_source_message_fk",
    "FOREIGN KEY (plan_source_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL",
  );
  await client.query("COMMIT");
}

export interface CredentialBackfillResult {
  mcpServersEncrypted: number;
  purchasedDomainsEncrypted: number;
  skippedBecauseEncryptionUnavailable: boolean;
}

/**
 * Encrypt the two legacy credential columns in-place using the active platform cipher.
 * Existing versioned ciphertext is skipped, and each update is compare-and-set so a
 * concurrent credential replacement cannot be overwritten by stale migration data.
 */
export async function backfillStoredIntegrationCredentials(
  client: Pick<import("pg").PoolClient, "query">,
  service: EncryptionService = encryptionService,
): Promise<CredentialBackfillResult> {
  if (service.isDevelopmentOnly) {
    return {
      mcpServersEncrypted: 0,
      purchasedDomainsEncrypted: 0,
      skippedBecauseEncryptionUnavailable: true,
    };
  }

  let mcpServersEncrypted = 0;
  let purchasedDomainsEncrypted = 0;

  await client.query("BEGIN");
  try {
    const mcpRows = await client.query<{ id: number; auth_header: string }>(
      `SELECT id, auth_header
         FROM mcp_servers
        WHERE auth_header IS NOT NULL`,
    );
    for (const row of mcpRows.rows) {
      if (isEncryptedValue(row.auth_header)) {
        service.decrypt(row.auth_header);
        continue;
      }
      const result = await client.query(
        `UPDATE mcp_servers
            SET auth_header = $1,
                updated_at = now()
          WHERE id = $2
            AND auth_header = $3`,
        [service.encrypt(row.auth_header), row.id, row.auth_header],
      );
      mcpServersEncrypted += result.rowCount ?? 0;
    }

    const domainRows = await client.query<{ id: number; transfer_auth_code: string }>(
      `SELECT id, transfer_auth_code
         FROM purchased_domains
        WHERE transfer_auth_code IS NOT NULL`,
    );
    for (const row of domainRows.rows) {
      if (isEncryptedValue(row.transfer_auth_code)) {
        service.decrypt(row.transfer_auth_code);
        continue;
      }
      const result = await client.query(
        `UPDATE purchased_domains
            SET transfer_auth_code = $1,
                updated_at = now()
          WHERE id = $2
            AND transfer_auth_code = $3`,
        [service.encrypt(row.transfer_auth_code), row.id, row.transfer_auth_code],
      );
      purchasedDomainsEncrypted += result.rowCount ?? 0;
    }

    await client.query("COMMIT");
    return {
      mcpServersEncrypted,
      purchasedDomainsEncrypted,
      skippedBecauseEncryptionUnavailable: false,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

/** Drop the legacy shared-owner default and add the missing ownership lookup indexes. */
export async function applyProjectOwnerSchemaHardening(
  client: Pick<import("pg").PoolClient, "query">,
): Promise<void> {
  await client.query(`ALTER TABLE projects ALTER COLUMN owner_id DROP DEFAULT`);
  await client.query(
    `CREATE INDEX IF NOT EXISTS workspaces_owner_user_idx ON workspaces(owner_user_id)`,
  );
  await client.query(`CREATE INDEX IF NOT EXISTS projects_owner_idx ON projects(owner_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS projects_workspace_idx ON projects(workspace_id)`);
}

export interface WorkspaceFoundationBackfillResult {
  existingWorkspaceOwnerMembershipsCreated: number;
  defaultWorkspacesCreated: number;
  defaultWorkspaceOwnerMembershipsCreated: number;
}

/**
 * Establish workspace membership and signup defaults without using a display name as identity.
 * The application has no canonical local users table, so the backfill enumerates every durable
 * user-bearing table. Optional cached profile names are display copy only and fall back to
 * "My workspace".
 */
export async function applyWorkspaceFoundationMigration(
  client: Pick<import("pg").PoolClient, "query">,
): Promise<WorkspaceFoundationBackfillResult> {
  await client.query("BEGIN");
  try {
    await client.query(`
      DO $$
      BEGIN
        CREATE TYPE workspace_member_role AS ENUM ('owner', 'admin', 'builder', 'viewer', 'billing');
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $$
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS workspace_members (
        workspace_id integer NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        user_id text NOT NULL,
        role workspace_member_role NOT NULL,
        invited_by text NOT NULL,
        joined_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT workspace_members_pk PRIMARY KEY (workspace_id, user_id)
      )
    `);
    await client.query(
      `CREATE INDEX IF NOT EXISTS workspace_members_user_idx ON workspace_members(user_id)`,
    );
    await client.query(`
      CREATE INDEX IF NOT EXISTS workspace_members_workspace_role_idx
        ON workspace_members(workspace_id, role)
    `);

    // Serialize the short backfill against signup workspace inserts. This makes repeated or
    // concurrent startup runs idempotent without treating a mutable display name as identity.
    await client.query(`LOCK TABLE workspaces IN SHARE ROW EXCLUSIVE MODE`);

    const existingOwners = await client.query<{ workspace_id: number }>(`
      INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, joined_at)
      SELECT id, owner_user_id, 'owner', owner_user_id, created_at
        FROM workspaces
      ON CONFLICT (workspace_id, user_id) DO NOTHING
      RETURNING workspace_id
    `);

    const defaultWorkspaces = await client.query<{
      id: number;
      owner_user_id: string;
      created_at: Date;
    }>(`
      WITH existing_users AS (
        SELECT user_id FROM user_credits
        UNION SELECT owner_id AS user_id FROM projects
        UNION SELECT user_id FROM org_members
        UNION SELECT user_id FROM user_subscriptions
        UNION SELECT user_id FROM personal_access_tokens
        UNION SELECT user_id FROM community_profiles
        UNION SELECT user_id FROM ora_profiles
        UNION SELECT owner_user_id AS user_id FROM workspaces
      ), org_display_names AS (
        SELECT user_id, MIN(NULLIF(BTRIM(display_name), '')) AS display_name
          FROM org_members
         GROUP BY user_id
      ), candidate_users AS (
        SELECT
          existing_users.user_id,
          COALESCE(
            NULLIF(BTRIM(community.display_name), ''),
            NULLIF(BTRIM(ora.preferred_name), ''),
            org_display_names.display_name
          ) AS display_name
        FROM existing_users
        LEFT JOIN community_profiles AS community ON community.user_id = existing_users.user_id
        LEFT JOIN ora_profiles AS ora ON ora.user_id = existing_users.user_id
        LEFT JOIN org_display_names ON org_display_names.user_id = existing_users.user_id
        WHERE existing_users.user_id <> 'demo-user'
          AND NOT EXISTS (
          SELECT 1
            FROM workspaces AS existing
           WHERE existing.owner_user_id = existing_users.user_id
             AND existing.deleted_at IS NULL
        )
      )
      INSERT INTO workspaces (owner_user_id, name, type)
      SELECT
        user_id,
        CASE
          WHEN display_name IS NULL THEN 'My workspace'
          ELSE LEFT(REGEXP_REPLACE(display_name, '\\s+', ' ', 'g'), 100) || '''s workspace'
        END,
        'personal'
      FROM candidate_users
      RETURNING id, owner_user_id, created_at
    `);

    let defaultWorkspaceOwnerMembershipsCreated = 0;
    if (defaultWorkspaces.rows.length > 0) {
      const defaultOwners = await client.query<{ workspace_id: number }>(
        `INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, joined_at)
         SELECT id, owner_user_id, 'owner', owner_user_id, created_at
           FROM workspaces
          WHERE id = ANY($1::integer[])
         ON CONFLICT (workspace_id, user_id) DO NOTHING
         RETURNING workspace_id`,
        [defaultWorkspaces.rows.map((workspace) => workspace.id)],
      );
      defaultWorkspaceOwnerMembershipsCreated = defaultOwners.rowCount ?? 0;
    }

    const ownerless = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM workspaces AS workspace
       WHERE NOT EXISTS (
         SELECT 1
           FROM workspace_members AS member
          WHERE member.workspace_id = workspace.id
            AND member.role = 'owner'
       )
    `);
    if (Number(ownerless.rows[0]?.count ?? "0") !== 0) {
      throw new Error("workspace_owner_membership_backfill_incomplete");
    }

    await client.query("COMMIT");
    return {
      existingWorkspaceOwnerMembershipsCreated: existingOwners.rowCount ?? 0,
      defaultWorkspacesCreated: defaultWorkspaces.rowCount ?? 0,
      defaultWorkspaceOwnerMembershipsCreated,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const LEGACY_TESTS_WORKSPACE_SYSTEM_KEY = "legacy-tests-adoption-v1";

export interface WorkspaceTenancyBackfillResult {
  legacyWorkspaceCreated: number;
  legacyOwnerMembershipsCreatedOrCorrected: number;
  demoProjectsAdoptedActive: number;
  demoProjectsAdoptedSoftDeleted: number;
  projectsBackfilledActive: number;
  projectsBackfilledSoftDeleted: number;
  projectsWithNullWorkspace: number;
}

/**
 * Adopt legacy pseudo-tenant projects, file every remaining project deterministically,
 * and only then enforce the project/workspace relationship at the database boundary.
 * The internal system key is durable identity; "Legacy tests" is display copy only.
 */
export async function applyWorkspaceTenancyMigration(
  client: Pick<import("pg").PoolClient, "query">,
  legacyOwnerId: string | undefined = process.env.LEGACY_ADOPTION_OWNER_ID,
): Promise<WorkspaceTenancyBackfillResult> {
  const normalizedOwnerId = legacyOwnerId?.trim();

  await client.query("BEGIN");
  try {
    await client.query(`ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS system_key text`);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS workspaces_system_key_unique
        ON workspaces(system_key)
        WHERE system_key IS NOT NULL
    `);

    // Exclude concurrent project/workspace writers until the invariant and NOT NULL fence agree.
    await client.query(`LOCK TABLE workspaces IN SHARE ROW EXCLUSIVE MODE`);
    await client.query(`LOCK TABLE workspace_members IN SHARE ROW EXCLUSIVE MODE`);
    await client.query(`LOCK TABLE projects IN SHARE ROW EXCLUSIVE MODE`);

    const existingLegacyWorkspace = await client.query<{
      id: number;
      owner_user_id: string;
      deleted_at: Date | null;
    }>(
      `SELECT id, owner_user_id, deleted_at
         FROM workspaces
        WHERE system_key = $1
        FOR UPDATE`,
      [LEGACY_TESTS_WORKSPACE_SYSTEM_KEY],
    );

    if (existingLegacyWorkspace.rows.length > 1) {
      throw new Error("legacy_adoption_workspace_identity_ambiguous");
    }

    const pendingLegacyRows = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM projects
       WHERE owner_id = 'demo-user'
    `);
    const pendingLegacyCount = Number(pendingLegacyRows.rows[0]?.count ?? "0");

    let legacyWorkspaceId: number | undefined;
    let effectiveLegacyOwnerId: string | undefined;
    let legacyWorkspaceCreated = 0;
    const existingLegacy = existingLegacyWorkspace.rows[0];
    if (existingLegacy) {
      if (pendingLegacyCount === 0) {
        // Deployment previews may omit or replace environment-specific adoption
        // identity. Once no legacy rows remain, the durable workspace owner is
        // the only authority needed for this idempotent no-op.
        effectiveLegacyOwnerId = existingLegacy.owner_user_id;
      } else {
        if (!normalizedOwnerId) {
          throw new Error("legacy_adoption_owner_id_missing");
        }
        if (normalizedOwnerId === "demo-user") {
          throw new Error("legacy_adoption_owner_id_invalid");
        }
        if (existingLegacy.owner_user_id !== normalizedOwnerId) {
          throw new Error("legacy_adoption_workspace_owner_mismatch");
        }
        effectiveLegacyOwnerId = normalizedOwnerId;
      }
      if (existingLegacy.deleted_at !== null) {
        throw new Error("legacy_adoption_workspace_deleted");
      }
      legacyWorkspaceId = existingLegacy.id;
    } else if (pendingLegacyCount > 0) {
      if (!normalizedOwnerId) {
        throw new Error("legacy_adoption_owner_id_missing");
      }
      if (normalizedOwnerId === "demo-user") {
        throw new Error("legacy_adoption_owner_id_invalid");
      }
      effectiveLegacyOwnerId = normalizedOwnerId;
      const created = await client.query<{ id: number }>(
        `INSERT INTO workspaces (owner_user_id, system_key, name, type)
         VALUES ($1, $2, 'Legacy tests', 'personal')
         RETURNING id`,
        [effectiveLegacyOwnerId, LEGACY_TESTS_WORKSPACE_SYSTEM_KEY],
      );
      const createdId = created.rows[0]?.id;
      if (!createdId) throw new Error("legacy_adoption_workspace_create_failed");
      legacyWorkspaceId = createdId;
      legacyWorkspaceCreated = 1;
    }

    let legacyOwnerMembershipsCreatedOrCorrected = 0;
    let adoptedRows: Array<{ deleted_at: Date | null }> = [];
    if (legacyWorkspaceId !== undefined && effectiveLegacyOwnerId !== undefined) {
      const legacyMembership = await client.query(
        `INSERT INTO workspace_members (workspace_id, user_id, role, invited_by, joined_at)
         VALUES ($1, $2, 'owner', $2, now())
         ON CONFLICT (workspace_id, user_id) DO UPDATE
           SET role = 'owner',
               invited_by = EXCLUDED.invited_by
         WHERE workspace_members.role IS DISTINCT FROM 'owner'
            OR workspace_members.invited_by IS DISTINCT FROM EXCLUDED.invited_by
         RETURNING workspace_id`,
        [legacyWorkspaceId, effectiveLegacyOwnerId],
      );
      legacyOwnerMembershipsCreatedOrCorrected = legacyMembership.rowCount ?? 0;

      const adopted = await client.query<{ deleted_at: Date | null }>(
        `UPDATE projects
            SET owner_id = $1,
                workspace_id = $2
          WHERE owner_id = 'demo-user'
        RETURNING deleted_at`,
        [effectiveLegacyOwnerId, legacyWorkspaceId],
      );
      adoptedRows = adopted.rows;
    }

    const backfilled = await client.query<{ deleted_at: Date | null }>(`
      WITH project_defaults AS (
        SELECT
          project.id AS project_id,
          (
            SELECT member.workspace_id
              FROM workspace_members AS member
              JOIN workspaces AS workspace ON workspace.id = member.workspace_id
             WHERE member.user_id = project.owner_id
               AND member.role = 'owner'
               AND workspace.deleted_at IS NULL
             ORDER BY workspace.created_at ASC, member.joined_at ASC, workspace.id ASC
             LIMIT 1
          ) AS workspace_id
          FROM projects AS project
         WHERE project.workspace_id IS NULL
      )
      UPDATE projects AS project
         SET workspace_id = project_defaults.workspace_id
        FROM project_defaults
       WHERE project.id = project_defaults.project_id
         AND project_defaults.workspace_id IS NOT NULL
      RETURNING project.deleted_at
    `);

    const nullWorkspace = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
        FROM projects
       WHERE workspace_id IS NULL
    `);
    const projectsWithNullWorkspace = Number(nullWorkspace.rows[0]?.count ?? "0");
    if (projectsWithNullWorkspace !== 0) {
      throw new Error(`project_workspace_backfill_incomplete:${projectsWithNullWorkspace}`);
    }

    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint AS constraint_row
            JOIN pg_class AS source_table ON source_table.oid = constraint_row.conrelid
           WHERE source_table.relname = 'projects'
             AND constraint_row.contype = 'f'
             AND pg_get_constraintdef(constraint_row.oid) =
                 'FOREIGN KEY (workspace_id) REFERENCES workspaces(id)'
        ) THEN
          ALTER TABLE projects
            ADD CONSTRAINT projects_workspace_tenancy_fk
            FOREIGN KEY (workspace_id) REFERENCES workspaces(id);
        END IF;
      END $$
    `);
    await client.query(`ALTER TABLE projects ALTER COLUMN workspace_id SET NOT NULL`);

    await client.query("COMMIT");

    const countCategory = (rows: Array<{ deleted_at: Date | null }>, deleted: boolean) =>
      rows.filter((row) => (row.deleted_at !== null) === deleted).length;

    return {
      legacyWorkspaceCreated,
      legacyOwnerMembershipsCreatedOrCorrected,
      demoProjectsAdoptedActive: countCategory(adoptedRows, false),
      demoProjectsAdoptedSoftDeleted: countCategory(adoptedRows, true),
      projectsBackfilledActive: countCategory(backfilled.rows, false),
      projectsBackfilledSoftDeleted: countCategory(backfilled.rows, true),
      projectsWithNullWorkspace,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

const BILLING_CREDITS_HELP_SLUG = "billing-credits";
const NABUFLOW_HELP_SLUGS = ["faq-what-is-mustaflow", "faq-build-mobile-apps"] as const;

/** One-time BC-2 content refresh; the seed remains the only owner of the article body. */
export async function refreshBillingCreditsHelpArticle(
  client: Pick<import("pg").PoolClient, "query">,
): Promise<void> {
  const { HELP_ARTICLE_SEED } = await import("@workspace/db");
  const article = HELP_ARTICLE_SEED.find((entry) => entry.slug === BILLING_CREDITS_HELP_SLUG);
  if (!article) {
    throw new Error(`Missing help-center seed article: ${BILLING_CREDITS_HELP_SLUG}`);
  }

  await client.query(
    `UPDATE help_articles
        SET body = $1,
            updated_at = now()
      WHERE slug = $2
        AND body IS DISTINCT FROM $1`,
    [article.body, article.slug],
  );
}

/** One-time product-name refresh for the two deployed builder FAQ articles. */
export async function refreshNabuflowHelpArticles(
  client: Pick<import("pg").PoolClient, "query">,
): Promise<void> {
  const { HELP_ARTICLE_SEED } = await import("@workspace/db");
  const articles = NABUFLOW_HELP_SLUGS.map((slug) => {
    const article = HELP_ARTICLE_SEED.find((entry) => entry.slug === slug);
    if (!article) {
      throw new Error(`Missing help-center seed article: ${slug}`);
    }
    return article;
  });

  for (const article of articles) {
    await client.query(
      `UPDATE help_articles
          SET title = $1,
              body = $2,
              updated_at = now()
        WHERE slug = $3
          AND (title IS DISTINCT FROM $1 OR body IS DISTINCT FROM $2)`,
      [article.title, article.body, article.slug],
    );
  }
}

export interface BrainstormAdmissionMigrationResult {
  tableReady: true;
  staleRowsRemoved: number;
  retentionDaysAfterReset: 1;
}

/** Create the shared admission-counter table and prune buckets outside retention. */
export async function applyBrainstormAdmissionMigration(
  client: Pick<import("pg").PoolClient, "query">,
): Promise<BrainstormAdmissionMigrationResult> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS brainstorm_admission_counters (
      admission_key TEXT NOT NULL,
      bucket_kind TEXT NOT NULL,
      bucket_start TIMESTAMPTZ NOT NULL,
      count INTEGER NOT NULL DEFAULT 0,
      reset_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      CONSTRAINT brainstorm_admission_counters_pk
        PRIMARY KEY (admission_key, bucket_kind, bucket_start),
      CONSTRAINT brainstorm_admission_bucket_kind_check
        CHECK (bucket_kind IN ('hour', 'day')),
      CONSTRAINT brainstorm_admission_count_nonnegative_check
        CHECK (count >= 0)
    )
  `);
  await client.query(
    `CREATE INDEX IF NOT EXISTS brainstorm_admission_counters_reset_idx
       ON brainstorm_admission_counters(reset_at)`,
  );
  const cleanup = await client.query(
    `DELETE FROM brainstorm_admission_counters
      WHERE reset_at < transaction_timestamp() - interval '1 day'`,
  );
  return {
    tableReady: true,
    staleRowsRemoved: cleanup.rowCount ?? 0,
    retentionDaysAfterReset: 1,
  };
}

/** Add the project-scoped prompt queue without rewriting existing project data. */
export async function applyZeroPromptQueuePersistenceMigration(
  client: MigrationClient,
): Promise<void> {
  await client.query("BEGIN");
  await client.query(`
    CREATE TABLE IF NOT EXISTS zero_prompt_queue_items (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      position INTEGER NOT NULL,
      current_text TEXT NOT NULL,
      asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
      state TEXT NOT NULL,
      promoted_turn_id TEXT,
      deleted_by TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT zero_prompt_queue_items_position_check CHECK (position > 0),
      CONSTRAINT zero_prompt_queue_items_text_check
        CHECK (char_length(current_text) BETWEEN 1 AND 10000),
      CONSTRAINT zero_prompt_queue_items_state_check
        CHECK (state IN ('queued', 'promoted', 'deleted')),
      CONSTRAINT zero_prompt_queue_items_terminal_check CHECK (
        (state = 'queued' AND promoted_turn_id IS NULL AND deleted_by IS NULL)
        OR (state = 'promoted' AND promoted_turn_id IS NOT NULL AND deleted_by IS NULL)
        OR (state = 'deleted' AND promoted_turn_id IS NULL AND deleted_by IS NOT NULL)
      ),
      CONSTRAINT zero_prompt_queue_items_project_position_unique
        UNIQUE (project_id, position)
    )
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS zero_prompt_queue_items_project_state_idx
      ON zero_prompt_queue_items(project_id, state, position)
  `);
  await client.query(`
    ALTER TABLE zero_prompt_queue_items
      ADD COLUMN IF NOT EXISTS asset_ids JSONB NOT NULL DEFAULT '[]'::jsonb
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS project_activity_queue_item_idx
      ON project_activity(project_id, ((metadata ->> 'itemId')), created_at DESC)
      WHERE event_type LIKE 'queue.item.%'
  `);
  await client.query("COMMIT");
}

type ZeroIntentReceiptSchemaState = {
  table_ready: boolean;
  receipt_columns_ready: boolean;
  message_link_ready: boolean;
  task_link_ready: boolean;
  constraints_ready: boolean;
};

/** Add durable, admission-ready intent receipts without backfilling legacy work. */
export async function applyZeroIntentReceiptMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS zero_intent_receipts (
        id SERIAL PRIMARY KEY,
        request_id TEXT NOT NULL,
        project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        source_message_id INTEGER,
        intent TEXT NOT NULL,
        deciding_source TEXT NOT NULL,
        confidence DOUBLE PRECISION,
        reason_code TEXT NOT NULL,
        decided_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        consumed_at TIMESTAMPTZ,
        CONSTRAINT zero_intent_receipts_project_request_uq UNIQUE (project_id, request_id),
        CONSTRAINT zero_intent_receipts_intent_check
          CHECK (intent IN ('answer', 'clarify', 'plan', 'mutate', 'observe')),
        CONSTRAINT zero_intent_receipts_source_check
          CHECK (deciding_source IN (
            'user_explicit', 'plan_approved', 'deterministic_rule', 'classifier',
            'classifier_fallback', 'snapshot_control', 'queue_promoted',
            'system_action', 'scheduled_action'
          )),
        CONSTRAINT zero_intent_receipts_confidence_check
          CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
      )
    `);
    await client.query(`
      ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS intent_receipt_id INTEGER;
      ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS intent_receipt_id INTEGER;
      DO $$ BEGIN
        ALTER TABLE zero_intent_receipts
          ADD CONSTRAINT zero_intent_receipts_source_message_fk
          FOREIGN KEY (source_message_id) REFERENCES chat_messages(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE chat_messages
          ADD CONSTRAINT chat_messages_intent_receipt_fk
          FOREIGN KEY (intent_receipt_id) REFERENCES zero_intent_receipts(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$;
      DO $$ BEGIN
        ALTER TABLE agent_tasks
          ADD CONSTRAINT agent_tasks_intent_receipt_fk
          FOREIGN KEY (intent_receipt_id) REFERENCES zero_intent_receipts(id) ON DELETE SET NULL;
      EXCEPTION WHEN duplicate_object THEN NULL; END $$
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS zero_intent_receipts_project_decided_idx
        ON zero_intent_receipts(project_id, decided_at);
      CREATE INDEX IF NOT EXISTS zero_intent_receipts_admission_idx
        ON zero_intent_receipts(project_id, intent, consumed_at);
      CREATE INDEX IF NOT EXISTS chat_messages_intent_receipt_id_idx
        ON chat_messages(intent_receipt_id);
      CREATE INDEX IF NOT EXISTS agent_tasks_intent_receipt_id_idx
        ON agent_tasks(intent_receipt_id)
    `);
    const verification = await client.query<ZeroIntentReceiptSchemaState>(`
      SELECT
        to_regclass('public.zero_intent_receipts') IS NOT NULL AS table_ready,
        (SELECT count(*) = 10
           FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = 'zero_intent_receipts'
            AND column_name IN (
              'id', 'request_id', 'project_id', 'source_message_id', 'intent',
              'deciding_source', 'confidence', 'reason_code', 'decided_at', 'consumed_at'
            )) AS receipt_columns_ready,
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'chat_messages'
                   AND column_name = 'intent_receipt_id') AS message_link_ready,
        EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = 'agent_tasks'
                   AND column_name = 'intent_receipt_id') AS task_link_ready,
        (SELECT count(*) >= 6
           FROM pg_constraint
          WHERE conrelid IN (
            'zero_intent_receipts'::regclass,
            'chat_messages'::regclass,
            'agent_tasks'::regclass
          )
            AND conname IN (
              'zero_intent_receipts_project_request_uq',
              'zero_intent_receipts_intent_check',
              'zero_intent_receipts_source_check',
              'zero_intent_receipts_source_message_fk',
              'chat_messages_intent_receipt_fk',
              'agent_tasks_intent_receipt_fk'
            )) AS constraints_ready
    `);
    const state = verification.rows[0];
    if (
      !state?.table_ready ||
      !state.receipt_columns_ready ||
      !state.message_link_ready ||
      !state.task_link_ready ||
      !state.constraints_ready
    ) {
      throw new Error("zero_intent_receipt_schema_incomplete");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

type ZeroModelControlSchemaState = {
  bindings_ready: boolean;
  settings_ready: boolean;
  calls_ready: boolean;
  constraints_ready: boolean;
};

/**
 * Add the versioned model-control registry and per-call identity receipts.
 * No binding is activated here: the current stage router remains authoritative
 * until the evaluation-gated cutover slice deliberately changes resolver_mode.
 */
export async function applyZeroModelControlMigration(client: MigrationClient): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS zero_model_registry_settings (
        registry_key TEXT PRIMARY KEY DEFAULT 'global',
        parity_floor NUMERIC(8,4),
        resolver_mode TEXT NOT NULL DEFAULT 'legacy',
        updated_by TEXT NOT NULL DEFAULT 'system',
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT zero_model_registry_key_check CHECK (registry_key = 'global'),
        CONSTRAINT zero_model_registry_mode_check CHECK (resolver_mode IN ('legacy','registry')),
        CONSTRAINT zero_model_registry_parity_floor_check
          CHECK (parity_floor IS NULL OR parity_floor >= 0)
      );
      INSERT INTO zero_model_registry_settings (registry_key)
      VALUES ('global') ON CONFLICT (registry_key) DO NOTHING
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS zero_model_binding_versions (
        id SERIAL PRIMARY KEY,
        tier TEXT NOT NULL,
        version INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        parameters JSONB NOT NULL DEFAULT '{}'::jsonb,
        state TEXT NOT NULL DEFAULT 'candidate',
        created_by TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        activated_by TEXT,
        activated_at TIMESTAMPTZ,
        deactivated_at TIMESTAMPTZ,
        CONSTRAINT zero_model_binding_tier_version_uq UNIQUE (tier, version),
        CONSTRAINT zero_model_binding_tier_check CHECK (tier IN ('lite','eco','power','pro')),
        CONSTRAINT zero_model_binding_provider_check
          CHECK (provider IN ('openai','anthropic','gemini','deepseek','local')),
        CONSTRAINT zero_model_binding_state_check
          CHECK (state IN ('candidate','active','previous','retired')),
        CONSTRAINT zero_model_binding_version_check CHECK (version > 0)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS zero_model_binding_one_active_per_tier_uq
        ON zero_model_binding_versions(tier) WHERE state = 'active';
      CREATE INDEX IF NOT EXISTS zero_model_binding_tier_state_idx
        ON zero_model_binding_versions(tier, state, created_at)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS zero_model_call_receipts (
        id UUID PRIMARY KEY,
        operation_id TEXT NOT NULL,
        task_id INTEGER REFERENCES agent_tasks(id) ON DELETE SET NULL,
        tier TEXT NOT NULL,
        stage TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        binding_version_id INTEGER REFERENCES zero_model_binding_versions(id) ON DELETE SET NULL,
        status TEXT NOT NULL DEFAULT 'started',
        input_tokens INTEGER,
        output_tokens INTEGER,
        error_code TEXT,
        started_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMPTZ,
        CONSTRAINT zero_model_call_tier_check CHECK (tier IN ('lite','eco','power','pro')),
        CONSTRAINT zero_model_call_stage_check
          CHECK (stage IN ('build','refine','plan','architect','intent','converse')),
        CONSTRAINT zero_model_call_provider_check
          CHECK (provider IN ('openai','anthropic','gemini','deepseek','local')),
        CONSTRAINT zero_model_call_status_check
          CHECK (status IN ('started','completed','failed','interrupted'))
      );
      CREATE INDEX IF NOT EXISTS zero_model_call_tier_finished_idx
        ON zero_model_call_receipts(tier, finished_at);
      CREATE INDEX IF NOT EXISTS zero_model_call_operation_idx
        ON zero_model_call_receipts(operation_id, started_at);
      CREATE INDEX IF NOT EXISTS zero_model_call_task_idx
        ON zero_model_call_receipts(task_id, started_at)
    `);
    const verification = await client.query<ZeroModelControlSchemaState>(`
      SELECT
        to_regclass('public.zero_model_binding_versions') IS NOT NULL AS bindings_ready,
        to_regclass('public.zero_model_registry_settings') IS NOT NULL AS settings_ready,
        to_regclass('public.zero_model_call_receipts') IS NOT NULL AS calls_ready,
        (SELECT count(*) >= 10
           FROM pg_constraint
          WHERE conname IN (
            'zero_model_registry_key_check', 'zero_model_registry_mode_check',
            'zero_model_registry_parity_floor_check', 'zero_model_binding_tier_version_uq',
            'zero_model_binding_tier_check', 'zero_model_binding_provider_check',
            'zero_model_binding_state_check', 'zero_model_binding_version_check',
            'zero_model_call_tier_check', 'zero_model_call_stage_check',
            'zero_model_call_provider_check', 'zero_model_call_status_check'
          )) AS constraints_ready
    `);
    const state = verification.rows[0];
    if (
      !state?.bindings_ready ||
      !state.settings_ready ||
      !state.calls_ready ||
      !state.constraints_ready
    ) {
      throw new Error("zero_model_control_schema_incomplete");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function applyPreviewDatabaseAllocationMigration(
  client: MigrationClient,
): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_db_allocation JSONB");
    const proof = await client.query<{ receipt_ready: boolean }>(
      "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' " +
        "AND table_name='projects' AND column_name='preview_db_allocation' " +
        "AND data_type='jsonb' AND is_nullable='YES') AS receipt_ready",
    );
    if (proof.rows[0]?.receipt_ready !== true) {
      throw new Error("preview_database_allocation_schema_incomplete");
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function applyProductionDatabaseAdmissionMigration(
  client: MigrationClient,
): Promise<void> {
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");
    await ensureProductionDatabaseAdmissionSchema(client);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Cleanup failure must not replace the original migration error.
    }
    throw error;
  }
}

const MIGRATION_STEPS: MigrationStep[] = [
  {
    name: "migrate-production-artifact-release-records",
    async run(client) {
      await client.query(
        `ALTER TABLE project_versions
           ADD COLUMN IF NOT EXISTS sealed_release jsonb,
           ADD COLUMN IF NOT EXISTS production_release jsonb`,
      );
    },
  },
  // ── migrate-containers ──────────────────────────────────────────────────────
  {
    name: "migrate-containers",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_id text`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_status text NOT NULL DEFAULT 'stopped'`,
      );
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS container_url text`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS container_logs (
          id         serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          level      text NOT NULL DEFAULT 'stdout',
          message    text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-production-container ────────────────────────────────────────────
  {
    name: "migrate-production-container",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_container_id text`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS production_container_url text`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-prod-containers ─────────────────────────────────────────────────
  {
    name: "migrate-prod-containers",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS prod_container_id text, ADD COLUMN IF NOT EXISTS prod_container_status text NOT NULL DEFAULT 'stopped', ADD COLUMN IF NOT EXISTS prod_container_url text`,
      );
    },
  },

  // ── migrate-db-snapshots ────────────────────────────────────────────────────
  {
    name: "migrate-db-snapshots",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS db_snapshots (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version_id  INTEGER REFERENCES project_versions(id) ON DELETE SET NULL,
          label       TEXT NOT NULL,
          provider    TEXT NOT NULL,
          dump_content TEXT,
          object_key  TEXT,
          is_partial  BOOLEAN NOT NULL DEFAULT FALSE,
          size_bytes  INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_db_snapshots_project_id ON db_snapshots(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_db_snapshots_version_id ON db_snapshots(version_id)`,
      );
      await client.query(`ALTER TABLE db_snapshots ALTER COLUMN dump_content DROP NOT NULL`);
      await client.query(`ALTER TABLE db_snapshots ADD COLUMN IF NOT EXISTS object_key TEXT`);
      await client.query(
        `ALTER TABLE db_snapshots ADD COLUMN IF NOT EXISTS is_partial BOOLEAN NOT NULL DEFAULT FALSE`,
      );
    },
  },

  // ── migrate-check-runs ──────────────────────────────────────────────────────
  {
    name: "migrate-check-runs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS check_runs (
          id         serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id    integer REFERENCES agent_tasks(id) ON DELETE CASCADE,
          check_name text NOT NULL,
          status     text NOT NULL,
          findings   jsonb NOT NULL DEFAULT '[]',
          ai_reason  text,
          ran_at     timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS check_runs_project_id_task_id_idx ON check_runs(project_id, task_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS check_runs_task_id_idx ON check_runs(task_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-e2e-enabled ─────────────────────────────────────────────────────
  {
    name: "migrate-e2e-enabled",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS e2e_enabled boolean NOT NULL DEFAULT true`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-multiplayer-uploads ─────────────────────────────────────────────
  {
    name: "migrate-multiplayer-uploads",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS multiplayer_enabled boolean NOT NULL DEFAULT false`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_uploads (
          id          serial PRIMARY KEY,
          project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          uploader_id text,
          filename    text NOT NULL,
          mime_type   text NOT NULL DEFAULT 'application/octet-stream',
          size_bytes  bigint NOT NULL DEFAULT 0,
          object_path text NOT NULL,
          text_preview text,
          created_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_uploads_project_id_idx ON project_uploads(project_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-security-gate ───────────────────────────────────────────────────
  {
    name: "migrate-security-gate",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS block_publish_on_critical boolean NOT NULL DEFAULT true`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS dismissed_finding_hashes jsonb NOT NULL DEFAULT '[]'::jsonb`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-security-findings ───────────────────────────────────────────────
  {
    name: "migrate-security-findings",
    async run(client) {
      const { rows } = await client.query<{ exists: boolean }>(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name = 'check_runs'
        ) AS exists
      `);
      const checkRunsExists = rows[0]?.exists ?? false;
      const checkRunCol = checkRunsExists
        ? `check_run_id INTEGER REFERENCES check_runs(id) ON DELETE SET NULL,`
        : `check_run_id INTEGER,`;

      await client.query(`
        CREATE TABLE IF NOT EXISTS security_findings (
          id            SERIAL PRIMARY KEY,
          project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          ${checkRunCol}
          check_type    TEXT NOT NULL,
          severity      TEXT NOT NULL,
          fingerprint   TEXT NOT NULL,
          message       TEXT NOT NULL,
          file          TEXT,
          line          INTEGER,
          status        TEXT NOT NULL DEFAULT 'open',
          dismissed_by  TEXT,
          dismissed_at  TIMESTAMPTZ,
          first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS security_findings_project_fingerprint_idx ON security_findings(project_id, fingerprint)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS security_findings_project_id_idx ON security_findings(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS security_findings_status_idx ON security_findings(status)`,
      );

      if (checkRunsExists) {
        const { rows: fkRows } = await client.query<{ exists: boolean }>(`
          SELECT EXISTS (
            SELECT FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name = kcu.constraint_name
            WHERE tc.table_name = 'security_findings'
              AND tc.constraint_type = 'FOREIGN KEY'
              AND kcu.column_name = 'check_run_id'
          ) AS exists
        `);
        if (!fkRows[0]?.exists) {
          await client.query(`
            ALTER TABLE security_findings
              ADD CONSTRAINT security_findings_check_run_id_fkey
              FOREIGN KEY (check_run_id) REFERENCES check_runs(id) ON DELETE SET NULL
          `);
        }
      }
    },
  },

  // ── migrate-app-test-runs ───────────────────────────────────────────────────
  {
    name: "migrate-app-test-runs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS app_test_runs (
          id         serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id    integer REFERENCES agent_tasks(id) ON DELETE SET NULL,
          ran_at     timestamptz NOT NULL DEFAULT now(),
          test_script text,
          results    jsonb NOT NULL DEFAULT '[]',
          passed     integer NOT NULL DEFAULT 0,
          failed     integer NOT NULL DEFAULT 0
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS app_test_runs_project_id_ran_at_idx ON app_test_runs(project_id, ran_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS app_test_runs_task_id_idx ON app_test_runs(task_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-cve-patch-columns ───────────────────────────────────────────────
  {
    name: "migrate-cve-patch-columns",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS cve_findings (
          id                     serial PRIMARY KEY,
          project_id             integer REFERENCES projects(id) ON DELETE CASCADE,
          severity               text NOT NULL,
          package_name           text NOT NULL,
          current_version        text,
          patched_version        text,
          cve_id                 text,
          title                  text,
          advisory_url           text,
          detected_at            timestamptz NOT NULL DEFAULT now(),
          status                 text NOT NULL DEFAULT 'open',
          dismissed_at           timestamptz,
          dismissed_by           text,
          patch_status           text,
          patch_content          text,
          patch_typecheck_passed boolean,
          patch_prepared_at      timestamptz,
          patch_applied_at       timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS cve_findings_status_idx ON cve_findings(status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS cve_findings_severity_idx ON cve_findings(severity)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS cve_findings_project_id_idx ON cve_findings(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS cve_findings_patch_status_idx ON cve_findings(patch_status)`,
      );
      await client.query(`
        ALTER TABLE cve_findings
          ADD COLUMN IF NOT EXISTS patch_status text,
          ADD COLUMN IF NOT EXISTS patch_content text,
          ADD COLUMN IF NOT EXISTS patch_typecheck_passed boolean,
          ADD COLUMN IF NOT EXISTS patch_prepared_at timestamptz,
          ADD COLUMN IF NOT EXISTS patch_applied_at timestamptz
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-knowledge-embeddings ────────────────────────────────────────────
  {
    name: "migrate-knowledge-embeddings",
    async run(client) {
      await client.query("BEGIN");
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      } catch {
        // vector extension may not be available in all environments
      }
      const { rows } = await client.query<{ data_type: string }>(`
        SELECT data_type FROM information_schema.columns
        WHERE table_name = 'knowledge_entries' AND column_name = 'embedding'
      `);
      if (rows[0] && rows[0].data_type !== "USER-DEFINED") {
        await client.query(`ALTER TABLE knowledge_entries DROP COLUMN embedding`);
      }
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS embedding vector(1536)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-knowledge-vault-v2 ──────────────────────────────────────────────
  {
    name: "migrate-knowledge-vault-v2",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE knowledge_entries
          ADD COLUMN IF NOT EXISTS scope TEXT NOT NULL DEFAULT 'project',
          ADD COLUMN IF NOT EXISTS thumbs_up INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS thumbs_down INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS usage_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS is_public BOOLEAN NOT NULL DEFAULT FALSE
      `);
      await client.query(
        `UPDATE knowledge_entries SET scope = 'global' WHERE approved_for_reuse = TRUE AND scope = 'project'`,
      );
      await client.query(
        `UPDATE knowledge_entries SET scope = 'user' WHERE project_id IS NULL AND user_id IS NOT NULL AND approved_for_reuse = FALSE AND scope = 'project'`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-version-validation-status ──────────────────────────────────────
  {
    name: "migrate-version-validation-status",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS validation_status text`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-architect-review ────────────────────────────────────────────────
  {
    name: "migrate-architect-review",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS architect_review_enabled boolean NOT NULL DEFAULT true`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-prod-logs ───────────────────────────────────────────────────────
  {
    name: "migrate-prod-logs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS prod_logs (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          snapshot_id INTEGER,
          kind        TEXT NOT NULL,
          method      TEXT,
          path        TEXT,
          status      INTEGER,
          latency_ms  INTEGER,
          request_id  TEXT,
          ip_hash     TEXT,
          user_agent  TEXT,
          error_class TEXT,
          message     TEXT,
          stack       TEXT,
          signature   TEXT,
          ts          TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS prod_logs_project_ts_idx ON prod_logs(project_id, ts)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS prod_logs_signature_idx ON prod_logs(signature)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS prod_logs_kind_idx ON prod_logs(kind)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS prod_error_groups (
          id             SERIAL PRIMARY KEY,
          project_id     INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          signature      TEXT NOT NULL,
          sample_message TEXT NOT NULL,
          sample_stack   TEXT,
          kind           TEXT NOT NULL DEFAULT 'browser',
          count          INTEGER NOT NULL DEFAULT 1,
          first_seen     TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS prod_error_groups_project_signature_idx ON prod_error_groups(project_id, signature)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS prod_error_groups_last_seen_idx ON prod_error_groups(last_seen)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS prod_health_checks (
          id              SERIAL PRIMARY KEY,
          project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          snapshot_id     INTEGER,
          public_slug     TEXT,
          status          TEXT NOT NULL,
          root_status     INTEGER,
          root_latency_ms INTEGER,
          routes_checked  INTEGER NOT NULL DEFAULT 0,
          routes_failed   INTEGER NOT NULL DEFAULT 0,
          failure_summary TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS prod_health_checks_project_idx ON prod_health_checks(project_id, created_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-policy-audit ────────────────────────────────────────────────────
  {
    name: "migrate-policy-audit",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS policy_strictness text NOT NULL DEFAULT 'standard'`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS tool_audit (
          id               serial PRIMARY KEY,
          project_id       integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id          integer,
          tool_name        text NOT NULL,
          stack            text,
          argv             jsonb NOT NULL,
          exit_code        integer,
          stdout_tail      text,
          stderr_tail      text,
          duration_ms      integer NOT NULL DEFAULT 0,
          blocked          boolean NOT NULL DEFAULT false,
          block_reason     text,
          policy_strictness text NOT NULL DEFAULT 'standard',
          created_at       timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS tool_audit_project_idx ON tool_audit(project_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS tool_audit_blocked_idx ON tool_audit(blocked, created_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-background-jobs ─────────────────────────────────────────────────
  {
    name: "migrate-background-jobs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE agent_tasks
          ADD COLUMN IF NOT EXISTS run_mode text NOT NULL DEFAULT 'foreground',
          ADD COLUMN IF NOT EXISTS wall_clock_cap_ms integer,
          ADD COLUMN IF NOT EXISTS credits_reserved integer,
          ADD COLUMN IF NOT EXISTS paused_at timestamptz,
          ADD COLUMN IF NOT EXISTS applied_at timestamptz,
          ADD COLUMN IF NOT EXISTS discarded_at timestamptz
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tasks_run_mode_status_idx ON agent_tasks(run_mode, status)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-builder-skills ──────────────────────────────────────────────────
  {
    name: "migrate-builder-skills",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS builder_skills (
          name        text PRIMARY KEY,
          enabled     boolean NOT NULL DEFAULT true,
          load_count  integer NOT NULL DEFAULT 0,
          last_loaded_at timestamptz,
          updated_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-builder-skills-drafts ──────────────────────────────────────────
  {
    name: "migrate-builder-skills-drafts",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE builder_skills
          ADD COLUMN IF NOT EXISTS draft boolean NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS authored_by text,
          ADD COLUMN IF NOT EXISTS authored_at timestamptz,
          ADD COLUMN IF NOT EXISTS authoring_context text
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-project-embeddings ──────────────────────────────────────────────
  {
    name: "migrate-project-embeddings",
    async run(client) {
      await client.query("BEGIN");
      try {
        await client.query(`CREATE EXTENSION IF NOT EXISTS vector`);
      } catch {
        // vector extension may not be available in all environments
      }
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_embeddings (
          id           serial PRIMARY KEY,
          project_id   integer NOT NULL,
          file_path    text NOT NULL,
          content_hash text NOT NULL,
          model        text NOT NULL DEFAULT 'text-embedding-3-small',
          embedding    vector(1536),
          snippet      text NOT NULL DEFAULT '',
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_embeddings_project_file_unique ON project_embeddings(project_id, file_path)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-project-domains ─────────────────────────────────────────────────
  {
    name: "migrate-project-domains",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_domains (
          id                  SERIAL PRIMARY KEY,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          hostname            TEXT NOT NULL,
          is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
          record_type         TEXT NOT NULL DEFAULT 'cname',
          verification_token  TEXT NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'pending',
          ssl_status          TEXT NOT NULL DEFAULT 'pending',
          verified_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_domains_hostname_unique ON project_domains(hostname)`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS redirect_www_apex BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      // data migration: backfill existing custom domains into project_domains
      const { rows } = await client.query<{
        id: number;
        custom_domain: string;
        domain_status: string | null;
        ssl_status: string | null;
        verification_token: string | null;
        domain_verified_at: string | null;
      }>(
        `SELECT id, custom_domain, domain_status, ssl_status, verification_token, domain_verified_at
         FROM projects WHERE custom_domain IS NOT NULL AND deleted_at IS NULL`,
      );
      for (const project of rows) {
        const isDns = (project.custom_domain ?? "").includes(".");
        await client.query(
          `INSERT INTO project_domains
             (project_id, hostname, is_primary, record_type, verification_token,
              verification_status, ssl_status, verified_at, created_at, updated_at)
           VALUES ($1, $2, TRUE, $3, $4, $5, $6, $7, NOW(), NOW())
           ON CONFLICT (hostname) DO NOTHING`,
          [
            project.id,
            project.custom_domain,
            isDns ? "cname" : "a",
            project.verification_token ?? crypto.randomUUID(),
            project.domain_status ?? "pending",
            project.ssl_status ?? "pending",
            project.domain_verified_at ?? null,
          ],
        );
      }
    },
  },

  // ── migrate-checkpoint-id ───────────────────────────────────────────────────
  {
    name: "migrate-checkpoint-id",
    async run(client) {
      await client.query(
        `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS checkpoint_id integer`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS chat_messages_checkpoint_id_idx ON chat_messages(checkpoint_id) WHERE checkpoint_id IS NOT NULL`,
      );
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_checkpoint_id_fkey'
          ) THEN
            ALTER TABLE chat_messages
              ADD CONSTRAINT chat_messages_checkpoint_id_fkey
              FOREIGN KEY (checkpoint_id) REFERENCES project_versions(id) ON DELETE SET NULL;
          END IF;
        END $$
      `);
    },
  },

  // ── migrate-staging-domains ─────────────────────────────────────────────────
  // Persist the chat surface that created each task so delayed reports can be
  // written back to the correct thread (for example Zero background tasks).
  {
    name: "migrate-agent-task-origin",
    async run(client) {
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS origin text`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tasks_origin_idx ON agent_tasks(origin) WHERE origin IS NOT NULL`,
      );
    },
  },

  {
    name: "migrate-staging-domains",
    async run(client) {
      await client.query(`ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS environment TEXT`);
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS environment TEXT NOT NULL DEFAULT 'production'`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS staging_published_snapshot_id INTEGER`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS preview_snapshots (
          id           SERIAL PRIMARY KEY,
          project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          version_id   INTEGER NOT NULL,
          task_id      INTEGER,
          preview_slug TEXT NOT NULL,
          expires_at   TIMESTAMPTZ NOT NULL,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS preview_snapshots_slug_unique ON preview_snapshots(preview_slug)`,
      );
    },
  },

  // ── migrate-cf-hostname-columns ─────────────────────────────────────────────
  {
    name: "migrate-cf-hostname-columns",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_domains (
          id                  SERIAL PRIMARY KEY,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          hostname            TEXT NOT NULL,
          is_primary          BOOLEAN NOT NULL DEFAULT FALSE,
          record_type         TEXT NOT NULL DEFAULT 'cname',
          verification_token  TEXT NOT NULL,
          verification_status TEXT NOT NULL DEFAULT 'pending',
          ssl_status          TEXT NOT NULL DEFAULT 'pending',
          verified_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_domains_hostname_unique ON project_domains(hostname)`,
      );
      await client.query(`
        ALTER TABLE project_domains
          ADD COLUMN IF NOT EXISTS cf_hostname_id TEXT,
          ADD COLUMN IF NOT EXISTS ssl_last_checked_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS ssl_expires_at TIMESTAMPTZ
      `);
    },
  },

  // ── migrate-canvas-variants ─────────────────────────────────────────────────
  {
    name: "migrate-canvas-variants",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS canvas_variants (
          id               serial PRIMARY KEY,
          project_id       integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          exploration_id   text NOT NULL,
          label            text NOT NULL,
          prompt           text NOT NULL,
          status           text NOT NULL DEFAULT 'pending',
          files            jsonb,
          assistant_summary text,
          error_message    text,
          rank             integer NOT NULL DEFAULT 1,
          source           text NOT NULL DEFAULT 'explore',
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now(),
          last_viewed_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS canvas_variants_project_idx ON canvas_variants(project_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS canvas_variants_exploration_idx ON canvas_variants(exploration_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS canvas_variants_last_viewed_idx ON canvas_variants(last_viewed_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-lesson-contribution-reward ──────────────────────────────────────
  {
    name: "migrate-lesson-contribution-reward",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS contributor_rewarded_at timestamptz`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-canvas-variants-v2 ──────────────────────────────────────────────
  {
    name: "migrate-canvas-variants-v2",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE canvas_variants
          ADD COLUMN IF NOT EXISTS variant_parent_id integer REFERENCES canvas_variants(id) ON DELETE SET NULL,
          ADD COLUMN IF NOT EXISTS share_token text,
          ADD COLUMN IF NOT EXISTS saved_to_library boolean NOT NULL DEFAULT false
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS canvas_variants_share_token_idx ON canvas_variants(share_token) WHERE share_token IS NOT NULL`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS canvas_variant_library (
          id               serial PRIMARY KEY,
          user_id          text NOT NULL,
          label            text NOT NULL,
          description      text,
          files            jsonb NOT NULL,
          source_project_id integer REFERENCES projects(id) ON DELETE SET NULL,
          source_variant_id integer,
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS canvas_variant_library_user_idx ON canvas_variant_library(user_id, created_at DESC)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS canvas_ab_tests (
          id             serial PRIMARY KEY,
          project_id     integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          variant_a_id   integer NOT NULL,
          variant_b_id   integer NOT NULL,
          traffic_split_pct integer NOT NULL DEFAULT 50,
          metric         text NOT NULL DEFAULT 'clicks',
          status         text NOT NULL DEFAULT 'running',
          winner_id      integer,
          views_a        integer NOT NULL DEFAULT 0,
          views_b        integer NOT NULL DEFAULT 0,
          conversions_a  integer NOT NULL DEFAULT 0,
          conversions_b  integer NOT NULL DEFAULT 0,
          created_at     timestamptz NOT NULL DEFAULT now(),
          ended_at       timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS canvas_ab_tests_project_idx ON canvas_ab_tests(project_id, created_at DESC)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-blueprints ──────────────────────────────────────────────────────
  {
    name: "migrate-blueprints",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_blueprints (
          id           serial PRIMARY KEY,
          project_id   integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          blueprint_id text NOT NULL,
          version      text NOT NULL DEFAULT '1.0.0',
          installed_by text,
          result       jsonb,
          installed_at timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_blueprints_pk_idx ON project_blueprints(project_id, blueprint_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS mcp_servers (
          id           serial PRIMARY KEY,
          name         text NOT NULL,
          description  text,
          endpoint     text NOT NULL,
          auth_header  text,
          enabled      boolean NOT NULL DEFAULT true,
          cached_tools jsonb,
          cached_at    timestamptz,
          created_by   text,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS mcp_servers_enabled_idx ON mcp_servers(enabled)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-deployment-substrate ────────────────────────────────────────────
  {
    name: "migrate-deployment-substrate",
    async run(client) {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS deployment_type text NOT NULL DEFAULT 'static',
          ADD COLUMN IF NOT EXISTS region text,
          ADD COLUMN IF NOT EXISTS cdn_enabled boolean NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS cdn_last_pushed_at timestamptz,
          ADD COLUMN IF NOT EXISTS health_check_path text NOT NULL DEFAULT '/',
          ADD COLUMN IF NOT EXISTS uptime_alert_email text
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS deployment_schedules (
          id               serial PRIMARY KEY,
          project_id       integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind             text NOT NULL DEFAULT 'task_run',
          cron_expr        text NOT NULL,
          enabled          boolean NOT NULL DEFAULT true,
          note             text,
          last_run_at      timestamptz,
          last_run_status  text,
          last_run_message text,
          next_run_at      timestamptz,
          created_by       text,
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS deployment_schedules_project_idx ON deployment_schedules(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS deployment_schedules_next_run_idx ON deployment_schedules(next_run_at)`,
      );
    },
  },

  // ── migrate-project-artifacts ───────────────────────────────────────────────
  {
    name: "migrate-project-artifacts",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_artifacts (
          id              serial PRIMARY KEY,
          project_id      integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind            text NOT NULL DEFAULT 'web',
          platform        text NOT NULL DEFAULT 'web',
          project_format  text NOT NULL DEFAULT 'static-html',
          stack           text NOT NULL DEFAULT 'react-vite',
          name            text NOT NULL,
          slug            text NOT NULL,
          is_primary      boolean NOT NULL DEFAULT false,
          status          text NOT NULL DEFAULT 'draft',
          last_task_summary text,
          deleted_at      timestamptz,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_artifacts_project_slug_unique ON project_artifacts(project_id, slug)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_artifacts_project_idx ON project_artifacts(project_id)`,
      );
      await client.query(`ALTER TABLE project_files ADD COLUMN IF NOT EXISTS artifact_id integer`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_files_artifact_idx ON project_files(artifact_id)`,
      );

      // data migration: create a primary artifact for each existing project
      const { rows: projects } = await client.query<{
        id: number;
        name: string;
        kind: string | null;
        platform: string | null;
        project_format: string | null;
        stack: string | null;
        status: string | null;
        last_task_summary: string | null;
      }>(
        `SELECT id, name, kind, platform, project_format, stack, status, last_task_summary
         FROM projects WHERE deleted_at IS NULL`,
      );
      for (const proj of projects) {
        const { rows: existing } = await client.query(
          `SELECT 1 FROM project_artifacts WHERE project_id = $1 AND is_primary = true LIMIT 1`,
          [proj.id],
        );
        if (!existing.length) {
          const { rows: arts } = await client.query(
            `INSERT INTO project_artifacts
               (project_id, kind, platform, project_format, stack, name, slug, is_primary, status, last_task_summary)
             VALUES ($1, $2, $3, $4, $5, $6, $7, true, $8, $9)
             RETURNING id`,
            [
              proj.id,
              proj.kind ?? "web",
              proj.platform ?? "web",
              proj.project_format ?? "static-html",
              proj.stack ?? "react-vite",
              proj.name,
              "main",
              proj.status ?? "draft",
              proj.last_task_summary,
            ],
          );
          if (arts[0]) {
            await client.query(
              `UPDATE project_files SET artifact_id = $1 WHERE project_id = $2 AND artifact_id IS NULL`,
              [arts[0].id, proj.id],
            );
          }
        }
      }

      await client.query(`DROP INDEX IF EXISTS project_files_project_path_unique`);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_files_project_artifact_path_unique ON project_files(project_id, artifact_id, path)`,
      );
    },
  },

  // ── migrate-security-scanners ───────────────────────────────────────────────
  {
    name: "migrate-security-scanners",
    async run(client) {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS scanner_hounddog_enabled BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS scanner_trivy_enabled    BOOLEAN NOT NULL DEFAULT false,
          ADD COLUMN IF NOT EXISTS scanner_semgrep_enabled  BOOLEAN NOT NULL DEFAULT true
      `);
    },
  },

  // ── migrate-agent-inbox ─────────────────────────────────────────────────────
  {
    name: "migrate-agent-inbox",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_inbox (
          id          serial PRIMARY KEY,
          project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id     text,
          category    text NOT NULL DEFAULT 'bug',
          severity    text NOT NULL DEFAULT 'medium',
          description text NOT NULL,
          screenshot_url text,
          status      text NOT NULL DEFAULT 'unread',
          created_at  timestamptz NOT NULL DEFAULT now(),
          read_at     timestamptz,
          resolved_at timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_inbox_project_status_idx ON agent_inbox(project_id, status, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_inbox_status_created_idx ON agent_inbox(status, created_at DESC)`,
      );
      await client.query(
        `ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS content_tsv tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS chat_messages_content_tsv_idx ON chat_messages USING GIN (content_tsv)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-preferred-region ────────────────────────────────────────────────
  {
    name: "migrate-preferred-region",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS preferred_region TEXT`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-receipt-url ─────────────────────────────────────────────────────
  {
    name: "migrate-receipt-url",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE credit_transactions ADD COLUMN IF NOT EXISTS receipt_url TEXT`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-domain-cert-fields ──────────────────────────────────────────────
  {
    name: "migrate-domain-cert-fields",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS ssl_source TEXT NOT NULL DEFAULT 'cloudflare'`,
      );
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS byo_cert_expires_at TIMESTAMPTZ`,
      );
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS byo_cert_subject TEXT`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-webhooks-pat ────────────────────────────────────────────────────
  {
    name: "migrate-webhooks-pat",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_webhooks (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          url         TEXT NOT NULL,
          secret      TEXT NOT NULL,
          events      JSONB NOT NULL DEFAULT '[]',
          active      BOOLEAN NOT NULL DEFAULT true,
          description TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_project_webhooks_project ON project_webhooks(project_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS webhook_deliveries (
          id           SERIAL PRIMARY KEY,
          webhook_id   INTEGER NOT NULL REFERENCES project_webhooks(id) ON DELETE CASCADE,
          project_id   INTEGER NOT NULL,
          event        TEXT NOT NULL,
          payload      JSONB NOT NULL,
          status       TEXT NOT NULL DEFAULT 'pending',
          status_code  INTEGER,
          response_body TEXT,
          attempt      INTEGER NOT NULL DEFAULT 1,
          duration_ms  INTEGER,
          error        TEXT,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_webhook ON webhook_deliveries(webhook_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_project ON webhook_deliveries(project_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS personal_access_tokens (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          name          TEXT NOT NULL,
          token_hash    TEXT NOT NULL UNIQUE,
          token_preview TEXT NOT NULL,
          project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          scopes        JSONB NOT NULL DEFAULT '["domains:read","domains:write"]',
          active        BOOLEAN NOT NULL DEFAULT true,
          last_used_at  TIMESTAMPTZ,
          expires_at    TIMESTAMPTZ,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_pat_user ON personal_access_tokens(user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS domain_serve_events (
          id          SERIAL PRIMARY KEY,
          project_id  INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          domain_id   INTEGER,
          snapshot_id INTEGER,
          hostname    TEXT,
          ts          TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_domain_serve_events_domain ON domain_serve_events(domain_id, ts DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_domain_serve_events_project ON domain_serve_events(project_id, ts DESC)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-domain-security ─────────────────────────────────────────────────
  {
    name: "migrate-domain-security",
    async run(client) {
      await client.query(`
        ALTER TABLE project_domains
          ADD COLUMN IF NOT EXISTS security_config JSONB,
          ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS suspension_reason TEXT
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS abuse_reports (
          id           SERIAL PRIMARY KEY,
          domain_id    INTEGER REFERENCES project_domains(id) ON DELETE SET NULL,
          hostname     TEXT NOT NULL,
          category     TEXT NOT NULL DEFAULT 'other',
          reason       TEXT NOT NULL,
          details      TEXT,
          reporter_email TEXT,
          reporter_ip  TEXT,
          status       TEXT NOT NULL DEFAULT 'open',
          resolved_by  TEXT,
          resolved_at  TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS abuse_reports_status_idx ON abuse_reports(status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS abuse_reports_hostname_idx ON abuse_reports(hostname)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS abuse_reports_domain_id_idx ON abuse_reports(domain_id)`,
      );
    },
  },

  // ── migrate-dns-records ─────────────────────────────────────────────────────
  {
    name: "migrate-dns-records",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS dns_records (
          id          serial PRIMARY KEY,
          project_id  integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          domain_id   integer NOT NULL REFERENCES project_domains(id) ON DELETE CASCADE,
          hostname    text NOT NULL,
          name        text NOT NULL,
          type        text NOT NULL,
          content     text,
          priority    integer,
          ttl         integer NOT NULL DEFAULT 1,
          proxied     boolean NOT NULL DEFAULT false,
          data        text,
          source      text NOT NULL DEFAULT 'local',
          cf_record_id text,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS dns_records_domain_idx ON dns_records(domain_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-pg-boss (schema auto-created by pg-boss on first start) ─────────
  // Skipped — pg-boss manages its own pgboss.* schema automatically.

  // ── migrate-workspace-domains ───────────────────────────────────────────────
  {
    name: "migrate-workspace-domains",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_domains (
          id                   SERIAL PRIMARY KEY,
          workspace_id         INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          hostname             TEXT NOT NULL,
          record_type          TEXT NOT NULL DEFAULT 'cname',
          verification_token   TEXT NOT NULL,
          status               TEXT NOT NULL DEFAULT 'pending_verification',
          verified_at          TIMESTAMPTZ,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS workspace_domains_hostname_unique ON workspace_domains(hostname)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_domain_roles (
          id                   SERIAL PRIMARY KEY,
          workspace_domain_id  INTEGER NOT NULL REFERENCES workspace_domains(id) ON DELETE CASCADE,
          user_id              TEXT NOT NULL,
          role                 TEXT NOT NULL DEFAULT 'viewer',
          granted_by           TEXT NOT NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS workspace_domain_roles_domain_user_unique ON workspace_domain_roles(workspace_domain_id, user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_usage_daily (
          id                         SERIAL PRIMARY KEY,
          workspace_id               INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          date                       DATE NOT NULL,
          hostname                   TEXT NOT NULL DEFAULT '',
          request_count              BIGINT NOT NULL DEFAULT 0,
          bandwidth_bytes            BIGINT NOT NULL DEFAULT 0,
          stripe_meter_reported_at   TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS workspace_usage_daily_workspace_date_host_unique ON workspace_usage_daily(workspace_id, date, hostname)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_domain_audit (
          id                   SERIAL PRIMARY KEY,
          workspace_id         INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
          workspace_domain_id  INTEGER,
          user_id              TEXT NOT NULL,
          action               TEXT NOT NULL,
          hostname             TEXT,
          payload              TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `ALTER TABLE project_domains ADD COLUMN IF NOT EXISTS workspace_domain_id INTEGER REFERENCES workspace_domains(id) ON DELETE SET NULL`,
      );
      await client.query(
        `ALTER TABLE domain_serve_events ADD COLUMN IF NOT EXISTS bytes_served BIGINT`,
      );
    },
  },

  // ── migrate-purchased-domains ───────────────────────────────────────────────
  {
    name: "migrate-purchased-domains",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS purchased_domains (
          id                               serial PRIMARY KEY,
          user_id                          text NOT NULL,
          hostname                         text NOT NULL UNIQUE,
          registrar                        text NOT NULL DEFAULT 'namecheap',
          registered_at                    timestamptz,
          expires_at                       timestamptz,
          auto_renew                       boolean NOT NULL DEFAULT true,
          whois_privacy                    boolean NOT NULL DEFAULT true,
          status                           text NOT NULL DEFAULT 'pending',
          namecheap_order_id               text,
          stripe_payment_intent_id         text,
          project_id                       integer,
          renewal_stripe_payment_intent_id text,
          last_renewal_at                  timestamptz,
          renewal_failed_at                timestamptz,
          renewal_failure_reason           text,
          transfer_auth_code               text,
          whois_first_name                 text,
          whois_last_name                  text,
          whois_email                      text,
          whois_phone                      text,
          whois_address                    text,
          whois_city                       text,
          whois_state_province             text,
          whois_postal_code                text,
          whois_country                    text,
          stripe_customer_id               text,
          price_paid_usd                   text,
          renewal_price_usd                text,
          created_at                       timestamptz NOT NULL DEFAULT now(),
          updated_at                       timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `ALTER TABLE purchased_domains ADD COLUMN IF NOT EXISTS stripe_customer_id text`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS purchased_domains_user_idx ON purchased_domains(user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS purchased_domains_project_idx ON purchased_domains(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS purchased_domains_expires_idx ON purchased_domains(expires_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-workspace-subscriptions ────────────────────────────────────────
  {
    name: "migrate-workspace-subscriptions",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS workspace_subscriptions (
          workspace_id           integer PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
          stripe_customer_id     text,
          stripe_subscription_id text UNIQUE,
          stripe_price_id        text,
          plan_tier              text NOT NULL DEFAULT 'free',
          status                 text NOT NULL DEFAULT 'inactive',
          current_period_end     timestamptz,
          cancel_at_period_end   text,
          created_at             timestamptz NOT NULL DEFAULT now(),
          updated_at             timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS workspace_subscriptions_customer_idx ON workspace_subscriptions(stripe_customer_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS workspace_subscriptions_status_idx ON workspace_subscriptions(status)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-plan-templates ──────────────────────────────────────────────────
  {
    name: "migrate-plan-templates",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS plan_templates (
          id          serial PRIMARY KEY,
          slug        text NOT NULL UNIQUE,
          category    text NOT NULL,
          name        text NOT NULL,
          description text NOT NULL,
          platform    text NOT NULL DEFAULT 'web',
          plan        jsonb NOT NULL,
          is_system   boolean NOT NULL DEFAULT true,
          sort_order  integer NOT NULL DEFAULT 0,
          created_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS plan_templates_category_idx ON plan_templates(category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS plan_templates_sort_order_idx ON plan_templates(sort_order)`,
      );
      await client.query("COMMIT");
      // Note: system template seeding is handled by the seed script
    },
  },

  // ── migrate-cdn-perfection ──────────────────────────────────────────────────
  {
    name: "migrate-cdn-perfection",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS error_page_404 text, ADD COLUMN IF NOT EXISTS error_page_500 text`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_bandwidth (
          id            serial PRIMARY KEY,
          project_id    integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          month         text NOT NULL,
          bytes_served  bigint NOT NULL DEFAULT 0,
          request_count integer NOT NULL DEFAULT 0,
          updated_at    timestamp with time zone NOT NULL DEFAULT now(),
          UNIQUE(project_id, month)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_bandwidth_project_month_idx ON project_bandwidth(project_id, month)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-subscriptions ───────────────────────────────────────────────────
  {
    name: "migrate-subscriptions",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS user_subscriptions (
          id                     SERIAL PRIMARY KEY,
          user_id                TEXT NOT NULL UNIQUE,
          stripe_customer_id     TEXT,
          stripe_subscription_id TEXT,
          tier                   TEXT NOT NULL DEFAULT 'free',
          status                 TEXT NOT NULL DEFAULT 'active',
          current_period_end     TIMESTAMPTZ,
          grace_period_end       TIMESTAMPTZ,
          cancel_at_period_end   BOOLEAN NOT NULL DEFAULT FALSE,
          last_monthly_grant_at  TIMESTAMPTZ,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS user_subscriptions_stripe_customer_idx ON user_subscriptions(stripe_customer_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS user_subscriptions_stripe_sub_idx ON user_subscriptions(stripe_subscription_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-runtime-breadth ─────────────────────────────────────────────────
  {
    name: "migrate-runtime-breadth",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS scheduled_job_runs (
          id           SERIAL PRIMARY KEY,
          schedule_id  INTEGER NOT NULL REFERENCES deployment_schedules(id) ON DELETE CASCADE,
          project_id   INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          status       TEXT NOT NULL DEFAULT 'running',
          exit_code    INTEGER,
          output       TEXT,
          error_message TEXT,
          duration_ms  INTEGER,
          triggered_by TEXT NOT NULL DEFAULT 'cron',
          started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          finished_at  TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS scheduled_job_runs_schedule_idx ON scheduled_job_runs(schedule_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS scheduled_job_runs_project_idx ON scheduled_job_runs(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS scheduled_job_runs_started_idx ON scheduled_job_runs(started_at)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS managed_addons (
          id                SERIAL PRIMARY KEY,
          project_id        INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind              TEXT NOT NULL,
          status            TEXT NOT NULL DEFAULT 'provisioning',
          external_id       TEXT,
          connection_info   JSONB,
          injected_env_keys JSONB NOT NULL DEFAULT '[]',
          plan              TEXT NOT NULL DEFAULT 'free',
          usage_bytes       INTEGER,
          usage_ops         INTEGER,
          last_metered_at   TIMESTAMPTZ,
          notes             TEXT,
          created_by        TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          removed_at        TIMESTAMPTZ,
          CONSTRAINT managed_addons_project_kind_unique UNIQUE (project_id, kind)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS managed_addons_project_idx ON managed_addons(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS managed_addons_kind_idx ON managed_addons(kind)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_environments (
          id                  SERIAL PRIMARY KEY,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          name                TEXT NOT NULL,
          snapshot_version_id INTEGER,
          status              TEXT NOT NULL DEFAULT 'idle',
          url                 TEXT,
          auto_promote        BOOLEAN NOT NULL DEFAULT FALSE,
          protected           BOOLEAN NOT NULL DEFAULT FALSE,
          deployed_by         TEXT,
          deployed_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT project_environments_project_name_unique UNIQUE (project_id, name)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_environments_project_idx ON project_environments(project_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS environment_promotions (
          id                  SERIAL PRIMARY KEY,
          project_id          INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          from_environment    TEXT NOT NULL,
          to_environment      TEXT NOT NULL,
          snapshot_version_id INTEGER,
          status              TEXT NOT NULL DEFAULT 'pending',
          notes               TEXT,
          triggered_by        TEXT,
          started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at        TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS environment_promotions_project_idx ON environment_promotions(project_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id            SERIAL PRIMARY KEY,
          project_id    INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id       TEXT NOT NULL,
          kind          TEXT NOT NULL,
          quantity      NUMERIC(18,6) NOT NULL DEFAULT 1,
          resource_type TEXT,
          resource_id   TEXT,
          unit          TEXT NOT NULL DEFAULT 'units',
          recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS usage_events_project_idx ON usage_events(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS usage_events_user_idx ON usage_events(user_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS usage_events_kind_idx ON usage_events(kind)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS usage_events_recorded_at_idx ON usage_events(recorded_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-collaboration ───────────────────────────────────────────────────
  {
    name: "migrate-collaboration",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS organizations (
          id                  serial PRIMARY KEY,
          name                text NOT NULL,
          slug                text NOT NULL UNIQUE,
          description         text,
          type                text NOT NULL DEFAULT 'team',
          avatar_url          text,
          billing_email       text,
          stripe_customer_id  text,
          created_by_user_id  text NOT NULL,
          deleted_at          timestamptz,
          created_at          timestamptz NOT NULL DEFAULT now(),
          updated_at          timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS org_members (
          id              serial PRIMARY KEY,
          organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id         text NOT NULL,
          role            text NOT NULL DEFAULT 'member',
          display_name    text,
          email           text,
          avatar_url      text,
          joined_at       timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          UNIQUE (organization_id, user_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS org_members_user_idx ON org_members(user_id)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS org_members_org_idx ON org_members(organization_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS org_invites (
          id                   serial PRIMARY KEY,
          organization_id      integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          token                text NOT NULL UNIQUE,
          email                text NOT NULL,
          role                 text NOT NULL DEFAULT 'member',
          invited_by_user_id   text NOT NULL,
          status               text NOT NULL DEFAULT 'pending',
          accepted_by_user_id  text,
          expires_at           timestamptz NOT NULL,
          accepted_at          timestamptz,
          created_at           timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS org_invites_org_idx ON org_invites(organization_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS org_invites_email_idx ON org_invites(email)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_comments (
          id                  serial PRIMARY KEY,
          project_id          integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          author_id           text NOT NULL,
          author_name         text,
          author_avatar       text,
          parent_id           integer,
          file_path           text,
          line_start          integer,
          line_end            integer,
          build_result_id     integer,
          body                text NOT NULL,
          resolved            boolean NOT NULL DEFAULT false,
          resolved_by_user_id text,
          resolved_at         timestamptz,
          edited_at           timestamptz,
          deleted_at          timestamptz,
          created_at          timestamptz NOT NULL DEFAULT now(),
          updated_at          timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_comments_project_idx ON project_comments(project_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_comments_parent_idx ON project_comments(parent_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_comments_file_idx ON project_comments(project_id, file_path)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id            serial PRIMARY KEY,
          recipient_id  text NOT NULL,
          type          text NOT NULL,
          title         text NOT NULL,
          body          text,
          actor_id      text,
          actor_name    text,
          resource_type text,
          resource_id   text,
          project_id    integer,
          metadata      jsonb,
          read          boolean NOT NULL DEFAULT false,
          read_at       timestamptz,
          created_at    timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(recipient_id, read) WHERE read = false`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_activity (
          id           serial PRIMARY KEY,
          project_id   integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          actor_id     text,
          actor_name   text,
          actor_avatar text,
          event_type   text NOT NULL,
          summary      text NOT NULL,
          metadata     jsonb,
          created_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_activity_project_idx ON project_activity(project_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_activity_actor_idx ON project_activity(actor_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS share_links (
          id                  serial PRIMARY KEY,
          project_id          integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          token               text NOT NULL UNIQUE,
          label               text,
          created_by_user_id  text NOT NULL,
          scope               text NOT NULL DEFAULT 'draft',
          snapshot_version_id integer,
          password_hash       text,
          expires_at          timestamptz,
          revoked             boolean NOT NULL DEFAULT false,
          revoked_at          timestamptz,
          view_count          integer NOT NULL DEFAULT 0,
          last_viewed_at      timestamptz,
          created_at          timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links(project_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS share_links_token_idx ON share_links(token)`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS organization_id integer REFERENCES organizations(id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(organization_id)`,
      );

      // data migration: create personal orgs for existing users
      const { rows: owners } = await client.query<{ owner_id: string }>(`
        SELECT DISTINCT p.owner_id FROM projects p
        WHERE p.owner_id IS NOT NULL AND p.owner_id != ''
          AND NOT EXISTS (
            SELECT 1 FROM organizations o
            WHERE o.created_by_user_id = p.owner_id AND o.type = 'personal'
          )
      `);
      for (const { owner_id } of owners) {
        const slug = `personal-${owner_id
          .toLowerCase()
          .replace(/[^a-z0-9]/g, "-")
          .slice(0, 40)}`;
        const { rows: orgs } = await client.query(
          `INSERT INTO organizations (name, slug, type, created_by_user_id)
           VALUES ($1, $2, 'personal', $3)
           ON CONFLICT (slug) DO UPDATE SET updated_at = now()
           RETURNING id`,
          ["Personal", slug, owner_id],
        );
        if (orgs[0]) {
          await client.query(
            `INSERT INTO org_members (organization_id, user_id, role)
             VALUES ($1, $2, 'owner')
             ON CONFLICT (organization_id, user_id) DO NOTHING`,
            [orgs[0].id, owner_id],
          );
          await client.query(
            `UPDATE projects SET organization_id = $1 WHERE owner_id = $2 AND organization_id IS NULL`,
            [orgs[0].id, owner_id],
          );
        }
      }

      await client.query("COMMIT");
    },
  },

  // ── migrate-ecosystem ───────────────────────────────────────────────────────
  {
    name: "migrate-ecosystem",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS gallery_templates (
          id            serial PRIMARY KEY,
          slug          text NOT NULL UNIQUE,
          title         text NOT NULL,
          description   text NOT NULL,
          readme        text,
          category      text NOT NULL DEFAULT 'web',
          tags          jsonb NOT NULL DEFAULT '[]',
          author_id     text,
          author_name   text,
          files_snapshot jsonb,
          preview_url   text,
          thumbnail_url text,
          platform      text NOT NULL DEFAULT 'web',
          stack         text NOT NULL DEFAULT 'react-vite',
          rating        real NOT NULL DEFAULT 0,
          rating_count  integer NOT NULL DEFAULT 0,
          fork_count    integer NOT NULL DEFAULT 0,
          use_count     integer NOT NULL DEFAULT 0,
          status        text NOT NULL DEFAULT 'draft',
          featured      boolean NOT NULL DEFAULT false,
          editors_pick  boolean NOT NULL DEFAULT false,
          is_system     boolean NOT NULL DEFAULT false,
          forked_from_id integer,
          source_project_id integer,
          created_at    timestamptz NOT NULL DEFAULT now(),
          updated_at    timestamptz NOT NULL DEFAULT now(),
          published_at  timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_status_idx ON gallery_templates(status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_category_idx ON gallery_templates(category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_featured_idx ON gallery_templates(featured)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_rating_idx ON gallery_templates(rating DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_author_idx ON gallery_templates(author_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS template_ratings (
          id          serial PRIMARY KEY,
          template_id integer NOT NULL,
          user_id     text NOT NULL,
          rating      integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment     text,
          created_at  timestamptz NOT NULL DEFAULT now(),
          updated_at  timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS template_ratings_template_idx ON template_ratings(template_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS template_ratings_user_idx ON template_ratings(user_id)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS template_ratings_user_template_unique ON template_ratings(template_id, user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS extensions (
          id               serial PRIMARY KEY,
          slug             text NOT NULL UNIQUE,
          name             text NOT NULL,
          description      text NOT NULL,
          long_description text,
          version          text NOT NULL DEFAULT '1.0.0',
          author_id        text,
          author_name      text,
          manifest_url     text,
          manifest         jsonb,
          scopes           jsonb NOT NULL DEFAULT '[]',
          icon_url         text,
          homepage_url     text,
          repository_url   text,
          category         text NOT NULL DEFAULT 'productivity',
          tags             jsonb NOT NULL DEFAULT '[]',
          install_count    integer NOT NULL DEFAULT 0,
          status           text NOT NULL DEFAULT 'draft',
          vetted           boolean NOT NULL DEFAULT false,
          featured         boolean NOT NULL DEFAULT false,
          is_system        boolean NOT NULL DEFAULT false,
          vetting_notes    text,
          vetted_at        timestamptz,
          vetted_by        text,
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now(),
          published_at     timestamptz
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS extensions_status_idx ON extensions(status)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_category_idx ON extensions(category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_featured_idx ON extensions(featured)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_author_idx ON extensions(author_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_extensions (
          id             serial PRIMARY KEY,
          project_id     integer NOT NULL,
          extension_id   integer NOT NULL,
          extension_slug text NOT NULL,
          installed_by   text,
          config         jsonb,
          enabled        boolean NOT NULL DEFAULT true,
          installed_at   timestamptz NOT NULL DEFAULT now(),
          updated_at     timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_extensions_project_idx ON project_extensions(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_extensions_extension_idx ON project_extensions(extension_id)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_extensions_unique ON project_extensions(project_id, extension_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS community_profiles (
          id                  serial PRIMARY KEY,
          user_id             text NOT NULL UNIQUE,
          username            text NOT NULL UNIQUE,
          display_name        text,
          bio                 text,
          avatar_url          text,
          website_url         text,
          twitter_handle      text,
          github_handle       text,
          location            text,
          public_project_ids  jsonb NOT NULL DEFAULT '[]',
          showcased_project_ids jsonb NOT NULL DEFAULT '[]',
          follower_count      integer NOT NULL DEFAULT 0,
          following_count     integer NOT NULL DEFAULT 0,
          badge_embed_enabled boolean NOT NULL DEFAULT false,
          profile_public      boolean NOT NULL DEFAULT true,
          created_at          timestamptz NOT NULL DEFAULT now(),
          updated_at          timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS community_profiles_username_idx ON community_profiles(username)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS community_profiles_user_id_idx ON community_profiles(user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS profile_follows (
          id           serial PRIMARY KEY,
          follower_id  text NOT NULL,
          following_id text NOT NULL,
          created_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS profile_follows_follower_idx ON profile_follows(follower_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS profile_follows_following_idx ON profile_follows(following_id)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS profile_follows_unique ON profile_follows(follower_id, following_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-secret-scoping ──────────────────────────────────────────────────
  {
    name: "migrate-secret-scoping",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS min_role TEXT NOT NULL DEFAULT 'viewer'`,
      );
      await client.query(`
        DO $$
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'project_secrets_min_role_check'
          ) THEN
            ALTER TABLE project_secrets
              ADD CONSTRAINT project_secrets_min_role_check
              CHECK (min_role IN ('viewer', 'member', 'admin', 'owner'));
          END IF;
        END
        $$
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-agentic-provisioning ────────────────────────────────────────────
  {
    name: "migrate-agentic-provisioning",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS builder_mode text NOT NULL DEFAULT 'static-legacy'`,
      );
      await client.query(`ALTER TABLE projects ALTER COLUMN builder_mode SET DEFAULT 'agentic'`);
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS neon_project_id text`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS provisioning_status text NOT NULL DEFAULT 'idle'`,
      );
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS provisioning_error text`);
      await client.query("COMMIT");
    },
  },

  // Builder architecture selection lock.
  {
    name: "migrate-builder-stack-lock",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS stack_locked BOOLEAN NOT NULL DEFAULT FALSE`,
      );
    },
  },

  // ── migrate-task-agent-mode ─────────────────────────────────────────────────
  {
    name: "migrate-task-agent-mode",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS task_agent_mode text`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-preview-secrets ─────────────────────────────────────────────────
  {
    name: "migrate-preview-secrets",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS is_preview_safe BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-testing-approval ────────────────────────────────────────────────
  {
    name: "migrate-testing-approval",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_approved_at timestamptz`,
      );
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_approved_by text`,
      );
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS migration_status text`,
      );
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS migration_log text`,
      );
      await client.query(
        `ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS testing_skipped boolean NOT NULL DEFAULT false`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-preview-db ──────────────────────────────────────────────────────
  {
    name: "migrate-preview-db",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_db_url text`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS preview_db_status text NOT NULL DEFAULT 'none'`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-testing-workflow ────────────────────────────────────────────────
  {
    name: "migrate-testing-workflow",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_id text`);
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_url text`);
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS test_container_status text NOT NULL DEFAULT 'stopped'`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS running_test_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS static_test_candidate_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS testing_candidate_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS testing_status text NOT NULL DEFAULT 'idle'`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS tested_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS previous_published_snapshot_id integer`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS active_preview_session_id text`,
      );
      await client.query(
        `ALTER TABLE project_secrets ADD COLUMN IF NOT EXISTS exposure_type text NOT NULL DEFAULT 'server'`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS preview_sessions (
          id                serial PRIMARY KEY,
          session_id        text NOT NULL UNIQUE,
          project_id        integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          user_id           text NOT NULL,
          launch_token_hash text NOT NULL,
          launch_token_used boolean NOT NULL DEFAULT false,
          cookie_issued_at  timestamptz,
          expires_at        timestamptz NOT NULL,
          revoked_at        timestamptz,
          revoke_reason     text,
          created_at        timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS preview_sessions_project_idx ON preview_sessions(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS preview_sessions_session_id_idx ON preview_sessions(session_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-deployment-logs-mobile ──────────────────────────────────────────
  {
    name: "migrate-deployment-logs-mobile",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS build_id text`);
      await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS platform text`);
      await client.query(`ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS download_url text`);
      await client.query(
        `ALTER TABLE deployment_logs ADD COLUMN IF NOT EXISTS testflight_url text`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-token-count ─────────────────────────────────────────────────────
  {
    name: "migrate-token-count",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS token_count integer`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-chip-label ──────────────────────────────────────────────────────
  {
    name: "migrate-chip-label",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS chip_label TEXT`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-personal-access-tokens ─────────────────────────────────────────
  {
    name: "migrate-personal-access-tokens",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS personal_access_tokens (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          name          TEXT NOT NULL,
          token_hash    TEXT NOT NULL UNIQUE,
          token_preview TEXT NOT NULL,
          project_id    INTEGER REFERENCES projects(id) ON DELETE CASCADE,
          scopes        JSONB NOT NULL DEFAULT '["domains:read","domains:write"]',
          active        BOOLEAN NOT NULL DEFAULT TRUE,
          last_used_at  TIMESTAMPTZ,
          expires_at    TIMESTAMPTZ,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-pat-rotation (Task #864) ────────────────────────────────────────
  {
    name: "migrate-pat-rotation",
    async run(client) {
      await client.query(
        `ALTER TABLE personal_access_tokens ADD COLUMN IF NOT EXISTS rotated_at TIMESTAMPTZ`,
      );
    },
  },

  // ── migrate-message-origin (Task #919) ──────────────────────────────────────
  {
    name: "migrate-message-origin",
    async run(client) {
      await client.query(`ALTER TABLE chat_messages ADD COLUMN IF NOT EXISTS origin TEXT`);
    },
  },

  // ── migrate-command-approval (Task #964) ─────────────────────────────────────
  {
    name: "migrate-command-approval",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS require_command_approval BOOLEAN NOT NULL DEFAULT false`,
      );
    },
  },

  // ── migrate-voice-lang ───────────────────────────────────────────────────────
  {
    name: "migrate-voice-lang",
    async run(client) {
      await client.query(`ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS voice_lang TEXT`);
    },
  },

  // ── migrate-auto-read-replies ────────────────────────────────────────────────
  {
    name: "migrate-auto-read-replies",
    async run(client) {
      await client.query(
        `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS auto_read_replies BOOLEAN NOT NULL DEFAULT false`,
      );
    },
  },

  // ── migrate-reinforced-count (Task #980) ─────────────────────────────────────
  {
    name: "migrate-reinforced-count",
    async run(client) {
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS reinforced_count INTEGER NOT NULL DEFAULT 0`,
      );
    },
  },

  // ── migrate-canvas-state (Task #904) ─────────────────────────────────────────
  {
    name: "migrate-canvas-state",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS canvas_state JSONB DEFAULT '{}'`,
      );
    },
  },

  // ── migrate-brainstorm-context ───────────────────────────────────────────────
  {
    name: "migrate-brainstorm-context",
    async run(client) {
      await client.query(`
        ALTER TABLE agent_tasks
          ADD COLUMN IF NOT EXISTS has_brainstorm_context BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS brainstorm_turn_count INTEGER
      `);
    },
  },

  // ── migrate-gdpr-erasure-job (Task #1002) ────────────────────────────────────
  {
    name: "migrate-gdpr-erasure-job",
    async run(client) {
      await client.query(`
        ALTER TABLE user_preferences
          ADD COLUMN IF NOT EXISTS erasure_job_id TEXT,
          ADD COLUMN IF NOT EXISTS erasure_requested_at TIMESTAMPTZ
      `);
    },
  },

  // ── migrate-low-credit-email (Task #1003) ────────────────────────────────────
  {
    name: "migrate-low-credit-email",
    async run(client) {
      await client.query(
        `ALTER TABLE user_credits ADD COLUMN IF NOT EXISTS last_low_credit_email_at TIMESTAMPTZ`,
      );
    },
  },

  // ── migrate-ora-project-description ───────────────────────────────────────────
  {
    name: "migrate-ora-project-description",
    async run(client) {
      await client.query(`ALTER TABLE ora_projects ADD COLUMN IF NOT EXISTS description TEXT`);
    },
  },

  // ── migrate-mobile-deployment-columns (Task #776) ────────────────────────────
  {
    name: "migrate-mobile-deployment-columns",
    async run(client) {
      await client.query(`
        ALTER TABLE deployment_logs
          ADD COLUMN IF NOT EXISTS build_id text,
          ADD COLUMN IF NOT EXISTS platform text,
          ADD COLUMN IF NOT EXISTS download_url text,
          ADD COLUMN IF NOT EXISTS testflight_url text
      `);
    },
  },

  // ── migrate-preferred-mode (Task #897) ───────────────────────────────────────
  {
    name: "migrate-preferred-mode",
    async run(client) {
      await client.query(
        `ALTER TABLE user_preferences ADD COLUMN IF NOT EXISTS preferred_mode TEXT`,
      );
      await client.query(
        `ALTER TABLE user_preferences DROP CONSTRAINT IF EXISTS user_preferences_preferred_mode_check`,
      );
      await client.query(
        `ALTER TABLE user_preferences ADD CONSTRAINT user_preferences_preferred_mode_check CHECK (preferred_mode IN ('builder','developer','ora'))`,
      );
    },
  },

  // ── migrate-project-mode (Task #898) ─────────────────────────────────────────
  {
    name: "migrate-project-mode",
    async run(client) {
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_mode TEXT NOT NULL DEFAULT 'builder'`,
      );
      await client.query(
        `ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_mode_check`,
      );
      await client.query(
        `ALTER TABLE projects ADD CONSTRAINT projects_project_mode_check CHECK (project_mode IN ('builder','developer'))`,
      );
    },
  },

  // ── migrate-provisioning-steps (Task #988) ───────────────────────────────────
  {
    name: "migrate-provisioning-steps",
    async run(client) {
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS provisioning_step TEXT,
          ADD COLUMN IF NOT EXISTS provisioning_started_at TIMESTAMPTZ
      `);
    },
  },

  // ── migrate-stripe-events-status ─────────────────────────────────────────────
  {
    name: "migrate-stripe-events-status",
    async run(client) {
      await client.query(`
        ALTER TABLE stripe_processed_events
          ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'succeeded',
          ADD COLUMN IF NOT EXISTS processing_started_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS succeeded_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS failed_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS error_message TEXT
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS credit_grants (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          subscription_id TEXT NOT NULL,
          period_start TIMESTAMPTZ NOT NULL,
          amount INTEGER NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT credit_grants_subscription_period_unique UNIQUE (subscription_id, period_start)
        )
      `);
    },
  },

  // ── migrate-drop-conversations ───────────────────────────────────────────────
  {
    name: "migrate-drop-conversations",
    async run(client) {
      await client.query(`DROP TABLE IF EXISTS conversations`);
    },
  },

  // ── migrate-agent-tool-calls ───────────────────────────────────────────────
  // Per-tool-call audit log for the agentic builder loop + per-project hourly
  // rate cap on projects. Without this table the agent-loop INSERT/COUNT in
  // handleToolResult silently falls back to a stale estimate (try/catch) so
  // the audit feed stays empty and the rate limiter never enforces.
  {
    name: "migrate-agent-tool-calls",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS agent_tool_calls (
          id              SERIAL PRIMARY KEY,
          project_id      INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          task_id         INTEGER,
          tool_name       TEXT NOT NULL,
          args_summary    TEXT,
          stdout_preview  TEXT,
          exit_code       INTEGER,
          ok              BOOLEAN NOT NULL DEFAULT TRUE,
          duration_ms     INTEGER NOT NULL DEFAULT 0,
          called_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tool_calls_project_called_idx ON agent_tool_calls (project_id, called_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tool_calls_task_idx ON agent_tool_calls (task_id)`,
      );
      await client.query(
        `ALTER TABLE projects ADD COLUMN IF NOT EXISTS tool_call_rate_cap_per_hour INTEGER NOT NULL DEFAULT 200`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-collaboration ────────────────────────────────────────────────────
  {
    name: "migrate-collaboration",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS organizations (
          id serial PRIMARY KEY,
          name text NOT NULL,
          slug text NOT NULL UNIQUE,
          description text,
          type text NOT NULL DEFAULT 'team',
          avatar_url text,
          billing_email text,
          stripe_customer_id text,
          created_by_user_id text NOT NULL,
          deleted_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS org_members (
          id serial PRIMARY KEY,
          organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          user_id text NOT NULL,
          role text NOT NULL DEFAULT 'member',
          display_name text,
          email text,
          avatar_url text,
          joined_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          UNIQUE (organization_id, user_id)
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS org_members_user_idx ON org_members(user_id)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS org_members_org_idx ON org_members(organization_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS org_invites (
          id serial PRIMARY KEY,
          organization_id integer NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          token text NOT NULL UNIQUE,
          email text NOT NULL,
          role text NOT NULL DEFAULT 'member',
          invited_by_user_id text NOT NULL,
          status text NOT NULL DEFAULT 'pending',
          accepted_by_user_id text,
          expires_at timestamptz NOT NULL,
          accepted_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS org_invites_org_idx ON org_invites(organization_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS org_invites_email_idx ON org_invites(email)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_comments (
          id serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          author_id text NOT NULL,
          author_name text,
          author_avatar text,
          parent_id integer,
          file_path text,
          line_start integer,
          line_end integer,
          build_result_id integer,
          body text NOT NULL,
          resolved boolean NOT NULL DEFAULT false,
          resolved_by_user_id text,
          resolved_at timestamptz,
          edited_at timestamptz,
          deleted_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_comments_project_idx ON project_comments(project_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_comments_parent_idx ON project_comments(parent_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_comments_file_idx ON project_comments(project_id, file_path)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS notifications (
          id serial PRIMARY KEY,
          recipient_id text NOT NULL,
          type text NOT NULL,
          title text NOT NULL,
          body text,
          actor_id text,
          actor_name text,
          resource_type text,
          resource_id text,
          project_id integer,
          metadata jsonb,
          read boolean NOT NULL DEFAULT false,
          read_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS notifications_recipient_idx ON notifications(recipient_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(recipient_id, read) WHERE read = false`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_activity (
          id serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          actor_id text,
          actor_name text,
          actor_avatar text,
          event_type text NOT NULL,
          summary text NOT NULL,
          metadata jsonb,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_activity_project_idx ON project_activity(project_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_activity_actor_idx ON project_activity(actor_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS share_links (
          id serial PRIMARY KEY,
          project_id integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          token text NOT NULL UNIQUE,
          label text,
          created_by_user_id text NOT NULL,
          scope text NOT NULL DEFAULT 'draft',
          snapshot_version_id integer,
          password_hash text,
          expires_at timestamptz,
          revoked boolean NOT NULL DEFAULT false,
          revoked_at timestamptz,
          view_count integer NOT NULL DEFAULT 0,
          last_viewed_at timestamptz,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS share_links_project_idx ON share_links(project_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS share_links_token_idx ON share_links(token)`);
      await client.query(`
        ALTER TABLE projects
          ADD COLUMN IF NOT EXISTS organization_id integer REFERENCES organizations(id)
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS projects_org_idx ON projects(organization_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ecosystem ─────────────────────────────────────────────────────────
  {
    name: "migrate-ecosystem",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS gallery_templates (
          id serial PRIMARY KEY,
          slug text NOT NULL UNIQUE,
          title text NOT NULL,
          description text NOT NULL,
          readme text,
          category text NOT NULL DEFAULT 'web',
          tags jsonb NOT NULL DEFAULT '[]',
          author_id text,
          author_name text,
          files_snapshot jsonb,
          preview_url text,
          thumbnail_url text,
          platform text NOT NULL DEFAULT 'web',
          stack text NOT NULL DEFAULT 'react-vite',
          rating real NOT NULL DEFAULT 0,
          rating_count integer NOT NULL DEFAULT 0,
          fork_count integer NOT NULL DEFAULT 0,
          use_count integer NOT NULL DEFAULT 0,
          status text NOT NULL DEFAULT 'draft',
          featured boolean NOT NULL DEFAULT false,
          editors_pick boolean NOT NULL DEFAULT false,
          is_system boolean NOT NULL DEFAULT false,
          forked_from_id integer,
          source_project_id integer,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          published_at timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_status_idx ON gallery_templates(status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_category_idx ON gallery_templates(category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_featured_idx ON gallery_templates(featured)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_rating_idx ON gallery_templates(rating DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS gallery_templates_author_idx ON gallery_templates(author_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS template_ratings (
          id serial PRIMARY KEY,
          template_id integer NOT NULL,
          user_id text NOT NULL,
          rating integer NOT NULL CHECK (rating >= 1 AND rating <= 5),
          comment text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS template_ratings_template_idx ON template_ratings(template_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS template_ratings_user_idx ON template_ratings(user_id)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS template_ratings_user_template_unique ON template_ratings(template_id, user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS extensions (
          id serial PRIMARY KEY,
          slug text NOT NULL UNIQUE,
          name text NOT NULL,
          description text NOT NULL,
          long_description text,
          version text NOT NULL DEFAULT '1.0.0',
          author_id text,
          author_name text,
          manifest_url text,
          manifest jsonb,
          scopes jsonb NOT NULL DEFAULT '[]',
          icon_url text,
          homepage_url text,
          repository_url text,
          category text NOT NULL DEFAULT 'productivity',
          tags jsonb NOT NULL DEFAULT '[]',
          install_count integer NOT NULL DEFAULT 0,
          status text NOT NULL DEFAULT 'draft',
          vetted boolean NOT NULL DEFAULT false,
          featured boolean NOT NULL DEFAULT false,
          is_system boolean NOT NULL DEFAULT false,
          vetting_notes text,
          vetted_at timestamptz,
          vetted_by text,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now(),
          published_at timestamptz
        )
      `);
      await client.query(`CREATE INDEX IF NOT EXISTS extensions_status_idx ON extensions(status)`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_category_idx ON extensions(category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_featured_idx ON extensions(featured)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS extensions_author_idx ON extensions(author_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS project_extensions (
          id serial PRIMARY KEY,
          project_id integer NOT NULL,
          extension_id integer NOT NULL,
          extension_slug text NOT NULL,
          installed_by text,
          config jsonb,
          enabled boolean NOT NULL DEFAULT true,
          installed_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_extensions_project_idx ON project_extensions(project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS project_extensions_extension_idx ON project_extensions(extension_id)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS project_extensions_unique ON project_extensions(project_id, extension_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS community_profiles (
          id serial PRIMARY KEY,
          user_id text NOT NULL UNIQUE,
          username text NOT NULL UNIQUE,
          display_name text,
          bio text,
          avatar_url text,
          website_url text,
          twitter_handle text,
          github_handle text,
          location text,
          public_project_ids jsonb NOT NULL DEFAULT '[]',
          showcased_project_ids jsonb NOT NULL DEFAULT '[]',
          follower_count integer NOT NULL DEFAULT 0,
          following_count integer NOT NULL DEFAULT 0,
          badge_embed_enabled boolean NOT NULL DEFAULT false,
          profile_public boolean NOT NULL DEFAULT true,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS community_profiles_username_idx ON community_profiles(username)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS community_profiles_user_id_idx ON community_profiles(user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS profile_follows (
          id serial PRIMARY KEY,
          follower_id text NOT NULL,
          following_id text NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS profile_follows_follower_idx ON profile_follows(follower_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS profile_follows_following_idx ON profile_follows(following_id)`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS profile_follows_unique ON profile_follows(follower_id, following_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-transcripts ──────────────────────────────────────────────────
  {
    name: "migrate-ora-transcripts",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_transcripts (
          id         SERIAL PRIMARY KEY,
          user_id    TEXT NOT NULL UNIQUE,
          messages   JSONB NOT NULL DEFAULT '[]'::jsonb,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_transcripts_user_id_idx ON ora_transcripts (user_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-vault ────────────────────────────────────────────────────────────
  {
    name: "migrate-vault",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS vault_entries (
          id               serial PRIMARY KEY,
          user_id          text NOT NULL,
          title            text NOT NULL,
          category         text NOT NULL DEFAULT 'OTHER',
          subcategory      text,
          summary          text NOT NULL,
          content          text NOT NULL,
          tags             text,
          department       text,
          source_type      text NOT NULL DEFAULT 'USER_CREATED',
          source_reference text,
          status           text NOT NULL DEFAULT 'draft',
          version          integer NOT NULL DEFAULT 1,
          confidence_score integer,
          approved         boolean NOT NULL DEFAULT false,
          updated_by       text,
          created_at       timestamptz NOT NULL DEFAULT now(),
          updated_at       timestamptz NOT NULL DEFAULT now(),
          archived_at      timestamptz
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_user_idx ON vault_entries(user_id, created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_category_idx ON vault_entries(user_id, category)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_status_idx ON vault_entries(user_id, status)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS vault_versions (
          id             serial PRIMARY KEY,
          entry_id       integer NOT NULL REFERENCES vault_entries(id) ON DELETE CASCADE,
          version        integer NOT NULL,
          title          text NOT NULL,
          summary        text NOT NULL,
          content        text NOT NULL,
          tags           text,
          department     text,
          edited_by      text NOT NULL,
          edited_at      timestamptz NOT NULL DEFAULT now(),
          change_summary text
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_versions_entry_idx ON vault_versions(entry_id, version DESC)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-vault-phase81 ─────────────────────────────────────────────────
  {
    name: "migrate-vault-phase81",
    async run(client) {
      await client.query("BEGIN");
      // Convert tags TEXT → TEXT[] in vault_entries
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'vault_entries' AND column_name = 'tags'
              AND data_type = 'text'
          ) THEN
            ALTER TABLE vault_entries
              ALTER COLUMN tags TYPE text[]
              USING (
                CASE
                  WHEN tags IS NULL OR tags = '' THEN '{}'::text[]
                  ELSE string_to_array(tags, ',')
                END
              );
            ALTER TABLE vault_entries ALTER COLUMN tags SET DEFAULT '{}';
            ALTER TABLE vault_entries ALTER COLUMN tags SET NOT NULL;
          END IF;
        END $$
      `);
      // Convert tags TEXT → TEXT[] in vault_versions
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name = 'vault_versions' AND column_name = 'tags'
              AND data_type = 'text'
          ) THEN
            ALTER TABLE vault_versions
              ALTER COLUMN tags TYPE text[]
              USING (
                CASE
                  WHEN tags IS NULL OR tags = '' THEN '{}'::text[]
                  ELSE string_to_array(tags, ',')
                END
              );
            ALTER TABLE vault_versions ALTER COLUMN tags SET DEFAULT '{}';
            ALTER TABLE vault_versions ALTER COLUMN tags SET NOT NULL;
          END IF;
        END $$
      `);
      // Create a stable IMMUTABLE wrapper so the GIN index expression stored in
      // pg_indexes does NOT contain || (pipe-pipe). Replit's deployment tool
      // misparses || in functional GIN index definitions and generates broken SQL.
      // Using a named function means pg_indexes shows `vault_fts(title, summary)` —
      // no || — so the tool copies it to production without corruption.
      await client.query(`
        CREATE OR REPLACE FUNCTION vault_fts(title text, summary text)
          RETURNS tsvector
          LANGUAGE sql
          IMMUTABLE PARALLEL SAFE
          AS $fn$
            SELECT to_tsvector('english'::regconfig,
              coalesce(title, '') || ' ' || coalesce(summary, ''))
          $fn$
      `);
      // Drop-then-recreate so any stale definition (e.g. the old inline ||
      // expression) is replaced with the function-based definition on every boot.
      await client.query(`DROP INDEX IF EXISTS vault_entries_search_idx`);
      await client.query(`
        CREATE INDEX vault_entries_search_idx
          ON vault_entries
          USING GIN(vault_fts(title, summary))
      `);
      // GIN index on tags array
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_tags_idx ON vault_entries USING GIN(tags)`,
      );
      // Performance indexes
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_updated_idx ON vault_entries (user_id, updated_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_dept_idx ON vault_entries (user_id, department)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS vault_entries_archived_idx ON vault_entries (user_id, archived_at) WHERE archived_at IS NOT NULL`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-vault-embeddings ───────────────────────────────────────────────
  {
    name: "migrate-vault-embeddings",
    async run(client) {
      await client.query("BEGIN");
      await client.query("CREATE EXTENSION IF NOT EXISTS vector");
      await client.query(`
        CREATE TABLE IF NOT EXISTS vault_embeddings (
          id              serial PRIMARY KEY,
          entry_id        integer NOT NULL,
          user_id         text NOT NULL,
          chunk_index     integer NOT NULL,
          chunk_text      text NOT NULL,
          chunk_hash      text NOT NULL,
          embedding       vector(1536),
          embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
          source_version  integer NOT NULL,
          created_at      timestamptz NOT NULL DEFAULT now(),
          updated_at      timestamptz NOT NULL DEFAULT now(),
          CONSTRAINT vault_embeddings_entry_chunk_unique UNIQUE (entry_id, chunk_index)
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS vault_embeddings_entry_idx
          ON vault_embeddings (entry_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS vault_embeddings_user_idx
          ON vault_embeddings (user_id, entry_id)
      `);
      await client.query("COMMIT");
    },
  },
  {
    name: "knowledge_usage_events",
    run: async (client) => {
      await ensureKnowledgeUsageEventsSchema(client);
    },
  },

  // ── migrate-image-studio ─────────────────────────────────────────────────
  {
    name: "migrate-image-studio",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS generated_images (
          id                     SERIAL PRIMARY KEY,
          user_id                TEXT NOT NULL,
          project_id             INTEGER,
          asset_id               INTEGER,
          prompt                 TEXT NOT NULL,
          revised_prompt         TEXT,
          style                  TEXT,
          quality                TEXT NOT NULL DEFAULT 'standard',
          aspect_ratio           TEXT NOT NULL DEFAULT '1:1',
          transparent_background BOOLEAN NOT NULL DEFAULT false,
          status                 TEXT NOT NULL DEFAULT 'pending',
          file_url               TEXT,
          storage_key            TEXT,
          safety_status          TEXT NOT NULL DEFAULT 'pending',
          credit_cost            INTEGER NOT NULL DEFAULT 3,
          error_message          TEXT,
          error_category         TEXT,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          deleted_at             TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_generated_images_user_id ON generated_images (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_generated_images_created_at ON generated_images (created_at DESC)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS idx_generated_images_status ON generated_images (status) WHERE deleted_at IS NULL`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-image-studio-v2 ───────────────────────────────────────────────
  {
    name: "migrate-image-studio-v2",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        ALTER TABLE generated_images
          ADD COLUMN IF NOT EXISTS negative_prompt TEXT,
          ADD COLUMN IF NOT EXISTS purpose         TEXT,
          ADD COLUMN IF NOT EXISTS provider_name   TEXT NOT NULL DEFAULT 'openai',
          ADD COLUMN IF NOT EXISTS model_name      TEXT,
          ADD COLUMN IF NOT EXISTS thumbnail_url   TEXT,
          ADD COLUMN IF NOT EXISTS asset_id        INTEGER
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-tier-rename ─────────────────────────────────────────────────
  // Collapse legacy paid tiers (pro, team) into the new top tier (wave) so
  // existing paying customers keep their highest benefits under the GPT-style
  // pricing model (free / core / wave). Idempotent.
  {
    name: "migrate-tier-rename",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        UPDATE user_subscriptions
          SET tier = 'wave', updated_at = now()
          WHERE tier IN ('pro', 'team')
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-knowledge-usage-events ──────────────────────────────────────
  {
    name: "migrate-knowledge-usage-events",
    async run(client) {
      await ensureKnowledgeUsageEventsSchema(client);
    },
  },

  // ── migrate-agent-task-heartbeat (Task #1182) ────────────────────────────
  {
    name: "migrate-agent-task-heartbeat",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS last_heartbeat_at TIMESTAMPTZ`,
      );
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS failure_reason TEXT`);
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS current_step INTEGER`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS agent_tasks_heartbeat_status_idx
         ON agent_tasks (status, last_heartbeat_at)
         WHERE status = 'building'`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-task-events-data (Preview Sync Pipeline) ─────────────────────
  {
    name: "migrate-task-events-data",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE task_events ADD COLUMN IF NOT EXISTS data JSONB`);
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-conversations (Ora Step 2: projects + conversations) ──────
  {
    name: "migrate-ora-conversations",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_projects (
          id          SERIAL PRIMARY KEY,
          user_id     TEXT NOT NULL,
          name        TEXT NOT NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_projects_user_id_idx ON ora_projects (user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_conversations (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          project_id      INTEGER,
          title           TEXT,
          messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at     TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_user_id_idx ON ora_conversations (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_project_id_idx ON ora_conversations (project_id)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-ora-assets (Task #1278) ─────────────────────────────────────────
  {
    name: "migrate-ora-assets",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_assets (
          id          SERIAL PRIMARY KEY,
          user_id     TEXT NOT NULL,
          kind        TEXT NOT NULL,
          file_name   TEXT NOT NULL,
          mime_type   TEXT NOT NULL,
          format      TEXT,
          prompt      TEXT,
          data        TEXT NOT NULL,
          size_bytes  INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at  TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_assets_user_id_idx ON ora_assets (user_id)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-ora-asset-storage (R2 offload, additive) ────────────────────────
  {
    name: "migrate-ora-asset-storage",
    async run(client) {
      await client.query("BEGIN");
      // Record the R2 object key when bytes are offloaded to object storage.
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS storage_key TEXT`);
      // `data` becomes nullable: offloaded rows store bytes in R2, not the DB.
      await client.query(`ALTER TABLE ora_assets ALTER COLUMN data DROP NOT NULL`);
      // Enforce the storage invariant: exactly one of `data` / `storage_key`.
      await client.query(`
        DO $$ BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint WHERE conname = 'ora_assets_storage_xor'
          ) THEN
            ALTER TABLE ora_assets
              ADD CONSTRAINT ora_assets_storage_xor
              CHECK ((data IS NOT NULL) <> (storage_key IS NOT NULL));
          END IF;
        END $$;
      `);
      await client.query("COMMIT");
    },
  },
  // ── migrate-drop-ora-daily-usage ─────────────────────────────────────────────
  // Ora usage metering moved from per-UTC-day caps (ora_daily_usage) to per-user
  // rolling windows (ora_usage_windows). Nothing reads the legacy table anymore;
  // drop it so the schema stays tidy. Idempotent via DROP TABLE IF EXISTS.
  {
    name: "migrate-drop-ora-daily-usage",
    async run(client) {
      await client.query(`DROP TABLE IF EXISTS ora_daily_usage`);
    },
  },

  // ── migrate-ora-memory-center (Phase 3B.1) ──────────────────────────────────
  {
    name: "migrate-ora-memory-center",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_profiles (
          id                 SERIAL PRIMARY KEY,
          user_id            TEXT NOT NULL UNIQUE,
          preferred_name     TEXT,
          occupation         TEXT,
          industry           TEXT,
          goals              TEXT,
          skill_level        TEXT,
          preferred_language TEXT,
          response_style     TEXT,
          avoid              TEXT,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS enabled BOOLEAN NOT NULL DEFAULT TRUE`,
      );
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS source_conversation_id INTEGER`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-knowledge-origin (Ora ↔ Builder isolation) ──────────────────────
  {
    name: "migrate-knowledge-origin",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS origin TEXT`);
      await client.query(`UPDATE knowledge_entries SET origin = 'builder' WHERE origin IS NULL`);
      await client.query("COMMIT");
    },
  },
  // ── migrate-recover-ora-memories (re-tag misfiled Ora saves) ────────────────
  // Recovers Ora memories that the buggy save paths POSTed to /api/knowledge
  // (origin="builder"). Genuine Builder user-scope data (brand profiles +
  // inferred style memories, both type="style_memory") is excluded. Idempotent:
  // recovered rows carry origin="ora" and no longer match. Must run AFTER the
  // knowledge-origin backfill above so origin is populated.
  {
    name: "migrate-recover-ora-memories",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `UPDATE knowledge_entries
            SET origin = 'ora'
          WHERE scope = 'user'
            AND origin = 'builder'
            AND type = 'note'
            AND type <> 'style_memory'
            AND project_id IS NULL`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-help-center (Task #1312) ────────────────────────────────────────
  {
    name: "migrate-help-center",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS help_articles (
          id serial PRIMARY KEY,
          slug text NOT NULL UNIQUE,
          category text NOT NULL DEFAULT 'getting-started',
          title text NOT NULL,
          body text NOT NULL,
          tags jsonb NOT NULL DEFAULT '[]'::jsonb,
          is_faq boolean NOT NULL DEFAULT false,
          sort_order integer NOT NULL DEFAULT 0,
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS help_articles_category_idx ON help_articles(category, sort_order)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS help_articles_is_faq_idx ON help_articles(is_faq)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS support_tickets (
          id serial PRIMARY KEY,
          user_id text NOT NULL,
          user_email text,
          plan text NOT NULL DEFAULT 'free',
          category text NOT NULL DEFAULT 'other',
          status text NOT NULL DEFAULT 'new',
          subject text NOT NULL,
          transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
          project_id integer,
          attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
          device_info jsonb,
          support_email_used text,
          email_status text NOT NULL DEFAULT 'skipped',
          created_at timestamptz NOT NULL DEFAULT now(),
          updated_at timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS support_tickets_user_id_idx ON support_tickets(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS support_tickets_status_idx ON support_tickets(status, created_at)`,
      );
      // Triage lifecycle moved to new/open/resolved; align the column default
      // for any table created under the old 'open' default.
      await client.query(`ALTER TABLE support_tickets ALTER COLUMN status SET DEFAULT 'new'`);
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS surface text NOT NULL DEFAULT 'normal'`,
      );
      await client.query(`UPDATE ora_conversations SET surface = 'normal' WHERE surface IS NULL`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_surface_idx ON ora_conversations(user_id, surface)`,
      );
      const { HELP_ARTICLE_SEED } = await import("@workspace/db");
      for (const a of HELP_ARTICLE_SEED) {
        await client.query(
          `INSERT INTO help_articles (slug, category, title, body, tags, is_faq, sort_order)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
           ON CONFLICT (slug) DO NOTHING`,
          [a.slug, a.category, a.title, a.body, JSON.stringify(a.tags), a.isFaq, a.sortOrder],
        );
      }
      await client.query("COMMIT");
    },
  },
  // ── migrate-ora-usage-windows (Ora per-user rolling-window quotas) ───────────
  {
    name: "migrate-ora-usage-windows",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_usage_windows (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          window_start  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          message_count INTEGER NOT NULL DEFAULT 0,
          image_count   INTEGER NOT NULL DEFAULT 0,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ora_usage_windows_user_uniq
           ON ora_usage_windows (user_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-memory-category (backfill typed Ora memory categories) ──────
  {
    name: "migrate-ora-memory-category",
    async run(client) {
      await client.query("BEGIN");
      // Coarse keyword heuristic mirroring lib/ora-memory-category.ts. Only
      // touches Ora user-scoped rows still at the legacy default, so it's safe
      // to re-run and never overrides a user's explicit re-categorization.
      await client.query(`
        UPDATE knowledge_entries
        SET category = CASE
          WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
            '(prefer|favorite|favourite|i like|i love|always use|never use|avoid|don''t|do not|tone|style|concise|verbose|formal|casual|dark mode|light mode|default to|colour|color|theme|font|format)'
            THEN 'preference'
          WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
            '(my name|name is|i am |i''m |i live|i work|based in|located in|email is|phone|birthday|i was born|pronoun|my job|my role|my title|my company|i have a|family|married|speak |native)'
            THEN 'personal'
          WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
            '(project|app called|building|website for|feature|deadline|tech stack|stack|database|deploy|client|customer|product|launch|repo|codebase|endpoint|integration)'
            THEN 'project'
          ELSE 'other'
        END
        WHERE origin = 'ora'
          AND scope = 'user'
          AND (category IS NULL OR category = 'note' OR category = 'other')
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax (isolated coding-agent foundation) ───────────────────────
  {
    name: "migrate-orax",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_repositories (
          id                SERIAL PRIMARY KEY,
          user_id           TEXT NOT NULL,
          provider          TEXT NOT NULL DEFAULT 'github',
          owner             TEXT NOT NULL,
          name              TEXT NOT NULL,
          repository_url    TEXT NOT NULL,
          default_branch    TEXT NOT NULL DEFAULT 'main',
          connection_status TEXT NOT NULL DEFAULT 'metadata_only',
          github_account_name TEXT,
          token_scopes      TEXT,
          encrypted_token   TEXT,
          connected_at      TIMESTAMPTZ,
          last_scan_at      TIMESTAMPTZ,
          scan_status       TEXT NOT NULL DEFAULT 'idle',
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at       TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repositories_user_id_idx ON orax_repositories(user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repositories_provider_idx
           ON orax_repositories(provider, owner, name)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_tasks (
          id                SERIAL PRIMARY KEY,
          user_id           TEXT NOT NULL,
          repository_id     INTEGER NOT NULL,
          kind              TEXT NOT NULL DEFAULT 'analyze',
          status            TEXT NOT NULL DEFAULT 'planned',
          title             TEXT NOT NULL,
          prompt            TEXT NOT NULL,
          plan              JSONB NOT NULL DEFAULT '{}'::jsonb,
          result            JSONB NOT NULL DEFAULT '{}'::jsonb,
          approval_required TEXT NOT NULL DEFAULT 'write_and_push',
          created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at      TIMESTAMPTZ,
          archived_at       TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_tasks_user_id_idx ON orax_tasks(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_tasks_repository_id_idx ON orax_tasks(repository_id)`,
      );
      await client.query(`CREATE INDEX IF NOT EXISTS orax_tasks_status_idx ON orax_tasks(status)`);
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_approvals (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          action        TEXT NOT NULL DEFAULT 'read_files',
          status        TEXT NOT NULL DEFAULT 'pending',
          request       JSONB NOT NULL DEFAULT '{}'::jsonb,
          result        JSONB NOT NULL DEFAULT '{}'::jsonb,
          risk_summary  TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at    TIMESTAMPTZ,
          completed_at  TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_user_id_idx
           ON orax_task_approvals(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_task_id_idx
           ON orax_task_approvals(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_status_idx
           ON orax_task_approvals(status)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_artifacts (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          approval_id   INTEGER,
          type          TEXT NOT NULL DEFAULT 'draft_patch',
          status        TEXT NOT NULL DEFAULT 'draft',
          title         TEXT NOT NULL,
          summary       TEXT,
          payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at   TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_user_id_idx
           ON orax_task_artifacts(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_task_id_idx
           ON orax_task_artifacts(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_status_idx
           ON orax_task_artifacts(status)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_repository_scans (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          repository_id   INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'completed',
          branch          TEXT NOT NULL,
          commit_sha      TEXT,
          file_count      INTEGER NOT NULL DEFAULT 0,
          directory_count INTEGER NOT NULL DEFAULT 0,
          total_bytes     INTEGER NOT NULL DEFAULT 0,
          summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
          error           TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at    TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repository_scans_user_id_idx
           ON orax_repository_scans(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repository_scans_repository_id_idx
           ON orax_repository_scans(repository_id, created_at)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-orax-github-readonly (repo scan upgrade) ──────────────────────
  {
    name: "migrate-orax-github-readonly",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS github_account_name TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS token_scopes TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS encrypted_token TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS connected_at TIMESTAMPTZ`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ`,
      );
      await client.query(
        `ALTER TABLE orax_repositories ADD COLUMN IF NOT EXISTS scan_status TEXT NOT NULL DEFAULT 'idle'`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_repository_scans (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          repository_id   INTEGER NOT NULL,
          status          TEXT NOT NULL DEFAULT 'completed',
          branch          TEXT NOT NULL,
          commit_sha      TEXT,
          file_count      INTEGER NOT NULL DEFAULT 0,
          directory_count INTEGER NOT NULL DEFAULT 0,
          total_bytes     INTEGER NOT NULL DEFAULT 0,
          summary         JSONB NOT NULL DEFAULT '{}'::jsonb,
          error           TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          completed_at    TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repository_scans_user_id_idx
           ON orax_repository_scans(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_repository_scans_repository_id_idx
           ON orax_repository_scans(repository_id, created_at)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-orax-approvals (approval-gated execution foundation) ──────────
  {
    name: "migrate-orax-approvals",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_approvals (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          action        TEXT NOT NULL DEFAULT 'read_files',
          status        TEXT NOT NULL DEFAULT 'pending',
          request       JSONB NOT NULL DEFAULT '{}'::jsonb,
          result        JSONB NOT NULL DEFAULT '{}'::jsonb,
          risk_summary  TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at    TIMESTAMPTZ,
          completed_at  TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_user_id_idx
           ON orax_task_approvals(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_task_id_idx
           ON orax_task_approvals(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_approvals_status_idx
           ON orax_task_approvals(status)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-orax-artifacts (draft patch previews) ─────────────────────────
  {
    name: "migrate-orax-artifacts",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_artifacts (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          approval_id   INTEGER,
          type          TEXT NOT NULL DEFAULT 'draft_patch',
          status        TEXT NOT NULL DEFAULT 'draft',
          title         TEXT NOT NULL,
          summary       TEXT,
          payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at   TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_user_id_idx
           ON orax_task_artifacts(user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_task_id_idx
           ON orax_task_artifacts(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_artifacts_status_idx
           ON orax_task_artifacts(status)`,
      );
      await client.query("COMMIT");
    },
  },
  // ── migrate-ora-project-memory (persistent Ora project memory) ─────────────
  {
    name: "migrate-ora-project-memory",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS ora_project_id integer`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS knowledge_entries_ora_project_id_idx ON knowledge_entries(ora_project_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-messages (task conversation threads) ─────────────────────
  {
    name: "migrate-orax-messages",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_task_messages (
          id            SERIAL PRIMARY KEY,
          user_id       TEXT NOT NULL,
          repository_id INTEGER NOT NULL,
          task_id       INTEGER NOT NULL,
          role          TEXT NOT NULL DEFAULT 'user',
          content       TEXT NOT NULL,
          metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
          artifact_id   INTEGER,
          approval_id   INTEGER,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          archived_at   TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_messages_user_task_idx
           ON orax_task_messages(user_id, task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_messages_task_id_idx
           ON orax_task_messages(task_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_messages_artifact_id_idx
           ON orax_task_messages(artifact_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_task_messages_approval_id_idx
           ON orax_task_messages(approval_id)`,
      );
      await client.query("COMMIT");
    },
  },
  {
    name: "migrate-ora-memory-supersede",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE knowledge_entries ADD COLUMN IF NOT EXISTS superseded_by INTEGER`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-conversation-summary ────────────────────────────────────────
  {
    name: "migrate-ora-conversation-summary",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS summary text`);
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS summary_msg_count integer NOT NULL DEFAULT 0`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS summary_updated_at timestamptz`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-spend-ledger ─────────────────────────────────────────────────
  {
    name: "migrate-ora-spend-ledger",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_spend_ledger (
          id          SERIAL PRIMARY KEY,
          date_key    DATE NOT NULL,
          ledger_key  TEXT NOT NULL,
          units       INTEGER NOT NULL DEFAULT 0,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ora_spend_ledger_date_key_unique
          ON ora_spend_ledger (date_key, ledger_key)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_spend_ledger_date_idx
          ON ora_spend_ledger (date_key)
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-realtime-usage ───────────────────────────────────────────────
  {
    name: "migrate-ora-realtime-usage",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_realtime_usage_windows (
          id           serial PRIMARY KEY,
          usage_key    text NOT NULL,
          window_start timestamptz NOT NULL DEFAULT now(),
          used_seconds integer NOT NULL DEFAULT 0,
          created_at   timestamptz NOT NULL DEFAULT now(),
          updated_at   timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ora_realtime_usage_windows_key_uniq ON ora_realtime_usage_windows(usage_key)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_realtime_sessions (
          id                   text PRIMARY KEY,
          usage_key            text NOT NULL,
          tier                 text NOT NULL,
          max_duration_seconds integer NOT NULL,
          started_at           timestamptz NOT NULL DEFAULT now(),
          last_heartbeat_at    timestamptz NOT NULL DEFAULT now(),
          charged_seconds      integer NOT NULL DEFAULT 0,
          status               text NOT NULL DEFAULT 'active',
          created_at           timestamptz NOT NULL DEFAULT now(),
          updated_at           timestamptz NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_realtime_sessions_key_status_idx ON ora_realtime_sessions(usage_key, status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_realtime_sessions_status_heartbeat_idx ON ora_realtime_sessions(status, last_heartbeat_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-file-contexts ───────────────────────────────────────────────
  {
    name: "migrate-ora-file-contexts",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_file_contexts (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          file_ref        TEXT NOT NULL,
          session_id      TEXT NOT NULL,
          asset_id        INTEGER,
          filename        TEXT NOT NULL,
          mime_type       TEXT NOT NULL,
          file_type       TEXT NOT NULL,
          extracted_text  TEXT NOT NULL DEFAULT '',
          char_count      INTEGER NOT NULL DEFAULT 0,
          dataset_summary JSONB,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          deleted_at      TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ora_file_contexts_user_ref_unique ON ora_file_contexts (user_id, file_ref)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_file_contexts_user_id_idx ON ora_file_contexts (user_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-desktop (Phase 2B base tables: hosts, threads, etc.) ────────
  // Must run BEFORE desktop-actions/command-approvals/projects, which reference
  // these tables (e.g. migrate-orax-projects ALTERs orax_threads). Mirrors
  // scripts/src/migrate-orax-desktop.ts. Every statement is IF NOT EXISTS, so
  // this is a no-op on DBs already provisioned by the standalone script.
  {
    name: "migrate-orax-desktop",
    async run(client) {
      await client.query("BEGIN");

      // orax_hosts
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_hosts (
          id              TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id         TEXT NOT NULL,
          device_name     TEXT NOT NULL,
          platform        TEXT NOT NULL DEFAULT 'windows',
          os_version      TEXT,
          app_version     TEXT NOT NULL DEFAULT '0.0.0',
          install_id      TEXT NOT NULL,
          public_key      TEXT NOT NULL DEFAULT '',
          status          TEXT NOT NULL DEFAULT 'offline',
          last_seen_at    TIMESTAMPTZ,
          paired_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          revoked_at      TIMESTAMPTZ,
          capabilities    JSONB NOT NULL DEFAULT '{}',
          permission_mode TEXT NOT NULL DEFAULT 'ask_risky',
          trusted_project_ids JSONB NOT NULL DEFAULT '[]',
          metadata        JSONB NOT NULL DEFAULT '{}',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS orax_hosts_install_id_uidx ON orax_hosts (install_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_hosts_user_id_idx ON orax_hosts (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_hosts_status_idx ON orax_hosts (user_id, status)`,
      );

      // orax_pairing_codes
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_pairing_codes (
          id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          host_id     TEXT NOT NULL REFERENCES orax_hosts(id),
          user_id     TEXT NOT NULL,
          code        TEXT NOT NULL,
          qr_payload  TEXT NOT NULL,
          expires_at  TIMESTAMPTZ NOT NULL,
          redeemed_at TIMESTAMPTZ,
          redeemed_by TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS orax_pairing_codes_code_uidx ON orax_pairing_codes (code)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pairing_codes_host_id_idx ON orax_pairing_codes (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pairing_codes_user_id_idx ON orax_pairing_codes (user_id)`,
      );

      // orax_paired_devices
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_paired_devices (
          id               TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          host_id          TEXT NOT NULL REFERENCES orax_hosts(id),
          user_id          TEXT NOT NULL,
          mobile_device_id TEXT NOT NULL,
          display_name     TEXT,
          platform         TEXT,
          paired_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at     TIMESTAMPTZ,
          revoked_at       TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS orax_paired_devices_host_mobile_uidx ON orax_paired_devices (host_id, mobile_device_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_paired_devices_user_id_idx ON orax_paired_devices (user_id)`,
      );

      // orax_projects (host-local folder concept; renamed to
      // orax_desktop_local_folders by migrate-orax-projects on the next step)
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_projects (
          id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          host_id                  TEXT NOT NULL REFERENCES orax_hosts(id),
          user_id                  TEXT NOT NULL,
          local_path               TEXT NOT NULL,
          display_name             TEXT NOT NULL,
          git_remote_url           TEXT,
          current_branch           TEXT,
          last_opened_at           TIMESTAMPTZ,
          permission_mode_override TEXT,
          setup_scripts            JSONB,
          status                   TEXT NOT NULL DEFAULT 'active',
          created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // These indexes target the OLD host-local orax_projects schema (host_id
      // only exists there). On DBs where the cloud orax_projects already exists
      // (e.g. provisioned via drizzle push), host_id is absent, so guard on the
      // local_path column to avoid a failing CREATE INDEX that would roll back
      // this entire step on every boot.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'orax_projects'
              AND column_name = 'local_path'
          ) THEN
            CREATE INDEX IF NOT EXISTS orax_projects_host_id_idx ON orax_projects (host_id);
            CREATE INDEX IF NOT EXISTS orax_projects_user_id_idx ON orax_projects (user_id);
          END IF;
        END $$
      `);

      // orax_threads
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_threads (
          id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id    TEXT NOT NULL,
          host_id    TEXT,
          project_id TEXT REFERENCES orax_projects(id),
          title      TEXT,
          status     TEXT NOT NULL DEFAULT 'idle',
          last_event JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_threads_user_id_idx ON orax_threads (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_threads_host_id_idx ON orax_threads (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_threads_project_id_idx ON orax_threads (project_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_threads_status_idx ON orax_threads (user_id, status)`,
      );

      // orax_thread_messages
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_thread_messages (
          id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          thread_id  TEXT NOT NULL REFERENCES orax_threads(id),
          role       TEXT NOT NULL,
          content    TEXT NOT NULL,
          event_type TEXT,
          payload    JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_thread_messages_thread_id_idx ON orax_thread_messages (thread_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_thread_messages_created_at_idx ON orax_thread_messages (thread_id, created_at)`,
      );

      // orax_pending_approvals
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_pending_approvals (
          id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          thread_id   TEXT NOT NULL REFERENCES orax_threads(id),
          host_id     TEXT NOT NULL,
          description TEXT NOT NULL,
          command     TEXT,
          file_path   TEXT,
          diff        TEXT,
          status      TEXT NOT NULL DEFAULT 'pending',
          resolved_at TIMESTAMPTZ,
          resolved_by TEXT,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pending_approvals_thread_id_idx ON orax_pending_approvals (thread_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pending_approvals_host_id_idx ON orax_pending_approvals (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_pending_approvals_status_idx ON orax_pending_approvals (host_id, status)`,
      );

      // orax_usage_events
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_usage_events (
          id            TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id       TEXT NOT NULL,
          host_id       TEXT NOT NULL REFERENCES orax_hosts(id),
          project_id    TEXT REFERENCES orax_projects(id),
          thread_id     TEXT REFERENCES orax_threads(id),
          action_type   TEXT NOT NULL,
          model_used    TEXT,
          input_tokens  INTEGER,
          output_tokens INTEGER,
          compute_ms    INTEGER,
          status        TEXT NOT NULL DEFAULT 'success',
          metadata      JSONB NOT NULL DEFAULT '{}',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_usage_events_user_id_idx ON orax_usage_events (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_usage_events_host_id_idx ON orax_usage_events (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_usage_events_thread_id_idx ON orax_usage_events (thread_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_usage_events_created_at_idx ON orax_usage_events (user_id, created_at)`,
      );

      // orax_audit_log (denormalized, no FK so it survives host/thread deletion)
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_audit_log (
          id         TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id    TEXT NOT NULL,
          host_id    TEXT NOT NULL,
          project_id TEXT,
          thread_id  TEXT,
          action     TEXT NOT NULL,
          command    TEXT,
          file_path  TEXT,
          outcome    TEXT NOT NULL,
          error_msg  TEXT,
          metadata   JSONB NOT NULL DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_audit_log_user_id_idx ON orax_audit_log (user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_audit_log_host_id_idx ON orax_audit_log (host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_audit_log_thread_id_idx ON orax_audit_log (thread_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_audit_log_created_at_idx ON orax_audit_log (user_id, created_at)`,
      );

      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-desktop-actions (Phase 2E relay action table) ───────────────
  {
    name: "migrate-orax-desktop-actions",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_desktop_actions (
          id              TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id         TEXT NOT NULL,
          host_id         TEXT NOT NULL,
          thread_id       TEXT,
          type            TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'queued',
          payload         JSONB NOT NULL DEFAULT '{}',
          result          JSONB,
          idempotency_key TEXT NOT NULL UNIQUE,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at      TIMESTAMPTZ,
          completed_at    TIMESTAMPTZ
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_desktop_actions_user_id_idx
           ON orax_desktop_actions(user_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_desktop_actions_host_id_idx
           ON orax_desktop_actions(host_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_desktop_actions_status_idx
           ON orax_desktop_actions(host_id, status)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS orax_desktop_actions_thread_id_idx
           ON orax_desktop_actions(thread_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-command-approvals ──────────────────────────────────────────
  {
    name: "migrate-orax-command-approvals",
    async run(client) {
      await client.query("BEGIN");
      // Check table existence before altering (table may not exist in some envs)
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT 1 AS exists FROM information_schema.tables
         WHERE table_name = 'orax_pending_approvals'`,
      );
      if (rows.length > 0) {
        // thread_id was NOT NULL in original CREATE TABLE; make nullable for Phase 2F
        await client.query(
          `ALTER TABLE orax_pending_approvals ALTER COLUMN thread_id DROP NOT NULL`,
        );
        // Phase 2F columns
        await client.query(
          `ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS user_id text`,
        );
        await client.query(`ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS cwd text`);
        await client.query(
          `ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS reason text`,
        );
        await client.query(
          `ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS risk_level text NOT NULL DEFAULT 'low'`,
        );
        await client.query(
          `ALTER TABLE orax_pending_approvals ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`,
        );
        await client.query(
          `CREATE INDEX IF NOT EXISTS orax_pending_approvals_user_id_idx
             ON orax_pending_approvals(user_id)`,
        );
      }
      await client.query("COMMIT");
    },
  },

  // ── migrate-orax-projects (Phase 2G: cloud workspace tables) ────────────────
  {
    name: "migrate-orax-projects",
    async run(client) {
      await client.query("BEGIN");

      // Rename old orax_projects (host-local folder concept) to orax_desktop_local_folders
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'orax_projects'
          ) AND EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public' AND table_name = 'orax_projects'
              AND column_name = 'local_path'
          ) AND NOT EXISTS (
            SELECT 1 FROM information_schema.tables
            WHERE table_schema = 'public' AND table_name = 'orax_desktop_local_folders'
          ) THEN
            ALTER TABLE orax_projects RENAME TO orax_desktop_local_folders;
          END IF;
        END $$
      `);

      // Ensure orax_desktop_local_folders exists
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_desktop_local_folders (
          id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
          host_id                  TEXT NOT NULL,
          user_id                  TEXT NOT NULL,
          local_path               TEXT NOT NULL,
          display_name             TEXT NOT NULL,
          git_remote_url           TEXT,
          current_branch           TEXT,
          last_opened_at           TIMESTAMPTZ,
          permission_mode_override TEXT,
          setup_scripts            JSONB,
          status                   TEXT NOT NULL DEFAULT 'active',
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_local_folders_host_id_idx
          ON orax_desktop_local_folders(host_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_local_folders_user_id_idx
          ON orax_desktop_local_folders(user_id)
      `);

      // New cloud workspace: orax_projects
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_projects (
          id                          TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id                     TEXT NOT NULL,
          name                        TEXT NOT NULL,
          description                 TEXT,
          icon                        TEXT,
          color                       TEXT,
          status                      TEXT NOT NULL DEFAULT 'active',
          default_execution_source_id TEXT,
          memory                      JSONB NOT NULL DEFAULT '{}',
          settings                    JSONB NOT NULL DEFAULT '{}',
          created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_projects_user_id_idx ON orax_projects(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_projects_status_idx ON orax_projects(user_id, status)
      `);

      // Execution sources table
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_project_sources (
          id           TEXT PRIMARY KEY DEFAULT gen_random_uuid(),
          project_id   TEXT NOT NULL,
          user_id      TEXT NOT NULL,
          host_id      TEXT,
          type         TEXT NOT NULL DEFAULT 'local_folder',
          display_name TEXT NOT NULL,
          local_path   TEXT,
          repo_url     TEXT,
          branch       TEXT,
          worktree_path TEXT,
          status       TEXT NOT NULL DEFAULT 'active',
          metadata     JSONB NOT NULL DEFAULT '{}',
          last_seen_at TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_project_sources_project_id_idx
          ON orax_project_sources(project_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_project_sources_user_id_idx
          ON orax_project_sources(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_project_sources_host_id_idx
          ON orax_project_sources(host_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_project_sources_status_idx
          ON orax_project_sources(project_id, status)
      `);

      // Add Phase 2G columns to existing tables
      await client.query(
        `ALTER TABLE orax_threads ADD COLUMN IF NOT EXISTS execution_source_id TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_threads ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'chat_only'`,
      );
      await client.query(
        `ALTER TABLE orax_audit_log ADD COLUMN IF NOT EXISTS execution_source_id TEXT`,
      );
      await client.query(
        `ALTER TABLE orax_usage_events ADD COLUMN IF NOT EXISTS execution_source_id TEXT`,
      );

      await client.query("COMMIT");
    },
  },
  // ── migrate-orax-desktop-auth (browser-approved desktop sign-in) ──────────
  {
    name: "migrate-orax-desktop-auth",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_desktop_auth_challenges (
          id                       TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id                  TEXT,
          status                   TEXT NOT NULL DEFAULT 'pending',
          user_code                TEXT NOT NULL,
          poll_token_hash          TEXT NOT NULL,
          session_id               TEXT,
          session_token_ciphertext TEXT,
          install_id               TEXT,
          device_name              TEXT,
          platform                 TEXT,
          app_version              TEXT,
          expires_at               TIMESTAMPTZ NOT NULL,
          approved_at              TIMESTAMPTZ,
          redeemed_at              TIMESTAMPTZ,
          denied_at                TIMESTAMPTZ,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS orax_desktop_auth_challenges_user_code_uidx
          ON orax_desktop_auth_challenges(user_code)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_user_id_idx
          ON orax_desktop_auth_challenges(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_status_idx
          ON orax_desktop_auth_challenges(status)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_auth_challenges_expires_at_idx
          ON orax_desktop_auth_challenges(expires_at)
      `);

      await client.query(`
        CREATE TABLE IF NOT EXISTS orax_desktop_sessions (
          id           TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
          user_id      TEXT NOT NULL,
          token_hash   TEXT NOT NULL UNIQUE,
          challenge_id TEXT,
          install_id   TEXT,
          device_name  TEXT,
          platform     TEXT,
          app_version  TEXT,
          metadata     JSONB NOT NULL DEFAULT '{}',
          expires_at   TIMESTAMPTZ NOT NULL,
          last_used_at TIMESTAMPTZ,
          revoked_at   TIMESTAMPTZ,
          created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_sessions_user_id_idx
          ON orax_desktop_sessions(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_sessions_token_hash_idx
          ON orax_desktop_sessions(token_hash)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS orax_desktop_sessions_expires_at_idx
          ON orax_desktop_sessions(expires_at)
      `);
      await client.query("COMMIT");
    },
  },
  {
    name: "ora-history-v2",
    run: async (client) => {
      await client.query("BEGIN");

      // Pinned conversations
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS pinned_at TIMESTAMPTZ`,
      );

      // Title source: 'client' (first-msg truncation) | 'ai' (smart title) | 'user' (renamed)
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS title_source TEXT NOT NULL DEFAULT 'client'`,
      );

      // History metadata badges — stored columns for fast list queries (no jsonb scan on every list)
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_has_images BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_has_generated_files BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_has_sources BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_has_voice BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query(
        `ALTER TABLE ora_conversations ADD COLUMN IF NOT EXISTS meta_last_activity_type TEXT`,
      );

      // Partial index to speed up pinned-first sorting
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_pinned_idx ON ora_conversations(user_id, pinned_at) WHERE pinned_at IS NOT NULL`,
      );

      // Full-text search index on title for fast ?q= queries
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_conversations_title_gin_idx ON ora_conversations USING gin(to_tsvector('english', coalesce(title,'')))`,
      );

      // Per-user Ora settings (last-active conversation ID, etc.)
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_user_settings (
          user_id    TEXT PRIMARY KEY,
          settings   JSONB NOT NULL DEFAULT '{}',
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-asset-versions (file revision lineage, Ora Phase 2) ────────
  {
    name: "migrate-ora-asset-versions",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS root_asset_id INTEGER`);
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS parent_asset_id INTEGER`);
      await client.query(
        `ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS version_number INTEGER NOT NULL DEFAULT 1`,
      );
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS source_file_ref TEXT`);
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS edit_summary TEXT`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_assets_root_asset_id_idx ON ora_assets(root_asset_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-project-spaces (Ora Phase 6: project-scoped assets/uploads) ─
  // Null ora_project_id = the user's default "Personal" space (standalone).
  // No FK by design, matching ora_conversations.project_id.
  {
    name: "migrate-ora-project-spaces",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE ora_assets ADD COLUMN IF NOT EXISTS ora_project_id INTEGER`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_assets_user_project_idx ON ora_assets(user_id, ora_project_id)`,
      );
      await client.query(
        `ALTER TABLE ora_file_contexts ADD COLUMN IF NOT EXISTS ora_project_id INTEGER`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS ora_file_contexts_user_project_idx ON ora_file_contexts(user_id, ora_project_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-brand-kits ───────────────────────────────────────────────────────
  // Mirrors scripts/src/migrate-brand-kits.ts. Keep both in sync on schema change.
  {
    name: "migrate-brand-kits",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS brand_kits (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          ora_project_id  INTEGER,
          logo_asset_id   INTEGER,
          primary_color   TEXT,
          secondary_color TEXT,
          accent_color    TEXT,
          heading_font    TEXT,
          body_font       TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Self-healing: if brand_kits_user_personal_idx exists but lacks the correct
      // partial WHERE clause (ora_project_id IS NULL), drop it so the CREATE below
      // can replace it with the right unique partial index.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE tablename  = 'brand_kits'
              AND indexname  = 'brand_kits_user_personal_idx'
              AND indexdef   NOT ILIKE '%where%ora_project_id is null%'
          ) THEN
            DROP INDEX IF EXISTS brand_kits_user_personal_idx;
          END IF;
        END
        $$
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS brand_kits_user_personal_idx
          ON brand_kits(user_id)
          WHERE ora_project_id IS NULL
      `);
      // Self-healing: if brand_kits_user_project_idx exists but lacks the correct
      // partial WHERE clause (ora_project_id IS NOT NULL), drop it so the CREATE
      // below can replace it with the right unique partial index.
      await client.query(`
        DO $$
        BEGIN
          IF EXISTS (
            SELECT 1 FROM pg_indexes
            WHERE tablename  = 'brand_kits'
              AND indexname  = 'brand_kits_user_project_idx'
              AND indexdef   NOT ILIKE '%where%ora_project_id is not null%'
          ) THEN
            DROP INDEX IF EXISTS brand_kits_user_project_idx;
          END IF;
        END
        $$
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS brand_kits_user_project_idx
          ON brand_kits(user_id, ora_project_id)
          WHERE ora_project_id IS NOT NULL
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS brand_kits_user_id_idx
          ON brand_kits(user_id)
      `);
      // DROP TRIGGER takes a table lock until this transaction commits. Remove
      // drifted legacy definitions before repair updates can invoke them.
      await client.query(`
        DROP TRIGGER IF EXISTS ora_asset_reference_guard_ora_file_contexts
          ON ora_file_contexts;
        DROP TRIGGER IF EXISTS ora_asset_reference_guard_brand_kits
          ON brand_kits
      `);
      await client.query(`
        CREATE OR REPLACE FUNCTION require_live_owned_ora_asset_reference()
        RETURNS TRIGGER AS $$
        DECLARE
          row_json JSONB;
          candidate_ora_asset_id INTEGER;
        BEGIN
          row_json := to_jsonb(NEW);
          IF TG_NARGS > 1
             AND NULLIF(row_json ->> TG_ARGV[1], '') IS NOT NULL THEN
            RETURN NEW;
          END IF;
          candidate_ora_asset_id := NULLIF(row_json ->> TG_ARGV[0], '')::integer;
          IF candidate_ora_asset_id IS NULL THEN
            RETURN NEW;
          END IF;
          PERFORM 1
            FROM public.ora_assets ora
           WHERE ora.id = candidate_ora_asset_id
             AND ora.user_id = row_json ->> 'user_id'
             AND ora.deleted_at IS NULL
           FOR SHARE;
          IF NOT FOUND THEN
            RAISE EXCEPTION 'ora_asset_reference_unavailable' USING ERRCODE = '55000';
          END IF;
          RETURN NEW;
        END;
        $$ LANGUAGE plpgsql SECURITY INVOKER
           SET search_path = pg_catalog, public
      `);
      const repairedOraAssetReferences = await client.query<{
        file_contexts_repaired: string;
        brand_kits_repaired: string;
      }>(`
        WITH repaired_file_contexts AS (
          UPDATE public.ora_file_contexts context_row
             SET asset_id = NULL
           WHERE context_row.asset_id IS NOT NULL
             AND context_row.deleted_at IS NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM public.ora_assets ora
                WHERE ora.id = context_row.asset_id
                  AND ora.user_id = context_row.user_id
                  AND ora.deleted_at IS NULL
             )
          RETURNING 1
        ), repaired_brand_kits AS (
          UPDATE public.brand_kits kit
             SET logo_asset_id = NULL,
                 updated_at = NOW()
           WHERE kit.logo_asset_id IS NOT NULL
             AND NOT EXISTS (
               SELECT 1
                 FROM public.ora_assets ora
                WHERE ora.id = kit.logo_asset_id
                  AND ora.user_id = kit.user_id
                  AND ora.deleted_at IS NULL
             )
          RETURNING 1
        )
        SELECT (SELECT COUNT(*)::text FROM repaired_file_contexts) AS file_contexts_repaired,
               (SELECT COUNT(*)::text FROM repaired_brand_kits) AS brand_kits_repaired
      `);
      logger.info(
        {
          fileContextsRepaired: Number(
            repairedOraAssetReferences.rows[0]?.file_contexts_repaired ?? 0,
          ),
          brandKitsRepaired: Number(repairedOraAssetReferences.rows[0]?.brand_kits_repaired ?? 0),
        },
        "startup-migrations: stale Ora asset references reconciled",
      );
      await client.query(`
        CREATE TRIGGER ora_asset_reference_guard_ora_file_contexts
          BEFORE INSERT OR UPDATE OF user_id, asset_id, deleted_at
          ON ora_file_contexts
          FOR EACH ROW EXECUTE FUNCTION require_live_owned_ora_asset_reference('asset_id', 'deleted_at')
      `);
      await client.query(`
        CREATE TRIGGER ora_asset_reference_guard_brand_kits
          BEFORE INSERT OR UPDATE OF user_id, logo_asset_id
          ON brand_kits
          FOR EACH ROW EXECUTE FUNCTION require_live_owned_ora_asset_reference('logo_asset_id')
      `);
      const oraAssetReferenceGuards = await client.query<{ guard_ready: boolean }>(`
        SELECT (
          to_regprocedure('public.require_live_owned_ora_asset_reference()') IS NOT NULL
          AND (SELECT COUNT(*) = 2
                 AND bool_and(NOT trigger_row.tgisinternal)
                 AND bool_and(trigger_row.tgenabled = ANY(ARRAY['O', 'A']::"char"[]))
                  AND bool_and(trigger_row.tgtype = 23)
                  AND bool_and(trigger_row.tgqual IS NULL)
                  AND bool_and(trigger_row.tgnargs = expected.argument_count)
                  AND bool_and(
                    encode(trigger_row.tgargs, 'escape') = expected.argument_bytes
                  )
                  AND bool_and(
                    trigger_row.tgfoid =
                     to_regprocedure('public.require_live_owned_ora_asset_reference()')
                 )
                 AND bool_and(
                   (SELECT string_agg(attribute.attname, ', ' ORDER BY trigger_column.ordinality)
                      FROM unnest(trigger_row.tgattr::smallint[]) WITH ORDINALITY
                           AS trigger_column(attnum, ordinality)
                      JOIN pg_catalog.pg_attribute attribute
                        ON attribute.attrelid=relation.oid
                       AND attribute.attnum=trigger_column.attnum) = expected.column_list
                 )
                 FROM (VALUES
                  ('ora_file_contexts', 'ora_asset_reference_guard_ora_file_contexts', 'user_id, asset_id, deleted_at', 2, 'asset_id\\000deleted_at\\000'),
                  ('brand_kits', 'ora_asset_reference_guard_brand_kits', 'user_id, logo_asset_id', 1, 'logo_asset_id\\000')
                ) AS expected(table_name, trigger_name, column_list, argument_count, argument_bytes)
                 JOIN pg_catalog.pg_class relation ON relation.relname=expected.table_name
                JOIN pg_catalog.pg_namespace namespace ON namespace.oid=relation.relnamespace
                JOIN pg_catalog.pg_trigger trigger_row ON trigger_row.tgrelid=relation.oid
               WHERE namespace.nspname='public'
                 AND trigger_row.tgname=expected.trigger_name)
          AND (SELECT NOT procedure_row.prosecdef
                 FROM pg_catalog.pg_proc procedure_row
                WHERE procedure_row.oid=
                  to_regprocedure('public.require_live_owned_ora_asset_reference()'))
          AND regexp_replace(
                lower(pg_get_functiondef(
                  to_regprocedure('public.require_live_owned_ora_asset_reference()')
                )), '[[:space:]]+', ' ', 'g'
              ) LIKE '%from public.ora_assets ora%ora.user_id = row_json ->> ''user_id''%ora.deleted_at is null%for share%'
          AND regexp_replace(
                lower(pg_get_functiondef(
                  to_regprocedure('public.require_live_owned_ora_asset_reference()')
                )), '[[:space:]]+', ' ', 'g'
              ) LIKE '%candidate_ora_asset_id := nullif(row_json ->> tg_argv[0],%'
          AND regexp_replace(
                lower(pg_get_functiondef(
                  to_regprocedure('public.require_live_owned_ora_asset_reference()')
                )), '[[:space:]]+', ' ', 'g'
              ) LIKE '%ora.id = candidate_ora_asset_id%'
          AND regexp_replace(
                lower(pg_get_functiondef(
                  to_regprocedure('public.require_live_owned_ora_asset_reference()')
                )), '[[:space:]]+', ' ', 'g'
              ) LIKE '%ora_asset_reference_unavailable%errcode = ''55000''%'
          AND EXISTS (
            SELECT 1
              FROM unnest(COALESCE(
                (SELECT proconfig FROM pg_catalog.pg_proc
                  WHERE oid=to_regprocedure('public.require_live_owned_ora_asset_reference()')),
                ARRAY[]::text[]
              )) setting
              WHERE regexp_replace(lower(setting), '[[:space:]]+', '', 'g') =
                    'search_path=pg_catalog,public'
           )
          AND NOT EXISTS (
            SELECT 1
              FROM public.ora_file_contexts context_row
              LEFT JOIN public.ora_assets ora
                ON ora.id = context_row.asset_id
               AND ora.user_id = context_row.user_id
               AND ora.deleted_at IS NULL
             WHERE context_row.asset_id IS NOT NULL
               AND context_row.deleted_at IS NULL
               AND ora.id IS NULL
          )
          AND NOT EXISTS (
            SELECT 1
              FROM public.brand_kits kit
              LEFT JOIN public.ora_assets ora
                ON ora.id = kit.logo_asset_id
               AND ora.user_id = kit.user_id
               AND ora.deleted_at IS NULL
             WHERE kit.logo_asset_id IS NOT NULL
               AND ora.id IS NULL
          )
        ) AS guard_ready
      `);
      if (oraAssetReferenceGuards.rows[0]?.guard_ready !== true) {
        throw new Error("ora_asset_reference_guards_missing");
      }
      await client.query("COMMIT");
    },
  },

  // ── migrate-ora-github ───────────────────────────────────────────────────────
  // Mirrors scripts/src/migrate-ora-github.ts. Keep both in sync on schema change.
  // Read-only GitHub repo analysis: encrypted OAuth token + selected-repo sessions.
  {
    name: "migrate-ora-github",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_github_connections (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          encrypted_token TEXT NOT NULL,
          github_login    TEXT NOT NULL,
          scopes          TEXT NOT NULL DEFAULT '',
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS ora_github_connections_user_uidx
          ON ora_github_connections(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_github_connections_user_id_idx
          ON ora_github_connections(user_id)
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS ora_repo_sessions (
          id              SERIAL PRIMARY KEY,
          user_id         TEXT NOT NULL,
          conversation_id TEXT,
          owner           TEXT NOT NULL,
          repo            TEXT NOT NULL,
          ref             TEXT NOT NULL DEFAULT '',
          default_branch  TEXT NOT NULL DEFAULT 'main',
          status          TEXT NOT NULL DEFAULT 'active',
          file_count      INTEGER,
          total_bytes     INTEGER,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_used_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await client.query(`ALTER TABLE ora_repo_sessions ADD COLUMN IF NOT EXISTS branch_sha TEXT`);
      await client.query(`ALTER TABLE ora_repo_sessions ADD COLUMN IF NOT EXISTS tree_sha TEXT`);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_repo_sessions_user_id_idx
          ON ora_repo_sessions(user_id)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_repo_sessions_user_status_idx
          ON ora_repo_sessions(user_id, status)
      `);
      await client.query(`
        CREATE INDEX IF NOT EXISTS ora_repo_sessions_conversation_idx
          ON ora_repo_sessions(conversation_id)
      `);
      await client.query("COMMIT");
    },
  },

  // ── migrate-agent-task-completion-kind (Builder Wave 7B) ─────────────────
  {
    name: "migrate-agent-task-completion-kind",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS completion_kind TEXT`);
      await client.query("COMMIT");
    },
  },
  {
    name: "migrate-builder-task-deep-reasoning",
    async run(client) {
      await client.query("BEGIN");
      await client.query(
        `ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS deep_reasoning BOOLEAN NOT NULL DEFAULT FALSE`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-nabuflow-billing (Task #1516) ─────────────────────────────────
  // NabuFlow Builder billing core: plan subscriptions, spend-cap settings,
  // per-cycle buckets/counters, and the per-build usage ledger. Fully separate
  // from Ora's user_subscriptions — nothing here touches Ora plan state.
  {
    name: "migrate-nabuflow-billing",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_subscriptions (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          plan_id TEXT NOT NULL,
          stripe_customer_id TEXT,
          stripe_subscription_id TEXT,
          stripe_item_id TEXT,
          status TEXT NOT NULL DEFAULT 'incomplete',
          cancel_at_period_end BOOLEAN NOT NULL DEFAULT FALSE,
          current_cycle_start TIMESTAMPTZ,
          current_cycle_end TIMESTAMPTZ,
          rollover_credits INTEGER NOT NULL DEFAULT 0,
          default_payment_method_id TEXT,
          card_brand TEXT,
          card_last4 TEXT,
          card_exp_month INTEGER,
          card_exp_year INTEGER,
          dunning_status TEXT NOT NULL DEFAULT 'none',
          dunning_started_at TIMESTAMPTZ,
          dunning_grace_until TIMESTAMPTZ,
          dunning_paused_at TIMESTAMPTZ,
          dunning_attempt_count INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_subscriptions_stripe_sub_idx
           ON nabuflow_subscriptions (stripe_subscription_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_subscriptions_stripe_customer_idx
           ON nabuflow_subscriptions (stripe_customer_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_billing_settings (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL UNIQUE,
          spend_cap_usd_cents INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_billing_cycles (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          plan_id TEXT NOT NULL,
          cycle_start TIMESTAMPTZ NOT NULL,
          cycle_end TIMESTAMPTZ NOT NULL,
          included_credits INTEGER NOT NULL DEFAULT 0,
          rollover_credits INTEGER NOT NULL DEFAULT 0,
          used_included_credits INTEGER NOT NULL DEFAULT 0,
          overage_credits INTEGER NOT NULL DEFAULT 0,
          overage_usd_cents INTEGER NOT NULL DEFAULT 0,
          pro_builds_used INTEGER NOT NULL DEFAULT 0,
          deep_builds_used INTEGER NOT NULL DEFAULT 0,
          bucket_notify_level INTEGER NOT NULL DEFAULT 0,
          cap_notify_level INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT nabuflow_cycles_user_cycle_unique UNIQUE (user_id, cycle_start)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_cycles_user_idx
           ON nabuflow_billing_cycles (user_id, cycle_start)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_usage_events (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          cycle_id INTEGER NOT NULL,
          cycle_start TIMESTAMPTZ NOT NULL,
          project_id INTEGER,
          task_id INTEGER,
          source TEXT NOT NULL DEFAULT 'pipeline',
          engine_mode TEXT,
          deep_reasoning BOOLEAN NOT NULL DEFAULT FALSE,
          credits INTEGER NOT NULL,
          included_credits INTEGER NOT NULL DEFAULT 0,
          overage_credits INTEGER NOT NULL DEFAULT 0,
          overage_usd_cents INTEGER NOT NULL DEFAULT 0,
          usd_value_cents INTEGER NOT NULL DEFAULT 0,
          attribution TEXT NOT NULL DEFAULT 'included',
          description TEXT,
          stripe_invoice_item_id TEXT,
          stripe_reported_at TIMESTAMPTZ,
          reversed_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_usage_events_user_idx
           ON nabuflow_usage_events (user_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_usage_events_cycle_idx
           ON nabuflow_usage_events (cycle_id)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-nabuflow-orgs (Task #1518) ────────────────────────────────────
  // Constellation enterprise lane: company billing records, seat membership,
  // shared credit-pool ledger, bulk purchases and monthly draw counters for
  // the org-wide cap + per-seat sub-caps. Usage events grow a nullable org
  // linkage (pool draws have no personal cycle). Ora/Orax untouched.
  {
    name: "migrate-nabuflow-orgs",
    async run(client) {
      await client.query("BEGIN");
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_orgs (
          id SERIAL PRIMARY KEY,
          organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
          company_name TEXT NOT NULL,
          billing_contact_name TEXT,
          billing_contact_email TEXT NOT NULL,
          tax_id TEXT,
          address_line1 TEXT NOT NULL,
          address_line2 TEXT,
          city TEXT NOT NULL,
          region TEXT,
          postal_code TEXT NOT NULL,
          country TEXT NOT NULL,
          po_reference TEXT,
          invoice_terms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          terms_net_days INTEGER NOT NULL DEFAULT 30,
          stripe_customer_id TEXT UNIQUE,
          status TEXT NOT NULL DEFAULT 'active',
          pool_credits INTEGER NOT NULL DEFAULT 0,
          monthly_spend_cap_usd_cents INTEGER,
          created_by_user_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_orgs_created_by_idx
           ON nabuflow_orgs (created_by_user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_seats (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL UNIQUE,
          role TEXT NOT NULL DEFAULT 'member',
          seat_spend_cap_usd_cents INTEGER,
          email TEXT,
          added_by_user_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_seats_org_idx
           ON nabuflow_org_seats (org_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_purchases (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          credits INTEGER NOT NULL,
          amount_usd_cents INTEGER NOT NULL,
          method TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          stripe_invoice_id TEXT UNIQUE,
          hosted_invoice_url TEXT,
          invoice_pdf_url TEXT,
          po_reference TEXT,
          requested_by_user_id TEXT NOT NULL,
          due_at TIMESTAMPTZ,
          paid_at TIMESTAMPTZ,
          credited_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_purchases_org_idx
           ON nabuflow_org_purchases (org_id, created_at)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_ledger (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          entry_type TEXT NOT NULL,
          credits INTEGER NOT NULL,
          balance_after INTEGER NOT NULL,
          usd_cents INTEGER NOT NULL DEFAULT 0,
          user_id TEXT,
          usage_event_id INTEGER,
          purchase_id INTEGER,
          description TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_ledger_org_idx
           ON nabuflow_org_ledger (org_id, created_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_ledger_user_idx
           ON nabuflow_org_ledger (user_id)`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_months (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          month_start TIMESTAMPTZ NOT NULL,
          credits_drawn INTEGER NOT NULL DEFAULT 0,
          drawn_usd_cents INTEGER NOT NULL DEFAULT 0,
          cap_notify_level INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT nabuflow_org_months_unique UNIQUE (org_id, month_start)
        )
      `);
      await client.query(`
        CREATE TABLE IF NOT EXISTS nabuflow_org_seat_months (
          id SERIAL PRIMARY KEY,
          org_id INTEGER NOT NULL REFERENCES nabuflow_orgs(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL,
          month_start TIMESTAMPTZ NOT NULL,
          credits_drawn INTEGER NOT NULL DEFAULT 0,
          drawn_usd_cents INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT nabuflow_org_seat_months_unique UNIQUE (org_id, user_id, month_start)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_org_seat_months_user_idx
           ON nabuflow_org_seat_months (user_id, month_start)`,
      );
      // Usage events: pool draws carry an org id and no personal cycle.
      await client.query(
        `ALTER TABLE nabuflow_usage_events ADD COLUMN IF NOT EXISTS org_id INTEGER`,
      );
      await client.query(`ALTER TABLE nabuflow_usage_events ALTER COLUMN cycle_id DROP NOT NULL`);
      await client.query(
        `CREATE INDEX IF NOT EXISTS nabuflow_usage_events_org_idx
           ON nabuflow_usage_events (org_id, created_at)`,
      );
      await client.query("COMMIT");
    },
  },

  // ── migrate-build-token-telemetry ────────────────────────────────────────────
  // NabuFlow R2 Phase D — per-build token telemetry table.
  // Purely additive: no existing table, column, or constraint is altered.
  {
    name: "migrate-build-token-telemetry",
    async run(client) {
      await client.query(`
        CREATE TABLE IF NOT EXISTS build_token_telemetry (
          id                SERIAL PRIMARY KEY,
          task_id           INTEGER NOT NULL REFERENCES agent_tasks(id) ON DELETE CASCADE,
          mode              TEXT NOT NULL,
          provider          TEXT NOT NULL,
          model             TEXT NOT NULL,
          input_tokens      INTEGER NOT NULL DEFAULT 0,
          output_tokens     INTEGER NOT NULL DEFAULT 0,
          computed_usd_cost NUMERIC(12, 8) NOT NULL DEFAULT 0,
          recorded_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT build_token_telemetry_task_id_unique UNIQUE (task_id)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS build_token_telemetry_task_id_idx
           ON build_token_telemetry(task_id)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS build_token_telemetry_mode_recorded_idx
           ON build_token_telemetry(mode, recorded_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS build_token_telemetry_recorded_at_idx
           ON build_token_telemetry(recorded_at)`,
      );
    },
  },

  // ── migrate-bw1-money-path-durability ────────────────────────────────────
  // Additive/idempotent durability rails for post-build settlement and
  // all-outcome token telemetry.
  {
    name: "migrate-bw1-money-path-durability",
    async run(client) {
      await client.query(
        `ALTER TABLE build_token_telemetry
           ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'completed'`,
      );
      await client.query(
        `ALTER TABLE credit_transactions
           ADD COLUMN IF NOT EXISTS settlement_key TEXT`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS credit_transactions_settlement_key_unique
           ON credit_transactions(settlement_key)
           WHERE settlement_key IS NOT NULL`,
      );
      await client.query(
        `ALTER TABLE nabuflow_usage_events
           ADD COLUMN IF NOT EXISTS settlement_key TEXT`,
      );
      await client.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS nabuflow_usage_events_settlement_key_unique
           ON nabuflow_usage_events(settlement_key)
           WHERE settlement_key IS NOT NULL`,
      );
      await client.query(`
        CREATE TABLE IF NOT EXISTS billing_settlement_outbox (
          id            SERIAL PRIMARY KEY,
          kind          TEXT NOT NULL,
          dedupe_key    TEXT NOT NULL,
          task_id       INTEGER,
          owner_id      TEXT,
          amount        INTEGER,
          context       JSONB NOT NULL DEFAULT '{}'::jsonb,
          attempts      INTEGER NOT NULL DEFAULT 0,
          next_retry_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          locked_at     TIMESTAMPTZ,
          completed_at  TIMESTAMPTZ,
          last_error    TEXT,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT billing_settlement_outbox_dedupe_key_unique UNIQUE (dedupe_key)
        )
      `);
      await client.query(
        `CREATE INDEX IF NOT EXISTS billing_settlement_outbox_due_idx
           ON billing_settlement_outbox(completed_at, next_retry_at)`,
      );
      await client.query(
        `CREATE INDEX IF NOT EXISTS billing_settlement_outbox_task_idx
           ON billing_settlement_outbox(task_id)`,
      );
    },
  },

  // Deferred NabuFlow plan downgrades keep the paid current tier active until
  // Stripe's renewal boundary. Additive and idempotent for existing installs.
  {
    name: "migrate-nabuflow-deferred-downgrades",
    async run(client) {
      await client.query(
        `ALTER TABLE nabuflow_subscriptions
           ADD COLUMN IF NOT EXISTS pending_plan_id TEXT`,
      );
      await client.query(
        `ALTER TABLE nabuflow_subscriptions
           ADD COLUMN IF NOT EXISTS pending_effective_at TIMESTAMPTZ`,
      );
    },
  },

  // BC-2: refresh the single deployed Help Center article whose original seed
  // was preserved by ON CONFLICT DO NOTHING. No general seed re-sync.
  {
    name: "migrate-refresh-billing-credits-help-copy",
    async run(client) {
      await refreshBillingCreditsHelpArticle(client);
    },
  },
  // Product-name disambiguation: the deployed FAQ rows predate NabuFlow and
  // are preserved by ON CONFLICT DO NOTHING. Keep this intentionally narrow.
  {
    name: "migrate-refresh-nabuflow-help-copy",
    async run(client) {
      await refreshNabuflowHelpArticles(client);
    },
  },
  // Provider-neutral tenant runtime manifest: existing projects remain null
  // and therefore retain their exact historical port behavior.
  {
    name: "migrate-project-runtime-port",
    async run(client) {
      await client.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS runtime_port INTEGER`);
      await client.query(`
        DO $$
        BEGIN
          ALTER TABLE projects
            ADD CONSTRAINT projects_runtime_port_range
            CHECK (runtime_port IS NULL OR runtime_port BETWEEN 1024 AND 65535);
        EXCEPTION WHEN duplicate_object THEN NULL;
        END $$
      `);
    },
  },
  {
    name: "migrate-project-owner-and-scope-indexes",
    async run(client) {
      await applyProjectOwnerSchemaHardening(client);
    },
  },
  {
    name: "migrate-brainstorm-admission-counters",
    async run(client) {
      const result = await applyBrainstormAdmissionMigration(client);
      logger.info(result, "startup-migrations: brainstorm admission counters ready");
    },
  },
  {
    name: "migrate-stored-integration-credentials",
    async run(client) {
      const result = await backfillStoredIntegrationCredentials(client);
      logger.info(
        {
          mcpServersEncrypted: result.mcpServersEncrypted,
          purchasedDomainsEncrypted: result.purchasedDomainsEncrypted,
          skippedBecauseEncryptionUnavailable: result.skippedBecauseEncryptionUnavailable,
        },
        "startup-migrations: stored integration credentials processed",
      );
    },
  },
  {
    name: "migrate-workspace-foundation",
    async run(client) {
      const result = await applyWorkspaceFoundationMigration(client);
      logger.info(result, "startup-migrations: workspace foundation established");
    },
  },
  {
    name: "migrate-workspace-tenancy",
    async run(client) {
      const result = await applyWorkspaceTenancyMigration(client);
      logger.info(result, "startup-migrations: workspace tenancy established");
    },
  },
  {
    name: "migrate-knowledge-provenance",
    async run(client) {
      await applyKnowledgeProvenanceMigration(client);
    },
  },
  {
    name: "migrate-zero-memory-version-lineage",
    async run(client) {
      await applyMemoryVersionLineageMigration(client);
    },
  },
  {
    name: "migrate-project-summary-provenance",
    async run(client) {
      await applyProjectSummaryProvenanceMigration(client);
    },
  },
  {
    name: "migrate-plan-snapshot-provenance",
    async run(client) {
      await applyPlanSnapshotProvenanceMigration(client);
    },
  },
  {
    name: "migrate-zero-prompt-queue-items",
    async run(client) {
      await applyZeroPromptQueuePersistenceMigration(client);
    },
  },
  {
    name: "migrate-zero-intent-receipts",
    async run(client) {
      await applyZeroIntentReceiptMigration(client);
    },
  },
  {
    name: "migrate-zero-terminal-v1",
    async run(client) {
      await applyZeroTerminalMigration(client);
    },
  },
  {
    name: "migrate-zero-model-control",
    async run(client) {
      await applyZeroModelControlMigration(client);
    },
  },
  {
    name: "migrate-admin-access-foundation",
    async run(client) {
      await applyAdminAccessFoundationMigration(client);
    },
  },
  {
    name: "migrate-support-operations",
    async run(client) {
      await applySupportOperationsMigration(client);
    },
  },
  {
    name: "migrate-project-collaboration",
    async run(client) {
      await applyProjectCollaborationMigration(client);
    },
  },
  {
    name: "migrate-unified-asset-registry",
    async run(client) {
      await applyUnifiedAssetRegistryMigration(client);
    },
  },
  {
    name: "migrate-project-retirement-operations",
    async run(client) {
      await applyProjectRetirementOperationsMigration(client);
    },
  },
  {
    name: "migrate-project-purge-operations",
    async run(client) {
      await applyProjectPurgeOperationsMigration(client);
    },
  },
  {
    name: "migrate-durable-asset-reference-guards-v2",
    async run(client) {
      await applyUnifiedAssetRegistryMigration(client);
    },
  },
  {
    name: "migrate-durable-asset-reference-guards-v3",
    async run(client) {
      await applyUnifiedAssetRegistryMigration(client);
    },
  },
  {
    name: "migrate-preview-database-allocation-receipt",
    async run(client) {
      await applyPreviewDatabaseAllocationMigration(client);
    },
  },
  {
    name: "migrate-production-database-admission",
    async run(client) {
      await applyProductionDatabaseAdmissionMigration(client);
    },
  },
  {
    name: "migrate-asset-product-scope-v1",
    async run(client) {
      await applyUnifiedAssetRegistryMigration(client);
    },
  },
];

/**
 * Run all outstanding schema migrations at server startup.
 *
 * Each migration is isolated: a failure in one step is logged and skipped so
 * the remaining steps still run. The shared pool is never closed.
 *
 * @returns Summary of how many migrations passed and failed.
 */
export async function runStartupMigrations(): Promise<{
  passed: number;
  failed: number;
  errors: { name: string; message: string }[];
}> {
  logger.info(
    { count: MIGRATION_STEPS.length },
    "startup-migrations: running all outstanding schema migrations",
  );

  let passed = 0;
  let failed = 0;
  const errors: { name: string; message: string }[] = [];

  const assessmentClient = await pool.connect();
  try {
    const assessment = await assessDeploymentRuntimeSchema(assessmentClient);
    if (assessment.mode === "read-only-ready") {
      logger.info(
        {
          contractId: assessment.contractId,
          verifiedMigrations: MIGRATION_STEPS.length,
          mode: assessment.mode,
        },
        "startup-migrations: deployed schema verified; runtime DDL is intentionally unavailable",
      );
      return { passed: MIGRATION_STEPS.length, failed: 0, errors: [] };
    }
    if (assessment.mode === "read-only-incomplete") {
      logger.error(
        {
          contractId: assessment.contractId,
          violations: assessment.violations,
          mode: assessment.mode,
        },
        "startup-migrations: deployed schema is incomplete and runtime DDL is unavailable",
      );
      return {
        passed: 0,
        failed: 1,
        errors: [
          {
            name: "verify-deployment-runtime-schema",
            message: assessment.violations.join(","),
          },
        ],
      };
    }
  } finally {
    assessmentClient.release();
  }

  for (const step of MIGRATION_STEPS) {
    const client = await pool.connect();
    try {
      await step.run(client);
      passed++;
      logger.debug({ migration: step.name }, "startup-migrations: step passed");
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ name: step.name, message });
      logger.warn(
        { migration: step.name, err },
        "startup-migrations: step failed (non-fatal, continuing)",
      );
      // Attempt rollback for open transactions
      try {
        await client.query("ROLLBACK");
      } catch {
        // ignore rollback errors
      }
    } finally {
      client.release();
    }
  }

  if (failed === 0) {
    logger.info({ passed }, "startup-migrations: all migrations completed successfully");
  } else {
    logger.warn(
      { passed, failed },
      "startup-migrations: some migrations failed — schema may be partially applied",
    );
  }

  return { passed, failed, errors };
}
