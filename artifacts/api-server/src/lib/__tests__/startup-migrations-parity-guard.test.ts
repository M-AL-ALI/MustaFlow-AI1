import { describe, expect, it, vi } from "vitest";
import { resolveDisposableStartupMigrationDatabase } from "./startup-migrations-parity-guard";

const databaseName = "mustaflow_parity_disposable_ab12cd34";
const testUrl = `postgresql://postgres:fixture@127.0.0.1:55432/${databaseName}`;
const explicit = {
  ALLOW_DESTRUCTIVE_STARTUP_MIGRATIONS_PARITY: "1",
  TEST_DATABASE_URL: testUrl,
};

describe("destructive startup migration parity guard", () => {
  it("ignores ambient DATABASE_URL without ever selecting a database", () => {
    for (const DATABASE_URL of [testUrl, "postgresql://user:secret@production.example/app"]) {
      expect(resolveDisposableStartupMigrationDatabase({ DATABASE_URL })).toBeNull();
      expect(
        resolveDisposableStartupMigrationDatabase({
          DATABASE_URL,
          TEST_DATABASE_URL: testUrl,
        }),
      ).toBeNull();
    }
  });

  it.each([undefined, "", "0", "true", "yes"])("requires exact affirmative opt-in: %s", (optIn) => {
    expect(
      resolveDisposableStartupMigrationDatabase({
        TEST_DATABASE_URL: testUrl,
        ALLOW_DESTRUCTIVE_STARTUP_MIGRATIONS_PARITY: optIn,
      }),
    ).toBeNull();
  });

  it("does not fall back to an ambient URL even with affirmative opt-in", () => {
    expect(() =>
      resolveDisposableStartupMigrationDatabase({
        ALLOW_DESTRUCTIVE_STARTUP_MIGRATIONS_PARITY: "1",
        DATABASE_URL: testUrl,
      }),
    ).toThrow("startup_migrations_parity_disposable_database_required");
  });

  it("selects only the explicitly supplied dedicated local database", () => {
    expect(
      resolveDisposableStartupMigrationDatabase({
        ...explicit,
        DATABASE_URL: "postgresql://user:secret@production.example/app",
      }),
    ).toEqual({ connectionString: testUrl });
    expect(
      resolveDisposableStartupMigrationDatabase({
        ...explicit,
        TEST_DATABASE_URL: testUrl.replace("127.0.0.1", "[::1]"),
      }),
    ).toEqual({ connectionString: testUrl.replace("127.0.0.1", "[::1]") });
  });

  it.each([
    "postgresql://user:secret@production.example:5432/app",
    `postgresql://user:secret@production.example:5432/${databaseName}`,
    `postgresql://user:secret@ep-production.neon.tech:5432/${databaseName}`,
    `postgresql://user:secret@production.replit.dev:5432/${databaseName}`,
    "postgresql://postgres:fixture@127.0.0.1:55432/production",
    "postgresql://postgres:fixture@127.0.0.1:55432/postgres",
    "postgresql://postgres:fixture@127.0.0.1:55432/template1",
    testUrl.replace(":55432", ""),
    testUrl.replace("127.0.0.1", "localhost"),
    testUrl.replace("postgres:fixture@", ""),
    testUrl.replace(databaseName, "mustaflow_parity_disposable_short"),
    testUrl.replace("postgresql:", "https:"),
    testUrl + "?host=production.replit.dev",
    testUrl + "?options=-csearch_path%3Dproduction",
    testUrl + "#production",
    "not-a-connection-url",
  ])("rejects unsafe targets before a pool can be created", (TEST_DATABASE_URL) => {
    const createPool = vi.fn();
    expect(() => {
      const target = resolveDisposableStartupMigrationDatabase({ ...explicit, TEST_DATABASE_URL });
      if (target) createPool({ connectionString: target.connectionString });
    }).toThrow("startup_migrations_parity_unsafe_database_target");
    expect(createPool).not.toHaveBeenCalled();
  });

  it.each([
    testUrl,
    testUrl.replace("127.0.0.1", "localhost").replace("postgres:fixture", "other:different"),
    testUrl.replace("127.0.0.1", "[::1]"),
  ])(
    "rejects the ambient database identity regardless of credentials or loopback alias",
    (DATABASE_URL) => {
      expect(() =>
        resolveDisposableStartupMigrationDatabase({ ...explicit, DATABASE_URL }),
      ).toThrow("startup_migrations_parity_ambient_database_forbidden");
    },
  );

  it.each([{ NODE_ENV: "production" }, { REPL_ID: "fixture" }, { REPLIT_DEPLOYMENT: "1" }])(
    "rejects production and Replit execution contexts",
    (environment) => {
      expect(() =>
        resolveDisposableStartupMigrationDatabase({ ...explicit, ...environment }),
      ).toThrow("startup_migrations_parity_production_environment_forbidden");
    },
  );
});
