/**
 * Migration: adds Task #545 SAST scanner toggle columns to `projects`.
 *
 *   scanner_hounddog_enabled BOOLEAN NOT NULL DEFAULT false
 *   scanner_trivy_enabled    BOOLEAN NOT NULL DEFAULT false
 *
 * Idempotent — safe to re-run. Uses ADD COLUMN IF NOT EXISTS.
 */
import { pool } from "@workspace/db";

async function main() {
  console.log("Adding scanner_hounddog_enabled / scanner_trivy_enabled to projects…");
  await pool.query(`
    ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS scanner_hounddog_enabled BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN IF NOT EXISTS scanner_trivy_enabled    BOOLEAN NOT NULL DEFAULT false;
  `);
  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
