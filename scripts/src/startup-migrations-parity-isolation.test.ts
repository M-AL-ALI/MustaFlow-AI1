import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";
import {
  ParityIsolationError,
  type ParityIsolationConnector,
  type ParityProofConnector,
  assertHonestLayerOneReceipt,
  assertToleratedMigrationResult,
  relayChildOutput,
  runParityIsolation,
  runThreeProofParity,
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

  it("bootstraps before idempotency and runs the restore probe last", async () => {
    const calls: string[] = [];
    const lines: string[] = [];
    let materializationRun = 0;
    let migrationRun = 0;
    const connector: ParityProofConnector = {
      async provisionExtensions() {
        calls.push("extensions:vector");
        return ["vector"];
      },
      async materializeBase() {
        materializationRun++;
        calls.push(`materialize:${materializationRun}`);
        return { objectCount: 137, sentinelPresent: true, stdout: "schema pushed\n", stderr: "" };
      },
      async runMigrations() {
        migrationRun++;
        calls.push(`migrate:${migrationRun}`);
        return { migrationCount: 145 };
      },
      async captureSchema() {
        calls.push(`capture:${migrationRun}`);
        return ["relation:public.projects", "column:public.projects.id"];
      },
      async dropRestoreProbeColumn() {
        calls.push("drop-restore-column");
      },
      async hasRestoreProbeColumn() {
        calls.push("verify-restore-column");
        return true;
      },
      async close() {
        calls.push("close");
      },
    };

    await runThreeProofParity({
      target: {
        connectionString: "postgresql://user:secret@scratch.dev.example/parity_scratch_order",
        host: "scratch.dev.example",
        databaseName: "parity_scratch_order",
      },
      connector,
      log: (line) => lines.push(line),
    });

    assert.deepEqual(calls, [
      "extensions:vector",
      "materialize:1",
      "migrate:1",
      "capture:1",
      "materialize:2",
      "migrate:2",
      "capture:2",
      "drop-restore-column",
      "migrate:3",
      "verify-restore-column",
      "close",
    ]);
    assert.ok(lines.some((line) => line.includes("parity_layer0_extension_pass")));
    assert.ok(lines.some((line) => line.includes("parity_layer1_materialize_pass")));
    assert.ok(lines.some((line) => line.includes("expected_object_count=TODO_PHASE_2_4")));
    assert.ok(lines.some((line) => line.includes("parity_layer2_migrations_pass")));
    assert.ok(lines.some((line) => line.includes("parity_construction_pass")));
    assert.ok(lines.some((line) => line.includes("diff_count=0")));
    assert.ok(lines.some((line) => line.includes("parity_restore_probe_pass")));
    assert.ok(lines.every((line) => !line.includes("user")));
    assert.ok(lines.every((line) => !line.includes("secret")));
  });

  it("rejects an exit-zero layer-one child whose stderr contains a PostgreSQL error", async () => {
    const calls: string[] = [];
    const connector: ParityProofConnector = {
      async provisionExtensions() {
        calls.push("extensions");
        return ["vector"];
      },
      async materializeBase() {
        calls.push("materialize");
        return {
          objectCount: 23,
          sentinelPresent: false,
          stdout: "pull complete\n",
          stderr: 'error: type "vector" does not exist\n',
        };
      },
      async runMigrations() {
        calls.push("migrate");
        return { migrationCount: 145 };
      },
      async captureSchema() {
        return [];
      },
      async dropRestoreProbeColumn() {},
      async hasRestoreProbeColumn() {
        return false;
      },
      async close() {
        calls.push("close");
      },
    };

    await assert.rejects(
      () =>
        runThreeProofParity({
          target: {
            connectionString: "postgresql://user:secret@scratch.dev.example/parity_scratch_error",
            host: "scratch.dev.example",
            databaseName: "parity_scratch_error",
          },
          connector,
          log: () => undefined,
        }),
      /parity_layer1_output_error.*type.*vector/u,
    );
    assert.deepEqual(calls, ["extensions", "materialize", "close"]);
  });

  it("requires the layer-one sentinel and enforces a numeric object-count pin", () => {
    assert.throws(
      () =>
        assertHonestLayerOneReceipt({
          objectCount: 137,
          sentinelPresent: false,
          stdout: "schema pushed\n",
          stderr: "",
        }),
      /parity_layer1_sentinel_missing/u,
    );
    assert.throws(
      () =>
        assertHonestLayerOneReceipt(
          {
            objectCount: 137,
            sentinelPresent: true,
            stdout: "schema pushed\n",
            stderr: "",
          },
          138,
        ),
      /parity_layer1_object_count_mismatch expected=138 actual=137/u,
    );
  });

  it("accepts only the exact tolerated startup-migration failure set", () => {
    assert.deepEqual(
      assertToleratedMigrationResult({
        passed: 144,
        failed: 1,
        errors: [
          {
            name: "migrate-workspace-tenancy",
            message: "legacy_adoption_owner_id_missing",
          },
        ],
      }),
      { migrationCount: 145 },
    );

    assert.throws(
      () =>
        assertToleratedMigrationResult({
          passed: 143,
          failed: 2,
          errors: [
            {
              name: "migrate-workspace-tenancy",
              message: "legacy_adoption_owner_id_missing",
            },
            { name: "migrate-other", message: "other_failure" },
          ],
        }),
      /parity_migrations_failed/u,
    );
    assert.throws(
      () =>
        assertToleratedMigrationResult({
          passed: 144,
          failed: 1,
          errors: [{ name: "migrate-other", message: "other_failure" }],
        }),
      /parity_migrations_failed/u,
    );
  });

  it("relays child stdout and stderr without suppressing either stream", () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];

    relayChildOutput(stdout, {
      write(chunk) {
        stdoutChunks.push(Buffer.from(chunk).toString("utf8"));
      },
    });
    relayChildOutput(stderr, {
      write(chunk) {
        stderrChunks.push(Buffer.from(chunk).toString("utf8"));
      },
    });

    stdout.emit("data", Buffer.from("migration receipt\n"));
    stderr.emit("data", Buffer.from("underlying failure stack\n"));

    assert.deepEqual(stdoutChunks, ["migration receipt\n"]);
    assert.deepEqual(stderrChunks, ["underlying failure stack\n"]);
  });
});
