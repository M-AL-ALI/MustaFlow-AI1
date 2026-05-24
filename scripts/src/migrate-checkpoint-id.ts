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
  console.log("Done.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
