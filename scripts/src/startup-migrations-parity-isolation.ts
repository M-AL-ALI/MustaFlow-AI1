import { spawn } from "node:child_process";

/**
 * Three-layer bootstrap law:
 * Layer 0 owns allowlisted PostgreSQL extensions required by the schema source.
 * Layer 1 owns creation from canonical Drizzle schema source.
 * Layer 2 owns additive evolution through runStartupMigrations().
 * This harness proves layer 2 atop canonical layers 0 and 1; it never clones a live database.
 */
const SCRATCH_DATABASE_PATTERN = /^parity_scratch(?:_[a-z0-9]+)?$/;
const CHILD_TIMEOUT_MS = 20 * 60 * 1000;
const CHILD_MODE_ARGUMENT = "--parity-child";
const SCHEMA_DIFF_MECHANISM = "pg_catalog_relations_columns_constraints_indexes";
const RESTORE_PROBE_TABLE = "knowledge_entries";
const RESTORE_PROBE_COLUMN = "source_message_start_id";
const LAYER1_SENTINEL_TABLE = "knowledge_entries";
const LAYER1_ERROR_LINE_PATTERN = /^error:|PostgresError|code: '42/;
const EXPECTED_MIGRATION_COUNT = 145;
const EXPECTED_LAYER1_OBJECT_COUNT = "TODO_PHASE_2_4" as const;
export const PARITY_EXTENSION_ALLOWLIST = ["vector"] as const;
const TOLERATED_MIGRATION_FAILURE = {
  name: "migrate-workspace-tenancy",
  message: "legacy_adoption_owner_id_missing",
} as const;
const REDACTED_DATABASE_ENV_NAMES = new Set([
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "PGHOST",
  "PGDATABASE",
  "PGUSER",
  "PGPASSWORD",
  "PGPORT",
  "PARITY_TEST_DATABASE_URL",
]);

export type ParityIsolationErrorCode =
  | "parity_database_url_missing"
  | "parity_database_url_malformed"
  | "parity_database_name_missing"
  | "parity_database_name_refused"
  | "parity_check_failed";

export class ParityIsolationError extends Error {
  constructor(
    readonly code: ParityIsolationErrorCode,
    readonly host: string,
    readonly databaseName: string,
  ) {
    super(`${code} host=${host} dbname=${databaseName}`);
    this.name = "ParityIsolationError";
  }
}

export interface ParityDatabaseTarget {
  readonly connectionString: string;
  readonly host: string;
  readonly databaseName: string;
}

export interface ParityIsolationConnector {
  setup(target: ParityDatabaseTarget): Promise<void>;
  check(target: ParityDatabaseTarget): Promise<void>;
  teardown(target: ParityDatabaseTarget): Promise<void>;
}

export interface ParityMigrationReceipt {
  readonly migrationCount: number;
}

export interface ParityBaseMaterializationReceipt {
  readonly objectCount: number;
  readonly sentinelPresent: boolean;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ParityProofConnector {
  provisionExtensions(target: ParityDatabaseTarget): Promise<readonly string[]>;
  materializeBase(target: ParityDatabaseTarget): Promise<ParityBaseMaterializationReceipt>;
  runMigrations(target: ParityDatabaseTarget): Promise<ParityMigrationReceipt>;
  captureSchema(target: ParityDatabaseTarget): Promise<readonly string[]>;
  dropRestoreProbeColumn(target: ParityDatabaseTarget): Promise<void>;
  hasRestoreProbeColumn(target: ParityDatabaseTarget): Promise<boolean>;
  close(): Promise<void>;
}

export interface RunParityIsolationOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly connector: ParityIsolationConnector;
  readonly log: (line: string) => void;
}

export interface RunThreeProofParityOptions {
  readonly target: ParityDatabaseTarget;
  readonly connector: ParityProofConnector;
  readonly log: (line: string) => void;
}

export interface ChildOutputSource {
  on(event: "data", listener: (chunk: Uint8Array | string) => void): unknown;
}

export interface ChildOutputDestination {
  write(chunk: Uint8Array | string): unknown;
}

export interface StreamingProcessReceipt {
  readonly stdout: string;
  readonly stderr: string;
}

export interface StartupMigrationResult {
  readonly passed: number;
  readonly failed: number;
  readonly errors: readonly { readonly name: string; readonly message: string }[];
}

