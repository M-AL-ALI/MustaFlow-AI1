import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@workspace/db", () => ({
  db: {
    select: () => ({ from: () => ({ where: () => Promise.resolve([]) }) }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
    }),
  },
  builderSkillsTable: {
    name: "name",
    enabled: "enabled",
    loadCount: "loadCount",
    lastLoadedAt: "lastLoadedAt",
    updatedAt: "updatedAt",
  },
  toolAuditTable: {},
}));

vi.mock("drizzle-orm", () => ({
  sql: (..._args: unknown[]) => ({ __sql: true }),
  inArray: () => ({ __inArray: true }),
  eq: () => ({ __eq: true }),
  and: () => ({ __and: true }),
}));

import { executeTool, type ToolCtx } from "./agent-loop";
import {
  invalidateSkillCache,
  __setManifestsForTesting,
  type SkillManifest,
} from "./builder-skills";

function makeCtx(
  overrides: Partial<ToolCtx> & {
    toolName: string;
    args: Record<string, unknown>;
    loadedSkills?: Map<string, SkillManifest>;
  },
): ToolCtx {
  const controller = new AbortController();
  const base: ToolCtx = {
    name: overrides.toolName,
    args: overrides.args,
    workspace: {} as ToolCtx["workspace"],
    stack: "static-html" as ToolCtx["stack"],
    profile: { checks: [], installCmd: null },
    input: {
      mode: "build",
      projectId: 1,
      projectName: "p",
      projectKind: "web",
      projectFormat: null,
      stack: null,
      userPrompt: "",
      agentMode: "eco",
      existingFiles: [],
      onEvent: async () => {},
      signal: controller.signal,
    } as unknown as ToolCtx["input"],
    commandsRun: [],
    step: 1,
    containerState: { id: null, installed: false },
    loadedSkills: overrides.loadedSkills ?? new Map(),
    e2eResults: [],
    screenshotBudget: { remaining: 5 * 1024 * 1024 },
    fetchBudget: { remaining: 20 },
    senseCounts: { screenshot: 0, webFetch: 0, webSearch: 0, branding: 0, diagnostics: 0 },
    creativeBudget: { remaining: 5 },
    creativeCounts: { image: 0, video: 0, audio: 0, bgRemoval: 0 },
    presentedAssets: [],
  };
  return base;
}

beforeEach(() => {
  invalidateSkillCache();
});

describe("executeTool — load_skill", () => {
  it("returns the manifest body on first load and caches it", async () => {
    const manifest: SkillManifest = {
      name: "react-vite",
      description: "React + Vite",
      triggers: [],
      body: "FULL BODY CONTENT",
      filePath: "(virtual)",
    };
    __setManifestsForTesting(new Map([[manifest.name, manifest]]));
    const loaded = new Map<string, SkillManifest>();
    const ctx = makeCtx({
      toolName: "load_skill",
      args: { name: "react-vite" },
      loadedSkills: loaded,
    });
    const res = await executeTool(ctx);
    expect(res.ok).toBe(true);
    expect(res.observation).toContain("# Skill: react-vite");
    expect(res.observation).toContain("FULL BODY CONTENT");
    expect(loaded.has("react-vite")).toBe(true);
  });

  it("returns a cache-hit observation on the second load without re-emitting the body", async () => {
    const manifest: SkillManifest = {
      name: "react-vite",
      description: "React + Vite",
      triggers: [],
      body: "FULL BODY CONTENT",
      filePath: "(virtual)",
    };
    __setManifestsForTesting(new Map([[manifest.name, manifest]]));
    const loaded = new Map<string, SkillManifest>([["react-vite", manifest]]);
    const ctx = makeCtx({
      toolName: "load_skill",
      args: { name: "react-vite" },
      loadedSkills: loaded,
    });
    const res = await executeTool(ctx);
    expect(res.ok).toBe(true);
    expect(res.observation).toContain("already loaded earlier this run");
    expect(res.observation).toContain(`${manifest.body.length} bytes`);
    expect(res.observation).not.toContain("FULL BODY CONTENT");
  });

  it("returns an error observation for an unknown skill", async () => {
    __setManifestsForTesting(new Map());
    const ctx = makeCtx({
      toolName: "load_skill",
      args: { name: "no-such-skill" },
    });
    const res = await executeTool(ctx);
    expect(res.ok).toBe(false);
    expect(res.observation).toMatch(/not found or disabled/);
  });

  it("rejects an empty name", async () => {
    const ctx = makeCtx({ toolName: "load_skill", args: { name: "   " } });
    const res = await executeTool(ctx);
    expect(res.ok).toBe(false);
    expect(res.observation).toMatch(/requires \{ name \}/);
  });

  it("rejects a name that is too long", async () => {
    const ctx = makeCtx({
      toolName: "load_skill",
      args: { name: "x".repeat(121) },
    });
    const res = await executeTool(ctx);
    expect(res.ok).toBe(false);
    expect(res.observation).toMatch(/too long/);
  });
});
