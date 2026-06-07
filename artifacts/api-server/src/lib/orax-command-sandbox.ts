import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { OraxSandboxCheck, OraxSandboxPatchedFile } from "./orax-sandbox";

const execFileAsync = promisify(execFile);

export const ORAX_SANDBOX_COMMAND_IDS = [
  "patch-static-checks",
  "json-syntax",
  "node-syntax",
] as const;

export type OraxSandboxCommandId = (typeof ORAX_SANDBOX_COMMAND_IDS)[number];

export type OraxCommandResult = {
  id: OraxSandboxCommandId;
  label: string;
  status: "passed" | "failed" | "skipped";
  exitCode: number | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  message: string;
};

export type OraxControlledSandboxResult = {
  mode: "controlled_sandbox_execution";
  passed: boolean;
  commands: OraxCommandResult[];
  blockedCommands: string[];
  summary: string;
};

const COMMAND_LABELS: Record<OraxSandboxCommandId, string> = {
  "patch-static-checks": "Patch static checks",
  "json-syntax": "JSON syntax check",
  "node-syntax": "Node JavaScript syntax check",
};

const DEFAULT_COMMANDS: OraxSandboxCommandId[] = ["patch-static-checks", "json-syntax"];
const MAX_COMMANDS = 3;
const EXEC_TIMEOUT_MS = 5000;
const OUTPUT_LIMIT = 4000;

export function normalizeOraxSandboxCommandIds(commands?: string[]): OraxSandboxCommandId[] {
  const requested = commands?.length ? commands : DEFAULT_COMMANDS;
  const normalized: OraxSandboxCommandId[] = [];
  const blocked: string[] = [];

  for (const command of requested) {
    const value = command.trim();
    if (ORAX_SANDBOX_COMMAND_IDS.includes(value as OraxSandboxCommandId)) {
      if (!normalized.includes(value as OraxSandboxCommandId)) {
        normalized.push(value as OraxSandboxCommandId);
      }
    } else {
      blocked.push(value);
    }
  }

  if (blocked.length) {
    throw new Error(`Unsupported ORAX sandbox command: ${blocked.join(", ")}`);
  }
  if (!normalized.length) {
    throw new Error("At least one ORAX sandbox command is required");
  }
  if (normalized.length > MAX_COMMANDS) {
    throw new Error(`At most ${MAX_COMMANDS} ORAX sandbox commands can run at once`);
  }
  return normalized;
}

export async function runOraxControlledSandboxChecks(input: {
  commands: OraxSandboxCommandId[];
  patchedFiles: OraxSandboxPatchedFile[];
  staticChecks: OraxSandboxCheck[];
}): Promise<OraxControlledSandboxResult> {
  const results: OraxCommandResult[] = [];

  for (const command of input.commands) {
    if (command === "patch-static-checks") {
      results.push(runPatchStaticChecks(input.staticChecks));
    } else if (command === "json-syntax") {
      results.push(runJsonSyntaxCheck(input.patchedFiles));
    } else if (command === "node-syntax") {
      results.push(await runNodeSyntaxCheck(input.patchedFiles));
    }
  }

  const failed = results.filter((result) => result.status === "failed");
  return {
    mode: "controlled_sandbox_execution",
    passed: failed.length === 0,
    commands: results,
    blockedCommands: [],
    summary: failed.length
      ? `${failed.length} controlled check(s) failed.`
      : "All controlled sandbox checks passed.",
  };
}

function runPatchStaticChecks(staticChecks: OraxSandboxCheck[]): OraxCommandResult {
  const started = Date.now();
  const failed = staticChecks.filter((check) => check.status === "failed");
  const skipped = staticChecks.filter((check) => check.status === "not_run");
  return {
    id: "patch-static-checks",
    label: COMMAND_LABELS["patch-static-checks"],
    status: failed.length ? "failed" : "passed",
    exitCode: failed.length ? 1 : 0,
    durationMs: Date.now() - started,
    stdout: staticChecks
      .map((check) => `${check.status}: ${check.name} - ${check.message}`)
      .join("\n"),
    stderr: failed.map((check) => check.message).join("\n"),
    message: failed.length
      ? `${failed.length} static patch check(s) failed.`
      : `Static patch checks passed${skipped.length ? ` with ${skipped.length} preview-only check(s).` : "."}`,
  };
}

