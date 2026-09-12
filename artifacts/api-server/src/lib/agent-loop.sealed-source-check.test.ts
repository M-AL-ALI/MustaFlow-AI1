import { describe, expect, it, vi } from "vitest";
import { ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE } from "@workspace/tenant-runtime-contracts";
import {
  withZeroSealedSourceCheck,
  ZERO_SEALED_SOURCE_CHECK_ID,
} from "./zero-sealed-finalize-check";

vi.mock("@workspace/integrations-openai-ai-server", () => ({ openai: {} }));
vi.mock("@workspace/db", () => ({
  db: {},
  toolAuditTable: {},
  agentToolCallsTable: {},
  agentTasksTable: {},
  projectsTable: {},
}));

import {
  FileWorkspace,
  executeTool,
  runCheckProfile,
  runAgentLoop,
  type ToolCtx,
} from "./agent-loop";

const modelTurns = vi.hoisted(() => vi.fn());
vi.mock("./agent-model-request", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./agent-model-request")>()),
  runAgentModelRequest: modelTurns,
}));
vi.mock("./ai-providers", () => ({
  createChatCompletion: vi.fn(),
  resolveStageProvider: () => ({ provider: "openai", model: "test-model" }),
  VISION_MODEL: {},
}));
vi.mock("./builder-skills", () => ({
  listEnabledSkills: async () => [],
  listEnabledSkillsForTarget: async () => [],
  formatSkillIndex: () => "",
}));
vi.mock("./mcp", () => ({ discoverMcpTools: async () => [] }));
vi.mock("./project-search", () => ({ invalidateFileEmbedding: async () => {} }));

function context(): ToolCtx {
  return {
    name: "run_command",
    args: { argv: ["__inprocess__", ZERO_SEALED_SOURCE_CHECK_ID] },
    workspace: new FileWorkspace([]),
    stack: "node-api",
    profile: {
      checks: withZeroSealedSourceCheck([], ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE),
      installCmd: null,
    },
    input: {
      mode: "refine",
      projectId: 61,
      projectName: "Source check regression",
      projectKind: "web",
      projectFormat: "node-api",
      stack: "node-api",
      userPrompt: "Preserve the English and Arabic notebook and repair the build.",
      agentMode: "lite",
      existingFiles: [],
      liveServerAvailable: false,
      zeroGenerationTarget: ZERO_SEALED_PRODUCTION_GENERATION_GATE_VALUE,
      onEvent: vi.fn(),
      onFileMutation: vi.fn(),
      signal: new AbortController().signal,
    },
    commandsRun: [],
    step: 1,
    containerState: { id: null, installed: false },
    loadedSkills: new Map(),
    e2eResults: [],
    screenshotBudget: { remaining: 0 },
    fetchBudget: { remaining: 0 },
    senseCounts: { screenshot: 0, webFetch: 0, webSearch: 0, branding: 0, diagnostics: 0 },
    creativeBudget: { remaining: 0 },
    creativeCounts: { image: 0, video: 0, audio: 0, bgRemoval: 0 },
    presentedAssets: [],
    loopStartedAt: Date.now(),
    loopWallClockMs: 60_000,
  };
}

describe("sealed source checks during the agent loop", () => {
  it("fails the shared automatic-check runner before finalization and without provisioning", async () => {
    const ctx = context();
    const results = await runCheckProfile(
      ctx.profile.checks,
      ctx.workspace,
      ctx.input,
      ctx.containerState,
    );
    expect(results).toEqual([
      expect.objectContaining({
        id: ZERO_SEALED_SOURCE_CHECK_ID,
        passed: false,
        code: "zero_sealed_source_contract_error",
        reasonCodes: ["required_files"],
        message: expect.stringContaining("required_files"),
      }),
    ]);
    expect(results[0].message).toContain("create package.json, tsconfig.json, and src/index.ts");
    expect(ctx.containerState.id).toBeNull();
    expect(ctx.input.onFileMutation).not.toHaveBeenCalled();
    expect(ctx.profile.checks[0].required).toBe(true);
  });

  it("runs the same check through an exact declared in-process command", async () => {
    const ctx = context();
    const result = await executeTool(ctx);
    expect(result.ok).toBe(false);
    expect(result.observation).toContain("required_files");
    expect(ctx.commandsRun).toEqual([expect.objectContaining({ exitCode: 1 })]);
    expect(ctx.input.onFileMutation).not.toHaveBeenCalled();
  });

  it("does not defer a source failure when all server checks are unavailable", async () => {
    const ctx = context();
    const results = await runCheckProfile(ctx.profile.checks, ctx.workspace, ctx.input);
    expect(results.every((check) => check.passed)).toBe(false);
    expect(results.some((check) => check.message.startsWith("deferred:"))).toBe(false);
  });

  it("honors cancellation before parsing or trying a container", async () => {
    const ctx = context();
    ctx.input.signal = AbortSignal.abort();
    const results = await runCheckProfile(ctx.profile.checks, ctx.workspace, ctx.input);
    expect(results[0]).toMatchObject({ passed: false, message: "aborted" });
    expect(ctx.containerState.id).toBeNull();
  });

  it("rejects the special command outside the declared profile", async () => {
    const ctx = context();
    ctx.profile.checks = [];
    const result = await executeTool(ctx);
    expect(result.ok).toBe(false);
    expect(result.observation).toContain("must exactly match");
  });

  it("does not give a non-sealed target access to the sealed validator", async () => {
    const ctx = context();
    ctx.input.zeroGenerationTarget = undefined;
    const result = await executeTool(ctx);
    expect(result.ok).toBe(false);
    expect(result.observation).toContain("requires a sealed generation target");
  });
});

describe("structured source diagnostics at real loop boundaries", () => {
  it("preserves reason codes in automatic, finalization, post-loop events and the report", async () => {
    const ctx = context();
    const observations: Array<{ phase: string; checks: Array<Record<string, unknown>> }> = [];
    let phase = "";
    ctx.input.onEvent = (type, message) => {
      if (type === "loop:phase") phase = JSON.parse(message).phase;
      if (type === "check_result") observations.push({ phase, checks: JSON.parse(message) });
    };
    const response = (id: string, name: string, args: Record<string, unknown>) => ({
      choices: [
        {
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              { id, type: "function", function: { name, arguments: JSON.stringify(args) } },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    });
    modelTurns.mockReset();
    modelTurns
      .mockResolvedValueOnce(
        response("write", "write_file", {
          path: "README.md",
          content: "Keep the requested notebook and repair its source.",
        }),
      )
      .mockResolvedValueOnce(response("finalize", "finalize", { summary: "Finished" }));
    const result = await runAgentLoop({ ...ctx.input, maxSteps: 2, e2eEnabled: false });
    for (const boundary of ["auto_check", "finalize_check", "post_loop_check"]) {
      expect(observations.find((event) => event.phase === boundary)?.checks).toContainEqual(
        expect.objectContaining({
          id: ZERO_SEALED_SOURCE_CHECK_ID,
          passed: false,
          code: "zero_sealed_source_contract_error",
          reasonCodes: ["required_files"],
        }),
      );
    }
    expect(result.loopReport.checkResults).toContainEqual(
      expect.objectContaining({
        id: ZERO_SEALED_SOURCE_CHECK_ID,
        code: "zero_sealed_source_contract_error",
        reasonCodes: ["required_files"],
      }),
    );
    expect(result.loopReport.terminationReason).not.toBe("finalized");
    expect(modelTurns).toHaveBeenCalledTimes(2);
  });
});
