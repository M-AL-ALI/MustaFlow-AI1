/**
 * Verification script — write_file fix + stuck-loop detection
 *
 * Tests 1-4 from the Phase 2A post-fix audit:
 *   Test 1 — File-write: write "Preview Sync Test 123", read back from container
 *   Test 2 — Preview chain: code-path verification (file_diff → refreshTrigger)
 *   Test 3 — Failure behavior: bad container → ok:false, no blind continuation
 *   Test 4 — Stuck-loop: strategy-change code paths present and correct
 *
 * Usage:
 *   pnpm --filter @workspace/scripts run verify-write-file
 */

import { readFileSync } from "fs";
import { join } from "path";
import { pool } from "@workspace/db";

// Workspace root is one level above scripts/
const ROOT = join(import.meta.dirname, "../..");

const FLY_API_BASE = "https://api.machines.dev/v1";
const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const FLY_TOKEN = process.env.FLY_API_TOKEN ?? "";
const TEST_CONTENT = "Preview Sync Test 123";
const TEST_FILE = "_verify_write_test.txt";

let passed = 0;
let failed = 0;

function pass(label: string, detail = "") {
  console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  passed++;
}
function fail(label: string, detail = "") {
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  failed++;
}
function section(title: string) {
  console.log(`\n── ${title} ──────────────────────────────────`);
}

// ── Fly exec helper (same pattern as verify-developer-mode-runtime.ts) ────────
async function execInMachine(
  machineId: string,
  command: string[],
  cwd = "/app",
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const res = await fetch(`${FLY_API_BASE}/apps/${FLY_APP}/machines/${machineId}/exec`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${FLY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ command, cwd, timeout: 15 }),
  });
  if (!res.ok) {
    const text = await res.text();
    return { ok: false, stdout: "", stderr: text, exitCode: -1 };
  }
  const data = (await res.json()) as { stdout?: string; stderr?: string; exit_code?: number };
  const exitCode = data.exit_code ?? 0;
  return { ok: exitCode === 0, stdout: data.stdout ?? "", stderr: data.stderr ?? "", exitCode };
}

// writeFileToContainer logic inline (same as container.ts)
async function writeFileTo(
  machineId: string,
  filePath: string,
  content: string,
): Promise<boolean> {
  if (!FLY_TOKEN) return false;
  try {
    const b64 = Buffer.from(content, "utf8").toString("base64");
    const dir = filePath.includes("/")
      ? `/app/${filePath.split("/").slice(0, -1).join("/")}`
      : "/app";
    const fullPath = `/app/${filePath}`;
    const cmd = [
      "/bin/sh",
      "-c",
      `mkdir -p "${dir}" && echo "${b64}" | base64 -d > "${fullPath}"`,
    ];
    const res = await execInMachine(machineId, cmd);
    return res.ok;
  } catch {
    return false;
  }
}

// ── Fetch a live project with a running container ─────────────────────────────
const projectRes = await pool.query<{
  id: number;
  name: string;
  container_id: string;
}>(
  `SELECT id, name, container_id FROM projects
   WHERE container_id IS NOT NULL AND deleted_at IS NULL AND provisioning_status = 'ready'
   ORDER BY updated_at DESC LIMIT 1`,
);

if (projectRes.rows.length === 0) {
  console.error("ERROR: no ready agentic project found");
  await pool.end();
  process.exit(1);
}
const { id: projectId, name: projectName, container_id: containerId } = projectRes.rows[0]!;
console.log(`\nUsing project #${projectId} — ${projectName} (container: ${containerId})`);
console.log(`FLY_API_TOKEN: ${FLY_TOKEN ? "present" : "MISSING — live container tests skipped"}`);

const canExec = !!FLY_TOKEN;

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: File-write + container read-back
// ─────────────────────────────────────────────────────────────────────────────
section("Test 1: File-write verification");

