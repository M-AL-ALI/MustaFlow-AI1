import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RUFLO_ALLOWED_TOOLS,
  RUFLO_MCP_POLICY_VERSION,
  RUFLO_PINNED_FILES,
  RUFLO_PINNED_VERSION,
  authorizeRufloClientRequest,
  buildSanitizedRufloEnvironment,
  filterRufloServerResponse,
  parseRufloVersion,
  resolveRufloSafePaths,
} from "./ruflo-mcp-policy";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const safePaths = resolveRufloSafePaths(repositoryRoot);
if (process.platform === "win32") {
  assert.equal(safePaths.repositoryRoot.startsWith("A:\\"), true);
  assert.equal(safePaths.runtimeRoot.startsWith("A:\\"), true);
  assert.equal(safePaths.toolRoot.startsWith("A:\\"), true);
  assert.throws(
    () => resolveRufloSafePaths("C:\\Users\\someone\\project", "win32"),
    /ruflo_workspace_must_be_on_a_drive/u,
  );
}
assert.equal(safePaths.runtimeRoot.startsWith(safePaths.repositoryRoot), false);
assert.equal(safePaths.toolRoot.startsWith(safePaths.repositoryRoot), false);

const environment = buildSanitizedRufloEnvironment(safePaths, {
  PATH: "safe-path",
  SystemRoot: "safe-system-root",
  ComSpec: "safe-command-shell",
  OPENAI_API_KEY: "must-not-cross-boundary",
  DATABASE_URL: "must-not-cross-boundary",
  CLOUDFLARE_API_TOKEN: "must-not-cross-boundary",
});
assert.equal(environment.OPENAI_API_KEY, undefined);
assert.equal(environment.DATABASE_URL, undefined);
assert.equal(environment.CLOUDFLARE_API_TOKEN, undefined);
assert.equal(environment.RUFLO_DAEMON_AUTOSTART, "0");
assert.equal(environment.CLAUDE_FLOW_ROUTER_FALLBACK_MAX_RETRIES, "0");
assert.equal(environment.CLAUDE_FLOW_MCP_TOOLS, RUFLO_ALLOWED_TOOLS.join(","));
assert.equal(environment.TEMP, safePaths.temp);
assert.equal(environment.TMP, safePaths.temp);
assert.equal(Object.keys(RUFLO_PINNED_FILES).length, 3);
assert.equal(
  Object.values(RUFLO_PINNED_FILES).every((hash) => /^[0-9a-f]{64}$/u.test(hash)),
  true,
);

const allowed = authorizeRufloClientRequest({
  jsonrpc: "2.0",
  id: 1,
  method: "tools/call",
  params: { name: "analyze_diff-stats", arguments: { ref: "main..HEAD" } },
});
assert.equal(allowed.allowed, true);

for (const name of ["system_reset", "memory_store", "agent_spawn", "terminal_execute"]) {
  const rejected = authorizeRufloClientRequest({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: {} },
  });
  assert.equal(rejected.allowed, false, `${name} must be denied by the proxy`);
  if (!rejected.allowed) assert.equal((rejected.response.error as { code: number }).code, -32601);
}

const invalidArguments = authorizeRufloClientRequest({
  jsonrpc: "2.0",
  id: 3,
  method: "tools/call",
  params: { name: "analyze_diff-risk", arguments: { ref: "--exec" } },
});
assert.equal(invalidArguments.allowed, false);
if (!invalidArguments.allowed) {
  assert.equal((invalidArguments.response.error as { code: number }).code, -32602);
}

const filtered = filterRufloServerResponse({
  jsonrpc: "2.0",
  id: 4,
  result: {
    tools: [
      ...RUFLO_ALLOWED_TOOLS.map((name) => ({ name })),
      { name: "system_reset" },
      { name: "memory_store" },
    ],
  },
});
assert.deepEqual(
  (filtered.result as { tools: { name: string }[] }).tools.map((tool) => tool.name),
  RUFLO_ALLOWED_TOOLS,
);

assert.equal(parseRufloVersion(`ruflo v${RUFLO_PINNED_VERSION}\n`), RUFLO_PINNED_VERSION);
assert.equal(parseRufloVersion("ruflo v3.39.0 unexpected"), null);

const codexConfig = readFileSync(resolve(repositoryRoot, ".codex/config.toml"), "utf8");
for (const tool of RUFLO_ALLOWED_TOOLS) assert.match(codexConfig, new RegExp(`"${tool}"`, "u"));
for (const forbidden of ["system_reset", "memory_store", "agent_spawn", "terminal_execute"]) {
  assert.doesNotMatch(codexConfig, new RegExp(`"${forbidden}"`, "u"));
}
assert.match(codexConfig, /default_tools_approval_mode = "prompt"/u);
assert.doesNotMatch(codexConfig, /A:\\|C:\\/u);

const proxySource = readFileSync(resolve(repositoryRoot, "scripts/src/ruflo-mcp-proxy.ts"), "utf8");
assert.match(proxySource, /childEnvironment\.GIT_WORK_TREE = repositoryRoot/u);
assert.match(proxySource, /safePaths\.toolRoot/u);
assert.doesNotMatch(proxySource, /where\.exe|execFileSync\("which"|ruflo\.cmd/u);
assert.match(proxySource, /\[rufloEntry, "mcp", "start"[\s\S]{0,500}cwd: safePaths\.runtimeRoot/u);
assert.doesNotMatch(proxySource, /\[rufloEntry, "mcp", "start"[\s\S]{0,500}cwd: repositoryRoot/u);
assert.doesNotMatch(proxySource, /cwd: repositoryRoot,/u);

console.log(`policy=${RUFLO_MCP_POLICY_VERSION}`);
console.log(`ruflo_version=${RUFLO_PINNED_VERSION}`);
console.log(`allowed_tools=${RUFLO_ALLOWED_TOOLS.length}`);
console.log("unauthorized_direct_calls=DENIED");
console.log("credential_environment_forwarding=ZERO");
console.log("database=NONE environment=LAB store=A:/NabuFlowLab/.ruflo-safe kind=unit-test");
