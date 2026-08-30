import { beforeEach, describe, expect, it, vi } from "vitest";

const createChatCompletion = vi.hoisted(() => vi.fn());

vi.mock("./ai-providers", () => ({
  computeModelUsdCost: vi.fn(() => 0.000031),
  creditCostFor: vi.fn(() => 1),
  resolveStageProvider: vi.fn(() => ({ provider: "test-provider", model: "test-vision" })),
  createChatCompletion,
  streamChatCompletion: vi.fn(),
  EmptyCompletionError: class EmptyCompletionError extends Error {},
}));

import { proposeImageAltText } from "./builder";
import { withOneCleanRetry } from "./asset-alt-text-policy";

describe("Zero image alt-text proposal", () => {
  beforeEach(() => createChatCompletion.mockReset());

  it("returns one bounded editable sentence with a provider-cost receipt", async () => {
    createChatCompletion.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: '"A red flag waving."' } }],
      usage: { prompt_tokens: 21, completion_tokens: 6 },
    });

    await expect(proposeImageAltText({ dataUri: "data:image/png;base64,cG5n" })).resolves.toEqual({
      text: "A red flag waving.",
      usage: {
        provider: "test-provider",
        model: "test-vision",
        inputTokens: 21,
        outputTokens: 6,
        estimatedProviderCostUsd: 0.000031,
      },
    });
    expect(createChatCompletion.mock.calls[0]?.[0].max_completion_tokens).toBe(160);
  });

  it("never returns more than the editable 500-character contract", async () => {
    createChatCompletion.mockResolvedValue({
      choices: [{ finish_reason: "stop", message: { content: "x".repeat(900) } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    });
    await expect(
      proposeImageAltText({ dataUri: "data:image/png;base64,cG5n" }),
    ).resolves.toMatchObject({ text: "x".repeat(500) });
  });

  it("retries provider weather exactly once and never loops", async () => {
    const work = vi.fn().mockRejectedValueOnce(new Error("weather")).mockResolvedValue("ready");
    await expect(withOneCleanRetry(work)).resolves.toBe("ready");
    expect(work).toHaveBeenCalledTimes(2);

    work.mockReset();
    work.mockRejectedValue(new Error("terminal"));
    await expect(withOneCleanRetry(work)).rejects.toThrow("terminal");
    expect(work).toHaveBeenCalledTimes(2);
  });
});
