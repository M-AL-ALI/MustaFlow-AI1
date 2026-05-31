/**
 * Developer Mode Runtime Verification Script
 *
 * Accepts a project ID via VERIFY_PROJECT_ID env var.
 * Prints a structured PASS/FAIL report for each step:
 *
 *   Step 1 — Status table: DB fields + env var presence
 *   Step 2 — Runtime proof test: pwd, ls /app, write/read/delete via container exec
 *   Step 3 — Agent task: enqueue a real task, poll to terminal state, confirm file in DB
 *
 * Usage:
 *   VERIFY_PROJECT_ID=<id> pnpm --filter @workspace/scripts run verify-developer-mode-runtime
 */

import { pool } from "@workspace/db";

const PROJECT_ID = parseInt(process.env.VERIFY_PROJECT_ID ?? "", 10);
if (isNaN(PROJECT_ID) || PROJECT_ID <= 0) {
  console.error("ERROR: set VERIFY_PROJECT_ID to a valid project ID");
  process.exit(1);
}

const FLY_API_TOKEN_PRESENT = !!process.env.FLY_API_TOKEN;
const NEON_API_KEY_PRESENT = !!process.env.NEON_API_KEY;

let totalPass = 0;
let totalFail = 0;

function pass(label: string, detail?: string) {
  totalPass++;
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
}

function fail(label: string, detail?: string) {
  totalFail++;
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
}

function section(title: string) {
  console.log(`\n── ${title} ──────────────────────────────────────────`);
}

// ── Step 1: Status table ─────────────────────────────────────────────────────
section("Step 1: Status Table");

const projectRes = await pool.query<{
  id: number;
  name: string;
  builder_mode: string;
  container_id: string | null;
  container_url: string | null;
  container_status: string | null;
  provisioning_status: string;
  provisioning_step: string | null;
}>(
  `SELECT id, name, builder_mode, container_id, container_url,
          container_status, provisioning_status, provisioning_step
   FROM projects
   WHERE id = $1 AND deleted_at IS NULL`,
  [PROJECT_ID],
);

if (projectRes.rows.length === 0) {
  console.error(`ERROR: project ${PROJECT_ID} not found`);
  await pool.end();
  process.exit(1);
}

const project = projectRes.rows[0]!;

console.log(`  Project:            #${project.id} — ${project.name}`);
console.log(`  builderMode:        ${project.builder_mode}`);
console.log(`  containerId:        ${project.container_id ?? "(null)"}`);
console.log(`  containerStatus:    ${project.container_status ?? "(null)"}`);
console.log(`  provisioningStatus: ${project.provisioning_status}`);
console.log(`  provisioningStep:   ${project.provisioning_step ?? "(null)"}`);
console.log(`  FLY_API_TOKEN:      ${FLY_API_TOKEN_PRESENT ? "present" : "MISSING"}`);
console.log(`  NEON_API_KEY:       ${NEON_API_KEY_PRESENT ? "present" : "MISSING"}`);

if (FLY_API_TOKEN_PRESENT) {
  pass("FLY_API_TOKEN present");
} else {
  fail("FLY_API_TOKEN present", "missing — container operations will no-op");
}

if (project.builder_mode === "agentic") {
  pass("builderMode is agentic");
} else {
  fail("builderMode is agentic", `got: ${project.builder_mode}`);
}

if (project.container_id) {
  pass("containerId is set", project.container_id);
} else {
  fail("containerId is set", "null — project is not provisioned");
}

if (project.provisioning_status === "ready") {
  pass("provisioningStatus is ready");
} else {
  fail("provisioningStatus is ready", `got: ${project.provisioning_status}`);
}

// ── Step 2: Runtime proof test ───────────────────────────────────────────────
section("Step 2: Runtime Proof Test (pwd, ls /app, write/read/delete)");

