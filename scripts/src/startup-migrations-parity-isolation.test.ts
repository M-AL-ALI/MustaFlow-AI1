import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ParityIsolationError,
  type ParityIsolationConnector,
  runParityIsolation,
} from "./startup-migrations-parity-isolation";

function connectorThatMustNotRun(): ParityIsolationConnector {
  return {
    async setup() {
      throw new Error("connector_was_touched");
    },
    async check() {
      throw new Error("connector_was_touched");
    },
    async teardown() {
      throw new Error("connector_was_touched");
    },
  };
}

async function expectRefusal(
  environment: Record<string, string | undefined>,
  expectedCode: ParityIsolationError["code"],
  expectedDatabaseName: string,
): Promise<void> {
  const lines: string[] = [];
  await assert.rejects(
    () =>
      runParityIsolation({
        environment,
        connector: connectorThatMustNotRun(),
        log: (line) => lines.push(line),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ParityIsolationError);
      assert.equal(error.code, expectedCode);
      assert.equal(error.databaseName, expectedDatabaseName);
      return true;
    },
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0], new RegExp(expectedCode));
  assert.ok(lines[0].includes(`dbname=${expectedDatabaseName}`));
}

describe("startup-migrations parity isolation", () => {
  it("does not let an ambient DATABASE_URL enable the runner", async () => {
    await expectRefusal(
      { DATABASE_URL: "postgresql://user:secret@prod.example/neondb" },
      "parity_database_url_missing",
      "<missing>",
    );
  });

  for (const [name, url, code, databaseName] of [
    [
      "serving database",
      "postgresql://user:secret@prod.example/neondb",
      "parity_database_name_refused",
      "neondb",
    ],
    [
      "development database",
      "postgresql://user:secret@dev.example/heliumdb",
      "parity_database_name_refused",
      "heliumdb",
    ],
    [
      "empty database name",
      "postgresql://user:secret@dev.example/",
      "parity_database_name_missing",
      "<missing>",
    ],
    ["malformed DSN", "not-a-postgres-url", "parity_database_url_malformed", "<unavailable>"],
  ] as const) {
    it(`refuses ${name} before connecting`, async () => {
      await expectRefusal({ PARITY_TEST_DATABASE_URL: url }, code, databaseName);
    });
  }

  it("passes the validated scratch scope through setup, check, and teardown", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    const connector: ParityIsolationConnector = {
      async setup(target) {
        calls.push(`setup:${target.host}:${target.databaseName}`);
      },
      async check(target) {
        calls.push(`check:${target.host}:${target.databaseName}`);
      },
      async teardown(target) {
        calls.push(`teardown:${target.host}:${target.databaseName}`);
      },
    };

    await runParityIsolation({
      environment: {
        DATABASE_URL: "postgresql://ignored:ignored@prod.example/neondb",
        PARITY_TEST_DATABASE_URL:
          "postgresql://scratch_user:scratch_secret@scratch.dev.example/parity_scratch_run1",
      },
      connector,
      log: (line) => lines.push(line),
    });

    assert.deepEqual(calls, [
      "setup:scratch.dev.example:parity_scratch_run1",
      "check:scratch.dev.example:parity_scratch_run1",
      "teardown:scratch.dev.example:parity_scratch_run1",
    ]);
    assert.equal(lines.length, 5);
    for (const line of lines) {
      assert.ok(line.includes("host=scratch.dev.example"));
      assert.ok(line.includes("dbname=parity_scratch_run1"));
      assert.ok(!line.includes("scratch_user"));
      assert.ok(!line.includes("scratch_secret"));
      assert.ok(!line.includes("ignored"));
    }
  });

  it("tears down the scratch scope after a failed check", async () => {
    const calls: string[] = [];
    const connector: ParityIsolationConnector = {
      async setup() {
        calls.push("setup");
      },
      async check() {
        calls.push("check");
        throw new Error("simulated_check_failure");
      },
      async teardown() {
        calls.push("teardown");
      },
    };

    await assert.rejects(
      () =>
        runParityIsolation({
          environment: {
            PARITY_TEST_DATABASE_URL: "postgresql://user:secret@scratch.dev.example/parity_scratch",
          },
          connector,
          log: () => undefined,
        }),
      (error: unknown) => {
        assert.ok(error instanceof ParityIsolationError);
        assert.equal(error.code, "parity_check_failed");
        return true;
      },
    );
    assert.deepEqual(calls, ["setup", "check", "teardown"]);
  });
});
