import { spawn, type ChildProcess } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

export type SandboxWorkspaceFile = {
  path: string;
  content: string;
};

export type SandboxCommandDecision =
  | {
      ok: true;
      argv: string[];
      requiresApproval: boolean;
      approvalReason: string | null;
    }
  | {
      ok: false;
      reason: string;
    };

export type SandboxShellResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  aborted: boolean;
  outputTruncated: boolean;
  budgetRemainingMs: number;
};

export type SandboxShellLimits = {
  commandTimeoutMs: number;
  taskBudgetMs: number;
  outputBytes: number;
  maxConcurrent: number;
  maxFiles: number;
  maxWorkspaceBytes: number;
};

const DEFAULT_LIMITS: SandboxShellLimits = {
  commandTimeoutMs: 20_000,
  taskBudgetMs: 60_000,
  outputBytes: 16 * 1024,
  maxConcurrent: 2,
  maxFiles: 2_000,
  maxWorkspaceBytes: 25 * 1024 * 1024,
};

const SESSION_TTL_MS = 30 * 60_000;
const TEMP_PREFIX = "mustaflow-zero-shell-";
const FORBIDDEN_ARG_RE = /[;&|`<>]|\$\(/;
const WINDOWS_ABSOLUTE_RE = /^[A-Za-z]:[\\/]/;
const RISKY_RE =
  /\b(deploy|publish|release|migrate|migration|prisma|drizzle|alembic|drop|truncate|delete|destroy|reset|clean)\b/i;
const SCRIPT_HEADS = new Set([
  "node",
  "npx",
  "tsc",
  "vitest",
  "vite",
  "next",
  "eslint",
  "prettier",
  "jest",
]);
const READ_ONLY_COMMANDS = new Set(["pwd", "ls", "cat", "head", "tail", "wc", "find", "grep"]);
const SAFE_LS_FLAGS = new Set(["-a", "-l", "-1", "-la", "-al"]);
const SAFE_WC_FLAGS = new Set(["-l", "-w", "-c", "-m"]);
const SAFE_GREP_FLAGS = new Set(["-n", "-i", "-l", "-c", "-F", "-E"]);
const SAFE_FIND_FLAGS = new Set(["-print"]);

let activeExecutions = 0;
const slotWaiters: Array<{
  maxConcurrent: number;
  resolve: (release: () => void) => void;
  reject: (error: Error) => void;
  signal: AbortSignal;
  timer: ReturnType<typeof setTimeout>;
  onAbort: () => void;
}> = [];

function clampInteger(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function sandboxShellEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.ZERO_SANDBOX_SHELL_ENABLED !== "false";
}

export function resolveSandboxShellLimits(
  env: NodeJS.ProcessEnv = process.env,
): SandboxShellLimits {
  return {
    commandTimeoutMs: clampInteger(
      env.ZERO_SANDBOX_COMMAND_TIMEOUT_MS,
      DEFAULT_LIMITS.commandTimeoutMs,
      1_000,
      60_000,
    ),
    taskBudgetMs: clampInteger(
      env.ZERO_SANDBOX_TASK_BUDGET_MS,
      DEFAULT_LIMITS.taskBudgetMs,
      5_000,
      180_000,
    ),
    outputBytes: clampInteger(
      env.ZERO_SANDBOX_OUTPUT_BYTES,
      DEFAULT_LIMITS.outputBytes,
      1_024,
      64 * 1024,
    ),
    maxConcurrent: clampInteger(
      env.ZERO_SANDBOX_MAX_CONCURRENCY,
      DEFAULT_LIMITS.maxConcurrent,
      1,
      4,
    ),
    maxFiles: clampInteger(env.ZERO_SANDBOX_MAX_FILES, DEFAULT_LIMITS.maxFiles, 1, 5_000),
    maxWorkspaceBytes: clampInteger(
      env.ZERO_SANDBOX_MAX_WORKSPACE_BYTES,
      DEFAULT_LIMITS.maxWorkspaceBytes,
      1 * 1024 * 1024,
      50 * 1024 * 1024,
    ),
  };
}

function commandBasename(value: string): string {
  return value.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
}

function containsControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function validateArgToken(token: string): string | null {
  if (!token || token.length > 2_048) return "arguments must be 1-2048 characters";
  if (FORBIDDEN_ARG_RE.test(token) || containsControlCharacter(token)) {
    return `shell metacharacters and control characters are not allowed: ${token}`;
  }
  if (token.includes("..")) return `parent-path segments are not allowed: ${token}`;
  if (token.startsWith("~") || isAbsolute(token) || WINDOWS_ABSOLUTE_RE.test(token)) {
    return `absolute paths are not allowed: ${token}`;
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(token) || /^(?:git|file|github):/i.test(token)) {
    return `URL and VCS arguments are not allowed: ${token}`;
  }
  return null;
}

function validateRelativePath(token: string, label = "path"): string | null {
  if (token === ".") return null;
  const reason = validateArgToken(token);
  if (reason) return `${label}: ${reason}`;
  const normalized = token.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.startsWith("/")) return `${label} must be workspace-relative`;
  return null;
}

function packageJsonFromFiles(
  files: readonly SandboxWorkspaceFile[],
): Record<string, unknown> | null {
  const raw = files.find((file) => file.path === "package.json")?.content;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function inspectNpmScript(
  name: string,
  files: readonly SandboxWorkspaceFile[],
): { ok: true; risky: boolean } | { ok: false; reason: string } {
  const pkg = packageJsonFromFiles(files);
  const scripts =
    pkg?.scripts && typeof pkg.scripts === "object"
      ? (pkg.scripts as Record<string, unknown>)
      : null;
  const script = scripts?.[name];
  if (typeof script !== "string" || !script.trim()) {
    return { ok: false, reason: `npm script "${name}" is not defined in package.json` };
  }
  if (FORBIDDEN_ARG_RE.test(script) || containsControlCharacter(script)) {
    return {
      ok: false,
      reason: `npm script "${name}" uses shell chaining, redirection, or substitution`,
    };
  }
  const tokens = script.trim().split(/\s+/);
  const head = commandBasename(tokens[0] ?? "");
  if (!SCRIPT_HEADS.has(head)) {
    return {
      ok: false,
      reason: `npm script "${name}" starts with unsupported executable "${head || "(empty)"}"`,
    };
  }
  for (const token of tokens) {
    const reason = validateArgToken(token);
    if (reason) return { ok: false, reason: `npm script "${name}": ${reason}` };
  }
  return { ok: true, risky: RISKY_RE.test(name) || RISKY_RE.test(script) };
}

function evaluateNode(argv: string[]): SandboxCommandDecision {
  const args = argv.slice(1);
  if (args.length === 0) {
    return { ok: false, reason: "node requires --version, --check, --test, or a local script" };
  }
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) {
    return { ok: true, argv: ["node", ...args], requiresApproval: false, approvalReason: null };
  }
  if (args[0] === "--check") {
    if (args.length !== 2) return { ok: false, reason: "node --check accepts one local script" };
    const reason = validateRelativePath(args[1]!, "node script");
    if (reason) return { ok: false, reason };
    return { ok: true, argv: ["node", ...args], requiresApproval: false, approvalReason: null };
  }
  if (args[0] === "--test") {
    for (const token of args.slice(1)) {
      const reason = validateRelativePath(token, "test path");
      if (reason) return { ok: false, reason };
    }
    return { ok: true, argv: ["node", ...args], requiresApproval: false, approvalReason: null };
  }
  if (args[0]!.startsWith("-")) {
    return { ok: false, reason: `node flag "${args[0]}" is not allowed` };
  }
  if (!/\.(?:cjs|mjs|js)$/i.test(args[0]!)) {
    return { ok: false, reason: "node may only execute a local .js, .mjs, or .cjs script" };
  }
  const pathReason = validateRelativePath(args[0]!, "node script");
  if (pathReason) return { ok: false, reason: pathReason };
  return {
    ok: true,
    argv: ["node", ...args],
    requiresApproval: RISKY_RE.test(args[0]!),
    approvalReason: RISKY_RE.test(args[0]!)
      ? "script name looks destructive or deploy-shaped"
      : null,
  };
}

function evaluateNpm(
  argv: string[],
  files: readonly SandboxWorkspaceFile[],
): SandboxCommandDecision {
  const args = argv.slice(1);
  if (args.length === 1 && ["--version", "-v"].includes(args[0]!)) {
    return { ok: true, argv: ["npm", ...args], requiresApproval: false, approvalReason: null };
  }
  const action = args[0]?.toLowerCase();
  if (action === "install" || action === "i") {
    const allowedFlags = new Set([
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save",
      "--save-dev",
      "-D",
      "--package-lock-only",
      "--offline",
      "--prefer-offline",
    ]);
    for (const token of args.slice(1)) {
      const reason = validateArgToken(token);
      if (reason) return { ok: false, reason };
      if (token.startsWith("-") && !allowedFlags.has(token)) {
        return { ok: false, reason: `npm install flag "${token}" is not allowed` };
      }
      if (!token.startsWith("-") && !/^@?[A-Za-z0-9][A-Za-z0-9@/_.+\-^~*<>=]*$/.test(token)) {
        return { ok: false, reason: `invalid npm package spec "${token}"` };
      }
    }
    const normalized = ["npm", "install", ...args.slice(1)];
    for (const required of ["--ignore-scripts", "--no-audit", "--no-fund"]) {
      if (!normalized.includes(required)) normalized.push(required);
    }
    return { ok: true, argv: normalized, requiresApproval: false, approvalReason: null };
  }
  let scriptName: string | null = null;
  let trailing: string[] = [];
  if (action === "test") {
    scriptName = "test";
    trailing = args.slice(1);
  } else if (action === "run" || action === "run-script") {
    scriptName = args[1] ?? null;
    trailing = args.slice(2);
  }
  if (!scriptName || !/^[A-Za-z0-9:_-]{1,80}$/.test(scriptName)) {
    return { ok: false, reason: "npm only supports install, test, or run <script>" };
  }
  for (const token of trailing) {
    if (token === "--") continue;
    const reason = validateArgToken(token);
    if (reason) return { ok: false, reason };
  }
  const inspected = inspectNpmScript(scriptName, files);
  if (!inspected.ok) return inspected;
  return {
    ok: true,
    argv: [
      "npm",
      action === "test" ? "test" : "run",
      ...(action === "test" ? [] : [scriptName]),
      ...trailing,
    ],
    requiresApproval: inspected.risky,
    approvalReason: inspected.risky
      ? `npm script "${scriptName}" looks destructive or deploy-shaped`
      : null,
  };
}

function evaluateNpx(argv: string[]): SandboxCommandDecision {
  const args = argv.slice(1);
  let toolIndex = -1;
  for (let index = 0; index < args.length; index++) {
    const token = args[index]!;
    if (token === "--no-install" || token === "--yes=false") continue;
    toolIndex = index;
    break;
  }
  if (toolIndex < 0) return { ok: false, reason: "npx requires tsc or vitest" };
  const tool = commandBasename(args[toolIndex]!);
  if (tool !== "tsc" && tool !== "vitest") {
    return { ok: false, reason: `npx tool "${tool}" is not allowed; use tsc or vitest` };
  }
  for (const token of args) {
    const reason = validateArgToken(token);
    if (reason) return { ok: false, reason };
  }
  const normalized = ["npx", ...args];
  if (!args.includes("--no-install")) normalized.splice(1, 0, "--no-install");
  return { ok: true, argv: normalized, requiresApproval: false, approvalReason: null };
}

function evaluateReadOnly(argv: string[]): SandboxCommandDecision {
  const head = commandBasename(argv[0]!);
  const args = argv.slice(1);
  if (head === "pwd") {
    return args.length === 0
      ? { ok: true, argv: ["pwd"], requiresApproval: false, approvalReason: null }
      : { ok: false, reason: "pwd accepts no arguments" };
  }
  if (head === "ls") {
    for (const token of args) {
      if (token.startsWith("-")) {
        if (!SAFE_LS_FLAGS.has(token))
          return { ok: false, reason: `ls flag "${token}" is not allowed` };
      } else {
        const reason = validateRelativePath(token);
        if (reason) return { ok: false, reason };
      }
    }
  } else if (head === "cat") {
    if (args.length === 0) return { ok: false, reason: "cat requires at least one local path" };
    for (const token of args) {
      const reason = validateRelativePath(token);
      if (reason) return { ok: false, reason };
    }
  } else if (head === "head" || head === "tail") {
    let index = 0;
    if (args[index] === "-n") {
      const count = args[index + 1];
      if (!count || !/^\d{1,5}$/.test(count)) {
        return { ok: false, reason: `${head} -n requires a bounded integer` };
      }
      index += 2;
    }
    if (index >= args.length) return { ok: false, reason: `${head} requires a local path` };
    for (const token of args.slice(index)) {
      const reason = validateRelativePath(token);
      if (reason) return { ok: false, reason };
    }
  } else if (head === "wc") {
    let sawPath = false;
    for (const token of args) {
      if (token.startsWith("-")) {
        if (!SAFE_WC_FLAGS.has(token))
          return { ok: false, reason: `wc flag "${token}" is not allowed` };
      } else {
        sawPath = true;
        const reason = validateRelativePath(token);
        if (reason) return { ok: false, reason };
      }
    }
    if (!sawPath) return { ok: false, reason: "wc requires a local path" };
  } else if (head === "grep") {
    let index = 0;
    while (index < args.length && args[index]!.startsWith("-")) {
      if (!SAFE_GREP_FLAGS.has(args[index]!)) {
        return { ok: false, reason: `grep flag "${args[index]}" is not allowed` };
      }
      index++;
    }
    if (args.length - index < 2) {
      return { ok: false, reason: "grep requires a pattern and at least one local path" };
    }
    const patternReason = validateArgToken(args[index]!);
    if (patternReason) return { ok: false, reason: patternReason };
    for (const token of args.slice(index + 1)) {
      const reason = validateRelativePath(token);
      if (reason) return { ok: false, reason };
    }
  } else if (head === "find") {
    if (args.length === 0) return { ok: false, reason: "find requires a local start path" };
    const rootReason = validateRelativePath(args[0]!);
    if (rootReason) return { ok: false, reason: rootReason };
    for (let index = 1; index < args.length; index++) {
      const token = args[index]!;
      if (SAFE_FIND_FLAGS.has(token)) continue;
      if (token === "-maxdepth") {
        const depth = args[++index];
        if (!depth || !/^\d{1,2}$/.test(depth) || Number(depth) > 12) {
          return { ok: false, reason: "find -maxdepth must be between 0 and 12" };
        }
        continue;
      }
      if (token === "-type") {
        const type = args[++index];
        if (type !== "f" && type !== "d") return { ok: false, reason: "find -type must be f or d" };
        continue;
      }
      if (token === "-name") {
        const pattern = args[++index];
        if (!pattern || validateArgToken(pattern)) {
          return { ok: false, reason: "find -name requires a safe literal pattern" };
        }
        continue;
      }
      return { ok: false, reason: `find predicate "${token}" is not allowed` };
    }
  }
  return { ok: true, argv: [head, ...args], requiresApproval: false, approvalReason: null };
}

export function evaluateSandboxCommand(
  argv: readonly string[],
  files: readonly SandboxWorkspaceFile[] = [],
): SandboxCommandDecision {
  if (!Array.isArray(argv) || argv.length === 0) return { ok: false, reason: "empty argv" };
  if (argv.length > 64) return { ok: false, reason: "too many argv entries (max 64)" };
  if (argv.some((token) => typeof token !== "string")) {
    return { ok: false, reason: "argv entries must be strings" };
  }
  const executable = argv[0]!;
  if (executable !== commandBasename(executable)) {
    return { ok: false, reason: "executable must be a bare allowlisted name" };
  }
  for (const token of argv) {
    const reason = validateArgToken(token);
    if (reason) return { ok: false, reason };
  }
  const head = commandBasename(executable);
  if (head === "node") return evaluateNode([...argv]);
  if (head === "npm") return evaluateNpm([...argv], files);
  if (head === "npx") return evaluateNpx([...argv]);
  if (READ_ONLY_COMMANDS.has(head)) return evaluateReadOnly([...argv]);
  return {
    ok: false,
    reason:
      `executable "${head || executable}" is not in the sandbox whitelist ` +
      "(node, npm install/run/test, npx tsc/vitest, pwd, ls, cat, head, tail, wc, find, grep)",
  };
}

export function buildSandboxEnvironment(root: string): NodeJS.ProcessEnv {
  // npm/npx themselves are trusted launchers, but any Node lifecycle/tooling
  // process they start inherits the same filesystem jail as a direct `node`
  // command. npm_config_node_options applies to children without constraining
  // npm's own globally-installed CLI entrypoint.
  const restrictedNodeOptions = nodePermissionArgs(root)
    .map((option) => (option.includes(" ") ? JSON.stringify(option) : option))
    .join(" ");
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    HOME: root,
    USERPROFILE: root,
    TMPDIR: join(root, ".tmp"),
    TMP: join(root, ".tmp"),
    TEMP: join(root, ".tmp"),
    CI: "true",
    NODE_ENV: "test",
    NODE_NO_WARNINGS: "1",
    NO_COLOR: "1",
    FORCE_COLOR: "0",
    NPM_CONFIG_CACHE: join(root, ".npm-cache"),
    npm_config_cache: join(root, ".npm-cache"),
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    npm_config_ignore_scripts: "true",
    NPM_CONFIG_AUDIT: "false",
    NPM_CONFIG_FUND: "false",
    NPM_CONFIG_UPDATE_NOTIFIER: "false",
    NPM_CONFIG_NODE_OPTIONS: restrictedNodeOptions,
    npm_config_node_options: restrictedNodeOptions,
  };
  // Windows process creation needs these non-secret platform values.
  for (const key of ["SystemRoot", "WINDIR", "PATHEXT"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return env;
}

function releaseSlot(): void {
  activeExecutions = Math.max(activeExecutions - 1, 0);
  for (let index = 0; index < slotWaiters.length; index++) {
    const waiter = slotWaiters[index]!;
    if (waiter.signal.aborted) {
      slotWaiters.splice(index--, 1);
      clearTimeout(waiter.timer);
      waiter.signal.removeEventListener("abort", waiter.onAbort);
      waiter.reject(new Error("sandbox command aborted while waiting for an execution slot"));
      continue;
    }
    if (activeExecutions >= waiter.maxConcurrent) continue;
    slotWaiters.splice(index, 1);
    clearTimeout(waiter.timer);
    waiter.signal.removeEventListener("abort", waiter.onAbort);
    activeExecutions++;
    waiter.resolve(releaseSlot);
    return;
  }
}

function acquireSlot(
  maxConcurrent: number,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<() => void> {
  if (signal.aborted) return Promise.reject(new Error("sandbox command aborted"));
  if (activeExecutions < maxConcurrent) {
    activeExecutions++;
    return Promise.resolve(releaseSlot);
  }
  return new Promise((resolvePromise, rejectPromise) => {
    const waiter = {
      maxConcurrent,
      resolve: resolvePromise,
      reject: rejectPromise,
      signal,
      timer: undefined as unknown as ReturnType<typeof setTimeout>,
      onAbort: () => undefined,
    };
    waiter.onAbort = () => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) slotWaiters.splice(index, 1);
      clearTimeout(waiter.timer);
      rejectPromise(new Error("sandbox command aborted while waiting for an execution slot"));
    };
    waiter.timer = setTimeout(() => {
      const index = slotWaiters.indexOf(waiter);
      if (index >= 0) slotWaiters.splice(index, 1);
      signal.removeEventListener("abort", waiter.onAbort);
      rejectPromise(new Error("sandbox task wall-clock budget expired while waiting for a slot"));
    }, timeoutMs);
    signal.addEventListener("abort", waiter.onAbort, { once: true });
    slotWaiters.push(waiter);
  });
}

function resolvedInside(root: string, projectPath: string): string {
  const normalized = projectPath.replace(/\\/g, "/").replace(/^\.\/+/, "");
  if (!normalized || normalized.includes("..") || normalized.startsWith("/")) {
    throw new Error(`unsafe workspace path: ${projectPath}`);
  }
  const target = resolve(root, normalized);
  const prefix = resolve(root) + sep;
  if (target !== resolve(root) && !target.startsWith(prefix)) {
    throw new Error(`workspace path escaped sandbox: ${projectPath}`);
  }
  return target;
}

async function assertNoSymlinkParents(root: string, target: string): Promise<void> {
  const rel = relative(root, target);
  const parts = rel.split(sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink()) throw new Error(`sandbox path contains symlink: ${rel}`);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      throw error;
    }
  }
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") {
      // taskkill receives a fixed argv array (no shell) and terminates any
      // npm/npx descendants as well as the direct process.
      const killer = spawn(
        "taskkill.exe",
        ["/pid", String(child.pid), "/t", signal === "SIGKILL" ? "/f" : ""].filter(Boolean),
        { shell: false, windowsHide: true, stdio: "ignore" },
      );
      killer.unref();
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Process already exited.
    }
  }
}

function nodePermissionArgs(root: string): string[] {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major < 20) return [];
  const permissionFlag = major >= 23 ? "--permission" : "--experimental-permission";
  return [permissionFlag, `--allow-fs-read=${root}`, `--allow-fs-write=${root}`, "--allow-worker"];
}

export class SandboxShellSession {
  private root: string | null = null;
  private readonly syncedPaths = new Set<string>();
  private remainingMs: number;
  private disposed = false;
  private cleanupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly limits: SandboxShellLimits = resolveSandboxShellLimits()) {
    this.remainingMs = limits.taskBudgetMs;
  }

  get budgetRemainingMs(): number {
    return Math.max(0, this.remainingMs);
  }

  private async ensureRoot(): Promise<string> {
    if (this.disposed) throw new Error("sandbox shell session is closed");
    if (this.root) return this.root;
    this.root = await mkdtemp(join(tmpdir(), TEMP_PREFIX));
    await Promise.all([
      mkdir(join(this.root, ".tmp"), { recursive: true }),
      mkdir(join(this.root, ".npm-cache"), { recursive: true }),
    ]);
    this.cleanupTimer = setTimeout(() => {
      void this.dispose();
    }, SESSION_TTL_MS);
    this.cleanupTimer.unref?.();
    return this.root;
  }

  private async syncWorkspace(files: readonly SandboxWorkspaceFile[]): Promise<string> {
    if (files.length > this.limits.maxFiles) {
      throw new Error(
        `workspace has ${files.length} files; sandbox cap is ${this.limits.maxFiles}`,
      );
    }
    const totalBytes = files.reduce((sum, file) => sum + Buffer.byteLength(file.content), 0);
    if (totalBytes > this.limits.maxWorkspaceBytes) {
      throw new Error(
        `workspace snapshot is ${totalBytes} bytes; sandbox cap is ${this.limits.maxWorkspaceBytes}`,
      );
    }
    const root = await this.ensureRoot();
    const nextPaths = new Set<string>();
    for (const file of files) {
      const target = resolvedInside(root, file.path);
      await assertNoSymlinkParents(root, target);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.content, { encoding: "utf8", flag: "w" });
      nextPaths.add(file.path);
    }
    for (const stalePath of this.syncedPaths) {
      if (nextPaths.has(stalePath)) continue;
      const target = resolvedInside(root, stalePath);
      await assertNoSymlinkParents(root, target);
      await rm(target, { force: true });
    }
    this.syncedPaths.clear();
    for (const path of nextPaths) this.syncedPaths.add(path);
    return root;
  }

  async execute(input: {
    argv: readonly string[];
    files: readonly SandboxWorkspaceFile[];
    timeoutMs?: number;
    signal: AbortSignal;
  }): Promise<SandboxShellResult> {
    if (!sandboxShellEnabled()) throw new Error("sandbox shell is disabled");
    const decision = evaluateSandboxCommand(input.argv, input.files);
    if (!decision.ok) throw new Error(`command rejected by sandbox policy: ${decision.reason}`);
    if (this.remainingMs <= 0) throw new Error("sandbox task wall-clock budget is exhausted");

    const root = await this.syncWorkspace(input.files);
    const requestedTimeout =
      typeof input.timeoutMs === "number" && Number.isFinite(input.timeoutMs)
        ? Math.max(1, input.timeoutMs)
        : this.limits.commandTimeoutMs;
    const allowedMs = Math.max(
      1,
      Math.min(requestedTimeout, this.limits.commandTimeoutMs, this.remainingMs),
    );
    const waitStartedAt = Date.now();
    const release = await acquireSlot(this.limits.maxConcurrent, allowedMs, input.signal);
    const waitedMs = Date.now() - waitStartedAt;
    this.remainingMs = Math.max(0, this.remainingMs - waitedMs);
    const executionBudgetMs = Math.max(
      1,
      Math.min(allowedMs - waitedMs, this.remainingMs || allowedMs - waitedMs),
    );

    const normalized = [...decision.argv];
    let executable = normalized.shift()!;
    if (executable === "node") {
      normalized.unshift(...nodePermissionArgs(root));
    } else if (process.platform === "win32" && (executable === "npm" || executable === "npx")) {
      executable = `${executable}.cmd`;
    }

    const startedAt = Date.now();
    let child: ChildProcess | null = null;
    try {
      const env = buildSandboxEnvironment(root);
      child = spawn(executable, normalized, {
        cwd: root,
        env,
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let capturedBytes = 0;
      let outputTruncated = false;
      const capture = (target: "stdout" | "stderr", chunk: Buffer | string) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        const available = Math.max(this.limits.outputBytes - capturedBytes, 0);
        if (available <= 0) {
          outputTruncated = true;
          return;
        }
        const slice = bytes.subarray(0, available);
        const text = slice.toString("utf8");
        if (target === "stdout") stdout += text;
        else stderr += text;
        capturedBytes += slice.length;
        if (slice.length < bytes.length) outputTruncated = true;
      };
      child.stdout?.on("data", (chunk) => capture("stdout", chunk));
      child.stderr?.on("data", (chunk) => capture("stderr", chunk));

      let timedOut = false;
      let aborted = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        killProcessTree(child!, "SIGTERM");
        setTimeout(() => killProcessTree(child!, "SIGKILL"), 500).unref?.();
      }, executionBudgetMs);
      const onAbort = () => {
        aborted = true;
        killProcessTree(child!, "SIGTERM");
        setTimeout(() => killProcessTree(child!, "SIGKILL"), 500).unref?.();
      };
      input.signal.addEventListener("abort", onAbort, { once: true });
      const exitCode = await new Promise<number>((resolvePromise, rejectPromise) => {
        child!.once("error", rejectPromise);
        child!.once("close", (code, signal) => {
          if (typeof code === "number") resolvePromise(code);
          else if (signal === "SIGKILL" || signal === "SIGTERM") resolvePromise(143);
          else resolvePromise(1);
        });
      }).finally(() => {
        clearTimeout(timeout);
        input.signal.removeEventListener("abort", onAbort);
      });
      const durationMs = Date.now() - startedAt;
      this.remainingMs = Math.max(0, this.remainingMs - durationMs);
      return {
        exitCode: aborted ? 130 : timedOut ? 124 : exitCode,
        stdout,
        stderr,
        durationMs,
        timedOut,
        aborted,
        outputTruncated,
        budgetRemainingMs: this.budgetRemainingMs,
      };
    } finally {
      release();
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    if (this.cleanupTimer) clearTimeout(this.cleanupTimer);
    this.cleanupTimer = null;
    const root = this.root;
    this.root = null;
    if (!root) return;
    const resolvedRoot = resolve(root);
    const tempPrefix = resolve(tmpdir()) + sep;
    if (!resolvedRoot.startsWith(tempPrefix) || !basename(resolvedRoot).startsWith(TEMP_PREFIX)) {
      throw new Error(`refusing to remove unexpected sandbox path: ${resolvedRoot}`);
    }
    await rm(resolvedRoot, { recursive: true, force: true });
  }
}

export function createSandboxShellSession(
  limits: SandboxShellLimits = resolveSandboxShellLimits(),
): SandboxShellSession {
  return new SandboxShellSession(limits);
}
