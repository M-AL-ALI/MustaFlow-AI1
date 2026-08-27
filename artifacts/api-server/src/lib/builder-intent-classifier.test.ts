import { beforeEach, describe, expect, it, vi } from "vitest";

const { createChatCompletion, streamChatCompletion } = vi.hoisted(() => ({
  createChatCompletion: vi.fn(),
  streamChatCompletion: vi.fn(),
}));

vi.mock("./ai-providers", () => ({
  creditCostFor: vi.fn(() => 1),
  resolveStageProvider: vi.fn(() => ({ provider: "test", model: "test" })),
  createChatCompletion,
  streamChatCompletion,
}));

import {
  runConversePipeline,
  runConverseStreamPipeline,
  runIntentClassifierPipeline,
} from "./builder";

describe("zero closed intent classifier", () => {
  beforeEach(() => {
    createChatCompletion.mockReset();
    streamChatCompletion.mockReset();
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

  it("keeps an explicit project-choice capture out of the mutation path without a model call", async () => {
    const result = await runIntentClassifierPipeline(
      "Save this as a project decision: keep the site static. Save this as a project rejection: never add a database or authentication unless I explicitly reverse it. Do not build or change files.",
      [],
      true,
    );
    expect(result).toMatchObject({
      intent: "answer",
      legacyIntent: "converse",
      confidence: 1,
      decisionSource: "deterministic_rule",
    });
    expect(createChatCompletion).not.toHaveBeenCalled();
  });

  it("preserves one focused question locally when clarification generation fails", async () => {
    createChatCompletion.mockRejectedValue(new Error("test provider unavailable"));
    const result = await runConversePipeline({
      projectName: "Example",
      userPrompt: "Maybe change the page",
      conversationHistory: [],
      currentFiles: [],
      agentMode: "lite",
      isAmbiguous: true,
    });

    expect(result).toMatchObject({
      markdown: "Should I change the content, the layout, or the visual style?",
      clarifying: {
        question: "Should I change the content, the layout, or the visual style?",
      },
      stopEvidence: {
        source: "local_contract_fallback",
        fallbackCode: "clarification_provider_unavailable",
      },
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(streamChatCompletion).not.toHaveBeenCalled();
  });

  it("preserves clarification locally when the provider returns a non-clean stop", async () => {
    createChatCompletion.mockResolvedValue({
      choices: [
        {
          finish_reason: "length",
          message: {
            content: '{"question":"Which page?","options":["Home","Settings"]}',
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 20 },
    });

    const result = await runConversePipeline({
      projectName: "Example",
      userPrompt: "Maybe change the page",
      conversationHistory: [],
      currentFiles: [],
      agentMode: "lite",
      isAmbiguous: true,
    });

    expect(result.clarifying?.question).toBe(
      "Should I change the content, the layout, or the visual style?",
    );
    expect(result.stopEvidence).toEqual({
      source: "local_contract_fallback",
      fallbackCode: "clarification_provider_unavailable",
    });
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
  });

  it("preserves one focused question locally on the streaming path", async () => {
    createChatCompletion.mockRejectedValue(new Error("test provider unavailable"));
    const onToken = vi.fn();
    const result = await runConverseStreamPipeline(
      {
        projectName: "Example",
        userPrompt: "Something is broken",
        conversationHistory: [],
        currentFiles: [],
        agentMode: "eco",
        isAmbiguous: true,
      },
      onToken,
    );

    expect(result.clarifying?.question).toBe(
      "Should I investigate what is wrong, or repair it now?",
    );
    expect(onToken).toHaveBeenCalledOnce();
    expect(onToken).toHaveBeenCalledWith(result.markdown);
    expect(createChatCompletion).toHaveBeenCalledTimes(1);
    expect(streamChatCompletion).not.toHaveBeenCalled();
  });
});
