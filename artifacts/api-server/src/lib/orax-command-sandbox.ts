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
  "pnpm-typecheck",
  "pnpm-lint",
  "pnpm-test",
  "pnpm-build",
] as const;

export type OraxSandboxCommandId = (typeof ORAX_SANDBOX_COMMAND_IDS)[number];
export type OraxWorkspaceCommandId = Extract<
  OraxSandboxCommandId,
  "pnpm-typecheck" | "pnpm-lint" | "pnpm-test" | "pnpm-build"
>;

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
  mode: "controlled_sandbox_execution" | "isolated_workspace_execution";
  passed: boolean;
  commands: OraxCommandResult[];
  blockedCommands: string[];
  summary: string;
};

const COMMAND_LABELS: Record<OraxSandboxCommandId, string> = {
  "patch-static-checks": "Patch static checks",
  "json-syntax": "JSON syntax check",
  "node-syntax": "Node JavaScript syntax check",
  "pnpm-typecheck": "pnpm run typecheck",
  "pnpm-lint": "pnpm run lint",
  "pnpm-test": "pnpm test",
  "pnpm-build": "pnpm run build",
};

const WORKSPACE_COMMANDS: Record<
  OraxWorkspaceCommandId,
  { executable: string; args: string[]; timeoutMs: number }
> = {
  "pnpm-typecheck": {
    executable: "corepack",
    args: ["pnpm", "run", "typecheck"],
    timeoutMs: 180_000,
  },
  "pnpm-lint": {
    executable: "corepack",
    args: ["pnpm", "run", "lint"],
    timeoutMs: 180_000,
  },
  "pnpm-test": {
    executable: "corepack",
    args: ["pnpm", "test"],
    timeoutMs: 180_000,
  },
  "pnpm-build": {
    executable: "corepack",
    args: ["pnpm", "run", "build"],
    timeoutMs: 180_000,
  },
};

const DEFAULT_COMMANDS: OraxSandboxCommandId[] = ["patch-static-checks", "json-syntax"];
export const ORAX_MAX_SANDBOX_COMMANDS = ORAX_SANDBOX_COMMAND_IDS.length;
const EXEC_TIMEOUT_MS = 5000;
const EXTRACT_TIMEOUT_MS = 30_000;
const OUTPUT_LIMIT = 4000;
const WORKSPACE_OUTPUT_BUFFER = 512 * 1024;

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
  if (normalized.length > ORAX_MAX_SANDBOX_COMMANDS) {
    throw new Error(`At most ${ORAX_MAX_SANDBOX_COMMANDS} ORAX sandbox commands can run at once`);
  }
  return normalized;
}

export function hasOraxWorkspaceCommandIds(commands: OraxSandboxCommandId[]): boolean {
  return commands.some(isOraxWorkspaceCommandId);
}

export async function runOraxControlledSandboxChecks(input: {
  commands: OraxSandboxCommandId[];
  patchedFiles: OraxSandboxPatchedFile[];
  staticChecks: OraxSandboxCheck[];
}): Promise<OraxControlledSandboxResult> {
  const results: OraxCommandResult[] = [];

  for (const command of input.commands) {
    if (isOraxWorkspaceCommandId(command)) {
      results.push(
        failedResult(
          command,
          "Workspace package commands require the isolated workspace runner.",
          "No repository archive was provided to the controlled sandbox runner.",
        ),
      );
    } else {
      results.push(await runStaticCommand(command, input.patchedFiles, input.staticChecks));
    }
  }

  return summarizeCommandResults("controlled_sandbox_execution", results);
}

