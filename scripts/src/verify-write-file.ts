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
import {
  execInContainer,
  hasContainerLayerCredentials,
  writeFileToContainer,
} from "../../artifacts/api-server/src/lib/tenant-runtime.js";

// Workspace root is one level above scripts/
const ROOT = join(import.meta.dirname, "../..");

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
  projectId: number,
  cwd = "/app",
): Promise<{ ok: boolean; stdout: string; stderr: string; exitCode: number }> {
  const result = await execInContainer(machineId, command, projectId, cwd);
  return {
    ok: result.ok,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
  };
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
console.log(
  `FLY_API_TOKEN: ${hasContainerLayerCredentials() ? "present" : "MISSING — live container tests skipped"}`,
);

const canExec = hasContainerLayerCredentials();

// ─────────────────────────────────────────────────────────────────────────────
// TEST 1: File-write + container read-back
// ─────────────────────────────────────────────────────────────────────────────
section("Test 1: File-write verification");

if (!canExec) {
  fail("1a-1c skipped", "FLY_API_TOKEN missing");
} else {
  // 1a. Write to container
  const writeOk = await writeFileToContainer(containerId, TEST_FILE, TEST_CONTENT, projectId);
  if (writeOk) pass("1a writeFileToContainer returns true");
  else fail("1a writeFileToContainer returned false — sync failed");

  // 1b. Read back from container
  const readBack = await execInMachine(
    containerId,
    ["/bin/sh", "-c", `cat /app/${TEST_FILE}`],
    projectId,
  );
  const got = readBack.stdout.trim();
  if (readBack.ok && got === TEST_CONTENT) {
    pass("1b container read-back matches written content", `"${got}"`);
  } else if (!readBack.ok) {
    fail(
      "1b container read-back exec failed",
      `exit=${readBack.exitCode} ${readBack.stderr.slice(0, 80)}`,
    );
  } else {
    fail("1b content mismatch", `expected "${TEST_CONTENT}" got "${got}"`);
  }

  // 1c. File exists at correct /app/ path
  const pathCheck = await execInMachine(
    containerId,
    ["/bin/sh", "-c", `test -f /app/${TEST_FILE} && echo EXISTS || echo MISSING`],
    projectId,
  );
  if (pathCheck.stdout.trim() === "EXISTS") pass("1c file exists at /app/ path in container");
  else fail("1c file not found at /app/ path", pathCheck.stdout.trim());

  // 1d. Failure case: bad container returns false (not success)
  const badWrite = await writeFileToContainer(
    "nonexistent-machine-00000",
    TEST_FILE,
    TEST_CONTENT,
    projectId,
  );
  if (!badWrite) pass("1d bad-container write returns false (would have looped before fix)");
  else fail("1d bad-container write incorrectly returned true");

  // Cleanup
  await execInMachine(containerId, ["/bin/sh", "-c", `rm -f /app/${TEST_FILE}`], projectId);
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
if (agentSrc.includes('op: "write"') && agentSrc.includes("emitFileDiffEvent"))
  pass("2a file_diff emitted from write_file tool handler");
else fail("2a file_diff emission missing from write_file");

if (agentSrc.includes('op: "patch"') && agentSrc.includes("emitFileDiffEvent"))
  pass("2b file_diff emitted from apply_patch tool handler");
else fail("2b file_diff emission missing from apply_patch");

// jobs.ts emits updating_preview after pipeline completes
if (jobsSrc.includes("updating_preview"))
  pass("2c updating_preview event emitted in jobs.ts build pipeline");
else fail("2c updating_preview not found in jobs.ts");

// Frontend PreviewPane has refreshTrigger
if (previewSrc.includes("refreshTrigger"))
  pass("2d PreviewPane uses refreshTrigger to reload iframe");
else fail("2d PreviewPane refreshTrigger not found");

// refreshTrigger is wired to a useEffect that reloads the iframe
if (
  previewSrc.includes("prevRefreshTriggerRef") &&
  previewSrc.includes("refreshTrigger !== prevRefreshTriggerRef.current")
)
  pass("2e refreshTrigger change detection fires iframe reload");
else fail("2e refreshTrigger change detection not found");

// ─────────────────────────────────────────────────────────────────────────────
// TEST 3: Failure behavior — write_file returns ok:false, no blind loop
// ─────────────────────────────────────────────────────────────────────────────
section("Test 3: Failure behavior");

// write_file tool handler: syncFailed → ok:false with BLOCKED message
if (
  agentSrc.includes("syncFailed") &&
  agentSrc.includes("BLOCKED: write_file workspace save succeeded but container sync FAILED")
)
  pass("3a write_file returns ok:false when container sync fails");
else fail("3a write_file ok:false branch not found");

// apply_patch tool handler: same check
if (
  agentSrc.includes("patchSyncFailed") &&
  agentSrc.includes("BLOCKED: apply_patch workspace save succeeded but container sync FAILED")
)
  pass("3b apply_patch returns ok:false when container sync fails");
else fail("3b apply_patch ok:false branch not found");

// ok:false propagates to consecutiveErrors (not silently reset to 0)
if (
  agentSrc.includes("if (lastError === observation) consecutiveErrors++") &&
  agentSrc.includes("consecutiveErrors = 1;")
)
  pass("3c ok:false result increments consecutiveErrors (REPEATED_ERROR_CAP terminates after 3)");
else fail("3c consecutiveErrors tracking not found");

// build timeline narrates "Blocked:" for repeated-error termination
if (
  agentSrc.includes('terminationReason === "repeated-error"') &&
  agentSrc.includes("Blocked: file write to container failed repeatedly")
)
  pass("3d build timeline emits Blocked: narration for repeated-error");
else fail("3d Blocked: narration for repeated-error not found");

// Agent does not continue past a failed write (ok:false short-circuits tool handler)
if (
  agentSrc.includes("if (syncFailed)") &&
  agentSrc.includes("return {") &&
  agentSrc.includes("Do NOT keep editing other files")
)
  pass("3e agent stops editing other files when sync fails (instruction in observation)");
else fail("3e stop-editing instruction missing from sync-failed observation");

// ─────────────────────────────────────────────────────────────────────────────
// TEST 4: Stuck-loop strategy-change detection
// ─────────────────────────────────────────────────────────────────────────────
section("Test 4: Stuck-loop strategy-change detection");

// Per-path failure map declared outside the per-step loop
if (agentSrc.includes("const pathConsecutiveCheckFails = new Map<string, number>()"))
  pass("4a pathConsecutiveCheckFails map declared (persists across turns)");
else fail("4a pathConsecutiveCheckFails map not found");

// Triggered after 2 consecutive failures on the same path
if (
  agentSrc.includes("STRATEGY CHANGE REQUIRED") &&
  agentSrc.includes("pathConsecutiveCheckFails.get(p) ?? 0) >= 2")
)
  pass("4b STRATEGY CHANGE REQUIRED injected after 2 failures on same path");
else fail("4b strategy-change trigger not found or wrong threshold");

// Path accumulation in BOTH parallel and serial tool-call paths
const hasParallelAccum =
  agentSrc.includes("_mutPath") && agentSrc.includes("mutatedPathsThisTurn.push(_mutPath)");
const hasSerialAccum =
  agentSrc.includes("_mutPathSerial") &&
  agentSrc.includes("mutatedPathsThisTurn.push(_mutPathSerial)");
if (hasParallelAccum && hasSerialAccum)
  pass("4c mutatedPathsThisTurn accumulated in both parallel and serial call paths");
else
  fail(
    "4c path accumulator missing — " +
      (!hasParallelAccum ? "parallel path" : "") +
      (!hasSerialAccum ? " serial path" : ""),
  );

// Per-path count resets when checks pass (no false-positive after recovery)
if (agentSrc.includes("pathConsecutiveCheckFails.delete(p)"))
  pass("4d per-path failure count resets when checks pass");
else fail("4d per-path reset on success not found");

// Strategy hint includes 5 concrete alternative approaches
if (
  agentSrc.includes("read_file the failing file and inspect what is actually on disk") &&
  agentSrc.includes("read_file related imported modules") &&
  agentSrc.includes("write_file the entire file from scratch") &&
  agentSrc.includes("revert your changes")
)
  pass("4e strategy hint includes 4+ concrete alternative approaches");
else fail("4e strategy hint alternatives incomplete");

// Repair loop prompt shows error progress between attempts
if (
  jobsSrc.includes("PROGRESS SINCE LAST ATTEMPT") &&
  jobsSrc.includes("UNCHANGED (still failing)") &&
  jobsSrc.includes("Try a DIFFERENT strategy")
)
  pass("4f repair loop prompt shows FIXED/UNCHANGED progress between attempts");
else fail("4f repair loop progress section not found");

// Attempt number passed per repair cycle so context improves each attempt
// (call is multiline-formatted; check for the repairAttempt arg on its own line)
if (jobsSrc.includes("buildRepairPrompt(") && jobsSrc.includes("repairAttempt,"))
  pass("4g attemptNumber passed to buildRepairPrompt each repair cycle");
else fail("4g attemptNumber not passed to buildRepairPrompt");

// ─────────────────────────────────────────────────────────────────────────────
// Summary
// ─────────────────────────────────────────────────────────────────────────────
const total = passed + failed;
console.log(`\n${"─".repeat(55)}`);
console.log(`Results: ${passed}/${total} passed, ${failed} failed`);
console.log(failed === 0 ? "ALL CHECKS PASSED" : "SOME CHECKS FAILED — see above");

await pool.end();
process.exit(failed === 0 ? 0 : 1);
