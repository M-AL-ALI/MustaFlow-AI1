import { neon, type FullQueryResults } from "@neondatabase/serverless";
import {
  databaseCapabilityInputSchema,
  databaseStatementResultSchema,
  type DatabaseCapabilityInput,
  type DatabaseStatementResult,
} from "@workspace/tenant-runtime-contracts";

const MAX_ROWS = 100;
const MAX_RESPONSE_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 10_000;

export type DatabaseBrokerErrorCode =
  | "database_invalid_query"
  | "database_constraint_violation"
  | "database_conflict"
  | "database_timeout"
  | "database_unavailable"
  | "database_execution_failed"
  | "database_response_too_large";

export class DatabaseBrokerError extends Error {
  constructor(
    readonly status: 400 | 409 | 502 | 503 | 504,
    readonly code: DatabaseBrokerErrorCode,
    readonly retryable: boolean,
    readonly sqlstate: string | null = null,
  ) {
    super("The database operation could not be completed");
  }
}

export interface DatabaseExecutionAdapter {
  statement(
    connectionString: string,
    statement: { sql: string; params: Array<string | number | boolean | null> },
    signal: AbortSignal,
  ): Promise<FullQueryResults<false>>;
  atomicBatch(
    connectionString: string,
    statements: Array<{ sql: string; params: Array<string | number | boolean | null> }>,
    signal: AbortSignal,
  ): Promise<Array<FullQueryResults<false>>>;
}

const neonExecutionAdapter: DatabaseExecutionAdapter = {
  async statement(connectionString, statement, signal) {
    const sql = neon<false, true>(connectionString, {
      fullResults: true,
      fetchOptions: { signal },
    });
    return sql.query(statement.sql, statement.params);
  },
  async atomicBatch(connectionString, statements, signal) {
    const sql = neon<false, true>(connectionString, {
      fullResults: true,
      fetchOptions: { signal },
    });
    return sql.transaction(
      statements.map((statement) => sql.query(statement.sql, statement.params)),
    );
  },
};

function validateConnectionString(connectionString: string): void {
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new DatabaseBrokerError(503, "database_unavailable", true);
  }
  if (
    (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") ||
    !/(?:^|\.)neon\.tech$/u.test(parsed.hostname) ||
    parsed.username.length === 0 ||
    parsed.password.length === 0
  ) {
    throw new DatabaseBrokerError(503, "database_unavailable", true);
  }
}

function sanitizedResult(result: FullQueryResults<false>): DatabaseStatementResult {
  if (result.rows.length > MAX_ROWS) {
    throw new DatabaseBrokerError(502, "database_response_too_large", false);
  }
  let rows: Array<Record<string, unknown>>;
  try {
    rows = JSON.parse(
      JSON.stringify(result.rows, (_key, value: unknown) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ) as Array<Record<string, unknown>>;
  } catch {
    throw new DatabaseBrokerError(502, "database_execution_failed", false);
  }
  return databaseStatementResultSchema.parse({
    command: result.command,
    // Neon follows node-postgres and returns null for commands such as CREATE.
    // The capability contract exposes an always-numeric affected-row count.
    rowCount: result.rowCount ?? 0,
    rows,
  });
}

function translateDatabaseError(error: unknown): DatabaseBrokerError {
  if (error instanceof DatabaseBrokerError) return error;
  if (error instanceof Error && error.name === "ZodError") {
    return new DatabaseBrokerError(502, "database_execution_failed", false);
  }
  if (error instanceof DOMException && error.name === "AbortError") {
    return new DatabaseBrokerError(504, "database_timeout", true);
  }
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  const sqlstate = /^[0-9A-Z]{5}$/u.test(code) ? code : null;
  if (code === "57014") {
    return new DatabaseBrokerError(504, "database_timeout", true, sqlstate);
  }
  if (code === "23505") {
    return new DatabaseBrokerError(409, "database_conflict", false, sqlstate);
  }
  if (/^23/u.test(code)) {
    return new DatabaseBrokerError(409, "database_constraint_violation", false, sqlstate);
  }
  if (/^(22|42)/u.test(code)) {
    return new DatabaseBrokerError(400, "database_invalid_query", false, sqlstate);
  }
  if (/^(08|53|57P)/u.test(code)) {
    return new DatabaseBrokerError(503, "database_unavailable", true, sqlstate);
  }
  return new DatabaseBrokerError(502, "database_execution_failed", false, sqlstate);
}

export async function executeDatabaseCapability(
  connectionString: string,
  untrustedInput: unknown,
  options: { adapter?: DatabaseExecutionAdapter; timeoutMs?: number } = {},
): Promise<
  | { kind: "statement"; result: DatabaseStatementResult }
  | { kind: "atomic-batch"; results: DatabaseStatementResult[] }
> {
  validateConnectionString(connectionString);
  const parsedInput = databaseCapabilityInputSchema.safeParse(untrustedInput);
  if (!parsedInput.success) {
    throw new DatabaseBrokerError(400, "database_invalid_query", false);
  }
  const input: DatabaseCapabilityInput = parsedInput.data;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const adapter = options.adapter ?? neonExecutionAdapter;
    const result =
      input.kind === "statement"
        ? {
            kind: "statement" as const,
            result: sanitizedResult(
              await adapter.statement(
                connectionString,
                { sql: input.sql, params: input.params },
                controller.signal,
              ),
            ),
          }
        : {
            kind: "atomic-batch" as const,
            results: (
              await adapter.atomicBatch(connectionString, input.statements, controller.signal)
            ).map(sanitizedResult),
          };
    if (JSON.stringify(result).length > MAX_RESPONSE_BYTES) {
      throw new DatabaseBrokerError(502, "database_response_too_large", false);
    }
    return result;
  } catch (error) {
    throw translateDatabaseError(error);
  } finally {
    clearTimeout(timeout);
  }
}
