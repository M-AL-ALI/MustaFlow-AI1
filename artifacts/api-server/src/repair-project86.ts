/**
 * Submit a focused server-startup repair task for project 86.
 * Run with: pnpm --filter @workspace/api-server exec tsx src/repair-project86.ts
 */
import { db, projectsTable, agentTasksTable } from "@workspace/db";
import { eq, desc } from "drizzle-orm";
import { enqueueJob } from "./lib/jobs";

const PROJECT_ID = 86;
const REAL_USER_ID = "user_3Dv2h4CdaJoviog3ToUryvt3kft";

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

async function main() {
  console.log("\n=== Project 86 Repair Task Submission ===\n");

  // Confirm project exists
  const [project] = await db.select().from(projectsTable).where(eq(projectsTable.id, PROJECT_ID));
  if (!project) {
    console.error("Project 86 not found");
    process.exit(1);
  }
  console.log(`Project: ${project.name} [${project.stack}] container=${project.containerId}`);

  // Check no task is currently active
  const [active] = await db
    .select({ id: agentTasksTable.id, status: agentTasksTable.status })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.projectId, PROJECT_ID))
    .orderBy(desc(agentTasksTable.id))
    .limit(1);

  if (active && ["building", "planning", "queued"].includes(active.status)) {
    console.log(`Task ${active.id} is already ${active.status} — skipping submission`);
    process.exit(0);
  }

  // Insert the repair task
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
  console.log(`Prompt length: ${REPAIR_PROMPT.length} chars`);

  // Enqueue the job
  enqueueJob({
    taskId: task.id,
    projectId: PROJECT_ID,
    kind: "refine",
    userPrompt: REPAIR_PROMPT,
    agentMode: "power",
    agentIdentity: "main",
  });

  console.log(`\nRepair task ${task.id} enqueued — agent is now working on project 86.`);
  console.log(
    "Monitor via: SELECT id, status, result FROM agent_tasks WHERE id = " + task.id + ";",
  );
  console.log("\nThe agent will:");
  console.log("  1. Run npm install and capture output");
  console.log("  2. Fix any TypeScript errors");
  console.log("  3. Verify GET /healthz returns 200");
  console.log("  4. Report final status honestly\n");

  // Give the job a moment to start, then check status
  await new Promise((r) => setTimeout(r, 3000));
  const [check] = await db
    .select({ status: agentTasksTable.status })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, task.id));
  console.log(`Task status after 3s: ${check?.status}`);

  process.exit(0);
}

main().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
