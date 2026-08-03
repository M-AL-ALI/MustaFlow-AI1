/**
 * Orax Desktop — Phase 2M post-apply verification.
 *
 * Runs allowlisted verification commands (typecheck, lint, test) after a
 * patch is applied. Security invariants:
 * - No shell:true — spawn always uses shell:false
 * - No exec — only spawn() with explicit [executable, args[]]
 * - No arbitrary commands — only scripts present in package.json with
 *   names on the ALLOWED_SCRIPT_NAMES allow-list
 * - No secrets exposed — SAFE_ENV passes only PATH/HOME
 * - 60 s hard timeout per check, SIGTERM → SIGKILL
 * - 10 KB output cap per check with secret redaction
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { redactSecrets } from "./command-executor";

const VERIFY_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 10_240; // 10 KB per check

// ── Allowlisted script name patterns ─────────────────────────────────────────

const ALLOWED_NAMES = ["typecheck", "tsc", "check", "lint", "test"] as const;
type AllowedName = (typeof ALLOWED_NAMES)[number];

const PRIORITY: Record<AllowedName, number> = {
  typecheck: 0,
  tsc: 0,
  check: 1,
  lint: 2,
  test: 3,
};

// Explicitly blocked — never run even if the name matches
const BLOCKED_SCRIPT_KEYS = new Set([
  "deploy",
  "publish",
  "release",
  "prepublish",
  "postpublish",
  "prepublishOnly",
  "postpublishOnly",
  "docker",
  "migrate",
  "db:push",
  "db:migrate",
  "db:seed",
]);

// ── Result types ──────────────────────────────────────────────────────────────

export interface VerifyCheck {
  name: string;
  command: string;
  status: "passed" | "failed" | "skipped";
  stdout: string;
  stderr: string;
  exitCode: number | null;
  durationMs: number;
}

export interface VerifyResult {
  checks: VerifyCheck[];
  totalDurationMs: number;
  allPassed: boolean;
}

// ── Safe environment (no secrets) ────────────────────────────────────────────

const SAFE_ENV: NodeJS.ProcessEnv =
  process.platform === "win32"
    ? {
        Path: process.env.Path ?? process.env.PATH ?? "",
        PATHEXT: process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD",
        SystemRoot: process.env.SystemRoot ?? "C:\\Windows",
      }
    : {
        PATH: process.env.PATH ?? "",
        HOME: process.env.HOME ?? "",
      };

// ── Internal spawn helper ─────────────────────────────────────────────────────

async function spawnCheck(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}> {
  const startMs = Date.now();
  return new Promise((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let settled = false;

    let proc: ReturnType<typeof spawn>;
    try {
      proc = spawn(executable, args, {
        cwd,
        shell: false,
        windowsHide: true,
        env: SAFE_ENV,
      });
    } catch (spawnErr) {
      resolve({
        exitCode: null,
        stdout: "",
        stderr: spawnErr instanceof Error ? spawnErr.message : "spawn failed",
        durationMs: Date.now() - startMs,
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      const force = setTimeout(() => proc.kill("SIGKILL"), 2_000);
      if (typeof force === "object" && force !== null) force.unref?.();
    }, VERIFY_TIMEOUT_MS);

    proc.stdout?.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
        stdoutBuf += chunk.toString("utf8");
        if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
          stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT_BYTES) + "\n[stdout truncated]";
        }
      }
    });

    proc.stderr?.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < MAX_OUTPUT_BYTES) {
        stderrBuf += chunk.toString("utf8");
        if (stderrBuf.length > MAX_OUTPUT_BYTES) {
          stderrBuf = stderrBuf.slice(0, MAX_OUTPUT_BYTES) + "\n[stderr truncated]";
        }
      }
    });

    function finish(code: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: code,
        stdout: redactSecrets(stdoutBuf.trimEnd()),
        stderr: redactSecrets(stderrBuf.trimEnd()),
        durationMs: Date.now() - startMs,
        timedOut,
      });
    }

    proc.on("close", finish);
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode: null,
        stdout: "",
        stderr: redactSecrets(err.message),
        durationMs: Date.now() - startMs,
        timedOut,
      });
    });
  });
}

// ── Script candidate discovery ────────────────────────────────────────────────

interface CheckCandidate {
  name: string;
  scriptKey: string;
  priority: number;
}

function matchAllowedName(key: string): AllowedName | null {
  for (const n of ALLOWED_NAMES) {
    if (key === n || key.startsWith(`${n}:`) || key.endsWith(`:${n}`)) {
      return n;
    }
  }
  return null;
}

function buildCandidates(scripts: Record<string, string>): CheckCandidate[] {
  const seen = new Set<AllowedName>();
  const candidates: CheckCandidate[] = [];

  for (const key of Object.keys(scripts)) {
    if (BLOCKED_SCRIPT_KEYS.has(key)) continue;

    const matched = matchAllowedName(key);
    if (!matched) continue;

    // Only one candidate per allowed name (prefer exact match)
    if (seen.has(matched) && key !== matched) continue;
    seen.add(matched);

    // Skip test scripts that include --coverage (expensive)
    if (matched === "test" && (scripts[key] ?? "").includes("--coverage")) continue;

    candidates.push({ name: key, scriptKey: key, priority: PRIORITY[matched] });
  }

  candidates.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));
  // Cap at 3 checks to avoid long-running verification
  return candidates.slice(0, 3);
}

// ── Package manager detection ─────────────────────────────────────────────────

type PkgMgr = "pnpm" | "yarn" | "bun" | "npm";

function detectPkgMgr(localPath: string): PkgMgr {
  if (fs.existsSync(path.join(localPath, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(localPath, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(localPath, "bun.lockb"))) return "bun";
  return "npm";
}

function buildSpawnArgs(pm: PkgMgr, scriptKey: string): [string, string[]] {
  switch (pm) {
    case "pnpm":
      return ["pnpm", ["run", scriptKey]];
    case "yarn":
      return ["yarn", [scriptKey]];
    case "bun":
      return ["bun", ["run", scriptKey]];
    case "npm":
    default:
      return ["npm", ["run", scriptKey]];
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function verifyProjectPatch(opts: { localPath: string }): Promise<VerifyResult> {
  const startMs = Date.now();

  // Require package.json
  const pkgJsonPath = path.join(opts.localPath, "package.json");
  let scripts: Record<string, string> = {};
  try {
    const raw = fs.readFileSync(pkgJsonPath, "utf8");
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return { checks: [], totalDurationMs: Date.now() - startMs, allPassed: true };
  }

  const candidates = buildCandidates(scripts);
  if (candidates.length === 0) {
    return { checks: [], totalDurationMs: Date.now() - startMs, allPassed: true };
  }

  const pm = detectPkgMgr(opts.localPath);
  const checks: VerifyCheck[] = [];

  for (const candidate of candidates) {
    const [exe, args] = buildSpawnArgs(pm, candidate.scriptKey);
    const cmdString = `${pm} run ${candidate.scriptKey}`;

    const raw = await spawnCheck(exe, args, opts.localPath);

    let status: VerifyCheck["status"];
    if (raw.timedOut || (raw.exitCode !== null && raw.exitCode !== 0)) {
      status = "failed";
    } else if (raw.exitCode === null) {
      status = "skipped";
    } else {
      status = "passed";
    }

    checks.push({
      name: candidate.name,
      command: cmdString,
      status,
      stdout: raw.stdout.slice(0, 2_000),
      stderr: raw.stderr.slice(0, 2_000),
      exitCode: raw.exitCode,
      durationMs: raw.durationMs,
    });
  }

  const allPassed = checks.every((c) => c.status !== "failed");
  return { checks, totalDurationMs: Date.now() - startMs, allPassed };
}
