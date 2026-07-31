import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const { createChatCompletion } = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));
vi.mock("./ai-providers", () => ({
  createChatCompletion,
  resolveStageProvider: vi.fn(() => ({ provider: "openai", model: "test-model" })),
}));

import { PLANNING_DEPTH_FOR_MODE, resolvePlanningDepth, runPlanningBrain } from "./planning-brain";

describe("unified Builder planning brain", () => {
  beforeEach(() => {
    createChatCompletion.mockReset();
    createChatCompletion.mockResolvedValue({
      choices: [{ message: { content: '{"ok":true}' } }],
    });
  });

  it("maps modes to the required depth ladder and Deep to deepest except Lite", () => {
    expect(PLANNING_DEPTH_FOR_MODE).toEqual({
      lite: "minimal",
      eco: "standard",
      power: "deep",
      pro: "deepest",
    });
    expect(resolvePlanningDepth("eco", true)).toBe("deepest");
    expect(resolvePlanningDepth("lite", true)).toBe("minimal");
  });

  it("runs Power's self-check pass", async () => {
    await runPlanningBrain({
      entryPoint: "planning_agent",
      mode: "power",
      systemPrompt: "Return JSON.",
      messages: [{ role: "user", content: "Plan an app" }],
      maxCompletionTokens: 1000,
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(createChatCompletion.mock.calls[1]?.[0].messages.at(-1)?.content).toContain(
      "Self-check",
    );
  });

  it("raises reasoning effort only for Pro with Deep enabled", async () => {
    await runPlanningBrain({
      entryPoint: "pro_micro",
      mode: "pro",
      deepReasoning: true,
      systemPrompt: "Return JSON.",
      messages: [{ role: "user", content: "Plan an app" }],
      maxCompletionTokens: 1000,
    });
    expect(createChatCompletion.mock.calls[0]?.[0].reasoning_effort).toBe("high");
  });

  it("passes the caller AbortSignal to every provider planning pass", async () => {
    const controller = new AbortController();

    await runPlanningBrain({
      entryPoint: "planning_agent",
      mode: "power",
      systemPrompt: "Return JSON.",
      messages: [{ role: "user", content: "Plan an app" }],
      maxCompletionTokens: 1000,
      signal: controller.signal,
    });

    expect(createChatCompletion).toHaveBeenCalledTimes(2);
    expect(createChatCompletion.mock.calls[0]?.[0].signal).toBe(controller.signal);
    expect(createChatCompletion.mock.calls[1]?.[0].signal).toBe(controller.signal);
  });

  it("is the landing point for all four legacy planner entry points", () => {
    const builder = readFileSync(new URL("./builder.ts", import.meta.url), "utf8");
    const subagent = readFileSync(new URL("./subagent.ts", import.meta.url), "utf8");
    expect(builder).toContain('entryPoint: "planning_agent"');
    expect(builder).toContain('entryPoint: "pro_micro"');
    expect(builder).toContain('entryPoint: "decompose"');
    expect(subagent).toContain('entryPoint: "plan_subtasks"');
  });
});
