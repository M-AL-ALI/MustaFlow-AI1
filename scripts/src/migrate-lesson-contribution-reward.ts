/**
 * One-time migration: add knowledge_entries.contributor_rewarded_at column
 * for Task #688 (credit reward for highly-rated public library lessons).
 * Run: pnpm --filter @workspace/scripts run migrate-lesson-contribution-reward
 */
import { pool } from "@workspace/db";

async function main(): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `ALTER TABLE knowledge_entries
        ADD COLUMN IF NOT EXISTS contributor_rewarded_at timestamptz`,
    );
    await client.query("COMMIT");
    console.log("✓ knowledge_entries.contributor_rewarded_at column ready");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
