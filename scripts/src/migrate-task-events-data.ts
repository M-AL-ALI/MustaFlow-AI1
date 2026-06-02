/**
 * Preview Sync Pipeline — adds `data jsonb` to task_events.
 *
 * The data column carries structured event payloads (e.g. project_files_changed
 * with files, changedPaths, removedPaths, requiresInstall, requiresRestart).
 * Replayed SSE events include this payload so the frontend can apply incremental
 * FS sync even after the panel was closed during the build.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-task-events-data
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(`
      ALTER TABLE task_events
        ADD COLUMN IF NOT EXISTS data JSONB
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_task_events_data_type
        ON task_events ((data->>'eventType'))
        WHERE data IS NOT NULL
    `);

    await client.query("COMMIT");
    console.log("task_events data migration complete.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
