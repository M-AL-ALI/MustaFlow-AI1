import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, statfsSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";
import {
  RUFLO_ALLOWED_TOOLS,
  RUFLO_MCP_POLICY_VERSION,
  RUFLO_PINNED_VERSION,
  findRepositoryRoot,
  resolveRufloSafePaths,
} from "./ruflo-mcp-policy";
import { RufloMcpProcessClient } from "./ruflo-mcp-client";
import { RufloReadOnlyReviewAdapter } from "./ruflo-orchestration-adapter";

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`ruflo_pilot_missing_${name}`);
  return value;
}

function git(repositoryRoot: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    windowsHide: true,
  }).trim();
}

function freeBytes(path: string): number {
  const stat = statfsSync(path);
  return Number(stat.bavail) * Number(stat.bsize);
}

const repositoryRoot = findRepositoryRoot(process.cwd());
const baseRef = argument("base");
if (!/^[0-9a-f]{40}$/u.test(baseRef)) throw new Error("ruflo_pilot_base_invalid");
const headCommit = git(repositoryRoot, "rev-parse", "HEAD");
const headTree = git(repositoryRoot, "show", "-s", "--format=%T", "HEAD");
const beforePorcelain = git(repositoryRoot, "status", "--porcelain");
assert.equal(beforePorcelain, "", "pilot requires a clean committed subject");
const claudeFlowPath = resolve(repositoryRoot, ".claude-flow");
const claudeFlowBefore = existsSync(claudeFlowPath);
const startedAt = new Date().toISOString();
const started = performance.now();
const paths = resolveRufloSafePaths(repositoryRoot);
const beforeFree = {
  A: process.platform === "win32" ? freeBytes("A:\\") : freeBytes(repositoryRoot),
  C: process.platform === "win32" ? freeBytes("C:\\") : null,
};

const client = new RufloMcpProcessClient(repositoryRoot);
let closeReceipt = { stderrBytes: 0 };
try {
  await client.start();
  const tools = await client.listTools();
  assert.deepEqual([...tools].sort(), [...RUFLO_ALLOWED_TOOLS].sort());

  const unauthorizedCode = await client.expectDeniedTool("system_reset", { confirm: true });
  assert.equal(unauthorizedCode, -32601);

  const mcpStatus = (await client.callTool("mcp_status", {})) as Record<string, unknown>;
  const systemInfo = (await client.callTool("system_info", {})) as Record<string, unknown>;
  assert.equal(mcpStatus.running, true);
  assert.equal(mcpStatus.transport, "stdio");
  assert.equal(systemInfo.version, RUFLO_PINNED_VERSION);
  assert.equal(resolve(String(systemInfo.cwd)), resolve(repositoryRoot));

  const riskCases = [
    { path: "docs/overview.md", additions: 10, deletions: 0, expected: "low" },
    { path: "src/auth/session.ts", additions: 10, deletions: 0, expected: "high" },
    { path: "src/auth/config.ts", additions: 350, deletions: 10, expected: "critical" },
  ];
  const observedCases = [];
  for (const testCase of riskCases) {
    const result = (await client.callTool("analyze_file-risk", {
      path: testCase.path,
      additions: testCase.additions,
      deletions: testCase.deletions,
      status: "modified",
    })) as Record<string, unknown>;
    assert.equal(result.risk, testCase.expected);
    observedCases.push({ ...testCase, observed: result.risk, score: result.score });
  }

  const adapter = new RufloReadOnlyReviewAdapter(client);
  const review = await adapter.review({ baseRef, headCommit, headTree });
  const finishedAt = new Date().toISOString();
  closeReceipt = await client.close();
  const afterPorcelain = git(repositoryRoot, "status", "--porcelain");
  const claudeFlowAfter = existsSync(claudeFlowPath);
  const afterFree = {
    A: process.platform === "win32" ? freeBytes("A:\\") : freeBytes(repositoryRoot),
    C: process.platform === "win32" ? freeBytes("C:\\") : null,
  };
  assert.equal(afterPorcelain, beforePorcelain);
  assert.equal(claudeFlowAfter, claudeFlowBefore);

  process.stdout.write(
    `${JSON.stringify(
      {
        schemaVersion: 1,
        pilot: "nabuflow-ruflo-readonly-pilot-v1",
        policy: RUFLO_MCP_POLICY_VERSION,
        providerVersion: RUFLO_PINNED_VERSION,
        subject: { baseRef, headCommit, headTree },
        startedAt,
        finishedAt,
        durationMs: Math.round(performance.now() - started),
        database: "NONE",
        environment: "LAB",
        store: paths.runtimeRoot.replaceAll("\\", "/"),
        kind: "bounded-readonly-mcp-pilot",
        tools,
        unauthorizedDirectCall: { tool: "system_reset", code: unauthorizedCode, blocked: true },
        connection: {
          running: mcpStatus.running,
          transport: mcpStatus.transport,
          cwd: String(systemInfo.cwd).replaceAll("\\", "/"),
          stderrBytes: closeReceipt.stderrBytes,
        },
        accuracyCases: observedCases,
        review,
        invariants: {
          worktreeCleanBefore: beforePorcelain === "",
          worktreeCleanAfter: afterPorcelain === "",
          projectStateCreated: !claudeFlowBefore && claudeFlowAfter,
          daemonAutostart: false,
          credentialEnvironmentForwarding: false,
        },
        freeBytes: { before: beforeFree, after: afterFree },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (closeReceipt.stderrBytes === 0) await client.close().catch(() => undefined);
}
