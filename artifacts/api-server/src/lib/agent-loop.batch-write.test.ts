import { describe, expect, it, vi } from "vitest";

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {},
}));

vi.mock("@workspace/db", () => ({
  db: {},
  toolAuditTable: {},
  agentToolCallsTable: {},
  agentTasksTable: {},
  projectsTable: {},
}));

import { FileWorkspace, MAX_BATCH_WRITE_BYTES, executeTool, type ToolCtx } from "./agent-loop.js";

function makeToolCtx(files: unknown[]): ToolCtx {
  return {
    name: "write_files",
    args: { files },
    workspace: new FileWorkspace([]),
    stack: "react-vite",
    profile: { checks: [], installCmd: null },
    input: {
      mode: "build",
      projectId: 35,
      projectName: "Batch write test",
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

function parseObservation(observation: string) {
  return JSON.parse(observation) as {
    written: number;
    failed: number;
    results: Array<{ path: string; ok: boolean; bytes: number; message: string }>;
    continuationRequired: boolean;
    remainingPaths: string[];
  };
}

describe("write_files", () => {
  it("writes several complete files in one tool execution", async () => {
    const ctx = makeToolCtx([
      { path: "package.json", content: '{"scripts":{"dev":"vite"}}' },
      { path: "src/App.tsx", content: "export default function App(){return <main>Hello</main>}" },
      { path: "src/main.tsx", content: "import './App'" },
    ]);

    const result = await executeTool(ctx);
    const summary = parseObservation(result.observation);

    expect(result.ok).toBe(true);
    expect(summary).toMatchObject({
      written: 3,
      failed: 0,
      continuationRequired: false,
      remainingPaths: [],
    });
    expect(ctx.workspace.read("package.json")?.content).toContain("vite");
    expect(ctx.workspace.read("src/App.tsx")?.content).toContain("Hello");
    expect(ctx.workspace.read("src/main.tsx")?.content).toBe("import './App'");
    expect(ctx.input.onEvent).toHaveBeenCalledWith(
      "loop:phase",
      JSON.stringify({
        semantics: "zero-prompt-queue-safe-boundaries-v1",
        phase: "executeBatchFileWrite",
      }),
    );
    expect(ctx.input.onEvent).not.toHaveBeenCalledWith(
      "loop:phase",
      expect.stringContaining('"phase":"executeSingleFileWrite"'),
    );
  });

  it("reports per-file partial failure and continues valid writes", async () => {
    const ctx = makeToolCtx([
      { path: "src/first.ts", content: "export const first = true;" },
      { path: "../outside.ts", content: "export const unsafe = true;" },
      { path: "src/last.ts", content: "export const last = true;" },
    ]);

    const result = await executeTool(ctx);
    const summary = parseObservation(result.observation);

    expect(result.ok).toBe(false);
    expect(summary.written).toBe(2);
    expect(summary.failed).toBe(1);
    expect(summary.results).toEqual([
      expect.objectContaining({ path: "src/first.ts", ok: true }),
      expect.objectContaining({ path: "../outside.ts", ok: false, message: "ERROR: invalid path" }),
      expect.objectContaining({ path: "src/last.ts", ok: true }),
    ]);
    expect(ctx.workspace.read("src/first.ts")).toBeDefined();
    expect(ctx.workspace.read("../outside.ts")).toBeUndefined();
    expect(ctx.workspace.read("src/last.ts")).toBeDefined();
  });

  it("stops at the byte bound and explicitly returns the continuation paths", async () => {
    const firstContent = "a".repeat(Math.floor(MAX_BATCH_WRITE_BYTES * 0.6));
    const secondContent = "b".repeat(Math.floor(MAX_BATCH_WRITE_BYTES * 0.6));
    const ctx = makeToolCtx([
      { path: "src/first.ts", content: firstContent },
      { path: "src/second.ts", content: secondContent },
    ]);

    const result = await executeTool(ctx);
    const summary = parseObservation(result.observation);

    expect(result.ok).toBe(true);
    expect(summary).toMatchObject({
      written: 1,
      failed: 0,
      continuationRequired: true,
      remainingPaths: ["src/second.ts"],
    });
    expect(ctx.workspace.read("src/first.ts")?.content).toBe(firstContent);
    expect(ctx.workspace.read("src/second.ts")).toBeUndefined();
    expect(result.observation).not.toContain(secondContent);
  });
});
