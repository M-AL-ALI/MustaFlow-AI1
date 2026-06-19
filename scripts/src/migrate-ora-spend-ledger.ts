/**
 * Migration: ora_spend_ledger table (Wave 1C — Durable Spend Ledger)
 *
 * Creates the aggregated daily spend ledger that backs Ora's in-memory
 * spend caps with restart-safe, durable storage. One row per
 * (date_key, ledger_key) is atomically upserted per request so the
 * API server can re-seed its in-memory Maps after a restart or deployment.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-ora-spend-ledger
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
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
    console.log("Migration complete: ora_spend_ledger table created");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