function refusal(code: ParityIsolationErrorCode, host: string, databaseName: string): never {
  throw new ParityIsolationError(code, host, databaseName);
}

export function parseParityDatabaseTarget(raw: string | undefined): ParityDatabaseTarget {
  if (raw === undefined || raw.trim() === "") {
    return refusal("parity_database_url_missing", "<unavailable>", "<missing>");
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return refusal("parity_database_url_malformed", "<unavailable>", "<unavailable>");
  }

  if (!["postgres:", "postgresql:"].includes(parsed.protocol) || parsed.hostname === "") {
    return refusal(
      "parity_database_url_malformed",
      parsed.hostname || "<unavailable>",
      "<unavailable>",
    );
  }

  const encodedName = parsed.pathname.replace(/^\//, "");
  if (encodedName === "" || encodedName.includes("/")) {
    return refusal("parity_database_name_missing", parsed.hostname, "<missing>");
  }

  let databaseName: string;
  try {
    databaseName = decodeURIComponent(encodedName);
  } catch {
    return refusal("parity_database_url_malformed", parsed.hostname, "<unavailable>");
  }

  if (!SCRATCH_DATABASE_PATTERN.test(databaseName)) {
    return refusal("parity_database_name_refused", parsed.hostname, databaseName);
  }

  return {
    connectionString: raw,
    host: parsed.hostname,
    databaseName,
  };
}

function targetSuffix(target: Pick<ParityDatabaseTarget, "host" | "databaseName">): string {
  return `host=${target.host} dbname=${target.databaseName}`;
}

function schemaDiffCount(before: readonly string[], after: readonly string[]): number {
  const beforeCounts = new Map<string, number>();
  const afterCounts = new Map<string, number>();
  for (const entry of before) beforeCounts.set(entry, (beforeCounts.get(entry) ?? 0) + 1);
  for (const entry of after) afterCounts.set(entry, (afterCounts.get(entry) ?? 0) + 1);

  let difference = 0;
  const entries = new Set([...beforeCounts.keys(), ...afterCounts.keys()]);
  for (const entry of entries) {
    difference += Math.abs((beforeCounts.get(entry) ?? 0) - (afterCounts.get(entry) ?? 0));
  }
  return difference;
}

function layer1ExpectedCountReceipt(): string {
  return typeof EXPECTED_LAYER1_OBJECT_COUNT === "number"
    ? String(EXPECTED_LAYER1_OBJECT_COUNT)
    : EXPECTED_LAYER1_OBJECT_COUNT;
}

function outputErrorLines(receipt: StreamingProcessReceipt): readonly string[] {
  return `${receipt.stdout}\n${receipt.stderr}`
    .split(/\r?\n/u)
    .filter((line) => LAYER1_ERROR_LINE_PATTERN.test(line));
}

export function assertHonestLayerOneReceipt(
  receipt: ParityBaseMaterializationReceipt,
  expectedObjectCount: number | typeof EXPECTED_LAYER1_OBJECT_COUNT = EXPECTED_LAYER1_OBJECT_COUNT,
): void {
  const errorLines = outputErrorLines(receipt);
  if (errorLines.length > 0) {
    throw new Error(
      `parity_layer1_output_error lines=${JSON.stringify(errorLines)} stdout=${JSON.stringify(receipt.stdout)} stderr=${JSON.stringify(receipt.stderr)}`,
    );
  }
  if (!receipt.sentinelPresent) {
    throw new Error(`parity_layer1_sentinel_missing table=${LAYER1_SENTINEL_TABLE}`);
  }
  if (receipt.objectCount <= 0) {
    throw new Error(`parity_layer1_object_count_invalid actual=${receipt.objectCount}`);
  }
  if (typeof expectedObjectCount === "number" && receipt.objectCount !== expectedObjectCount) {
    throw new Error(
      `parity_layer1_object_count_mismatch expected=${expectedObjectCount} actual=${receipt.objectCount}`,
    );
  }
}

export function assertToleratedMigrationResult(
  result: StartupMigrationResult,
): ParityMigrationReceipt {
  const exactCount = result.passed + result.failed === EXPECTED_MIGRATION_COUNT;
  const exactFailure =
    result.passed === EXPECTED_MIGRATION_COUNT - 1 &&
    result.failed === 1 &&
    result.errors.length === 1 &&
    result.errors[0]?.name === TOLERATED_MIGRATION_FAILURE.name &&
    result.errors[0]?.message === TOLERATED_MIGRATION_FAILURE.message;

  if (!exactCount || !exactFailure) {
    throw new Error(
      `parity_migrations_failed passed=${result.passed} failed=${result.failed} errors=${JSON.stringify(result.errors)}`,
    );
  }
  return { migrationCount: result.passed + result.failed };
}

function assertExactExtensionReceipts(extensions: readonly string[]): void {
  if (
    extensions.length !== PARITY_EXTENSION_ALLOWLIST.length ||
    extensions.some((extension, index) => extension !== PARITY_EXTENSION_ALLOWLIST[index])
  ) {
    throw new Error(
      `parity_extension_receipt_mismatch expected=${JSON.stringify(PARITY_EXTENSION_ALLOWLIST)} actual=${JSON.stringify(extensions)}`,
    );
  }
}

export async function runThreeProofParity({
  target,
  connector,
  log,
}: RunThreeProofParityOptions): Promise<void> {
  const suffix = targetSuffix(target);
  try {
    log(`parity_layer0_extensions_start ${suffix}`);
    const extensions = await connector.provisionExtensions(target);
    assertExactExtensionReceipts(extensions);
    for (const extension of extensions) {
      log(`parity_layer0_extension_pass ${suffix} extension=${extension}`);
    }
    log(`parity_layer1_materialize_start ${suffix}`);
    const layer1 = await connector.materializeBase(target);
    assertHonestLayerOneReceipt(layer1);
    log(
      `parity_layer1_materialize_pass ${suffix} object_count=${layer1.objectCount} expected_object_count=${layer1ExpectedCountReceipt()} sentinel=${LAYER1_SENTINEL_TABLE}`,
    );
    log(`parity_layer2_migrations_start ${suffix}`);
    const layer2 = await connector.runMigrations(target);
    log(`parity_layer2_migrations_pass ${suffix} migration_count=${layer2.migrationCount}`);
    const bootstrapSchema = await connector.captureSchema(target);
    log(`parity_construction_pass ${suffix} schema_entry_count=${bootstrapSchema.length}`);

    log(`parity_idempotency_start ${suffix}`);
    const idempotentLayer1 = await connector.materializeBase(target);
    assertHonestLayerOneReceipt(idempotentLayer1);
    log(
      `parity_idempotency_layer1_pass ${suffix} object_count=${idempotentLayer1.objectCount} expected_object_count=${layer1ExpectedCountReceipt()} sentinel=${LAYER1_SENTINEL_TABLE}`,
    );
    const idempotentLayer2 = await connector.runMigrations(target);
    log(
      `parity_idempotency_layer2_pass ${suffix} migration_count=${idempotentLayer2.migrationCount}`,
    );
    const idempotentSchema = await connector.captureSchema(target);
    const difference = schemaDiffCount(bootstrapSchema, idempotentSchema);
    log(
      `parity_idempotency_diff ${suffix} mechanism=${SCHEMA_DIFF_MECHANISM} diff_count=${difference}`,
    );
    if (difference !== 0) {
      throw new Error(`parity_schema_diff_nonempty diff_count=${difference}`);
    }
    log(`parity_idempotency_pass ${suffix}`);

    log(
      `parity_restore_probe_start ${suffix} table=${RESTORE_PROBE_TABLE} column=${RESTORE_PROBE_COLUMN}`,
    );
    await connector.dropRestoreProbeColumn(target);
    const restore = await connector.runMigrations(target);
    if (!(await connector.hasRestoreProbeColumn(target))) {
      throw new Error(
        `parity_restore_probe_column_missing table=${RESTORE_PROBE_TABLE} column=${RESTORE_PROBE_COLUMN}`,
      );
    }
    log(`parity_restore_probe_pass ${suffix} migration_count=${restore.migrationCount}`);
  } finally {
    await connector.close();
  }
}

export async function runParityIsolation({
  environment,
  connector,
  log,
}: RunParityIsolationOptions): Promise<void> {
  let target: ParityDatabaseTarget;
  try {
    target = parseParityDatabaseTarget(environment.PARITY_TEST_DATABASE_URL);
  } catch (error) {
    if (error instanceof ParityIsolationError) {
      log(`${error.code} host=${error.host} dbname=${error.databaseName}`);
    }
    throw error;
  }

  const suffix = targetSuffix(target);
  log(`parity_setup_start ${suffix}`);
  await connector.setup(target);

  try {
    log(`parity_check_start ${suffix}`);
    await connector.check(target);
    log(`parity_check_pass ${suffix}`);
  } catch {
    const error = new ParityIsolationError("parity_check_failed", target.host, target.databaseName);
    log(error.message);
    throw error;
  } finally {
    log(`parity_teardown_start ${suffix}`);
    await connector.teardown(target);
    log(`parity_teardown_complete ${suffix}`);
  }
}

function sanitizedChildEnvironment(target: ParityDatabaseTarget): NodeJS.ProcessEnv {
  const childEnvironment: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(process.env)) {
    if (REDACTED_DATABASE_ENV_NAMES.has(name)) continue;
    const value = process.env[name];
    if (value !== undefined) childEnvironment[name] = value;
  }

  childEnvironment.DATABASE_URL = target.connectionString;
  return childEnvironment;
}

