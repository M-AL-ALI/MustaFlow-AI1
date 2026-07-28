import { afterEach, describe, expect, it } from "vitest";
import {
  SandboxShellSession,
  buildSandboxEnvironment,
  evaluateSandboxCommand,
  sandboxShellEnabled,
  type SandboxWorkspaceFile,
} from "./sandbox-shell";

const sessions: SandboxShellSession[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((session) => session.dispose()));
});

describe("sandbox shell policy", () => {
  it("is enabled by default and supports an explicit kill switch", () => {
    expect(sandboxShellEnabled({})).toBe(true);
    expect(sandboxShellEnabled({ ZERO_SANDBOX_SHELL_ENABLED: "false" })).toBe(false);
  });

  it("allows the documented argv-only command families", () => {
    const files: SandboxWorkspaceFile[] = [
      {
        path: "package.json",
        content: JSON.stringify({ scripts: { test: "vitest run", check: "tsc --noEmit" } }),
      },
    ];

    expect(evaluateSandboxCommand(["node", "--version"], files).ok).toBe(true);
    expect(evaluateSandboxCommand(["npm", "install"], files).ok).toBe(true);
    expect(evaluateSandboxCommand(["npm", "test"], files).ok).toBe(true);
    expect(evaluateSandboxCommand(["npm", "run", "check"], files).ok).toBe(true);
    expect(evaluateSandboxCommand(["npx", "tsc", "--noEmit"], files).ok).toBe(true);
    expect(evaluateSandboxCommand(["npx", "vitest", "run"], files).ok).toBe(true);
    expect(evaluateSandboxCommand(["cat", "src/App.tsx"], files).ok).toBe(true);
  });

  it("rejects raw shells, inline eval, path escapes, network URLs, and unsafe find", () => {
    expect(evaluateSandboxCommand(["sh", "-c", "echo nope"]).ok).toBe(false);
    expect(evaluateSandboxCommand(["node", "-e", "console.log(1)"]).ok).toBe(false);
    expect(evaluateSandboxCommand(["cat", "../server.env"]).ok).toBe(false);
    expect(evaluateSandboxCommand(["npm", "install", "https://example.com/pkg.tgz"]).ok).toBe(
      false,
    );
    expect(evaluateSandboxCommand(["find", ".", "-exec", "cat", "{}", ";"]).ok).toBe(false);
  });

  it("marks deploy-shaped package scripts for the existing approval rail", () => {
    const files: SandboxWorkspaceFile[] = [
      {
        path: "package.json",
        content: JSON.stringify({ scripts: { deploy: "node scripts/deploy.js" } }),
      },
    ];
    const decision = evaluateSandboxCommand(["npm", "run", "deploy"], files);
    expect(decision.ok).toBe(true);
    if (decision.ok) expect(decision.requiresApproval).toBe(true);
  });
});

describe("SandboxShellSession", () => {
  it("executes a real command in the temp snapshot with bounded output and scrubbed secrets", async () => {
    const session = new SandboxShellSession({
      commandTimeoutMs: 5_000,
      taskBudgetMs: 10_000,
      outputBytes: 128,
      maxConcurrent: 1,
      maxFiles: 20,
      maxWorkspaceBytes: 100_000,
    });
    sessions.push(session);
    const controller = new AbortController();
    const files: SandboxWorkspaceFile[] = [
      {
        path: "verify.mjs",
        content:
          "console.log('sandbox-executed'); console.log('db-secret=' + String(Boolean(process.env.DATABASE_URL))); console.log('x'.repeat(500));",
      },
    ];

    const previousDatabaseUrl = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgresql://production-secret";
    try {
      const result = await session.execute({
        argv: ["node", "verify.mjs"],
        files,
        signal: controller.signal,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("sandbox-executed");
      expect(result.stdout).toContain("db-secret=false");
      expect(result.stdout).not.toContain("production-secret");
      expect(result.outputTruncated).toBe(true);
      expect(
        Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr),
      ).toBeLessThanOrEqual(128);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it("builds an allowlist environment instead of inheriting server secrets", () => {
    const env = buildSandboxEnvironment("C:\\sandbox");
    expect(env.DATABASE_URL).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CI).toBe("true");
    expect(env.HOME).toBe("C:\\sandbox");
  });
});