if (!canExec) {
  fail("1a-1c skipped", "FLY_API_TOKEN missing");
} else {
  // 1a. Write to container
  const writeOk = await writeFileTo(containerId, TEST_FILE, TEST_CONTENT);
  writeOk
    ? pass("1a writeFileToContainer returns true")
    : fail("1a writeFileToContainer returned false — sync failed");

  // 1b. Read back from container
  const readBack = await execInMachine(containerId, ["/bin/sh", "-c", `cat /app/${TEST_FILE}`]);
  const got = readBack.stdout.trim();
  if (readBack.ok && got === TEST_CONTENT) {
    pass("1b container read-back matches written content", `"${got}"`);
  } else if (!readBack.ok) {
    fail("1b container read-back exec failed", `exit=${readBack.exitCode} ${readBack.stderr.slice(0, 80)}`);
  } else {
    fail("1b content mismatch", `expected "${TEST_CONTENT}" got "${got}"`);
  }

  // 1c. File exists at correct /app/ path
  const pathCheck = await execInMachine(containerId, [
    "/bin/sh",
    "-c",
    `test -f /app/${TEST_FILE} && echo EXISTS || echo MISSING`,
  ]);
  pathCheck.stdout.trim() === "EXISTS"
    ? pass("1c file exists at /app/ path in container")
    : fail("1c file not found at /app/ path", pathCheck.stdout.trim());

  // 1d. Failure case: bad container returns false (not success)
  const badWrite = await writeFileTo("nonexistent-machine-00000", TEST_FILE, TEST_CONTENT);
  !badWrite
    ? pass("1d bad-container write returns false (would have looped before fix)")
    : fail("1d bad-container write incorrectly returned true");

  // Cleanup
  await execInMachine(containerId, ["/bin/sh", "-c", `rm -f /app/${TEST_FILE}`]);
}

// ─────────────────────────────────────────────────────────────────────────────
// TEST 2: Preview refresh chain (code-path)
// ─────────────────────────────────────────────────────────────────────────────
section("Test 2: Preview refresh chain");

const agentSrc = readFileSync(join(ROOT, "artifacts/api-server/src/lib/agent-loop.ts"), "utf8");
const jobsSrc = readFileSync(join(ROOT, "artifacts/api-server/src/lib/jobs.ts"), "utf8");
const previewSrc = readFileSync(
  join(ROOT, "artifacts/mustaflow/src/pages/projects/components/preview-tab.tsx"),
  "utf8",
);

// file_diff emitted from write_file and apply_patch
agentSrc.includes('op: "write"') && agentSrc.includes("emitFileDiffEvent")
  ? pass("2a file_diff emitted from write_file tool handler")
  : fail("2a file_diff emission missing from write_file");

agentSrc.includes('op: "patch"') && agentSrc.includes("emitFileDiffEvent")
  ? pass("2b file_diff emitted from apply_patch tool handler")
  : fail("2b file_diff emission missing from apply_patch");

// jobs.ts emits updating_preview after pipeline completes
jobsSrc.includes("updating_preview")
  ? pass("2c updating_preview event emitted in jobs.ts build pipeline")
  : fail("2c updating_preview not found in jobs.ts");

// Frontend PreviewPane has refreshTrigger
previewSrc.includes("refreshTrigger")
  ? pass("2d PreviewPane uses refreshTrigger to reload iframe")
  : fail("2d PreviewPane refreshTrigger not found");

// refreshTrigger is wired to a useEffect that reloads the iframe
previewSrc.includes("prevRefreshTriggerRef") && previewSrc.includes("refreshTrigger !== prevRefreshTriggerRef.current")
  ? pass("2e refreshTrigger change detection fires iframe reload")
  : fail("2e refreshTrigger change detection not found");

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Failure behavior — write_file returns ok:false, no blind loop
// ─────────────────────────────────────────────────────────────────────────────
section("Test 3: Failure behavior");

// write_file tool handler: syncFailed → ok:false with BLOCKED message
agentSrc.includes("syncFailed") &&
agentSrc.includes("BLOCKED: write_file workspace save succeeded but container sync FAILED")
  ? pass("3a write_file returns ok:false when container sync fails")
  : fail("3a write_file ok:false branch not found");

// apply_patch tool handler: same check
agentSrc.includes("patchSyncFailed") &&
agentSrc.includes("BLOCKED: apply_patch workspace save succeeded but container sync FAILED")
  ? pass("3b apply_patch returns ok:false when container sync fails")
  : fail("3b apply_patch ok:false branch not found");

