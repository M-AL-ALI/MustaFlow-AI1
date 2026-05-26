/**
 * Backfill: Set origin='zero' for pre-existing Zero-panel chat messages.
 *
 * Context
 * -------
 * Task #919 added `chat_messages.origin` (TEXT NULL). Going forward every
 * message sent from the Zero agent panel is stored with origin='zero'.
 * Messages created before that migration — or by any code path that didn't
 * set the field — remain NULL.
 *
 * Limitation
 * ----------
 * The chat_messages table has no field that reliably identifies whether a
 * historical NULL-origin message was sent from the Zero panel or from the
 * main builder chat.  Zero-panel messages and main-chat messages share the
 * same schema (role, content, agentMode, planMode, plan, attachments).
 * A blind "mark every NULL row as 'zero'" would incorrectly tag main-chat
 * history and pollute the Zero thread.
 *
 * Strategy
 * --------
 * Dry-run mode (default): reports per-project counts of NULL-origin messages
 * so you can decide which projects need manual backfill.
 *
 * Targeted commit mode (--commit --project-id=<N>[,<M>,...]):
 *   Sets origin='zero' only on the specified project(s).  Use this when you
 *   know a project's entire message history came from the Zero panel (e.g. a
 *   project created before the origin column shipped that was exclusively used
 *   via Zero).
 *
 * Usage
 * -----
 *   # Dry run — see how many rows are affected per project
 *   pnpm --filter @workspace/scripts run backfill-message-origin
 *
 *   # Target specific projects (dry-run first, then add --commit)
 *   pnpm --filter @workspace/scripts run backfill-message-origin -- --project-id=42,99
 *   pnpm --filter @workspace/scripts run backfill-message-origin -- --project-id=42,99 --commit
 *
 * Run: pnpm --filter @workspace/scripts run backfill-message-origin
 */

import { pool } from "@workspace/db";

function parseArgs() {
  const args = process.argv.slice(2);
  const commit = args.includes("--commit");
  const pidArg = args.find((a) => a.startsWith("--project-id="));
  const projectIds: number[] = pidArg
    ? pidArg
        .replace("--project-id=", "")
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n) && n > 0)
    : [];
  return { commit, projectIds };
}

async function run() {
  const { commit, projectIds } = parseArgs();

  const client = await pool.connect();
  try {
    // ── 1. Report current state ─────────────────────────────────────────────
    const statsResult = await client.query<{
      project_id: number;
      null_origin_count: string;
      zero_origin_count: string;
    }>(`
      SELECT
        project_id,
        COUNT(*) FILTER (WHERE origin IS NULL)  AS null_origin_count,
        COUNT(*) FILTER (WHERE origin = 'zero') AS zero_origin_count
      FROM chat_messages
      GROUP BY project_id
      HAVING COUNT(*) FILTER (WHERE origin IS NULL) > 0
      ORDER BY null_origin_count DESC
    `);

    const rows = statsResult.rows;

    if (rows.length === 0) {
      console.log("No chat_messages rows with NULL origin found. Nothing to do.");
      return;
    }

    const totalNull = rows.reduce((s, r) => s + parseInt(r.null_origin_count, 10), 0);
    const totalProjects = rows.length;

    console.log(
      `\nFound ${totalNull} NULL-origin message(s) across ${totalProjects} project(s):\n`,
    );
    console.log(
      `${"project_id".padEnd(12)} ${"null_origin".padEnd(14)} ${"zero_origin".padEnd(12)}`,
    );
    console.log("-".repeat(40));
    for (const r of rows) {
      console.log(
        `${String(r.project_id).padEnd(12)} ${r.null_origin_count.padEnd(14)} ${r.zero_origin_count.padEnd(12)}`,
      );
    }
    console.log();

    // ── 2. Dry-run: no --commit flag ────────────────────────────────────────
    if (!commit) {
      if (projectIds.length > 0) {
        const targeted = rows.filter((r) => projectIds.includes(r.project_id));
        const targetNull = targeted.reduce((s, r) => s + parseInt(r.null_origin_count, 10), 0);
        console.log(
          `DRY RUN — would mark ${targetNull} NULL-origin message(s) as origin='zero' ` +
            `in project(s): ${projectIds.join(", ")}`,
        );
      } else {
        console.log(
          "DRY RUN — pass --commit --project-id=<N>[,<M>,...] to update specific projects.\n" +
            "WARNING: Only target projects whose entire message history came from the\n" +
            "Zero panel. Setting origin='zero' on main-chat messages will pollute the\n" +
            "Zero thread view.",
        );
      }
      console.log('\nRerun with "--commit" to apply changes.');
      return;
    }

    // ── 3. Commit mode requires --project-id ────────────────────────────────
    if (projectIds.length === 0) {
      console.error(
        "ERROR: --commit requires --project-id=<N>[,<M>,...]\n" +
          "Refusing to blindly update all projects — see script header for rationale.",
      );
      process.exit(1);
    }

    // Validate that all specified project IDs actually appear in the stats
    const affectedProjectIds = new Set(rows.map((r) => r.project_id));
    const notFound = projectIds.filter((id) => !affectedProjectIds.has(id));
    if (notFound.length > 0) {
      console.log(
        `Note: project(s) ${notFound.join(", ")} have no NULL-origin messages — skipping.`,
      );
    }

    const toUpdate = projectIds.filter((id) => affectedProjectIds.has(id));
    if (toUpdate.length === 0) {
      console.log("Nothing to update.");
      return;
    }

    // ── 4. Apply backfill ───────────────────────────────────────────────────
    await client.query("BEGIN");

    const result = await client.query<{ count: string }>(
      `
      UPDATE chat_messages
         SET origin = 'zero'
       WHERE origin IS NULL
         AND project_id = ANY($1::int[])
      RETURNING id
      `,
      [toUpdate],
    );

    await client.query("COMMIT");

    console.log(
      `✓ Backfilled ${result.rowCount ?? 0} message(s) with origin='zero' ` +
        `for project(s): ${toUpdate.join(", ")}`,
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("Backfill failed:", err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

void run();
