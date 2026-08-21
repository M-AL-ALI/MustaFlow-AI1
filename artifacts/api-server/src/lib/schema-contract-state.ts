import type { PoolClient, QueryConfig } from "pg";

export const ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_ID = "zero_prompt_queue_v1" as const;
export const SCHEMA_CONTRACT_VERIFICATION_INTERVAL_MS = 60_000 as const;
export const SCHEMA_CONTRACT_MAX_AGE_MS = 120_000 as const;
export const SCHEMA_CONTRACT_QUERY_TIMEOUT_MS = 5_000 as const;

type SchemaContractColumn = {
  name: string;
  dataType: string;
  notNull: boolean;
  migrationFragment: string;
};

type SchemaContractConstraint = {
  name: string;
  type: "c" | "f" | "p" | "u";
  deleteAction?: "c";
  definitionFragments: readonly string[];
  migrationFragments: readonly string[];
};

type SchemaContractIndex = {
  name: string;
  tableName: string;
  unique: boolean;
  definitionFragments: readonly string[];
  predicateFragments?: readonly string[];
  migrationFragments: readonly string[];
};

export const ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT = {
  id: ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_ID,
  schemaName: "public",
  tableName: "zero_prompt_queue_items",
  tableIdentity: "public.zero_prompt_queue_items",
  tableMigrationFragment: "CREATE TABLE IF NOT EXISTS zero_prompt_queue_items",
  columns: [
    { name: "id", dataType: "text", notNull: true, migrationFragment: "id TEXT PRIMARY KEY" },
    {
      name: "project_id",
      dataType: "integer",
      notNull: true,
      migrationFragment: "project_id INTEGER NOT NULL",
    },
    {
      name: "position",
      dataType: "integer",
      notNull: true,
      migrationFragment: "position INTEGER NOT NULL",
    },
    {
      name: "current_text",
      dataType: "text",
      notNull: true,
      migrationFragment: "current_text TEXT NOT NULL",
    },
    {
      name: "state",
      dataType: "text",
      notNull: true,
      migrationFragment: "state TEXT NOT NULL",
    },
    {
      name: "promoted_turn_id",
      dataType: "text",
      notNull: false,
      migrationFragment: "promoted_turn_id TEXT",
    },
    {
      name: "deleted_by",
      dataType: "text",
      notNull: false,
      migrationFragment: "deleted_by TEXT",
    },
    {
      name: "created_at",
      dataType: "timestamp with time zone",
      notNull: true,
      migrationFragment: "created_at TIMESTAMPTZ NOT NULL",
    },
    {
      name: "updated_at",
      dataType: "timestamp with time zone",
      notNull: true,
      migrationFragment: "updated_at TIMESTAMPTZ NOT NULL",
    },
  ] satisfies readonly SchemaContractColumn[],
  constraints: [
    {
      name: "zero_prompt_queue_items_pkey",
      type: "p",
      definitionFragments: ["primary key", "id"],
      migrationFragments: ["id TEXT PRIMARY KEY"],
    },
    {
      name: "zero_prompt_queue_items_project_id_fkey",
      type: "f",
      deleteAction: "c",
      definitionFragments: ["foreign key", "project_id", "projects", "id", "delete cascade"],
      migrationFragments: ["project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE"],
    },
    {
      name: "zero_prompt_queue_items_position_check",
      type: "c",
      definitionFragments: ["check", "position", "> 0"],
      migrationFragments: ["zero_prompt_queue_items_position_check", "CHECK (position > 0)"],
    },
    {
      name: "zero_prompt_queue_items_text_check",
      type: "c",
      definitionFragments: ["check", "char_length", "current_text", "1", "10000"],
      migrationFragments: [
        "zero_prompt_queue_items_text_check",
        "CHECK (char_length(current_text) BETWEEN 1 AND 10000)",
      ],
    },
    {
      name: "zero_prompt_queue_items_state_check",
      type: "c",
      definitionFragments: ["check", "state", "queued", "promoted", "deleted"],
      migrationFragments: [
        "zero_prompt_queue_items_state_check",
        "CHECK (state IN ('queued', 'promoted', 'deleted'))",
      ],
    },
    {
      name: "zero_prompt_queue_items_terminal_check",
      type: "c",
      definitionFragments: [
        "check",
        "state",
        "queued",
        "promoted",
        "deleted",
        "promoted_turn_id",
        "deleted_by",
      ],
      migrationFragments: [
        "zero_prompt_queue_items_terminal_check",
        "state = 'queued'",
        "state = 'promoted'",
        "state = 'deleted'",
        "promoted_turn_id",
        "deleted_by",
      ],
    },
    {
      name: "zero_prompt_queue_items_project_position_unique",
      type: "u",
      definitionFragments: ["unique", "project_id", "position"],
      migrationFragments: [
        "zero_prompt_queue_items_project_position_unique",
        "UNIQUE (project_id, position)",
      ],
    },
  ] satisfies readonly SchemaContractConstraint[],
  indexes: [
    {
      name: "zero_prompt_queue_items_pkey",
      tableName: "zero_prompt_queue_items",
      unique: true,
      definitionFragments: ["zero_prompt_queue_items", "id"],
      migrationFragments: ["id TEXT PRIMARY KEY"],
    },
    {
      name: "zero_prompt_queue_items_project_position_unique",
      tableName: "zero_prompt_queue_items",
      unique: true,
      definitionFragments: ["zero_prompt_queue_items", "project_id", "position"],
      migrationFragments: [
        "zero_prompt_queue_items_project_position_unique",
        "UNIQUE (project_id, position)",
      ],
    },
    {
      name: "zero_prompt_queue_items_project_state_idx",
      tableName: "zero_prompt_queue_items",
      unique: false,
      definitionFragments: ["zero_prompt_queue_items", "project_id", "state", "position"],
      migrationFragments: [
        "zero_prompt_queue_items_project_state_idx",
        "ON zero_prompt_queue_items(project_id, state, position)",
      ],
    },
    {
      name: "project_activity_queue_item_idx",
      tableName: "project_activity",
      unique: false,
      definitionFragments: ["project_activity", "project_id", "metadata", "itemid", "created_at"],
      predicateFragments: ["event_type", "queue.item.%"],
      migrationFragments: [
        "project_activity_queue_item_idx",
        "ON project_activity(project_id, ((metadata ->> 'itemId')), created_at DESC)",
        "WHERE event_type LIKE 'queue.item.%'",
      ],
    },
  ] satisfies readonly SchemaContractIndex[],
} as const;