if (!project.container_id) {
  fail("container exec available", "no containerId — skipping proof test");
  console.log("  (skipped — no container)");
} else if (!FLY_API_TOKEN_PRESENT) {
  fail("container exec available", "FLY_API_TOKEN missing — skipping proof test");
  console.log("  (skipped — FLY_API_TOKEN missing)");
} else {
  try {
    const FLY_API_BASE = "https://api.machines.dev/v1";
    const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
    const FLY_TOKEN = process.env.FLY_API_TOKEN!;
    const containerId = project.container_id;

    async function execInMachine(command: string[], cwd = "/app") {
      const res = await fetch(`${FLY_API_BASE}/apps/${FLY_APP}/machines/${containerId}/exec`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${FLY_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ command, cwd, timeout: 15 }),
      });
      if (!res.ok) {
        const text = await res.text();
        return { ok: false as const, stdout: "", stderr: text, exitCode: -1 };
      }
      const data = (await res.json()) as { stdout?: string; stderr?: string; exit_code?: number };
      const exitCode = data.exit_code ?? 0;
      return {
        ok: exitCode === 0,
        stdout: data.stdout ?? "",
        stderr: data.stderr ?? "",
        exitCode,
      };
    }

    // pwd
    const pwdResult = await execInMachine(["pwd"]);
    if (pwdResult.ok) {
      pass("pwd exec", `stdout: ${pwdResult.stdout.trim()}`);
    } else {
      fail("pwd exec", `exit ${pwdResult.exitCode}: ${pwdResult.stderr.slice(0, 120)}`);
    }

    // ls /app
    const lsResult = await execInMachine(["ls", "/app"]);
    if (lsResult.ok) {
      pass("ls /app exec", `${lsResult.stdout.trim().split("\n").length} entries`);
    } else {
      fail("ls /app exec", `exit ${lsResult.exitCode}: ${lsResult.stderr.slice(0, 120)}`);
    }

    // write test file
    const writeResult = await execInMachine([
      "/bin/sh",
      "-c",
      "printf 'runtime working' > /app/.mustaflow-runtime-test && echo ok",
    ]);
    if (writeResult.ok) {
      pass("write .mustaflow-runtime-test");
    } else {
      fail("write .mustaflow-runtime-test", writeResult.stderr.slice(0, 120));
    }

    // read back
    const readResult = await execInMachine(["cat", "/app/.mustaflow-runtime-test"]);
    const readContent = readResult.stdout.trim();
    if (readResult.ok && readContent === "runtime working") {
      pass("read .mustaflow-runtime-test", `content: "${readContent}"`);
    } else {
      fail("read .mustaflow-runtime-test", `got: "${readContent}"`);
    }

    // delete
    const deleteResult = await execInMachine(["rm", "-f", "/app/.mustaflow-runtime-test"]);
    if (deleteResult.ok) {
      pass("delete .mustaflow-runtime-test");
    } else {
      fail("delete .mustaflow-runtime-test", deleteResult.stderr.slice(0, 120));
    }
  } catch (err) {
    fail("container exec", `exception: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Step 3: Agent task end-to-end ────────────────────────────────────────────
section("Step 3: Agent Task End-to-End");

const AGENT_PROMPT = "Create a file called agent-test.txt with the text: Agent is working.";
const TASK_TITLE = "[verify] Create agent-test.txt";

if (!project.container_id || !FLY_API_TOKEN_PRESENT) {
  fail("agent task can be enqueued", "no container or FLY_API_TOKEN missing — skipping");
  console.log("  (skipped)");
} else {
  try {
    const insertRes = await pool.query<{ id: number }>(
      `INSERT INTO agent_tasks (project_id, title, prompt, status, task_agent_mode)
       VALUES ($1, $2, $3, 'pending', 'lite')
       RETURNING id`,
      [PROJECT_ID, TASK_TITLE, AGENT_PROMPT],
    );

    const taskId = insertRes.rows[0]?.id;
    if (!taskId) {
      fail("agent task enqueue", "insert returned no id");
    } else {
      pass("agent task enqueued", `taskId=${taskId}`);

      // Poll for terminal state (max 3 min)
      const deadline = Date.now() + 3 * 60_000;
      let finalStatus = "pending";
      while (Date.now() < deadline) {
        await new Promise<void>((r) => setTimeout(r, 5_000));
        const pollRes = await pool.query<{ status: string }>(
          "SELECT status FROM agent_tasks WHERE id = $1",
          [taskId],
        );
        finalStatus = pollRes.rows[0]?.status ?? "pending";
        if (["completed", "failed", "cancelled"].includes(finalStatus)) break;
        process.stdout.write(".");
      }
      console.log();

      if (finalStatus === "completed") {
        pass("agent task reached completed state", `taskId=${taskId}`);
      } else {
        fail("agent task reached completed state", `status=${finalStatus}`);
      }

      // Check task events for container_unavailable / failed events
      const eventsRes = await pool.query<{ event_type: string; message: string | null }>(
        `SELECT event_type, message FROM task_events
         WHERE task_id = $1 AND event_type IN ('container_unavailable', 'failed')
         ORDER BY created_at DESC LIMIT 1`,
        [taskId],
      );
      const notableEvent = eventsRes.rows[0];
      if (notableEvent) {
        console.log(`  Event: ${notableEvent.event_type} — ${notableEvent.message?.slice(0, 120)}`);
      }

      // Check if agent-test.txt was created in project_files
      const fileRes = await pool.query<{ path: string; content: string }>(
        "SELECT path, content FROM project_files WHERE project_id = $1 AND path = 'agent-test.txt'",
        [PROJECT_ID],
      );
      const testFile = fileRes.rows[0];

      if (testFile && testFile.content?.includes("Agent is working")) {
        pass(
          "agent-test.txt created in project_files",
          `content: "${testFile.content.slice(0, 60)}"`,
        );
      } else if (testFile) {
        fail("agent-test.txt content matches", `got: "${testFile.content?.slice(0, 60)}"`);
      } else {
        fail("agent-test.txt created in project_files", "file not found");
      }
    }
  } catch (err) {
    fail("agent task step", `exception: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${"─".repeat(60)}`);
console.log(`Result: ${totalPass} passed, ${totalFail} failed`);

await pool.end();

if (totalFail > 0) process.exit(1);
