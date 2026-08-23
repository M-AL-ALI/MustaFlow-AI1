import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  deepseekCreate: vi.fn(),
  anthropicStream: vi.fn(),
  geminiStream: vi.fn(),
}));

vi.mock("openai", () => ({
  default: class OpenAIMock {
    chat = { completions: { create: mocks.deepseekCreate } };
  },
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: mocks.openaiCreate } } },
}));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { stream: mocks.anthropicStream } },
}));

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: { models: { generateContentStream: mocks.geminiStream } },
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { streamChatCompletion } from "./ai-providers";

async function* streamOf(...chunks: unknown[]): AsyncGenerator<unknown> {
  for (const chunk of chunks) yield chunk;
}

async function collect(stream: AsyncGenerator<string, void, void>): Promise<string> {
  let output = "";
  for await (const delta of stream) output += delta;
  return output;
}

const messages = [{ role: "user" as const, content: "What does this app do?" }];

describe("stream completion honesty", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.DEEPSEEK_API_KEY = "test-placeholder";
  });

  it("surfaces an OpenAI length terminal with usage and refusal evidence", async () => {
    mocks.openaiCreate.mockResolvedValue(
      streamOf(
        { choices: [{ delta: { refusal: "refused" }, finish_reason: null }] },
        {
          choices: [{ delta: {}, finish_reason: "length" }],
          usage: {
            prompt_tokens: 40,
            completion_tokens: 1_200,
            completion_tokens_details: { reasoning_tokens: 1_200 },
          },
        },
      ),
    );

    const promise = collect(
      streamChatCompletion({
        provider: "openai",
        model: "gpt-5-mini",
        messages,
        max_completion_tokens: 4_096,
        reasoning_effort: "low",
      }),
    );

    await expect(promise).rejects.toMatchObject({
      name: "EmptyCompletionError",
      code: "empty_completion",
      finishReason: "length",
      outputTokens: 1_200,
      reasoningTokens: 1_200,
      refusal: true,
    });
    expect(mocks.openaiCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        max_completion_tokens: 4_096,
        reasoning_effort: "low",
        stream: true,
      }),
    );
  });

  it("preserves a normal OpenAI text stream", async () => {
    mocks.openaiCreate.mockResolvedValue(
      streamOf(
        { choices: [{ delta: { content: "The app" }, finish_reason: null }] },
        {
          choices: [{ delta: { content: " is ready." }, finish_reason: "stop" }],
          usage: { prompt_tokens: 10, completion_tokens: 4 },
        },
      ),
    );

    await expect(
      collect(streamChatCompletion({ provider: "openai", model: "gpt-5-mini", messages })),
    ).resolves.toBe("The app is ready.");
  });

  it("guards empty Anthropic, DeepSeek, and Gemini streams", async () => {
    mocks.anthropicStream.mockReturnValue(
      streamOf(
        { type: "message_start", message: { usage: { input_tokens: 9 } } },
        { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 0 } },
      ),
    );
    mocks.deepseekCreate.mockResolvedValue(
      streamOf({
        choices: [{ delta: {}, finish_reason: "length" }],
        usage: { prompt_tokens: 9, completion_tokens: 0 },
      }),
    );
    mocks.geminiStream.mockResolvedValue(
      streamOf({
        candidates: [{ content: { parts: [] }, finishReason: "MAX_TOKENS" }],
        usageMetadata: { promptTokenCount: 9, candidatesTokenCount: 0, thoughtsTokenCount: 12 },
      }),
    );

    await expect(
      collect(streamChatCompletion({ provider: "anthropic", model: "claude-test", messages })),
    ).rejects.toMatchObject({ name: "EmptyCompletionError", finishReason: "end_turn" });
    await expect(
      collect(streamChatCompletion({ provider: "deepseek", model: "deepseek-test", messages })),
    ).rejects.toMatchObject({ name: "EmptyCompletionError", finishReason: "length" });
    await expect(
      collect(streamChatCompletion({ provider: "gemini", model: "gemini-test", messages })),
    ).rejects.toMatchObject({
      name: "EmptyCompletionError",
      finishReason: "MAX_TOKENS",
      reasoningTokens: 12,
    });
  });
});
