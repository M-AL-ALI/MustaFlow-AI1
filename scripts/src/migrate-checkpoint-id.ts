import { pool } from "@workspace/db";

async function main() {
  console.log("Adding checkpoint_id column to chat_messages…");
  await pool.query(`
    ALTER TABLE chat_messages
    ADD COLUMN IF NOT EXISTS checkpoint_id integer
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS chat_messages_checkpoint_id_idx
    ON chat_messages (checkpoint_id)
    WHERE checkpoint_id IS NOT NULL
  `);
  console.log("Adding FK chat_messages.checkpoint_id → project_versions.id (set null on delete)…");
  await pool.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'chat_messages_checkpoint_id_fkey'
      ) THEN
        ALTER TABLE chat_messages
          ADD CONSTRAINT chat_messages_checkpoint_id_fkey
          FOREIGN KEY (checkpoint_id) REFERENCES project_versions(id) ON DELETE SET NULL;
      END IF;
    END $$;
  `);
  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
