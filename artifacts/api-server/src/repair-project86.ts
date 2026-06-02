/**
 * Submit a focused server-startup repair task for project 86.
 * Run with: pnpm --filter @workspace/api-server exec tsx src/repair-project86.ts
 *
 * This script keeps the process alive until the task reaches a terminal state.
 * The enqueued job runs inside this tsx process (in-memory path — pg-boss is not
 * started here). The job-level setInterval heartbeat in runJob keeps the event
 * loop live; when runJob finishes its finally block clears the interval and the
 * process exits naturally after the polling loop detects the terminal status.
 */
import { db, projectsTable, agentTasksTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { enqueueJob } from "./lib/jobs";

const PROJECT_ID = 86;

const REPAIR_PROMPT = `Fix server startup for this node-api project. The dev server is not running because npm install did not complete in the previous build — node_modules is empty and tsx is not available.

Steps to execute in order:
1. Run the shell command: cd /app && npm install 2>&1 | tail -30
   - If it succeeds: continue to step 2
   - If it fails with a network error: inspect the error, try npm install --prefer-offline, or identify missing packages and add them manually if npm registry is unreachable
2. After install: run cd /app && npx tsc --noEmit 2>&1 | head -60 and fix every TypeScript error you see
3. Verify the dev server starts: cd /app && timeout 8 node_modules/.bin/tsx src/server/index.ts & sleep 5 && curl -sf http://localhost:3000/healthz
4. If /healthz returns 200: the server is fixed. Summarize what was wrong and what you fixed.
5. If /healthz still fails: read the server startup output from /tmp/ or stderr, identify the crash reason, and fix it.

Constraints:
- Do NOT add any new features or change any existing business logic
- Do NOT modify the app's routes, UI, or database schema
- Fix only what is needed to make npm install succeed and GET /healthz return 200
- The server must listen on process.env.PORT (already coded correctly in src/server/index.ts)
- The /healthz route already exists and is correct — just need deps installed and server running`;

const TERMINAL = new Set(["completed", "failed", "canceled", "completed_with_errors"]);

async function pollUntilDone(taskId: number, timeoutMs = 25 * 60 * 1000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt++;
    await new Promise((r) => setTimeout(r, 20_000));
    const [row] = await db
      .select({
        status: agentTasksTable.status,
        failureReason: agentTasksTable.failureReason,
        lastHeartbeatAt: agentTasksTable.lastHeartbeatAt,
        result: agentTasksTable.result,
      })
      .from(agentTasksTable)
      .where(eq(agentTasksTable.id, taskId));
    if (!row) {
      console.log(`[poll #${attempt}] task ${taskId} not found`);
      continue;
    }
    const hb = row.lastHeartbeatAt?.toISOString().slice(11, 19) ?? "never";
    console.log(
      `[poll #${attempt}] status=${row.status} hb=${hb} failReason=${row.failureReason ?? "-"}`,
    );
    if (TERMINAL.has(row.status)) {
      console.log(`\n=== Task ${taskId} finished ===`);
      console.log(`Status      : ${row.status}`);
      if (row.failureReason) console.log(`Fail reason : ${row.failureReason}`);
      if (row.result) console.log(`Result      : ${row.result.slice(0, 800)}`);
      return;
    }
  }
  console.warn(`Polling timed out after ${timeoutMs / 60_000} min — task may still be running.`);
}

async function main() {
  console.log("\n=== Project 86 Repair Task Submission ===\n");

  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, PROJECT_ID));
  if (!project) {
    console.error("Project 86 not found");
    process.exit(1);
  }
  console.log(`Project: ${project.name} [${project.stack}] container=${project.containerId}`);

  const [active] = await db
    .select({ id: agentTasksTable.id, status: agentTasksTable.status })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.projectId, PROJECT_ID))
    .orderBy(desc(agentTasksTable.id))
    .limit(1);

  if (active && ["building", "planning", "queued"].includes(active.status)) {
    console.log(`Task ${active.id} is already ${active.status} — skipping submission`);
    console.log("Will poll the existing task for completion instead...\n");
    await pollUntilDone(active.id);
    process.exit(0);
  }

  const [task] = await db
    .insert(agentTasksTable)
    .values({
      projectId: PROJECT_ID,
      title: "Fix server startup — npm install + healthz",
      kind: "refine",
      status: "queued",
      prompt: REPAIR_PROMPT,
      taskAgentMode: "power",
      agentIdentity: "main",
      runMode: "foreground",
    })
    .returning();

  console.log(`Created task id=${task.id} status=${task.status}`);
  console.log("Enqueuing job — process stays alive until task completes...\n");

  // Fire the job. Because this script does NOT start pg-boss, enqueueJob falls
  // through to the in-memory path and calls runJob() directly in this process.
  // The job-level setInterval heartbeat inside runJob keeps the event loop alive
  // for the full duration (30 s interval, NOT unref'd).
  enqueueJob({
    taskId: task.id,
    projectId: PROJECT_ID,
    kind: "refine",
    userPrompt: REPAIR_PROMPT,
    agentMode: "power",
    agentIdentity: "main",
  });

  // Poll DB until terminal status — the process stays alive because runJob's
  // setInterval is keeping the event loop busy. After runJob's finally block
  // clears the interval the process will exit naturally once we return here.
  await pollUntilDone(task.id);
  // Give the event loop one tick to flush any final I/O before we force exit.
  await new Promise((r) => setImmediate(r));
  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