export function relayChildOutput(
  source: ChildOutputSource,
  destination: ChildOutputDestination,
): void {
  source.on("data", (chunk) => destination.write(chunk));
}

function runStreamingProcess(
  command: string,
  arguments_: readonly string[],
  environment: NodeJS.ProcessEnv,
  label: string,
): Promise<StreamingProcessReceipt> {
  return new Promise((resolve, reject) => {
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const child = spawn(command, arguments_, {
      cwd: process.cwd(),
      env: environment,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    if (!child.stdout || !child.stderr) {
      reject(new Error("parity_child_output_unavailable"));
      return;
    }
    relayChildOutput(child.stdout, process.stdout);
    relayChildOutput(child.stderr, process.stderr);
    child.stdout.on("data", (chunk) => stdoutChunks.push(Buffer.from(chunk).toString("utf8")));
    child.stderr.on("data", (chunk) => stderrChunks.push(Buffer.from(chunk).toString("utf8")));

    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`${label}_timeout`));
    }, CHILD_TIMEOUT_MS);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      const receipt = { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
      if (code === 0) resolve(receipt);
      else {
        reject(
          new Error(
            `${label}_exit code=${String(code)} signal=${String(signal)} stdout=${JSON.stringify(receipt.stdout)} stderr=${JSON.stringify(receipt.stderr)}`,
          ),
        );
      }
    });
  });
}

