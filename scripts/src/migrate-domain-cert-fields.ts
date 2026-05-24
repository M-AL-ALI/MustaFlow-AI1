/**
 * Migration: Add BYO cert fields to project_domains table (Task #554).
 *
 * Adds:
 *   ssl_source       TEXT NOT NULL DEFAULT 'cloudflare'
 *   byo_cert_expires_at TIMESTAMPTZ
 *   byo_cert_subject TEXT
 *
 * Safe to re-run — uses IF NOT EXISTS / DO NOTHING guards.
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE project_domains
        ADD COLUMN IF NOT EXISTS ssl_source TEXT NOT NULL DEFAULT 'cloudflare';
    `);

    await client.query(`
      ALTER TABLE project_domains
        ADD COLUMN IF NOT EXISTS byo_cert_expires_at TIMESTAMPTZ;
    `);

    await client.query(`
      ALTER TABLE project_domains
        ADD COLUMN IF NOT EXISTS byo_cert_subject TEXT;
    `);

    await client.query("COMMIT");
    console.log("Migration complete: BYO cert fields added to project_domains.");
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

void run();
