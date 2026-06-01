/**
 * Small runtime test for autostop-prevention mechanisms.
 *
 * Tests (in order):
 *   1. Disable autostop via POST (patchMachineAutostop "off")
 *   2. Confirm machine reaches "running" after config restart
 *   3. Start health server (startContainerHealthServer with retry)
 *   4. Confirm /healthz responds on the EXACT machine (fly-force-instance-id)
 *   5. Run `sleep 120` exec and confirm it completes without the machine stopping
 *   6. Confirm machine is still "running" after the long exec
 *   7. Stop the health server
 *   8. Restore autostop ("stop")
 *
 * Usage:
 *   pnpm --filter @workspace/api-server exec tsx src/test-autostop-prevention.ts
 *
 * Env vars required: FLY_API_TOKEN (and optionally FLY_APP_NAME).
 * The test machine is hardcoded as project 82 / machine 865990ce734128.
 */

import {
  patchMachineAutostop,
  startContainerHealthServer,
  stopContainerHealthServer,
  startContainer,
  getContainerStatus,
} from "./lib/container.js";

const TEST_MACHINE_ID = "865990ce734128";
const TEST_PROJECT_ID = 82;
const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const MACHINE_PROXY_BASE = `https://${FLY_APP}.fly.dev/container/${TEST_MACHINE_ID}`;
const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pass(step: number, msg: string) {
  console.log(`  PASS [${step}] ${msg}`);
}

function fail(step: number, msg: string) {
  console.error(`  FAIL [${step}] ${msg}`);
  process.exitCode = 1;
}

async function flyFetchDirect(path: string, init?: RequestInit) {
  return fetch(`https://api.machines.dev/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${FLY_TOKEN}`,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
}

async function runExecAndWait(
  machineId: string,
  command: string[],
  timeoutSec: number,
): Promise<{ exitCode: number; stdout: string; stderr: string } | null> {
  const res = await flyFetchDirect(`/apps/${FLY_APP}/machines/${machineId}/exec`, {
    method: "POST",
    body: JSON.stringify({ command, timeout: timeoutSec }),
  });
  if (!res.ok) {
    const body = await res.text();
    console.error(`    exec HTTP ${res.status}: ${body}`);
    return null;
  }
  const json = (await res.json()) as {
    exit_code: number;
    stdout: string;
    stderr: string;
  };
  return { exitCode: json.exit_code, stdout: json.stdout, stderr: json.stderr };
}

// ─── Test sequence ────────────────────────────────────────────────────────────

console.log("\n=== Autostop Prevention Runtime Test ===");
console.log(`  machine : ${TEST_MACHINE_ID}`);
console.log(`  project : ${TEST_PROJECT_ID}`);
console.log(`  fly app : ${FLY_APP}`);
console.log(`  proxy   : ${MACHINE_PROXY_BASE}`);
console.log("");

if (!FLY_TOKEN) {
  console.error("FATAL: FLY_API_TOKEN not set — cannot run Fly API calls.");
  process.exit(1);
}

// --- Step 0: Wake the machine -------------------------------------------------
// Production always calls ensureContainerAwake before patchMachineAutostop.
// The test machine may be hibernated, so we must start it first.
console.log("[0] Waking machine (startContainer) …");
const wakeOk = await startContainer(TEST_MACHINE_ID, TEST_PROJECT_ID);
if (wakeOk) {
  pass(0, "machine started / was already running");
} else {
  fail(0, "startContainer returned false — machine may not start; continuing anyway");
}
// Brief pause for machine to reach 'started' state after wake.
await new Promise((r) => setTimeout(r, 5_000));

// --- Step 1: Disable autostop -------------------------------------------------
console.log("[1] Disabling autostop (patchMachineAutostop 'off') …");
await patchMachineAutostop(TEST_MACHINE_ID, TEST_PROJECT_ID, "off");

// --- Step 2: Confirm machine is running after restart -------------------------
console.log("[2] Checking machine status after autostop patch …");
const statusAfterPatch = await getContainerStatus(TEST_MACHINE_ID);
if (statusAfterPatch === "running") {
  pass(2, `machine is "running" after config update`);
} else {
  fail(2, `machine status is "${statusAfterPatch}" — expected "running"`);
  // Attempt restore before exiting
  await patchMachineAutostop(TEST_MACHINE_ID, TEST_PROJECT_ID, "stop");
  process.exit(1);
}

// --- Step 3: Start health server ----------------------------------------------
console.log("[3] Starting health server (with retry logic) …");
await startContainerHealthServer(TEST_MACHINE_ID, TEST_PROJECT_ID);
// Give the nohup process a moment to bind the port.
await new Promise((r) => setTimeout(r, 2_000));

// --- Step 4: Confirm /healthz responds on the EXACT machine ------------------
console.log("[4] Probing /healthz on the exact machine …");
let healthzOk = false;
for (let i = 0; i < 5; i++) {
  try {
    const r = await fetch(`${MACHINE_PROXY_BASE}/healthz`, {
      signal: AbortSignal.timeout(5_000),
      headers: { "fly-force-instance-id": TEST_MACHINE_ID },
    });
    if (r.ok) {
      healthzOk = true;
      break;
    }
    console.log(`    attempt ${i + 1}: HTTP ${r.status} — retrying …`);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`    attempt ${i + 1}: ${msg} — retrying …`);
  }
  await new Promise((r) => setTimeout(r, 2_000));
}
if (healthzOk) {
  pass(4, `/healthz returned 200 with fly-force-instance-id header`);
} else {
  fail(4, `/healthz did not return 200 after 5 attempts (health server may not be listening)`);
  // Don't abort — still run the sleep test to see if autostop itself holds.
}

