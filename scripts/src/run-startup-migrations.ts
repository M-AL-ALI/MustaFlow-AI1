import { resolveVitestDatabaseUrl } from "../../artifacts/api-server/vitest.database";

const EXPECTED_STARTUP_MIGRATION_COUNT = 158;

async function main(): Promise<void> {
  const approvedDatabaseUrl = resolveVitestDatabaseUrl(process.env);
  if (!approvedDatabaseUrl) {
    throw new Error("NABUFLOW_VITEST_DATABASE_URL is required for startup migration convergence");
  }
  if (process.env.DATABASE_URL && process.env.DATABASE_URL !== approvedDatabaseUrl) {
    throw new Error("DATABASE_URL must exactly match the approved disposable database URL");
  }

  // Configure the shared pool only after the loopback/disposable guard passes.
  process.env.DATABASE_URL = approvedDatabaseUrl;
  const [{ runStartupMigrations }, { pool }] = await Promise.all([
    import("../../artifacts/api-server/src/lib/startup-migrations"),
    import("@workspace/db"),
  ]);

  try {
    const result = await runStartupMigrations();
    const database = decodeURIComponent(new URL(approvedDatabaseUrl).pathname.slice(1));
    process.stdout.write(
      `${JSON.stringify({
        kind: "startup-migration-convergence",
        database,
        expected: EXPECTED_STARTUP_MIGRATION_COUNT,
        passed: result.passed,
        failed: result.failed,
        errors: result.errors,
      })}\n`,
    );
    if (
      result.failed !== 0 ||
      result.passed !== EXPECTED_STARTUP_MIGRATION_COUNT ||
      result.errors.length !== 0
    ) {
      throw new Error("startup migration convergence failed or its reviewed count changed");
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error("startup migration convergence failed:", error);
  process.exitCode = 1;
});
