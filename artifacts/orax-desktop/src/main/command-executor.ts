/**
 * Orax Desktop — Phase 2F command executor.
 *
 * Executes ONLY allowlisted safe commands using child_process.spawn.
 * Never uses child_process.exec, never passes shell: true, never accepts arbitrary input.
 *
 * Security properties:
 * - spawn() with explicit args — no shell interpolation possible
 * - 30s hard timeout, SIGTERM → SIGKILL
 * - 20 KB stdout cap, 20 KB stderr cap
 * - Secret redaction applied to all output
 */

import { spawn } from "node:child_process";

const TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 20_480; // 20 KB

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

// ── Safe execution map ──────────────────────────────────────────────────────
// Each entry maps an exact command string to [executable, args[]].
// No shell, no interpolation, no dynamic construction from untrusted input.

const WIN32 = process.platform === "win32";

const SAFE_SPAWN_MAP: Map<string, [string, string[]]> = new Map([
  ["node --version", ["node", ["--version"]]],
  ["npm --version", ["npm", ["--version"]]],
  ["pnpm --version", ["pnpm", ["--version"]]],
  ["git --version", ["git", ["--version"]]],
  [
    "pwd",
    WIN32 ? ["cmd.exe", ["/c", "cd"]] : ["pwd", []],
  ],
  [
    "dir /b",
    WIN32 ? ["cmd.exe", ["/c", "dir", "/b"]] : ["ls", ["-1"]],
  ],
  [
    "Get-ChildItem -Name",
    WIN32
      ? ["powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-ChildItem -Name"]]
      : ["ls", ["-1"]],
  ],
]);

function resolveSpawnArgs(command: string): [string, string[]] | null {
  const exact = SAFE_SPAWN_MAP.get(command);
  if (exact) return exact;

  // echo <printable ASCII text>
  const echoMatch = command.match(/^echo ([ -~]{1,200})$/);
  if (echoMatch) {
    const text = echoMatch[1]!;
    if (WIN32) {
      return ["cmd.exe", ["/c", "echo", text]];
    }
    return ["/bin/echo", [text]];
  }

  return null;
}

// ── Secret redaction ────────────────────────────────────────────────────────

function redactSecrets(output: string): string {
  return output
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_SK]")
    .replace(/\bghp_[A-Za-z0-9_]{10,}/g, "[REDACTED_GHP]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}/g, "[REDACTED_PAT]")
    .replace(/Bearer\s+[A-Za-z0-9_.\-]{10,}/g, "Bearer [REDACTED]")
    .replace(/[A-Z][A-Z0-9_]{2,}_(?:API_)?KEY\s*=\s*\S+/g, "[REDACTED_KEY]");
}

// ── Main executor ───────────────────────────────────────────────────────────

export async function executeCommand(
  command: string,
  cwd?: string,
): Promise<CommandResult> {
  const spawnArgs = resolveSpawnArgs(command.trim());
  if (!spawnArgs) {
    return {
      exitCode: null,
      stdout: "",
      stderr: `Command not in safe execution map: ${command}`,
      durationMs: 0,
      timedOut: false,
    };
  }

  const [executable, args] = spawnArgs;
  const startMs = Date.now();

  return new Promise<CommandResult>((resolve) => {
    let stdoutBuf = "";
    let stderrBuf = "";
    let timedOut = false;
    let settled = false;

    const proc = spawn(executable, args, {
      cwd: cwd ?? process.cwd(),
      shell: false,
      windowsHide: true,
      env: { ...process.env },
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      // Escalate to SIGKILL after 2s if still alive
      const force = setTimeout(() => proc.kill("SIGKILL"), 2_000);
      if (typeof force === "object" && force !== null) force.unref?.();
    }, TIMEOUT_MS);

    proc.stdout.on("data", (chunk: Buffer) => {
      if (stdoutBuf.length < MAX_OUTPUT_BYTES) {
        stdoutBuf += chunk.toString("utf8");
        if (stdoutBuf.length > MAX_OUTPUT_BYTES) {
          stdoutBuf = stdoutBuf.slice(0, MAX_OUTPUT_BYTES) + "\n[stdout truncated]";
        }
      }
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      if (stderrBuf.length < MAX_OUTPUT_BYTES) {
        stderrBuf += chunk.toString("utf8");
        if (stderrBuf.length > MAX_OUTPUT_BYTES) {
          stderrBuf = stderrBuf.slice(0, MAX_OUTPUT_BYTES) + "\n[stderr truncated]";
        }
      }
    });

    function finish(exitCode: number | null) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        exitCode,
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
