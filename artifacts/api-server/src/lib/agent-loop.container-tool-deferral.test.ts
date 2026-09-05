import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const containerMocks = vi.hoisted(() => ({
  isContainerLayerConfigured: vi.fn(),
  provisionContainer: vi.fn(),
  execInContainer: vi.fn(),
  dbInsertValues: vi.fn().mockResolvedValue(undefined),
  dbSelectWhere: vi.fn().mockResolvedValue([]),
}));

const promptMocks = vi.hoisted(() => ({
  createPrompt: vi.fn(),
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {},
}));

vi.mock("@workspace/db", () => ({
  db: {
    insert: vi.fn(() => ({ values: containerMocks.dbInsertValues })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({ where: containerMocks.dbSelectWhere })),
    })),
  },
  toolAuditTable: {},
  agentToolCallsTable: {},
  agentTasksTable: {},
  projectsTable: {},
  secretsTable: {
    projectId: {},
    valueEncrypted: {},
  },
}));

// Mock the selected-provider gateway, not the retired Fly adapter. These
// behavioral checks must not depend on live Cloudflare configuration.
vi.mock("./tenant-runtime", () => ({
  isContainerLayerConfigured: containerMocks.isContainerLayerConfigured,
  provisionContainer: containerMocks.provisionContainer,
  execInContainer: containerMocks.execInContainer,
}));

vi.mock("./agent-prompts", async () => ({
  createPrompt: promptMocks.createPrompt,
}));

vi.mock("./project-lifecycle", () => ({
  withActiveProjectLifecycle: async (
    _projectId: number,
    work: (session: { assertActive: () => Promise<boolean> }) => Promise<unknown>,
  ) => ({
    state: "active" as const,
    value: await work({ assertActive: async () => true }),
  }),
}));

import {
  FileWorkspace,
  applyToolResultToRepeatedErrorState,
  executeTool,
  type ToolCtx,
} from "./agent-loop.js";

function makeToolCtx(name: string, args: Record<string, unknown>): ToolCtx {
  return {
    name,
    args,
    workspace: new FileWorkspace([]),
    stack: "react-vite",
    profile: { checks: [], installCmd: null },
    input: {
      mode: "build",
      projectId: 32,
      projectName: "Wave 4.1 Test",
      projectKind: "web",
      projectFormat: "react-vite",
      stack: "react-vite",
      userPrompt: "Build a frontend-only app.",
      agentMode: "lite",
      existingFiles: [],
      onEvent: vi.fn(),
      signal: new AbortController().signal,
    },
    commandsRun: [],
    step: 1,
    containerState: { id: null, installed: false },
    loadedSkills: new Map(),
    e2eResults: [],
    screenshotBudget: { remaining: 5 * 1024 * 1024 },
    fetchBudget: { remaining: 20 },
    senseCounts: {
      screenshot: 0,
      webFetch: 0,
      webSearch: 0,
      branding: 0,
      diagnostics: 0,
    },
    creativeBudget: { remaining: 5 },
    creativeCounts: { image: 0, video: 0, audio: 0, bgRemoval: 0 },
    presentedAssets: [],
    loopStartedAt: Date.now(),
    loopWallClockMs: 60_000,
  };
}