export const ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY = `
  SELECT
    to_regclass($1) IS NOT NULL AS "tableExists",
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', attribute.attname,
        'dataType', format_type(attribute.atttypid, attribute.atttypmod),
        'notNull', attribute.attnotnull
      ) ORDER BY attribute.attnum)
        FROM pg_catalog.pg_attribute attribute
        JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $2
         AND relation.relname = $3
         AND attribute.attnum > 0
         AND NOT attribute.attisdropped
    ), '[]'::jsonb) AS columns,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', constraint_row.conname,
        'type', constraint_row.contype,
        'validated', constraint_row.convalidated,
        'deleteAction', constraint_row.confdeltype,
        'definition', pg_get_constraintdef(constraint_row.oid, true)
      ) ORDER BY constraint_row.conname)
        FROM pg_catalog.pg_constraint constraint_row
        JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
       WHERE namespace.nspname = $2
         AND relation.relname = $3
    ), '[]'::jsonb) AS constraints,
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'name', index_relation.relname,
        'tableName', table_relation.relname,
        'unique', index_row.indisunique,
        'valid', index_row.indisvalid,
        'ready', index_row.indisready,
        'definition', pg_get_indexdef(index_row.indexrelid),
        'predicate', COALESCE(pg_get_expr(index_row.indpred, index_row.indrelid), '')
      ) ORDER BY index_relation.relname)
        FROM pg_catalog.pg_index index_row
        JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
        JOIN pg_catalog.pg_class table_relation ON table_relation.oid = index_row.indrelid
        JOIN pg_catalog.pg_namespace namespace ON namespace.oid = table_relation.relnamespace
       WHERE namespace.nspname = $2
         AND index_relation.relname = ANY($4::text[])
    ), '[]'::jsonb) AS indexes
`;