export async function runOraxIsolatedWorkspaceChecks(input: {
  commands: OraxSandboxCommandId[];
  patchedFiles: OraxSandboxPatchedFile[];
  staticChecks: OraxSandboxCheck[];
  repositoryArchive?: Buffer | null;
}): Promise<OraxControlledSandboxResult> {
  const results: OraxCommandResult[] = [];
  const needsWorkspace = hasOraxWorkspaceCommandIds(input.commands);
  let workspace: { root: string; repoRoot: string } | null = null;
  let workspaceError: string | null = null;

  if (needsWorkspace) {
    if (!input.repositoryArchive?.length) {
      workspaceError = "Repository archive is required for workspace package checks.";
    } else {
      try {
        workspace = await prepareIsolatedWorkspace(input.repositoryArchive, input.patchedFiles);
      } catch (err) {
        workspaceError =
          err instanceof Error ? err.message : "Could not prepare isolated ORAX workspace.";
      }
    }
  }

  try {
    for (const command of input.commands) {
      if (isOraxWorkspaceCommandId(command)) {
        if (!workspace || workspaceError) {
          results.push(
            failedResult(command, "Could not prepare isolated workspace.", workspaceError ?? ""),
          );
        } else {
          results.push(await runWorkspaceCommand(command, workspace.root, workspace.repoRoot));
        }
      } else {
        results.push(await runStaticCommand(command, input.patchedFiles, input.staticChecks));
      }
    }
  } finally {
    if (workspace) {
      await rm(workspace.root, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return summarizeCommandResults(
    needsWorkspace ? "isolated_workspace_execution" : "controlled_sandbox_execution",
    results,
  );
}

async function runStaticCommand(
  command: Exclude<OraxSandboxCommandId, OraxWorkspaceCommandId>,
  patchedFiles: OraxSandboxPatchedFile[],
  staticChecks: OraxSandboxCheck[],
): Promise<OraxCommandResult> {
  if (command === "patch-static-checks") {
    return runPatchStaticChecks(staticChecks);
  }
  if (command === "json-syntax") {
    return runJsonSyntaxCheck(patchedFiles);
  }
  return runNodeSyntaxCheck(patchedFiles);
}

function summarizeCommandResults(
  mode: OraxControlledSandboxResult["mode"],
  results: OraxCommandResult[],
): OraxControlledSandboxResult {
  const failed = results.filter((result) => result.status === "failed");
  return {
    mode,
    passed: failed.length === 0,
    commands: results,
    blockedCommands: [],
    summary: failed.length
      ? `${failed.length} ORAX check(s) failed.`
      : mode === "isolated_workspace_execution"
        ? "All ORAX checks passed in the isolated workspace."
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

async function prepareIsolatedWorkspace(
  repositoryArchive: Buffer,
  patchedFiles: OraxSandboxPatchedFile[],
): Promise<{ root: string; repoRoot: string }> {
  const root = path.join(
    tmpdir(),
    `orax-workspace-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const repoRoot = path.join(root, "repo");
  const archivePath = path.join(root, "repo.tar.gz");
  const tempPath = path.join(root, "tmp");

  await mkdir(repoRoot, { recursive: true });
  await mkdir(tempPath, { recursive: true });
  await writeFile(archivePath, repositoryArchive);
  await execFileAsync("tar", ["-xzf", archivePath, "-C", repoRoot, "--strip-components=1"], {
    cwd: root,
    timeout: EXTRACT_TIMEOUT_MS,
    maxBuffer: 64 * 1024,
    env: sanitizedWorkspaceEnv(root),
  });

  for (const file of patchedFiles) {
    const target = resolveSandboxPath(repoRoot, file.path);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }

  return { root, repoRoot };
}

async function runWorkspaceCommand(
  command: OraxWorkspaceCommandId,
  workspaceRoot: string,
  repoRoot: string,
): Promise<OraxCommandResult> {
  const started = Date.now();
  const config = WORKSPACE_COMMANDS[command];
  try {
    const result = await execFileAsync(config.executable, config.args, {
      cwd: repoRoot,
      timeout: config.timeoutMs,
      maxBuffer: WORKSPACE_OUTPUT_BUFFER,
      env: sanitizedWorkspaceEnv(workspaceRoot),
    });
    return {
      id: command,
      label: COMMAND_LABELS[command],
      status: "passed",
      exitCode: 0,
      durationMs: Date.now() - started,
      stdout: truncate(result.stdout ?? ""),
      stderr: truncate(result.stderr ?? ""),
      message: `${COMMAND_LABELS[command]} passed inside the isolated workspace.`,
    };
  } catch (err) {
    const output = extractExecOutput(err);
    return {
      id: command,
      label: COMMAND_LABELS[command],
      status: "failed",
      exitCode: output.exitCode,
      durationMs: Date.now() - started,
      stdout: truncate(output.stdout),
      stderr: truncate(output.stderr || output.message),
      message: `${COMMAND_LABELS[command]} failed inside the isolated workspace.`,
    };
  }
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

function failedResult(
  id: OraxSandboxCommandId,
  message: string,
  stderr: string,
): OraxCommandResult {
  return {
    id,
    label: COMMAND_LABELS[id],
    status: "failed",
    exitCode: 1,
    durationMs: 0,
    stdout: "",
    stderr: truncate(stderr),
    message,
  };
}

function isOraxWorkspaceCommandId(
  command: OraxSandboxCommandId,
): command is OraxWorkspaceCommandId {
  return command in WORKSPACE_COMMANDS;
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

function sanitizedWorkspaceEnv(root: string): NodeJS.ProcessEnv {
  const tempPath = path.join(root, "tmp");
  return {
    PATH: process.env.PATH ?? "",
    CI: "true",
    NO_COLOR: "1",
    HOME: root,
    TMPDIR: tempPath,
    TMP: tempPath,
    TEMP: tempPath,
    PNPM_HOME: path.join(root, ".pnpm-home"),
    npm_config_cache: path.join(root, ".npm-cache"),
    npm_config_store_dir: path.join(root, ".pnpm-store"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
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

function extractExecOutput(err: unknown): {
  stdout: string;
  stderr: string;
  message: string;
  exitCode: number;
} {
  if (err && typeof err === "object") {
    const record = err as {
      stdout?: unknown;
      stderr?: unknown;
      message?: unknown;
      code?: unknown;
    };
    return {
      stdout: typeof record.stdout === "string" ? record.stdout : "",
      stderr: typeof record.stderr === "string" ? record.stderr : "",
      message: typeof record.message === "string" ? record.message : "",
      exitCode: typeof record.code === "number" ? record.code : 1,
    };
  }
  return { stdout: "", stderr: "", message: String(err), exitCode: 1 };
}

function truncate(value: string): string {
  return value.length > OUTPUT_LIMIT ? `${value.slice(0, OUTPUT_LIMIT)}\n...[truncated]` : value;
}
