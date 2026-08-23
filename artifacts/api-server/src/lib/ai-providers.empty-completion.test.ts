import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  openaiCreate: vi.fn(),
  deepseekCreate: vi.fn(),
  anthropicStream: vi.fn(),
  geminiStream: vi.fn(),
  loggerInfo: vi.fn(),
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
  logger: { info: mocks.loggerInfo, warn: vi.fn(), error: vi.fn() },
}));

import { streamChatCompletion, type StreamCompletionSummary } from "./ai-providers";

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

    let summary: StreamCompletionSummary | null = null;
    const promise = collect(
      streamChatCompletion({
        provider: "openai",
        model: "gpt-5-mini",
        messages,
        max_completion_tokens: 4_096,
        reasoning_effort: "low",
        onFinish: (value) => {
          summary = value;
        },
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
    expect(summary).toEqual({
      finishReason: "length",
      inputTokens: 40,
      outputTokens: 1_200,
      reasoningTokens: 1_200,
      refusal: true,
      aborted: false,
    });
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ finishReason: "length", outputTokens: 1_200, aborted: false }),
      "AI stream completion summary",
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

    let summary: StreamCompletionSummary | null = null;
    await expect(
      collect(
        streamChatCompletion({
          provider: "openai",
          model: "gpt-5-mini",
          messages,
          onFinish: (value) => {
            summary = value;
          },
        }),
      ),
    ).resolves.toBe("The app is ready.");
    expect(summary).toMatchObject({
      finishReason: "stop",
      inputTokens: 10,
      outputTokens: 4,
      refusal: false,
      aborted: false,
    });
  });

  it("guards empty Anthropic, DeepSeek, and Gemini streams", async () => {
    let anthropicSummary: StreamCompletionSummary | null = null;
    let deepSeekSummary: StreamCompletionSummary | null = null;
    let geminiSummary: StreamCompletionSummary | null = null;
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
      collect(
        streamChatCompletion({
          provider: "anthropic",
          model: "claude-test",
          messages,
          onFinish: (value) => {
            anthropicSummary = value;
          },
        }),
      ),
    ).rejects.toMatchObject({ name: "EmptyCompletionError", finishReason: "end_turn" });
    await expect(
      collect(
        streamChatCompletion({
          provider: "deepseek",
          model: "deepseek-test",
          messages,
          onFinish: (value) => {
            deepSeekSummary = value;
          },
        }),
      ),
    ).rejects.toMatchObject({ name: "EmptyCompletionError", finishReason: "length" });
    await expect(
      collect(
        streamChatCompletion({
          provider: "gemini",
          model: "gemini-test",
          messages,
          onFinish: (value) => {
            geminiSummary = value;
          },
        }),
      ),
    ).rejects.toMatchObject({
      name: "EmptyCompletionError",
      finishReason: "MAX_TOKENS",
      reasoningTokens: 12,
    });
    expect(anthropicSummary).toMatchObject({
      finishReason: "end_turn",
      inputTokens: 9,
      outputTokens: 0,
      aborted: false,
    });
    expect(deepSeekSummary).toMatchObject({
      finishReason: "length",
      inputTokens: 9,
      outputTokens: 0,
      aborted: false,
    });
    expect(geminiSummary).toMatchObject({
      finishReason: "MAX_TOKENS",
      inputTokens: 9,
      outputTokens: 0,
      reasoningTokens: 12,
      aborted: false,
    });
  });

  it("reports an aborted stream even when the provider throws before a finish reason", async () => {
    async function* abortedStream(): AsyncGenerator<unknown> {
      yield { choices: [{ delta: { content: "Partial" }, finish_reason: null }] };
      const error = new Error("request aborted");
      error.name = "AbortError";
      throw error;
    }
    mocks.openaiCreate.mockResolvedValue(abortedStream());
    let summary: StreamCompletionSummary | null = null;

    await expect(
      collect(
        streamChatCompletion({
          provider: "openai",
          model: "gpt-5-mini",
          messages,
          onFinish: (value) => {
            summary = value;
          },
        }),
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(summary).toMatchObject({
      finishReason: null,
      refusal: false,
      aborted: true,
    });
  });
});
