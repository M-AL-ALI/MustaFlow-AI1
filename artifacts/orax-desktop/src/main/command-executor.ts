/**
 * Orax Desktop — Phase 2F command executor.
 *
 * Executes ONLY allowlisted safe commands.
 * Never uses child_process.exec, never enables shell interpolation, never accepts arbitrary input.
 *
 * Security properties:
 * - pwd / echo / dir / Get-ChildItem implemented via Node fs APIs — no subprocess
 * - version checks (node/npm/pnpm/git) use spawn() with explicit args, shell: false
 * - Minimal safe env: only PATH/PATHEXT/SystemRoot passed to child processes
 * - 30s hard timeout, SIGTERM → SIGKILL
 * - 20 KB stdout cap, 20 KB stderr cap
 * - Secret redaction applied to all output
 */

import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";

export const TIMEOUT_MS = 30_000;
export const MAX_OUTPUT_BYTES = 20_480; // 20 KB

export interface CommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
}

// ── Minimal safe environment for spawned processes ───────────────────────────
// Never spread process.env into child processes — that leaks API keys, tokens,
// and other secrets. Only include what is needed to locate executables.

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

// ── Version commands: spawn with explicit args, no shell ────────────────────
// These are the ONLY commands that use a subprocess. All others use Node APIs.

const VERSION_SPAWN_MAP: Map<string, [string, string[]]> = new Map([
  ["node --version", ["node", ["--version"]]],
  ["npm --version", ["npm", ["--version"]]],
  ["pnpm --version", ["pnpm", ["--version"]]],
  ["git --version", ["git", ["--version"]]],
]);

// ── Secret redaction ────────────────────────────────────────────────────────

export function redactSecrets(output: string): string {
  return output
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_SK]")
    .replace(/\bghp_[A-Za-z0-9_]{10,}/g, "[REDACTED_GHP]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{10,}/g, "[REDACTED_PAT]")
    .replace(/Bearer\s+[A-Za-z0-9_.\\-]{10,}/g, "Bearer [REDACTED]")
    .replace(/[A-Z][A-Z0-9_]{2,}_(?:API_)?KEY\s*=\s*\S+/g, "[REDACTED_KEY]");
}

// ── Node API implementations (no subprocess) ─────────────────────────────────
// pwd, echo, dir /b, Get-ChildItem -Name are implemented here using Node fs
// APIs so no Windows shell interpreter or native shell binary is ever spawned.

async function nodeApiCommand(command: string, cwd?: string): Promise<CommandResult | null> {
  const startMs = Date.now();
  const effectiveCwd = cwd ?? process.cwd();

  if (command === "pwd") {
    return {
      exitCode: 0,
      stdout: redactSecrets(effectiveCwd),
      stderr: "",
      durationMs: Date.now() - startMs,
      timedOut: false,
    };
  }

  const echoMatch = command.match(/^echo ([ -~]{1,200})$/);
  if (echoMatch) {
    return {
      exitCode: 0,
      stdout: redactSecrets(echoMatch[1]!),
      stderr: "",
      durationMs: Date.now() - startMs,
      timedOut: false,
    };
  }

  if (command === "dir /b" || command === "Get-ChildItem -Name") {
    try {
      const entries = await readdir(effectiveCwd);
      return {
        exitCode: 0,
        stdout: redactSecrets(entries.join("\n")),
        stderr: "",
        durationMs: Date.now() - startMs,
        timedOut: false,
      };
    } catch (err) {
      return {
        exitCode: 1,
        stdout: "",
        stderr: err instanceof Error ? err.message : "readdir failed",
        durationMs: Date.now() - startMs,
        timedOut: false,
      };
    }
  }

  return null;
}

// ── Main executor ────────────────────────────────────────────────────────────

export async function executeCommand(
  command: string,
  cwd?: string,
): Promise<CommandResult> {
  const trimmed = command.trim();

  const nodeResult = await nodeApiCommand(trimmed, cwd);
  if (nodeResult) return nodeResult;

  const spawnArgs = VERSION_SPAWN_MAP.get(trimmed);
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
      env: SAFE_ENV,
    });

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
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
