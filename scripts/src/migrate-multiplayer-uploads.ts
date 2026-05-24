/**
 * Migration (Task #540):
 *   1. Add projects.multiplayer_enabled boolean column (default false).
 *   2. Create project_uploads table for drag-drop file uploads.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-multiplayer-uploads
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`
      ALTER TABLE projects
      ADD COLUMN IF NOT EXISTS multiplayer_enabled boolean NOT NULL DEFAULT false
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS project_uploads (
        id            serial PRIMARY KEY,
        project_id    integer NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        uploader_id   text,
        filename      text NOT NULL,
        mime_type     text NOT NULL DEFAULT 'application/octet-stream',
        size_bytes    bigint NOT NULL DEFAULT 0,
        object_path   text NOT NULL,
        text_preview  text,
        created_at    timestamptz NOT NULL DEFAULT now()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS project_uploads_project_id_idx
      ON project_uploads(project_id)
    `);
    await client.query("COMMIT");
    console.log("multiplayer_enabled + project_uploads migration complete.");
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
