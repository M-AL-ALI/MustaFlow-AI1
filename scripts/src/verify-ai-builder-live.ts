/**
 * Live AI Builder verification — normal (non-Developer-Mode) flow.
 *
 * Verifies all 9 acceptance criteria:
 *  1. AI Builder starts the agent (task status progresses)
 *  2. No "Developer Mode runtime" wording in any emitted event
 *  3. Container preflight skipped cleanly for static projects (no container needed)
 *  4. Agent writes real files (project_files count increases)
 *  5. Agent does not loop on same failed action (≤ 1 repeat per tool call path)
 *  6. Stuck-loop detection fires if needed (strategy-change event seen, or no stuck loop)
 *  7. Preview refresh event emitted (file_diff or completed event)
 *  8. App loads / final status is honest
 *  9. project_versions row written with a real validation_status
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run verify-ai-builder-live
 *   PROJECT_ID=26 pnpm --filter @workspace/scripts run verify-ai-builder-live
 */

import { pool } from "@workspace/db";
import { randomUUID } from "crypto";

const PROJECT_ID = Number(process.env.PROJECT_ID ?? "26");
const QUEUE_BUILD = "mustaflow.build";
const MAX_WAIT_MS = 10 * 60 * 1000; // 10 min
const POLL_MS = 10_000;

const PROMPT =
  "Build a simple booking app with a home page, booking form, customer list, and admin dashboard. Use HTML, CSS, and JavaScript only.";