export const ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY_VALUES = [
  ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.tableIdentity,
  ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.schemaName,
  ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.tableName,
  ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.indexes.map((index) => index.name),
] as const;

export const SCHEMA_CONTRACT_VIOLATION_CODES = [
  "catalog_query_failed",
  "table_missing",
  "column_missing",
  "column_type_mismatch",
  "column_nullability_mismatch",
  "constraint_missing",
  "constraint_type_mismatch",
  "constraint_unvalidated",
  "constraint_delete_action_mismatch",
  "constraint_definition_mismatch",
  "index_missing",
  "index_table_mismatch",
  "index_uniqueness_mismatch",
  "index_invalid",
  "index_not_ready",
  "index_definition_mismatch",
  "index_predicate_mismatch",
  "verification_stale",
] as const;

export type SchemaContractViolationCode = (typeof SCHEMA_CONTRACT_VIOLATION_CODES)[number];

export type SchemaContractState = {
  contractId: typeof ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_ID;
  status: "starting" | "ready" | "unready";
  checkedAtMs: number | null;
  durationMs: number | null;
  violations: readonly SchemaContractViolationCode[];
};

type CatalogColumn = { name: string; dataType: string; notNull: boolean };
type CatalogConstraint = {
  name: string;
  type: string;
  validated: boolean;
  deleteAction: string;
  definition: string;
};
type CatalogIndex = {
  name: string;
  tableName: string;
  unique: boolean;
  valid: boolean;
  ready: boolean;
  definition: string;
  predicate: string;
};
export type ZeroPromptQueueSchemaCatalog = {
  tableExists: boolean;
  columns: CatalogColumn[];
  constraints: CatalogConstraint[];
  indexes: CatalogIndex[];
};

type QueryClient = Pick<PoolClient, "query">;
type Clock = () => number;

