// Drops the orphaned `conversations` table.
// The schema definition has been removed from lib/db/src/schema/conversations.ts.
// Run with: pnpm --filter @workspace/scripts run migrate-drop-conversations

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("DROP TABLE IF EXISTS conversations");
    console.log("conversations table dropped (or did not exist).");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