// ok:false propagates to consecutiveErrors (not silently reset to 0)
agentSrc.includes("if (lastError === observation) consecutiveErrors++") &&
agentSrc.includes("consecutiveErrors = 1;")
  ? pass("3c ok:false result increments consecutiveErrors (REPEATED_ERROR_CAP terminates after 3)")
  : fail("3c consecutiveErrors tracking not found");

// build timeline narrates "Blocked:" for repeated-error termination
agentSrc.includes('terminationReason === "repeated-error"') &&
agentSrc.includes("Blocked: file write to container failed repeatedly")
  ? pass("3d build timeline emits Blocked: narration for repeated-error")
  : fail("3d Blocked: narration for repeated-error not found");

// Agent does not continue past a failed write (ok:false short-circuits tool handler)
agentSrc.includes("if (syncFailed)") && agentSrc.includes("return {") &&
agentSrc.includes("Do NOT keep editing other files")
  ? pass("3e agent stops editing other files when sync fails (instruction in observation)")
  : fail("3e stop-editing instruction missing from sync-failed observation");

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Stuck-loop strategy-change detection
// ─────────────────────────────────────────────────────────────────────────────
section("Test 4: Stuck-loop strategy-change detection");

// Per-path failure map declared outside the per-step loop
agentSrc.includes("const pathConsecutiveCheckFails = new Map<string, number>()")
  ? pass("4a pathConsecutiveCheckFails map declared (persists across turns)")
  : fail("4a pathConsecutiveCheckFails map not found");

// Triggered after 2 consecutive failures on the same path
agentSrc.includes("STRATEGY CHANGE REQUIRED") &&
agentSrc.includes("pathConsecutiveCheckFails.get(p) ?? 0) >= 2")
  ? pass("4b STRATEGY CHANGE REQUIRED injected after 2 failures on same path")
  : fail("4b strategy-change trigger not found or wrong threshold");

// Path accumulation in BOTH parallel and serial tool-call paths
const hasParallelAccum =
  agentSrc.includes("_mutPath") && agentSrc.includes("mutatedPathsThisTurn.push(_mutPath)");
const hasSerialAccum =
  agentSrc.includes("_mutPathSerial") &&
  agentSrc.includes("mutatedPathsThisTurn.push(_mutPathSerial)");
hasParallelAccum && hasSerialAccum
  ? pass("4c mutatedPathsThisTurn accumulated in both parallel and serial call paths")
  : fail(
      "4c path accumulator missing — " +
        (!hasParallelAccum ? "parallel path" : "") +
        (!hasSerialAccum ? " serial path" : ""),
    );

// Per-path count resets when checks pass (no false-positive after recovery)
agentSrc.includes("pathConsecutiveCheckFails.delete(p)")
  ? pass("4d per-path failure count resets when checks pass")
  : fail("4d per-path reset on success not found");

// Strategy hint includes 5 concrete alternative approaches
agentSrc.includes("read_file the failing file and inspect what is actually on disk") &&
agentSrc.includes("read_file related imported modules") &&
agentSrc.includes("write_file the entire file from scratch") &&
agentSrc.includes("revert your changes")
  ? pass("4e strategy hint includes 4+ concrete alternative approaches")
  : fail("4e strategy hint alternatives incomplete");

// Repair loop prompt shows error progress between attempts
jobsSrc.includes("PROGRESS SINCE LAST ATTEMPT") &&
jobsSrc.includes("UNCHANGED (still failing)") &&
jobsSrc.includes("Try a DIFFERENT strategy")
  ? pass("4f repair loop prompt shows FIXED/UNCHANGED progress between attempts")
  : fail("4f repair loop progress section not found");

// Attempt number passed per repair cycle so context improves each attempt
// (call is multiline-formatted; check for the repairAttempt arg on its own line)
jobsSrc.includes("buildRepairPrompt(") && jobsSrc.includes("repairAttempt,")
  ? pass("4g attemptNumber passed to buildRepairPrompt each repair cycle")
  : fail("4g attemptNumber not passed to buildRepairPrompt");

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
console.log(failed === 0 ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED — see above");

await pool.end();
process.exit(failed === 0 ? 0 : 1);
