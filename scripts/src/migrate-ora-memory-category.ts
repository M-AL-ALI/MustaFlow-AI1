/**
 * Migration: Backfill `category` on existing Ora memories.
 *
 * Ora memories are `knowledge_entries` rows isolated by origin='ora' AND
 * scope='user'. Task #1371 introduces typed/categorized memories
 * (preference | personal | project | other, default 'other'). Newly saved
 * memories are auto-categorized at write time; this migration backfills the
 * rows that pre-date that change.
 *
 * The heuristic mirrors `artifacts/api-server/src/lib/ora-memory-category.ts`
 * (keyword presence on lowercased title+content). It is intentionally a coarse
 * SQL approximation — the goal is a sensible default, and users can always
 * re-categorize from the Memory Center.
 *
 * Idempotent: only touches Ora user-scoped rows whose category is still NULL or
 * the legacy default ('note'/'other'), so re-running won't clobber user choices.
 *
 * Run: pnpm --filter @workspace/scripts run migrate-ora-memory-category
 */

import { pool } from "@workspace/db";

async function run() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Single pass: classify by keyword presence, highest-priority match wins.
    // Order of CASE branches sets precedence when multiple match: preference,
    // then personal, then project, else 'other'.
    const result = await client.query(`
      UPDATE knowledge_entries
      SET category = CASE
        WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
          '(prefer|favorite|favourite|i like|i love|always use|never use|avoid|don''t|do not|tone|style|concise|verbose|formal|casual|dark mode|light mode|default to|colour|color|theme|font|format)'
          THEN 'preference'
        WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
          '(my name|name is|i am |i''m |i live|i work|based in|located in|email is|phone|birthday|i was born|pronoun|my job|my role|my title|my company|i have a|family|married|speak |native)'
          THEN 'personal'
        WHEN lower(coalesce(title,'') || ' ' || coalesce(content,'')) ~
          '(project|app called|building|website for|feature|deadline|tech stack|stack|database|deploy|client|customer|product|launch|repo|codebase|endpoint|integration)'
          THEN 'project'
        ELSE 'other'
      END
      WHERE origin = 'ora'
        AND scope = 'user'
        AND (category IS NULL OR category = 'note' OR category = 'other')
    `);

    await client.query("COMMIT");
    console.log(`✓ Backfilled category on ${result.rowCount ?? 0} Ora memory row(s)`);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void run();
