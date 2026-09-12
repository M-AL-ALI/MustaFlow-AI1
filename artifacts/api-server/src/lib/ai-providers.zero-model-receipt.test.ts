import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  query: vi.fn(),
  openaiCreate: vi.fn(),
  anthropicCreate: vi.fn(),
  geminiCreate: vi.fn(),
}));

vi.mock("@workspace/db", () => ({
  pool: {
    query: mocks.query,
  },
}));

vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: {
      completions: {
        create: mocks.openaiCreate,
      },
    },
  },
}));

vi.mock("openai", () => ({
  default: class OpenAIMock {},
}));

vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: mocks.anthropicCreate } },
}));

vi.mock("@workspace/integrations-gemini-ai", () => ({
  ai: { models: { generateContent: mocks.geminiCreate } },
}));

const circuit = { call: vi.fn(async (run: () => Promise<unknown>) => run()) };
vi.mock("./resilience", () => ({
  openaiCircuit: circuit,
  anthropicCircuit: circuit,
  geminiCircuit: circuit,
  deepseekCircuit: circuit,
  withRetry: vi.fn(async (run: () => Promise<unknown>) => run()),
  isTransientError: vi.fn(() => false),
}));

vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { createChatCompletion, type CreateChatCompletionParams } from "./ai-providers";
import { boundedAgentModelTurn, isCompleteAgentModelResponse } from "./agent-model-response-policy";

const toolInput = { path: "src/fixture.ts", content: "export const fixture = true;" };

function mockNativeResponse(provider: "anthropic" | "gemini", stop: string, withTool: boolean) {
  if (provider === "anthropic") {
    return {
      stop_reason: stop,
      content: withTool
        ? [{ type: "tool_use", id: "fixture-tool", name: "write_file", input: toolInput }]
        : [{ type: "text", text: "done" }],
      usage: { input_tokens: 11, output_tokens: 7 },
    };
  }
  return {
    candidates: [
      {
        finishReason: stop,
        content: {
          parts: withTool
            ? [{ functionCall: { name: "write_file", args: toolInput } }]
            : [{ text: "done" }],
        },
      },
    ],
    usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
  };
}

function providerParams(
  provider: "anthropic" | "gemini",
  model: string,
): CreateChatCompletionParams {
  return {
    provider,
    model,
    taskId: 7001,
    taskMode: "eco",
    zeroCall: { tier: "eco", stage: "build" },
    messages: [{ role: "user", content: "Build one complete fixture module." }],
    tools: [{ type: "function", function: { name: "write_file", parameters: { type: "object" } } }],
    tool_choice: "required",
  };
}

