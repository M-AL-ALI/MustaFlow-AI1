import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  order: [] as string[],
  query: vi.fn(),
  openaiCreate: vi.fn(),
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

import { createChatCompletion } from "./ai-providers";

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
