/**
 * Part 1 verification script — creates a fresh node-api agentic project
 * under the real user's Clerk account and runs the initial build.
 *
 * Run with:
 *   pnpm --filter @workspace/api-server exec tsx src/test-part1.ts
 */

import { db } from "@workspace/db";
import { projectsTable, agentTasksTable } from "@workspace/db";
import { eq } from "drizzle-orm";

const REAL_USER_ID = "user_3Dv2h4CdaJoviog3ToUryvt3kft";
const PROJECT_NAME = "Towco Fullstack";
const PROMPT =
  "Build the Towco tow-truck request app with counter-offer flow, operator quotes, live status tracking, home page, request form, customer/operator dashboard, backend API, and test database records.";

async function poll<T>(
  label: string,
  fn: () => Promise<T | null>,
  until: (v: T) => boolean,
  intervalMs = 15_000,
  maxMs = 15 * 60_000,
): Promise<T | null> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v !== null && until(v)) return v;
    const remaining = Math.round((deadline - Date.now()) / 1000);
    console.log(`  [${label}] waiting… (${remaining}s left)`);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return null;
}

async function main() {
  console.log("\n=== Part 1: Real-Account Builder Test ===\n");

  // ── Step 1: Create project ──────────────────────────────────────────────
  console.log("Step 1: Creating project…");
  const [project] = await db
    .insert(projectsTable)
    .values({
      name: PROJECT_NAME,
      ownerId: REAL_USER_ID,
      kind: "web",
      stack: "node-api",
      builderMode: "agentic",
      projectMode: "builder",
      provisioningStatus: "provisioning",
      status: "draft",
      agentMode: "power",
      defaultAgent: "main",
    })
    .returning();

  console.log(`  Created project id=${project.id} name="${project.name}"`);
  console.log(`  owner_id=${project.ownerId}`);
  console.log(`  project_mode=${project.projectMode} builder_mode=${project.builderMode}`);
  console.log(`  kind=${project.kind} stack=${project.stack}`);
  console.log(`  URL: /projects/${project.id}\n`);

  // ── Step 2: Provision (Fly + Neon) ─────────────────────────────────────
  console.log("Step 2: Provisioning Fly container + Neon DB…");
  const { runProvisionProjectJob } = await import("./lib/provisioning");
  await runProvisionProjectJob(project.id);

  const [provisioned] = await db
    .select({
      provisioningStatus: projectsTable.provisioningStatus,
      containerId: projectsTable.containerId,
      neonProjectId: projectsTable.neonProjectId,
      provisioningError: projectsTable.provisioningError,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, project.id));

  console.log(`  provisioning_status=${provisioned.provisioningStatus}`);
  console.log(`  container_id=${provisioned.containerId ?? "(none)"}`);
  console.log(`  neon_project_id=${provisioned.neonProjectId ?? "(none)"}`);
  if (provisioned.provisioningError) {
    console.log(`  provisioning_error=${provisioned.provisioningError}`);
  }

  if (provisioned.provisioningStatus !== "ready" && provisioned.provisioningStatus !== "idle") {
    console.error("\nBLOCKER: Provisioning failed — aborting build test.");
    process.exit(1);
  }

  if (!provisioned.containerId) {
    console.log(
      "\nNOTE: No Fly container provisioned (FLY_API_TOKEN may be absent or provisioning degraded).",
    );
    console.log("      builder_mode=agentic without a container will be blocked at preflight.");
    console.log("      Switching builder_mode to static-legacy for this test run.");
    await db
      .update(projectsTable)
      .set({ builderMode: "static-legacy" })
      .where(eq(projectsTable.id, project.id));
  }
  console.log();

  // ── Step 3: Create build task ──────────────────────────────────────────
  console.log("Step 3: Creating build task…");
  const [task] = await db
    .insert(agentTasksTable)
    .values({
      projectId: project.id,
      title: "Initial build",
      kind: "main",
      status: "queued",
      prompt: PROMPT,
      taskAgentMode: "power",
      runMode: "foreground",
      wallClockCapMs: 20 * 60_000,
    })
    .returning();

  console.log(`  Created task id=${task.id} status=${task.status}\n`);

  // ── Step 4: Run the build ──────────────────────────────────────────────
  console.log("Step 4: Running build (up to 20 min)…");
  const { runJob } = await import("./lib/jobs");

  const abortController = new AbortController();
  const timeout = setTimeout(() => {
    console.log("\nWall-clock timeout reached — aborting.");
    abortController.abort();
  }, 22 * 60_000);

  try {
    await runJob({
      taskId: task.id,
      projectId: project.id,
      kind: "build",
      userPrompt: PROMPT,
      agentMode: "power",
      agentIdentity: "main",
      runMode: "foreground",
      wallClockCapMs: 20 * 60_000,
    });
  } catch (err) {
    console.error("runJob threw:", err);
  } finally {
    clearTimeout(timeout);
  }

  // ── Step 5: Read final state ───────────────────────────────────────────
  console.log("\nStep 5: Reading final task state…");
  const [finalTask] = await db
    .select({
      id: agentTasksTable.id,
      status: agentTasksTable.status,
      result: agentTasksTable.result,
      report: agentTasksTable.report,
      failureReason: agentTasksTable.failureReason,
      completedAt: agentTasksTable.completedAt,
    })
    .from(agentTasksTable)
    .where(eq(agentTasksTable.id, task.id));

  const [finalProject] = await db
    .select({
      id: projectsTable.id,
      name: projectsTable.name,
      ownerId: projectsTable.ownerId,
      projectMode: projectsTable.projectMode,
      builderMode: projectsTable.builderMode,
      containerId: projectsTable.containerId,
      provisioningStatus: projectsTable.provisioningStatus,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, project.id));

  const report = finalTask.report as Record<string, unknown> | null;
  const validationStatus = (report?.validationStatus as string | undefined) ?? "(not set)";

  console.log("\n=== FINAL REPORT ===");
  console.log(`Project ID:         ${finalProject.id}`);
  console.log(`Project Name:       ${finalProject.name}`);
  console.log(`Owner ID:           ${finalProject.ownerId}`);
  console.log(`project_mode:       ${finalProject.projectMode}`);
  console.log(`builder_mode:       ${finalProject.builderMode}`);
  console.log(`container_id:       ${finalProject.containerId ?? "(none)"}`);
  console.log(`provisioning_status:${finalProject.provisioningStatus}`);
  console.log(`Task ID:            ${finalTask.id}`);
  console.log(`Task Status:        ${finalTask.status}`);
  console.log(`validation_status:  ${validationStatus}`);
  console.log(`Result snippet:     ${String(finalTask.result ?? "").slice(0, 120)}`);
  if (finalTask.failureReason) {
    console.log(`failure_reason:     ${finalTask.failureReason}`);
  }

  const loop = report?.agentLoop as Record<string, unknown> | null;
  if (loop) {
    console.log(`terminationReason:  ${loop.terminationReason ?? "?"}`);
    const checks = loop.checkResults as Array<{
      id: string;
      passed: boolean;
      message?: string;
    }> | null;
    if (checks?.length) {
      console.log(`Check results (${checks.length} total):`);
      for (const c of checks) {
        console.log(`  ${c.passed ? "PASS" : "FAIL"} ${c.id}: ${(c.message ?? "").slice(0, 100)}`);
      }
    }
  }

  console.log("\nApp URL: /projects/" + finalProject.id);
}

main().catch((err) => {
  console.error("Script failed:", err);
  process.exit(1);
});