// --- Step 5: Run sleep 120 exec -----------------------------------------------
console.log("[5] Running `sleep 120` exec on exact machine (takes ~120 s) …");
const sleepStart = Date.now();
const sleepResult = await runExecAndWait(TEST_MACHINE_ID, ["sleep", "120"], 150);
const sleepElapsed = Math.round((Date.now() - sleepStart) / 1000);

if (sleepResult === null) {
  fail(5, `exec call failed (machine may have been stopped mid-sleep)`);
} else if (sleepResult.exitCode !== 0) {
  fail(5, `sleep exited with code ${sleepResult.exitCode} after ${sleepElapsed} s`);
} else {
  pass(5, `sleep 120 completed cleanly (elapsed ${sleepElapsed} s, exit 0)`);
}

// --- Step 6: Confirm machine still running ------------------------------------
console.log("[6] Confirming machine is still running after long exec …");
const statusAfterSleep = await getContainerStatus(TEST_MACHINE_ID);
if (statusAfterSleep === "running") {
  pass(6, `machine is still "running" after sleep 120`);
} else {
  fail(6, `machine status is "${statusAfterSleep}" — machine was stopped during exec`);
}

// --- Step 7: Stop health server -----------------------------------------------
console.log("[7] Stopping health server …");
await stopContainerHealthServer(TEST_MACHINE_ID, TEST_PROJECT_ID);
pass(7, "health server stop command sent");

// --- Step 8: Restore autostop -------------------------------------------------
console.log("[8] Restoring autostop to 'stop' …");
await patchMachineAutostop(TEST_MACHINE_ID, TEST_PROJECT_ID, "stop");
const statusAfterRestore = await getContainerStatus(TEST_MACHINE_ID);
if (statusAfterRestore === "running") {
  pass(8, `autostop restored; machine still "running"`);
} else {
  pass(8, `autostop restored; machine is "${statusAfterRestore}" (expected — may idle-stop later)`);
}

// ─── Summary ─────────────────────────────────────────────────────────────────
console.log("");
if (process.exitCode === 1) {
  console.error("=== RESULT: FAIL — one or more steps failed (see FAIL lines above) ===");
} else {
  console.log("=== RESULT: PASS — all steps passed ===");
}
console.log("");
