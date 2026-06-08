/**
 * Migration: recover misfiled Ora memories (Ora ↔ Builder isolation)
 *
 * Background: before the Ora save path was repointed to POST /api/ora/memories,
 * the Ora "Save to memory" chip, the opt-in auto-save, and the duplicate
 * "Ora Memories" section on the Style Memory page all POSTed to
 * /api/knowledge, which hardcodes origin="builder". So genuine Ora saves were
 * misfiled into the AI Builder Knowledge Vault — invisible to Ora and to the
 * Ora Memory Center, and (worse) eligible to leak back into builds.
 *
 * This migration re-tags those misfiled rows to origin="ora" so they reappear
 * in the Ora Memory Center and stay out of the Builder.
 *
 * Precise recovery filter (derived from what the buggy paths actually wrote —
 * type="note", category="note", scope="user", project_id NULL):
 *     scope      = 'user'
 *     origin     = 'builder'
 *     type       = 'note'
 *     project_id IS NULL
 *
 * EXCLUDED (legitimate Builder user-scope data — never touched):
 *     type = 'style_memory'  (brand profiles + inferred style memories)
 * The type='note' inclusion already excludes style_memory; the explicit
 * `type <> 'style_memory'` guard is belt-and-suspenders.
 *
 * Idempotent: after the first run the matched rows carry origin='ora', so they
 * no longer match the WHERE clause. Safe to re-run.
 *
 * Run with:
 *   pnpm --filter @workspace/scripts run migrate-recover-ora-memories
 */

import { pool } from "@workspace/db";

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rowCount } = await client.query(
      `UPDATE knowledge_entries
          SET origin = 'ora'
        WHERE scope = 'user'
          AND origin = 'builder'
          AND type = 'note'
          AND type <> 'style_memory'
          AND project_id IS NULL`,
    );

    await client.query("COMMIT");
    console.log(
      `Migration complete: recovered ${rowCount ?? 0} misfiled Ora memories (origin builder→ora)`,
    );
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
  }
}

await migrate();