function normalizedSql(value: string): string {
  return value.toLowerCase().replace(/"/g, "").replace(/\s+/g, " ").trim();
}

function includesEvery(value: string, fragments: readonly string[]): boolean {
  const normalized = normalizedSql(value);
  return fragments.every((fragment) => normalized.includes(normalizedSql(fragment)));
}

function violationsFor(catalog: ZeroPromptQueueSchemaCatalog): SchemaContractViolationCode[] {
  const violations = new Set<SchemaContractViolationCode>();
  if (!catalog.tableExists) violations.add("table_missing");

  const columns = new Map(catalog.columns.map((column) => [column.name, column]));
  for (const expected of ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.columns) {
    const actual = columns.get(expected.name);
    if (!actual) {
      violations.add("column_missing");
      continue;
    }
    if (actual.dataType !== expected.dataType) violations.add("column_type_mismatch");
    if (actual.notNull !== expected.notNull) violations.add("column_nullability_mismatch");
  }

  const constraints = new Map(
    catalog.constraints.map((constraint) => [constraint.name, constraint]),
  );
  for (const expected of ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.constraints) {
    const actual = constraints.get(expected.name);
    if (!actual) {
      violations.add("constraint_missing");
      continue;
    }
    if (actual.type !== expected.type) violations.add("constraint_type_mismatch");
    if (!actual.validated) violations.add("constraint_unvalidated");
    if (expected.deleteAction && actual.deleteAction !== expected.deleteAction) {
      violations.add("constraint_delete_action_mismatch");
    }
    if (!includesEvery(actual.definition, expected.definitionFragments)) {
      violations.add("constraint_definition_mismatch");
    }
  }

  const indexes = new Map(catalog.indexes.map((index) => [index.name, index]));
  for (const expected of ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT.indexes) {
    const actual = indexes.get(expected.name);
    if (!actual) {
      violations.add("index_missing");
      continue;
    }
    if (actual.tableName !== expected.tableName) violations.add("index_table_mismatch");
    if (actual.unique !== expected.unique) violations.add("index_uniqueness_mismatch");
    if (!actual.valid) violations.add("index_invalid");
    if (!actual.ready) violations.add("index_not_ready");
    if (!includesEvery(actual.definition, expected.definitionFragments)) {
      violations.add("index_definition_mismatch");
    }
    if (
      expected.predicateFragments &&
      !includesEvery(actual.predicate, expected.predicateFragments)
    ) {
      violations.add("index_predicate_mismatch");
    }
  }

  return [...violations];
}

export function evaluateZeroPromptQueueSchemaContract(
  catalog: ZeroPromptQueueSchemaCatalog,
  checkedAtMs: number,
  durationMs: number,
): SchemaContractState {
  const violations = violationsFor(catalog);
  return {
    contractId: ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_ID,
    status: violations.length === 0 ? "ready" : "unready",
    checkedAtMs,
    durationMs,
    violations,
  };
}

function startingState(): SchemaContractState {
  return {
    contractId: ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_ID,
    status: "starting",
    checkedAtMs: null,
    durationMs: null,
    violations: [],
  };
}

export class SchemaContractMonitor {
  private state: SchemaContractState = startingState();
  private verification: Promise<SchemaContractState> | null = null;

  read(nowMs = Date.now()): SchemaContractState {
    if (
      this.state.status === "ready" &&
      this.state.checkedAtMs !== null &&
      nowMs - this.state.checkedAtMs > SCHEMA_CONTRACT_MAX_AGE_MS
    ) {
      return { ...this.state, status: "unready", violations: ["verification_stale"] };
    }
    return { ...this.state, violations: [...this.state.violations] };
  }

  isReady(nowMs = Date.now()): boolean {
    return this.read(nowMs).status === "ready";
  }

  verify(client: QueryClient, clock: Clock = Date.now): Promise<SchemaContractState> {
    if (this.verification) return this.verification;
    const startedAt = clock();
    const queryConfig: QueryConfig & { query_timeout: number } = {
      text: ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY,
      values: [
        ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY_VALUES[0],
        ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY_VALUES[1],
        ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY_VALUES[2],
        [...ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_QUERY_VALUES[3]],
      ],
      query_timeout: SCHEMA_CONTRACT_QUERY_TIMEOUT_MS,
    };
    this.verification = client
      .query<ZeroPromptQueueSchemaCatalog>(queryConfig)
      .then((result) => {
        const checkedAtMs = clock();
        const catalog = result.rows[0];
        this.state = catalog
          ? evaluateZeroPromptQueueSchemaContract(
              catalog,
              checkedAtMs,
              Math.max(0, checkedAtMs - startedAt),
            )
          : {
              contractId: ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_ID,
              status: "unready",
              checkedAtMs,
              durationMs: Math.max(0, checkedAtMs - startedAt),
              violations: ["catalog_query_failed"],
            };
        return this.read(checkedAtMs);
      })
      .catch(() => {
        const checkedAtMs = clock();
        this.state = {
          contractId: ZERO_PROMPT_QUEUE_SCHEMA_CONTRACT_ID,
          status: "unready",
          checkedAtMs,
          durationMs: Math.max(0, checkedAtMs - startedAt),
          violations: ["catalog_query_failed"],
        };
        return this.read(checkedAtMs);
      })
      .finally(() => {
        this.verification = null;
      });
    return this.verification;
  }
}

export const zeroPromptQueueSchemaContractState = new SchemaContractMonitor();

export function startSchemaContractVerificationCadence(
  client: QueryClient,
  monitor = zeroPromptQueueSchemaContractState,
  intervalMs = SCHEMA_CONTRACT_VERIFICATION_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void monitor.verify(client);
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
