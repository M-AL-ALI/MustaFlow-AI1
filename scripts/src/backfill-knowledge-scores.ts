/**
 * backfill-knowledge-scores.ts
 *
 * One-shot script that reviews existing Knowledge Vault entries and auto-approves
 * high-signal, project-agnostic lessons for cross-project reuse based on
 * deterministic, privacy-safe rules:
 *
 *   ELIGIBLE (auto-approved):
 *   - severity = "error" AND type IN ("build", "refine")
 *     Rationale: build/refine errors encode repeatable code-quality or pattern
 *     mistakes that are valuable to other projects. Content is typically generic
 *     (e.g. "always wrap flex children with min-w-0") rather than project-specific.
 *
 *   NOT ELIGIBLE (skipped):
 *   - type = "rollback" — rollback entries often capture project-specific context
 *     (what the user was trying to do, which files changed) that should not leak
 *     cross-project. Leave these as project-scoped only.
 *   - type IN ("conversation_summary", "note", "secret_change", "secret_warning")
 *     — personal/sensitive context.
 *   - severity != "error" — lower-severity entries are too speculative for
 *     automatic global promotion; they can be promoted manually via the Vault UI.
 *   - entries already approved_for_reuse = true (idempotent — already done).
 *   - archived entries.
 *
 * Safe to re-run multiple times.
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run backfill-knowledge-scores
 */

import { pool } from "@workspace/db";

async function run(): Promise<void> {
  const client = await pool.connect();
  try {
    console.log("Knowledge Vault backfill: scanning entries...");

    // Count candidates before update
    const { rows: countRows } = await client.query<{ count: string }>(`
      SELECT COUNT(*)::text AS count
      FROM knowledge_entries
      WHERE approved_for_reuse = false
        AND archived_at IS NULL
        AND severity = 'error'
        AND type IN ('build', 'refine')
    `);
    const count = parseInt(countRows[0]?.count ?? "0", 10);
    console.log(`  Found ${count} high-signal build/refine error entries to auto-approve.`);

    if (count === 0) {
      console.log("  No entries needed updating. Done.");
      return;
    }

    // Bulk-update eligible entries only
    const { rowCount } = await client.query(`
      UPDATE knowledge_entries
      SET approved_for_reuse = true
      WHERE approved_for_reuse = false
        AND archived_at IS NULL
        AND severity = 'error'
        AND type IN ('build', 'refine')
    `);

    console.log(`  Marked ${rowCount ?? 0} entries as approved_for_reuse = true.`);
    console.log("Backfill complete.");
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err: unknown) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
