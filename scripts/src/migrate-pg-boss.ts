/**
 * pg-boss schema initialisation helper.
 *
 * pg-boss manages its own DB schema (pgboss.*) — it auto-creates on first
 * start. This script is provided as a convenience to pre-create the schema
 * before the first server boot (e.g. during a cold deploy).
 *
 * Run: pnpm --filter @workspace/scripts run migrate-pg-boss
 */
import { PgBoss } from "pg-boss";

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL not set — cannot initialise pg-boss schema");
    process.exit(1);
  }

  console.log("Initialising pg-boss schema…");
  const boss = new PgBoss({ connectionString });
  await boss.start();
  console.log("pg-boss schema ready.");
  await boss.stop();
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