describe("Zero provider-call receipts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.order.length = 0;
    mocks.query.mockImplementation(async (text: string) => {
      mocks.order.push(text.trimStart().startsWith("INSERT") ? "receipt:start" : "receipt:finish");
      return { rows: [], rowCount: 1 };
    });
    mocks.openaiCreate.mockImplementation(async () => {
      mocks.order.push("provider:dispatch");
      return {
        id: "completion-1",
        object: "chat.completion",
        created: 1,
        model: "gpt-5.4",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            logprobs: null,
            message: { role: "assistant", content: "done", refusal: null },
          },
        ],
        usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
      };
    });
  });

  it("persists identity before dispatch and a completed terminal after it", async () => {
    await createChatCompletion({
      provider: "openai",
      model: "gpt-5.4",
      messages: [{ role: "user", content: "Build it" }],
      taskId: 51,
      taskMode: "power",
      zeroCall: { tier: "power", stage: "build" },
    });

    expect(mocks.order).toEqual(["receipt:start", "provider:dispatch", "receipt:finish"]);
    expect(mocks.query.mock.calls[0]?.[1]?.slice(3, 7)).toEqual([
      "power",
      "build",
      "openai",
      "gpt-5.4",
    ]);
    expect(mocks.query.mock.calls[1]?.[1]?.slice(1, 4)).toEqual(["completed", 11, 7]);
  });

  it.each([
    {
      provider: "anthropic",
      nativeStop: "max_tokens",
      withTool: true,
      normalized: "length",
      accepted: false,
    },
    {
      provider: "anthropic",
      nativeStop: "max_tokens",
      withTool: false,
      normalized: "length",
      accepted: false,
    },
    {
      provider: "anthropic",
      nativeStop: "tool_use",
      withTool: true,
      normalized: "tool_calls",
      accepted: true,
    },
    {
      provider: "anthropic",
      nativeStop: "end_turn",
      withTool: false,
      normalized: "stop",
      accepted: true,
    },
    {
      provider: "gemini",
      nativeStop: "MAX_TOKENS",
      withTool: true,
      normalized: "length",
      accepted: false,
    },
    {
      provider: "gemini",
      nativeStop: "MAX_TOKENS",
      withTool: false,
      normalized: "length",
      accepted: false,
    },
    {
      provider: "gemini",
      nativeStop: "STOP",
      withTool: true,
      normalized: "tool_calls",
      accepted: true,
    },
    { provider: "gemini", nativeStop: "STOP", withTool: false, normalized: "stop", accepted: true },
  ] as const)(
    "preserves $provider $nativeStop with tool=$withTool before response acceptance",
    async ({ provider, nativeStop, withTool, normalized, accepted }) => {
      const sdk = provider === "anthropic" ? mocks.anthropicCreate : mocks.geminiCreate;
      sdk.mockImplementation(async () => {
        mocks.order.push("provider:dispatch");
        return mockNativeResponse(provider, nativeStop, withTool);
      });
      const model = provider === "anthropic" ? "claude-sonnet-fixture" : "gemini-fixture";
      const result = await createChatCompletion(
        boundedAgentModelTurn(providerParams(provider, model), false),
      );

      expect(result.choices[0]?.finish_reason).toBe(normalized);
      expect(isCompleteAgentModelResponse(result)).toBe(accepted);
      expect(result.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
      expect(mocks.order).toEqual(["receipt:start", "provider:dispatch", "receipt:finish"]);
      expect(mocks.query.mock.calls[0]?.[1]?.slice(3, 7)).toEqual([
        "eco",
        "build",
        provider,
        model,
      ]);
      expect(mocks.query.mock.calls[1]?.[1]?.slice(1, 4)).toEqual(["completed", 11, 7]);
      if (withTool) {
        const call = result.choices[0]?.message.tool_calls?.[0];
        expect(call?.type).toBe("function");
        if (call?.type === "function")
          expect(JSON.parse(call.function.arguments)).toEqual(toolInput);
      }
    },
  );

  it.each([
    { provider: "anthropic", model: "claude-haiku-fixture" },
    { provider: "anthropic", model: "claude-sonnet-fixture" },
    { provider: "gemini", model: "gemini-fixture" },
  ] as const)(
    "does not increase the actual $provider/$model adapter default",
    async ({ provider, model }) => {
      const sdk = provider === "anthropic" ? mocks.anthropicCreate : mocks.geminiCreate;
      sdk.mockResolvedValue(
        mockNativeResponse(provider, provider === "anthropic" ? "tool_use" : "STOP", true),
      );
      const params = providerParams(provider, model);
      await createChatCompletion(params);
      await createChatCompletion(boundedAgentModelTurn(params, false));
      await createChatCompletion(boundedAgentModelTurn(params, true));
      const outputBudget = (index: number): number =>
        provider === "anthropic"
          ? sdk.mock.calls[index]?.[0]?.max_tokens
          : sdk.mock.calls[index]?.[0]?.config.maxOutputTokens;
      expect(outputBudget(1)).toBeLessThanOrEqual(outputBudget(0));
      expect(outputBudget(2)).toBeLessThanOrEqual(outputBudget(1));
    },
  );

  it("does not dispatch when the identity receipt cannot be written", async () => {
    mocks.query.mockRejectedValueOnce(new Error("receipt store unavailable"));

    await expect(
      createChatCompletion({
        provider: "openai",
        model: "gpt-5.4",
        messages: [{ role: "user", content: "Build it" }],
        zeroCall: { tier: "power", stage: "build" },
      }),
    ).rejects.toThrow("receipt store unavailable");
    expect(mocks.openaiCreate).not.toHaveBeenCalled();
  });
});