async function runBootstrapFirstParityCheck(target: ParityDatabaseTarget): Promise<void> {
  const scriptPath = process.argv[1];
  if (!scriptPath) return Promise.reject(new Error("parity_script_path_missing"));
  await runStreamingProcess(
    process.execPath,
    ["--import", "tsx", scriptPath, CHILD_MODE_ARGUMENT],
    sanitizedChildEnvironment(target),
    "parity_child",
  );
}

export const bootstrapFirstParityConnector: ParityIsolationConnector = {
  async setup() {
    // The desk creates the validated scratch database before this runner starts.
  },
  async check(target) {
    await runBootstrapFirstParityCheck(target);
  },
  async teardown() {
    // The child closes its pool. The desk drops the scratch database afterward.
  },
};

async function createPostgresProofConnector(): Promise<ParityProofConnector> {
  const [{ pool }, { runStartupMigrations }] = await Promise.all([
    import("@workspace/db"),
    import("../../artifacts/api-server/src/lib/startup-migrations"),
  ]);

  return {
    async provisionExtensions() {
      for (const extension of PARITY_EXTENSION_ALLOWLIST) {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS "${extension}"`);
      }
      return PARITY_EXTENSION_ALLOWLIST;
    },
    async materializeBase() {
      const command = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
      const output = await runStreamingProcess(
        command,
        ["--filter", "@workspace/db", "push-force"],
        process.env,
        "parity_layer1_materialization",
      );
      const count = await pool.query<{ object_count: string }>(`
        SELECT count(*)::text AS object_count
          FROM pg_catalog.pg_class relation
          JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
         WHERE namespace.nspname IN ('public', 'pgboss', '_system')
           AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
      `);
      const sentinel = await pool.query<{ present: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS present`,
        [`public.${LAYER1_SENTINEL_TABLE}`],
      );
      return {
        objectCount: Number(count.rows[0]?.object_count ?? "0"),
        sentinelPresent: sentinel.rows[0]?.present === true,
        stdout: output.stdout,
        stderr: output.stderr,
      };
    },
    async runMigrations() {
      const result = await runStartupMigrations();
      return assertToleratedMigrationResult(result);
    },
    async captureSchema() {
      const result = await pool.query<{ kind: string; identity: string }>(`
        SELECT kind, identity
          FROM (
            SELECT 'relation'::text AS kind,
                   format('%I.%I|%s|%s', namespace.nspname, relation.relname,
                          relation.relkind, relation.relpersistence) AS identity
              FROM pg_catalog.pg_class relation
              JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname IN ('public', 'pgboss', '_system')
               AND relation.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
            UNION ALL
            SELECT 'column'::text AS kind,
                   format('%I.%I.%I|%s|%s|%s|%s|%s', namespace.nspname, relation.relname,
                          attribute.attname, pg_catalog.format_type(attribute.atttypid, attribute.atttypmod),
                          attribute.attnotnull, attribute.attidentity, attribute.attgenerated,
                          COALESCE(pg_catalog.pg_get_expr(default_row.adbin, default_row.adrelid), '')) AS identity
              FROM pg_catalog.pg_attribute attribute
              JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
              JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
              LEFT JOIN pg_catalog.pg_attrdef default_row
                     ON default_row.adrelid = attribute.attrelid AND default_row.adnum = attribute.attnum
             WHERE namespace.nspname IN ('public', 'pgboss', '_system')
               AND attribute.attnum > 0
               AND NOT attribute.attisdropped
            UNION ALL
            SELECT 'constraint'::text AS kind,
                   format('%I.%I.%I|%s|%s', namespace.nspname, relation.relname,
                          constraint_row.conname, constraint_row.contype,
                          pg_catalog.pg_get_constraintdef(constraint_row.oid, true)) AS identity
              FROM pg_catalog.pg_constraint constraint_row
              JOIN pg_catalog.pg_class relation ON relation.oid = constraint_row.conrelid
              JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
             WHERE namespace.nspname IN ('public', 'pgboss', '_system')
            UNION ALL
            SELECT 'index'::text AS kind,
                   format('%I.%I|%s', namespace.nspname, index_relation.relname,
                          pg_catalog.pg_get_indexdef(index_relation.oid)) AS identity
              FROM pg_catalog.pg_index index_row
              JOIN pg_catalog.pg_class index_relation ON index_relation.oid = index_row.indexrelid
              JOIN pg_catalog.pg_namespace namespace ON namespace.oid = index_relation.relnamespace
             WHERE namespace.nspname IN ('public', 'pgboss', '_system')
          ) snapshot
         ORDER BY kind, identity
      `);
      return result.rows.map((row) => `${row.kind}:${row.identity}`);
    },
    async dropRestoreProbeColumn() {
      await pool.query(
        `ALTER TABLE ${RESTORE_PROBE_TABLE} DROP COLUMN IF EXISTS ${RESTORE_PROBE_COLUMN}`,
      );
    },
    async hasRestoreProbeColumn() {
      const result = await pool.query<{ present: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM information_schema.columns
            WHERE table_schema = current_schema()
              AND table_name = $1
              AND column_name = $2
         ) AS present`,
        [RESTORE_PROBE_TABLE, RESTORE_PROBE_COLUMN],
      );
      return result.rows[0]?.present === true;
    },
    async close() {
      await pool.end();
    },
  };
}

async function runChild(): Promise<void> {
  const target = parseParityDatabaseTarget(process.env.DATABASE_URL);
  const connector = await createPostgresProofConnector();
  await runThreeProofParity({
    target,
    connector,
    log: (line) => console.log(line),
  });
}

async function main(): Promise<void> {
  if (process.argv.includes(CHILD_MODE_ARGUMENT)) {
    await runChild();
    return;
  }

  await runParityIsolation({
    environment: process.env,
    connector: bootstrapFirstParityConnector,
    log: (line) => console.log(line),
  });
}

const invokedPath = process.argv[1]?.replaceAll("\\", "/");
if (invokedPath?.endsWith("/startup-migrations-parity-isolation.ts")) {
  main().catch((error: unknown) => {
    if (error instanceof Error) {
      console.error(error.stack ?? error.message);
    } else {
      console.error(String(error));
    }
    process.exitCode = 1;
  });
}