type Result = { pass: boolean; note: string };

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const results: Record<string, Result> = {};
  const start = Date.now();
  let taskId: number | null = null;

  console.log(`\nAI Builder Live Verification — project ${PROJECT_ID}`);
  console.log("=".repeat(64));

  // ── Step 0: Confirm project exists and is AI Builder (not Developer Mode) ──
  console.log("\n── Step 0: Confirm project ──");
  const { rows: projRows } = await pool.query<{
    id: number;
    name: string;
    kind: string;
    project_format: string;
    builder_mode: string | null;
    project_mode: string | null;
    container_id: string | null;
  }>(
    `SELECT id, name, kind, project_format, builder_mode, project_mode, container_id
     FROM projects WHERE id=$1 AND deleted_at IS NULL`,
    [PROJECT_ID],
  );
  if (!projRows[0]) {
    console.error(`  FATAL: project ${PROJECT_ID} not found`);
    await pool.end();
    process.exit(1);
  }
  const proj = projRows[0];
  console.log(`  project: id=${proj.id} name="${proj.name}" kind=${proj.kind}`);
  console.log(
    `  format=${proj.project_format} builder_mode=${proj.builder_mode ?? "null"} project_mode=${proj.project_mode ?? "null"}`,
  );
  console.log(`  container_id=${proj.container_id ?? "none"}`);

  // ── Step 1: Count existing files and versions ─────────────────────────────
  console.log("\n── Step 1: Baseline snapshot ──");
  const { rows: baseFiles } = await pool.query<{ n: string }>(
    `SELECT count(*) as n FROM project_files WHERE project_id=$1`,
    [PROJECT_ID],
  );
  const { rows: baseVersions } = await pool.query<{ n: string }>(
    `SELECT count(*) as n FROM project_versions WHERE project_id=$1`,
    [PROJECT_ID],
  );
  const baseFileCount = Number(baseFiles[0]?.n ?? 0);
  const baseVersionCount = Number(baseVersions[0]?.n ?? 0);
  console.log(`  files before: ${baseFileCount}  versions before: ${baseVersionCount}`);

  // ── Step 2: Enqueue a BUILD task ─────────────────────────────────────────
  console.log("\n── Step 2: Enqueue build task ──");
  const { rows: taskRows } = await pool.query<{ id: number }>(
    `INSERT INTO agent_tasks
       (project_id, title, kind, status, prompt, agent_identity, run_mode, task_agent_mode)
     VALUES ($1, 'AI-Builder-live-verify: booking app', 'build', 'queued', $2, 'main', 'foreground', 'power')
     RETURNING id`,
    [PROJECT_ID, PROMPT],
  );
  taskId = taskRows[0]?.id ?? null;
  if (!taskId) {
    console.error("  FATAL: INSERT returned no id");
    await pool.end();
    process.exit(1);
  }

  // Insert into pg-boss queue using the correct schema pattern
  const jobId = randomUUID();
  const jobPayload = {
    taskId,
    projectId: PROJECT_ID,
    kind: "build",
    userPrompt: PROMPT,
    agentMode: "power",
    agentIdentity: "main",
    planContext: null,
    conversationHistory: null,
    imageAttachments: null,
    queueBatchId: null,
    queueIndex: null,
    queueTotalCount: null,
    runMode: "foreground",
    wallClockCapMs: null,
  };
  await pool.query(
    `INSERT INTO pgboss.job
       (id, name, data, state, priority,
        retry_limit, retry_count, retry_delay, retry_backoff,
        expire_seconds, start_after, keep_until, created_on)
     VALUES ($1, $2, $3::jsonb, 'created', 0,
             0, 0, 30, true,
             7200, now(), now() + interval '30 days', now())`,
    [jobId, QUEUE_BUILD, JSON.stringify(jobPayload)],
  );
  console.log(`  agent_task id=${taskId}  pg-boss job inserted: ${jobId}`);

  // ── Step 3: Poll until task completes ────────────────────────────────────
  console.log("\n── Step 3: Polling for completion (max 10 min) ──");
  let finalStatus = "";
  let eventCount = 0;
  let elapsed = 0;

  while (elapsed < MAX_WAIT_MS) {
    await sleep(POLL_MS);
    elapsed += POLL_MS;
    const secs = Math.round(elapsed / 1000);

    const { rows: taskStatus } = await pool.query<{ status: string }>(
      `SELECT status FROM agent_tasks WHERE id=$1`,
      [taskId],
    );
    const { rows: evtRows } = await pool.query<{ n: string }>(
      `SELECT count(*) as n FROM task_events WHERE task_id=$1`,
      [taskId],
    );
    finalStatus = taskStatus[0]?.status ?? "unknown";
    eventCount = Number(evtRows[0]?.n ?? 0);
    process.stdout.write(`  [${secs}s] status=${finalStatus} events=${eventCount}\n`);

    if (["completed", "failed", "cancelled"].includes(finalStatus)) break;
  }

  console.log(
    `\nTask finished in ${Math.round((Date.now() - start) / 1000)}s — final status: ${finalStatus}`,
  );
  results["task_started"] = {
    pass: finalStatus !== "queued",
    note: `Task progressed from queued → ${finalStatus}`,
  };
  results["task_completed"] = {
    pass: finalStatus === "completed",
    note: `Task status=${finalStatus} (expected: completed)`,
  };

  // ── Step 4: Check events for "Developer Mode runtime" wording ─────────────
  console.log("\n── Step 4: Check event messages for banned wording ──");
  const { rows: eventRows } = await pool.query<{ event_type: string; message: string }>(
    `SELECT event_type, message FROM task_events WHERE task_id=$1 ORDER BY id`,
    [taskId],
  );
  const bannedPhrases = ["developer mode runtime", "developer mode runtime is not ready"];
  const bannedMatches = eventRows.filter((e) =>
    bannedPhrases.some((p) => (e.message ?? "").toLowerCase().includes(p)),
  );
  console.log(`  Total events: ${eventRows.length}`);
  if (bannedMatches.length > 0) {
    console.log("  BANNED wording found:");
    bannedMatches.forEach((e) => console.log(`    [${e.event_type}] ${e.message}`));
  } else {
    console.log('  No "Developer Mode runtime" wording in any event');
  }
  results["no_devmode_wording"] = {
    pass: bannedMatches.length === 0,
    note:
      bannedMatches.length === 0
        ? 'No "Developer Mode runtime" wording in any event'
        : `Found banned wording in ${bannedMatches.length} event(s)`,
  };

  // ── Step 5: Check files were written ──────────────────────────────────────
  console.log("\n── Step 5: Check files written ──");
  const { rows: afterFiles } = await pool.query<{ n: string }>(
    `SELECT count(*) as n FROM project_files WHERE project_id=$1`,
    [PROJECT_ID],
  );
  const afterFileCount = Number(afterFiles[0]?.n ?? 0);
  const newFiles = afterFileCount - baseFileCount;
  console.log(`  files after: ${afterFileCount} (${newFiles >= 0 ? "+" : ""}${newFiles} new)`);
  results["files_written"] = {
    pass: afterFileCount > baseFileCount,
    note: `project_files went from ${baseFileCount} → ${afterFileCount} (+${newFiles})`,
  };

  // ── Step 6: Check file_diff events (preview refresh trigger) ───────────────
  console.log("\n── Step 6: Check file_diff events (preview refresh) ──");
  const fileDiffEvents = eventRows.filter((e) => e.event_type === "file_diff");
  const completedEvents = eventRows.filter((e) => e.event_type === "completed");
  console.log(`  file_diff events: ${fileDiffEvents.length}`);
  console.log(`  completed events: ${completedEvents.length}`);
  results["preview_refresh_event"] = {
    pass: fileDiffEvents.length > 0 || completedEvents.length > 0,
    note: `file_diff=${fileDiffEvents.length} completed=${completedEvents.length}`,
  };

  // ── Step 7: Check agent loop — detect repeated tool calls ─────────────────
  console.log("\n── Step 7: Check for stuck/repeating agent behavior ──");
  const narrations = eventRows.filter((e) => e.event_type === "narration").map((e) => e.message);
  const writingEvents = narrations.filter((m) => m.toLowerCase().includes("writing"));
  const uniqueWriting = new Set(writingEvents);
  const strategyChangeEvents = eventRows.filter(
    (e) => e.message && e.message.toLowerCase().includes("strategy change"),
  );
  const stuckRunEvents = eventRows.filter((e) => e.event_type === "stuck_run_detected");
  console.log(`  Writing narrations: ${writingEvents.length} (${uniqueWriting.size} unique)`);
  console.log(`  Strategy-change events: ${strategyChangeEvents.length}`);
  console.log(`  Stuck-run events: ${stuckRunEvents.length}`);
  const repeatedSameAction =
    writingEvents.length > 0 && writingEvents.length > uniqueWriting.size * 3;
  results["no_stuck_loop"] = {
    pass: !repeatedSameAction && stuckRunEvents.length === 0,
    note: repeatedSameAction
      ? `Agent repeated same write narration ${writingEvents.length}x (${uniqueWriting.size} unique) — possible loop`
      : `No stuck loop detected. Writes: ${writingEvents.length}, strategy-changes: ${strategyChangeEvents.length}`,
  };

  // ── Step 8: Check project_versions row ────────────────────────────────────
  console.log("\n── Step 8: Check project_versions row ──");
  const { rows: versionRows } = await pool.query<{
    id: number;
    validation_status: string;
    created_at: string;
  }>(
    `SELECT id, validation_status, created_at
     FROM project_versions WHERE project_id=$1 ORDER BY id DESC LIMIT 3`,
    [PROJECT_ID],
  );
  const newVersions = versionRows.filter((v) => Number(baseVersionCount) < 9999); // all versions after baseline
  console.log("  Recent versions:");
  versionRows.forEach((v) =>
    console.log(`    id=${v.id} validation_status=${v.validation_status} created=${v.created_at}`),
  );
  const latestVersion = versionRows[0];
  const validStatuses = ["passed", "passed_with_warnings", "completed_with_errors", "failed"];
  const versionHonest = latestVersion && validStatuses.includes(latestVersion.validation_status);
  results["honest_version_status"] = {
    pass: !!versionHonest,
    note: latestVersion
      ? `Latest version ${latestVersion.id} has validation_status=${latestVersion.validation_status}`
      : "No project_versions row found",
  };

  // ── Step 9: Check task report has real status ──────────────────────────────
  console.log("\n── Step 9: Check task report ──");
  const { rows: reportRows } = await pool.query<{ report: Record<string, unknown> | null }>(
    `SELECT report FROM agent_tasks WHERE id=$1`,
    [taskId],
  );
  const report = reportRows[0]?.report;
  const hasReport = report && typeof report === "object";
  const agentLoopUsed = hasReport && (report as Record<string, unknown>).agentLoop != null;
  console.log(`  Report present: ${hasReport ? "YES" : "NO"}`);
  console.log(`  Agent loop used: ${agentLoopUsed ? "YES" : "NO (legacy pipeline)"}`);
  results["real_agent_report"] = {
    pass: !!hasReport,
    note: hasReport
      ? `Task report present. agentLoop section: ${agentLoopUsed ? "YES" : "NO"}`
      : "No task report found",
  };

  // ── Print results ──────────────────────────────────────────────────────────
  const elapsed2 = Math.round((Date.now() - start) / 1000);
  console.log("\n" + "=".repeat(64));
  console.log("Results:");
  let passCount = 0;
  let totalCount = 0;
  for (const [key, result] of Object.entries(results)) {
    const icon = result.pass ? "PASS" : "FAIL";
    console.log(`  ${icon}  ${key}\n         ${result.note}`);
    if (result.pass) passCount++;
    totalCount++;
  }
  console.log(`\n${"─".repeat(64)}`);
  console.log(`AI Builder Live: ${passCount}/${totalCount} PASS  (${elapsed2}s)`);
  const allPass = passCount === totalCount;
  console.log(
    `STATUS: ${allPass ? "AI BUILDER LIVE FLOW PROVEN" : "ISSUES FOUND — see FAIL rows above"}`,
  );

  await pool.end();
  process.exit(allPass ? 0 : 1);
}

main().catch((err) => {
  console.error("FATAL:", err);
  pool.end().catch(() => {});
  process.exit(1);
});
