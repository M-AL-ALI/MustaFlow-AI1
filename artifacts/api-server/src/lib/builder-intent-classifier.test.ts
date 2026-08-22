import { beforeEach, describe, expect, it, vi } from "vitest";

const { createChatCompletion } = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
}));

vi.mock("./ai-providers", () => ({
  creditCostFor: vi.fn(() => 1),
  resolveStageProvider: vi.fn(() => ({ provider: "test", model: "test" })),
  createChatCompletion,
}));

import { runIntentClassifierPipeline } from "./builder";

describe("zero closed intent classifier", () => {
  beforeEach(() => {
    createChatCompletion.mockReset();
  });

  it.each([
    ["Thanks", "answer"],
    ["Plan a settings dashboard", "plan"],
    ["Fix the login form", "mutate"],
    ["Check the logs", "observe"],
  ] as const)("maps %s to %s without an open-ended label", async (prompt, intent) => {
    await expect(runIntentClassifierPipeline(prompt, [], true)).resolves.toMatchObject({ intent });
  });

  it("uses clarify for an ambiguous low-confidence classification", async () => {
    createChatCompletion.mockResolvedValue({
      choices: [{ message: { content: '{"intent":"mutate","confidence":0.61}' } }],
    });
    await expect(runIntentClassifierPipeline("Maybe the header", [], true)).resolves.toMatchObject({
      intent: "clarify",
      confidence: 0.61,
    });
  });

  it("uses clarify when the classifier throws", async () => {
    createChatCompletion.mockRejectedValue(new Error("test classifier unavailable"));
    await expect(runIntentClassifierPipeline("Maybe the header", [], true)).resolves.toMatchObject({
      intent: "clarify",
      decisionSource: "classifier_fallback",
    });
  });
});