function runJsonSyntaxCheck(files: OraxSandboxPatchedFile[]): OraxCommandResult {
  const started = Date.now();
  const jsonFiles = files.filter((file) => file.path.toLowerCase().endsWith(".json"));
  if (!jsonFiles.length) {
    return skippedResult("json-syntax", "No patched JSON files were present.");
  }

  const errors: string[] = [];
  for (const file of jsonFiles) {
    try {
      JSON.parse(file.content);
    } catch (err) {
      errors.push(`${file.path}: ${err instanceof Error ? err.message : "JSON parse failed"}`);
    }
  }

  return {
    id: "json-syntax",
    label: COMMAND_LABELS["json-syntax"],
    status: errors.length ? "failed" : "passed",
    exitCode: errors.length ? 1 : 0,
    durationMs: Date.now() - started,
    stdout: errors.length ? "" : `Parsed ${jsonFiles.length} JSON file(s).`,
    stderr: errors.join("\n"),
    message: errors.length ? "JSON syntax failed." : "JSON syntax passed.",
  };
}

async function runNodeSyntaxCheck(files: OraxSandboxPatchedFile[]): Promise<OraxCommandResult> {
  const started = Date.now();
  const jsFiles = files.filter((file) => /\.(?:mjs|cjs|js)$/i.test(file.path));
  if (!jsFiles.length) {
    return skippedResult("node-syntax", "No patched JavaScript files were present.");
  }

  const root = path.join(
    tmpdir(),
    `orax-check-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const stdout: string[] = [];
  const stderr: string[] = [];
  let failed = false;

  try {
    for (const file of jsFiles) {
      const target = resolveSandboxPath(root, file.path);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content, "utf8");
      try {
        const result = await execFileAsync(process.execPath, ["--check", target], {
          cwd: root,
          timeout: EXEC_TIMEOUT_MS,
          maxBuffer: 64 * 1024,
          env: { PATH: process.env.PATH ?? "" },
        });
        if (result.stdout) stdout.push(`${file.path}\n${result.stdout}`);
        if (result.stderr) stderr.push(`${file.path}\n${result.stderr}`);
      } catch (err) {
        failed = true;
        stderr.push(`${file.path}\n${formatExecError(err)}`);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }

  return {
    id: "node-syntax",
    label: COMMAND_LABELS["node-syntax"],
    status: failed ? "failed" : "passed",
    exitCode: failed ? 1 : 0,
    durationMs: Date.now() - started,
    stdout: truncate(stdout.join("\n")),
    stderr: truncate(stderr.join("\n")),
    message: failed
      ? "Node syntax check failed."
      : `Node syntax passed for ${jsFiles.length} file(s).`,
  };
}

function skippedResult(id: OraxSandboxCommandId, message: string): OraxCommandResult {
  return {
    id,
    label: COMMAND_LABELS[id],
    status: "skipped",
    exitCode: null,
    durationMs: 0,
    stdout: "",
    stderr: "",
    message,
  };
}

function resolveSandboxPath(root: string, filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.includes("../") ||
    normalized === ".."
  ) {
    throw new Error(`Unsafe ORAX sandbox path: ${filePath}`);
  }
  const resolved = path.resolve(root, normalized);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    throw new Error(`Unsafe ORAX sandbox path: ${filePath}`);
  }
  return resolved;
}

function formatExecError(err: unknown): string {
  if (err && typeof err === "object") {
    const record = err as { stdout?: unknown; stderr?: unknown; message?: unknown };
    return truncate(
      [record.stdout, record.stderr, record.message]
        .filter((value): value is string => typeof value === "string" && value.length > 0)
        .join("\n"),
    );
  }
  return String(err);
}

function truncate(value: string): string {
  return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}\n...[truncated]` : value;
}
