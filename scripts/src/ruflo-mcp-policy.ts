import { existsSync } from "node:fs";
import { dirname, parse, resolve } from "node:path";

export const RUFLO_PINNED_VERSION = "3.38.20" as const;
export const RUFLO_MCP_POLICY_VERSION = "nabuflow-ruflo-readonly-v1" as const;
export const RUFLO_MAX_MESSAGE_BYTES = 1_048_576;
export const RUFLO_PINNED_FILES = {
  "package.json": "f979110b4e35a3e3361dc56e319d0cbb2eec2b1e7c8062ef0566cb2b6918d506",
  "bin/ruflo.js": "af863233c65b825ae38c689f759d9dcbb18528b42771aed4e929ca6d57f21ccd",
  "node_modules/@claude-flow/cli/bin/cli.js":
    "4ec921923fb00ad86f89b171b0dbc293a1ec613c8ce0a20cbdc8169d4c836e51",
} as const;

export const RUFLO_ALLOWED_TOOLS = [
  "mcp_status",
  "system_info",
  "analyze_diff-risk",
  "analyze_diff-classify",
  "analyze_diff-stats",
  "analyze_file-risk",
] as const;

const allowedTools = new Set<string>(RUFLO_ALLOWED_TOOLS);
const allowedMethods = new Set([
  "initialize",
  "notifications/initialized",
  "ping",
  "tools/list",
  "tools/call",
]);

export interface RufloSafePaths {
  repositoryRoot: string;
  runtimeRoot: string;
  home: string;
  appData: string;
  localAppData: string;
  cache: string;
  config: string;
  data: string;
  temp: string;
}

export interface JsonRpcRequest {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc?: unknown;
  id?: unknown;
  result?: unknown;
  error?: unknown;
}

export type RufloRequestDecision =
  | { allowed: true; message: JsonRpcRequest }
  | { allowed: false; response: JsonRpcResponse };

