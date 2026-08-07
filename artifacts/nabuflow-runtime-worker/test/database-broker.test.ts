import type { FullQueryResults } from "@neondatabase/serverless";
import { describe, expect, it, vi } from "vitest";
import {
  DatabaseBrokerError,
  executeDatabaseCapability,
  type DatabaseExecutionAdapter,
} from "../src/database-broker";

const TEST_CONNECTION =
  "postgresql://slice_user:staging-password@ep-db-broker.us-east-2.aws.neon.tech/slice_db?sslmode=require";

function result(
  command: string,
  rowCount: number,
  rows: Array<Record<string, unknown>>,
): FullQueryResults<false> {
  return { command, rowCount, rows, fields: [], rowAsArray: false };
}

describe("database broker", () => {
  it("executes parameterized statements and returns only sanitized result metadata", async () => {
    const adapter: DatabaseExecutionAdapter = {
      statement: vi.fn(async (_connection, statement) => {
        expect(statement).toEqual({ sql: "select $1::text as value", params: ["hello"] });
        return result("SELECT", 1, [{ value: "hello" }]);
      }),
      atomicBatch: vi.fn(),
    };
    await expect(
      executeDatabaseCapability(
        TEST_CONNECTION,
        { kind: "statement", sql: "select $1::text as value", params: ["hello"] },
        { adapter },
      ),
    ).resolves.toEqual({
      kind: "statement",
      result: { command: "SELECT", rowCount: 1, rows: [{ value: "hello" }] },
    });
  });

  it("normalizes successful DDL's null row count to the numeric contract", async () => {
    const adapter: DatabaseExecutionAdapter = {
      statement: vi.fn(
        async () =>
          ({
            command: "CREATE",
            rowCount: null,
            rows: [],
            fields: [],
            rowAsArray: false,
          }) as unknown as FullQueryResults<false>,
      ),
      atomicBatch: vi.fn(),
    };
    await expect(
      executeDatabaseCapability(
        TEST_CONNECTION,
        { kind: "statement", sql: "create table items(id integer)", params: [] },
        { adapter },
      ),
    ).resolves.toEqual({
      kind: "statement",
      result: { command: "CREATE", rowCount: 0, rows: [] },
    });
  });

  it("submits an atomic batch through one adapter transaction", async () => {
    const adapter: DatabaseExecutionAdapter = {
      statement: vi.fn(),
      atomicBatch: vi.fn(async (_connection, statements) => {
        expect(statements).toHaveLength(2);
        return [result("INSERT", 1, []), result("SELECT", 1, [{ count: "1" }])];
      }),
    };
    await expect(
      executeDatabaseCapability(
        TEST_CONNECTION,
        {
          kind: "atomic-batch",
          statements: [
            { sql: "insert into items(value) values ($1)", params: ["one"] },
            { sql: "select count(*)::text as count from items", params: [] },
          ],
        },
        { adapter },
      ),
    ).resolves.toMatchObject({
      kind: "atomic-batch",
      results: [
        { command: "INSERT", rowCount: 1 },
        { command: "SELECT", rows: [{ count: "1" }] },
      ],
    });
    expect(adapter.atomicBatch).toHaveBeenCalledOnce();
  });

  it("rejects non-Neon hosts before an outbound fetch can occur", async () => {
    const statement = vi.fn();
    await expect(
      executeDatabaseCapability(
        "postgresql://user:password@database.attacker.example/db",
        { kind: "statement", sql: "select 1", params: [] },
        { adapter: { statement, atomicBatch: vi.fn() } },
      ),
    ).rejects.toMatchObject({ code: "database_unavailable", retryable: true });
    expect(statement).not.toHaveBeenCalled();
  });

  it("translates SQLSTATE errors without exposing raw database details", async () => {
    const sensitive =
      "postgresql://slice_user:staging-password@ep-db-broker.us-east-2.aws.neon.tech/slice_db";
    const adapter: DatabaseExecutionAdapter = {
      statement: vi.fn(async () => {
        throw Object.assign(new Error(`relation missing via ${sensitive}`), { code: "42P01" });
      }),
      atomicBatch: vi.fn(),
    };
    let caught: unknown;
    try {
      await executeDatabaseCapability(
        TEST_CONNECTION,
        { kind: "statement", sql: "select * from missing", params: [] },
        { adapter },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DatabaseBrokerError);
    expect(caught).toMatchObject({
      status: 400,
      code: "database_invalid_query",
      retryable: false,
      sqlstate: "42P01",
    });
    expect(JSON.stringify(caught)).not.toContain(sensitive);
  });

  it("enforces row and timeout bounds", async () => {
    const tooManyRows: DatabaseExecutionAdapter = {
      statement: vi.fn(async () =>
        result(
          "SELECT",
          101,
          Array.from({ length: 101 }, (_value, id) => ({ id })),
        ),
      ),
      atomicBatch: vi.fn(),
    };
    await expect(
      executeDatabaseCapability(
        TEST_CONNECTION,
        { kind: "statement", sql: "select id from large_table", params: [] },
        { adapter: tooManyRows },
      ),
    ).rejects.toMatchObject({ code: "database_response_too_large" });

    const timesOut: DatabaseExecutionAdapter = {
      statement: vi.fn(
        async (_connection, _statement, signal) =>
          new Promise<FullQueryResults<false>>((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
      atomicBatch: vi.fn(),
    };
    await expect(
      executeDatabaseCapability(
        TEST_CONNECTION,
        { kind: "statement", sql: "select pg_sleep(10)", params: [] },
        { adapter: timesOut, timeoutMs: 1 },
      ),
    ).rejects.toMatchObject({ code: "database_timeout", retryable: true });
  });
});
