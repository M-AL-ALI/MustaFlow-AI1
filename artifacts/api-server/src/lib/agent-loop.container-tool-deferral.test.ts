import { beforeEach, describe, expect, it, vi } from "vitest";

const containerMocks = vi.hoisted(() => ({
  isContainerLayerConfigured: vi.fn(),
  provisionContainer: vi.fn(),
  execInContainer: vi.fn(),
  dbInsertValues: vi.fn().mockResolvedValue(undefined),
  dbSelectWhere: vi.fn().mockResolvedValue([]),
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

vi.mock("./container", () => ({
  isContainerLayerConfigured: containerMocks.isContainerLayerConfigured,
  provisionContainer: containerMocks.provisionContainer,
  execInContainer: containerMocks.execInContainer,
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
  beforeEach(() => {
    vi.clearAllMocks();
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

  it.each([
    ["run_command", { argv: ["pwd"] }],
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
    const ctx = makeToolCtx("run_command", { argv: ["pwd"] });

    const result = await executeTool(ctx);

    expect(result.ok).toBe(true);
    expect(result.deferred).toBeUndefined();
    expect(ctx.containerState.id).toBe("machine-1");
    expect(containerMocks.provisionContainer).toHaveBeenCalledTimes(1);
    expect(containerMocks.execInContainer).toHaveBeenCalled();
  });

  it("returns a ready result immediately for an attached live container", async () => {
    const ctx = makeToolCtx("run_command", { argv: ["pwd"] });
    ctx.containerState.id = "machine-existing";

    const result = await executeTool(ctx);

    expect(result.ok).toBe(true);
    expect(result.deferred).toBeUndefined();
    expect(containerMocks.isContainerLayerConfigured).not.toHaveBeenCalled();
    expect(containerMocks.provisionContainer).not.toHaveBeenCalled();
    expect(containerMocks.execInContainer).toHaveBeenCalled();
  });
});