describe("Builder Wave 4.1 container-tool deferral", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("TENANT_RUNTIME_PROVIDER", "cloudflare");
    vi.stubEnv("ZERO_SANDBOX_SHELL_ENABLED", "false");
    // Prevent E2E auto-approve from bypassing the createPrompt gate in tests
    // that verify deploy-shaped command approval (E2E_TEST_ENABLED may be set
    // in the Vitest process environment).
    vi.stubEnv("E2E_TEST_ENABLED", "");
    promptMocks.createPrompt.mockReturnValue({
      promptId: "prompt-1",
      promise: Promise.resolve({ canceled: false, response: false }),
    });
    containerMocks.isContainerLayerConfigured.mockResolvedValue(false);
    containerMocks.provisionContainer.mockResolvedValue(null);
    containerMocks.execInContainer.mockResolvedValue({
      ok: true,
      output: "ok",
      stdout: "ok",
      stderr: "",
      exitCode: 0,
      machineWoken: false,
    });
  });

  it("runs an allowlisted command in the temp sandbox and streams start/finish events", async () => {
    vi.stubEnv("ZERO_SANDBOX_SHELL_ENABLED", "true");
    const ctx = makeToolCtx("run_command", { argv: ["node", "--version"] });
    const onEvent = vi.fn().mockResolvedValue(undefined);
    ctx.input.onEvent = onEvent;

    const result = await executeTool(ctx);

    expect(result).toMatchObject({ ok: true, exitCode: 0 });
    expect(result.observation).toContain("sandbox=temp-workspace");
    expect(result.observation).toContain(process.version);
    expect(onEvent.mock.calls.filter(([eventType]) => eventType === "command_output")).toHaveLength(
      2,
    );
    expect(containerMocks.provisionContainer).not.toHaveBeenCalled();
    expect(containerMocks.execInContainer).not.toHaveBeenCalled();
  });

  it("blocks run_command completely when the sandbox kill switch is off", async () => {
    containerMocks.isContainerLayerConfigured.mockResolvedValue(true);
    const result = await executeTool(makeToolCtx("run_command", { argv: ["pwd"] }));

    expect(result).toMatchObject({ ok: false, exitCode: 126 });
    expect(result.observation).toContain("ZERO_SANDBOX_SHELL_ENABLED");
    expect(containerMocks.isContainerLayerConfigured).not.toHaveBeenCalled();
    expect(containerMocks.provisionContainer).not.toHaveBeenCalled();
    expect(containerMocks.execInContainer).not.toHaveBeenCalled();
  });

  it("always asks before destructive or deploy-shaped sandbox commands", async () => {
    vi.stubEnv("ZERO_SANDBOX_SHELL_ENABLED", "true");
    const ctx = makeToolCtx("run_command", { argv: ["npm", "run", "deploy"] });
    ctx.workspace = new FileWorkspace([
      {
        path: "package.json",
        content: JSON.stringify({ scripts: { deploy: "node deploy.js" } }),
        mimeType: "application/json",
      },
      {
        path: "deploy.js",
        content: "console.log('must not execute without approval')",
        mimeType: "text/javascript",
      },
    ]);
    ctx.input.taskId = 91;
    ctx.input.requireCommandApproval = false;

    const result = await executeTool(ctx);

    expect(promptMocks.createPrompt).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: false });
    expect(result.observation).toContain("rejected by user");
    expect(containerMocks.execInContainer).not.toHaveBeenCalled();
  });

  it.each([
    ["run_workflow", { name: "build" }],
    ["pkg_install", { manager: "npm", pkg: "react" }],
    ["run_tests", {}],
    ["install_package", { runtime: "node", name: "react" }],
    ["read_diagnostics", { path: "src/App.tsx", tool: "tsc" }],
  ])(
    "%s short-circuits without provisioning when capability is unavailable",
    async (name, args) => {
      const result = await executeTool(makeToolCtx(name, args));

      expect(result).toMatchObject({
        ok: true,
        deferred: true,
      });
      expect(result.observation).toContain("DEFERRED:");
      expect(result.observation).toContain("live-server infrastructure");
      expect(containerMocks.isContainerLayerConfigured).toHaveBeenCalledTimes(1);
      expect(containerMocks.provisionContainer).not.toHaveBeenCalled();
      expect(containerMocks.execInContainer).not.toHaveBeenCalled();
    },
  );

  it("does not increment the repeated-error counter for deferred outcomes", () => {
    let state = { lastError: "", consecutiveErrors: 0 };
    const deferred = { ok: true, deferred: true };

    for (let attempt = 0; attempt < 3; attempt += 1) {
      state = applyToolResultToRepeatedErrorState(
        state,
        deferred,
        "DEFERRED: live-server infrastructure is unavailable",
      );
    }

    expect(state).toEqual({ lastError: "", consecutiveErrors: 0 });

    const firstFailure = applyToolResultToRepeatedErrorState(
      state,
      { ok: false },
      "ERROR: genuine failure",
    );
    const repeatedFailure = applyToolResultToRepeatedErrorState(
      firstFailure,
      { ok: false },
      "ERROR: genuine failure",
    );
    expect(repeatedFailure.consecutiveErrors).toBe(2);
  });

  it("uses an accurate sanitized message when operational provisioning returns no container", async () => {
    containerMocks.isContainerLayerConfigured.mockResolvedValue(true);
    containerMocks.provisionContainer.mockResolvedValue(null);

    const result = await executeTool(makeToolCtx("pkg_install", { manager: "npm", pkg: "react" }));

    expect(result).toEqual({
      ok: false,
      observation: "ERROR: container provisioning failed.",
    });
    expect(result.observation).not.toContain("FLY_API_TOKEN");
  });

  it("preserves normal tool execution when capability is operational", async () => {
    containerMocks.isContainerLayerConfigured.mockResolvedValue(true);
    containerMocks.provisionContainer.mockResolvedValue({ containerId: "machine-1" });
    const ctx = makeToolCtx("pkg_install", { manager: "npm", pkg: "react" });

    const result = await executeTool(ctx);

    expect(result.ok).toBe(true);
    expect(result.deferred).toBeUndefined();
    expect(ctx.containerState.id).toBe("machine-1");
    expect(containerMocks.provisionContainer).toHaveBeenCalledTimes(1);
    expect(containerMocks.execInContainer).toHaveBeenCalled();
  });

  it("returns a ready result immediately for an attached live container", async () => {
    const ctx = makeToolCtx("pkg_install", { manager: "npm", pkg: "react" });
    ctx.containerState.id = "machine-existing";

    const result = await executeTool(ctx);

    expect(result.ok).toBe(true);
    expect(result.deferred).toBeUndefined();
    expect(containerMocks.isContainerLayerConfigured).not.toHaveBeenCalled();
    expect(containerMocks.provisionContainer).not.toHaveBeenCalled();
    expect(containerMocks.execInContainer).toHaveBeenCalled();
  });

  it("records a Pantry intent without provisioning or installing in sealed mode", async () => {
    const ctx = makeToolCtx("pkg_install", {
      manager: "npm",
      pkg: "express",
      version: "^4.21.0",
    });
    ctx.stack = "node-api";
    ctx.input.stack = "node-api";
    ctx.input.zeroGenerationTarget = "cloudflare-sealed-staging-v1";

    const result = await executeTool(ctx);

    expect(result).toMatchObject({ ok: true });
    expect(JSON.parse(result.observation)).toEqual({
      ok: true,
      disposition: "pantry-dependency-intent-recorded",
      ecosystem: "npm",
      name: "express",
      selector: "^4.21.0",
      tenantInstallStarted: false,
    });
    expect(containerMocks.isContainerLayerConfigured).not.toHaveBeenCalled();
    expect(containerMocks.provisionContainer).not.toHaveBeenCalled();
    expect(containerMocks.execInContainer).not.toHaveBeenCalled();
  });

  it("blocks executable commands before the sandbox in sealed mode", async () => {
    const ctx = makeToolCtx("run_command", { argv: ["npm", "install"] });
    ctx.stack = "node-api";
    ctx.input.stack = "node-api";
    ctx.input.zeroGenerationTarget = "cloudflare-sealed-staging-v1";

    const result = await executeTool(ctx);

    expect(result).toMatchObject({ ok: false, exitCode: 126 });
    expect(result.observation).toContain("Pantry owns dependencies");
    expect(containerMocks.execInContainer).not.toHaveBeenCalled();
  });
});