function jsonRpcError(id: unknown, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export function findRepositoryRoot(startDirectory: string): string {
  let current = resolve(startDirectory);
  while (true) {
    if (existsSync(resolve(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) {
      throw new Error("ruflo_repository_root_not_found");
    }
    current = parent;
  }
}

export function resolveRufloSafePaths(
  repositoryRoot: string,
  platform: NodeJS.Platform = process.platform,
): RufloSafePaths {
  const resolvedRoot = resolve(repositoryRoot);
  const volume = parse(resolvedRoot).root;
  if (platform === "win32" && volume.toUpperCase() !== "A:\\") {
    throw new Error("ruflo_workspace_must_be_on_a_drive");
  }

  const labRoot = dirname(resolvedRoot);
  const runtimeRoot = resolve(labRoot, ".ruflo-safe");
  const temp = resolve(labRoot, ".tmp");
  if (parse(runtimeRoot).root.toUpperCase() !== volume.toUpperCase()) {
    throw new Error("ruflo_runtime_volume_mismatch");
  }
  if (runtimeRoot === resolvedRoot || runtimeRoot.startsWith(`${resolvedRoot}\\`)) {
    throw new Error("ruflo_runtime_must_be_outside_worktree");
  }

  return {
    repositoryRoot: resolvedRoot,
    runtimeRoot,
    home: resolve(runtimeRoot, "home"),
    appData: resolve(runtimeRoot, "appdata"),
    localAppData: resolve(runtimeRoot, "localappdata"),
    cache: resolve(runtimeRoot, "cache"),
    config: resolve(runtimeRoot, "config"),
    data: resolve(runtimeRoot, "data"),
    temp,
  };
}

function copyIfPresent(
  target: Record<string, string>,
  source: NodeJS.ProcessEnv,
  targetName: string,
  ...sourceNames: string[]
): void {
  for (const sourceName of sourceNames) {
    const value = source[sourceName];
    if (value) {
      target[targetName] = value;
      return;
    }
  }
}

export function buildSanitizedRufloEnvironment(
  paths: RufloSafePaths,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const env: Record<string, string> = {};
  copyIfPresent(env, source, "PATH", "PATH", "Path");
  copyIfPresent(env, source, "PATHEXT", "PATHEXT");
  copyIfPresent(env, source, "SystemRoot", "SystemRoot", "SYSTEMROOT");
  copyIfPresent(env, source, "ComSpec", "ComSpec", "COMSPEC");
  copyIfPresent(env, source, "WINDIR", "WINDIR");

  Object.assign(env, {
    TEMP: paths.temp,
    TMP: paths.temp,
    HOME: paths.home,
    USERPROFILE: paths.home,
    APPDATA: paths.appData,
    LOCALAPPDATA: paths.localAppData,
    XDG_CACHE_HOME: paths.cache,
    XDG_CONFIG_HOME: paths.config,
    XDG_DATA_HOME: paths.data,
    npm_config_cache: resolve(dirname(paths.repositoryRoot), ".npm-cache"),
    PNPM_HOME: resolve(dirname(paths.repositoryRoot), ".pnpm-home"),
    CLAUDE_FLOW_CWD: paths.repositoryRoot,
    CLAUDE_FLOW_MCP_TOOLS: RUFLO_ALLOWED_TOOLS.join(","),
    CLAUDE_FLOW_STRICT_GUARDRAIL: "true",
    CLAUDE_FLOW_ROUTER_FALLBACK_MAX_RETRIES: "0",
    CLAUDE_FLOW_ROUTER_TRAJECTORY: "0",
    CLAUDE_FLOW_RUN_TRANSCRIPTS: "0",
    CLAUDE_FLOW_HTTP_FETCH_ALLOW_PRIVATE: "0",
    CLAUDE_FLOW_HTTP_FETCH_AUTH: "0",
    CLAUDE_FLOW_BBS_ATOMIC_BUDGET: "0",
    CLAUDE_FLOW_NO_COW_MEMORY: "1",
    RUFLO_DAEMON_AUTOSTART: "0",
    NO_UPDATE_NOTIFIER: "1",
    CI: "1",
  });
  return env;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateRef(value: unknown): boolean {
  return (
    value === undefined ||
    (typeof value === "string" &&
      value.length > 0 &&
      value.length <= 160 &&
      !value.startsWith("-") &&
      /^[A-Za-z0-9_./~^:=-]+$/u.test(value))
  );
}

function validateToolArguments(tool: string, value: unknown): boolean {
  if (!isObject(value)) return false;
  if (JSON.stringify(value).length > 16_384) return false;

  if (tool === "mcp_status" || tool === "system_info") {
    return Object.keys(value).length === 0;
  }
  if (
    tool === "analyze_diff-risk" ||
    tool === "analyze_diff-classify" ||
    tool === "analyze_diff-stats"
  ) {
    return Object.keys(value).every((key) => key === "ref") && validateRef(value.ref);
  }
  if (tool === "analyze_file-risk") {
    return (
      typeof value.path === "string" &&
      value.path.length > 0 &&
      value.path.length <= 512 &&
      Object.keys(value).every((key) =>
        ["path", "additions", "deletions", "status"].includes(key),
      ) &&
      [value.additions, value.deletions].every(
        (count) =>
          count === undefined ||
          (typeof count === "number" && Number.isInteger(count) && count >= 0 && count <= 100_000),
      ) &&
      (value.status === undefined ||
        ["added", "modified", "deleted", "renamed"].includes(String(value.status)))
    );
  }
  return false;
}

export function authorizeRufloClientRequest(message: unknown): RufloRequestDecision {
  if (!isObject(message)) {
    return { allowed: false, response: jsonRpcError(null, -32600, "Invalid MCP request") };
  }
  const request = message as JsonRpcRequest;
  if (request.jsonrpc !== "2.0" || typeof request.method !== "string") {
    return {
      allowed: false,
      response: jsonRpcError(request.id, -32600, "Invalid MCP request"),
    };
  }
  if (!allowedMethods.has(request.method)) {
    return {
      allowed: false,
      response: jsonRpcError(request.id, -32601, "MCP method is not allowed by NabuFlow policy"),
    };
  }
  if (request.method !== "tools/call") return { allowed: true, message: request };

  const params = isObject(request.params) ? request.params : {};
  const tool = typeof params.name === "string" ? params.name : "";
  if (!allowedTools.has(tool)) {
    return {
      allowed: false,
      response: jsonRpcError(request.id, -32601, "Ruflo tool is not allowed by NabuFlow policy"),
    };
  }
  if (!validateToolArguments(tool, params.arguments ?? {})) {
    return {
      allowed: false,
      response: jsonRpcError(request.id, -32602, "Ruflo tool arguments are outside policy"),
    };
  }
  return { allowed: true, message: request };
}

export function filterRufloServerResponse(message: unknown): JsonRpcResponse {
  if (!isObject(message)) {
    return jsonRpcError(null, -32603, "Ruflo returned an invalid MCP response");
  }
  const response = message as JsonRpcResponse;
  if (isObject(response.result) && Array.isArray(response.result.tools)) {
    response.result = {
      ...response.result,
      tools: response.result.tools.filter(
        (tool) => isObject(tool) && typeof tool.name === "string" && allowedTools.has(tool.name),
      ),
    };
  }
  return response;
}

export function parseRufloVersion(output: string): string | null {
  const match = /^ruflo v(\d+\.\d+\.\d+)\s*$/u.exec(output.trim());
  return match?.[1] ?? null;
}
