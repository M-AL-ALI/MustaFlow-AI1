import type { ChatCompletion } from "openai/resources/chat/completions";
import { describe, expect, it } from "vitest";
import {
  AGENT_MODEL_RECOVERY_TOKEN_CAP,
  AGENT_MODEL_RESPONSE_TOKEN_CAP,
  boundedAgentModelTurn,
  isCompleteAgentModelResponse,
} from "./agent-model-response-policy";
import type { CreateChatCompletionParams } from "./ai-providers";

function completion(finishReason: string, args: string): ChatCompletion {
  return {
    choices: [
      {
        finish_reason: finishReason,
        message: {
          tool_calls: [{ type: "function", function: { name: "write_file", arguments: args } }],
        },
      },
    ],
  } as ChatCompletion;
}

describe("bounded generation turns", () => {
  it("preserves routing, paid-call identity, tools, requirements, and caller cancellation", () => {
    const input: CreateChatCompletionParams = {
      provider: "openai",
      model: "gpt-5.4",
      taskId: 317,
      taskMode: "eco",
      messages: [{ role: "user", content: "English and Arabic notes with backend persistence." }],
      signal: new AbortController().signal,
      tools: [],
      tool_choice: "required",
      zeroCall: { tier: "eco", stage: "refine" },
    };
    const normal = boundedAgentModelTurn(input, false);
    const recovery = boundedAgentModelTurn(input, true);
    expect(normal.max_completion_tokens).toBe(AGENT_MODEL_RESPONSE_TOKEN_CAP);
    expect(recovery.max_completion_tokens).toBe(AGENT_MODEL_RECOVERY_TOKEN_CAP);
    for (const actual of [normal, recovery]) {
      expect(actual).toMatchObject({ provider: input.provider, model: input.model, taskId: 317 });
      expect(actual.signal).toBe(input.signal);
      expect(actual.tools).toBe(input.tools);
      expect(actual.zeroCall).toBe(input.zeroCall);
      expect(actual.messages[0]).toBe(input.messages[0]);
      expect(actual.messages.at(-1)?.content).toContain("never use placeholders");
      expect(actual.messages.at(-1)?.content).toContain("existing checks and finalize gates");
    }
    expect(input.messages).toHaveLength(1);
    expect(input.max_completion_tokens).toBeUndefined();
  });

  it.each([
    { provider: "anthropic", model: "claude-haiku-fixture", normal: 8_192 },
    { provider: "anthropic", model: "claude-sonnet-fixture", normal: 16_000 },
    { provider: "anthropic", model: "claude-opus-fixture", normal: 16_000 },
    { provider: "gemini", model: "gemini-fixture", normal: 8_192 },
    { provider: "openai", model: "openai-fixture", normal: 16_384 },
    { provider: "deepseek", model: "deepseek-fixture", normal: 16_384 },
  ] as const)(
    "preserves the existing default for $provider/$model",
    ({ provider, model, normal }) => {
      const params = { provider, model, messages: [] };
      expect(boundedAgentModelTurn(params, false).max_completion_tokens).toBe(normal);
      expect(boundedAgentModelTurn(params, true).max_completion_tokens).toBe(
        AGENT_MODEL_RECOVERY_TOKEN_CAP,
      );
    },
  );

  it("honors an explicit budget within the turn ceiling rather than substituting a default", () => {
    const params = {
      provider: "gemini" as const,
      model: "gemini-fixture",
      messages: [],
      max_completion_tokens: 12_000,
    };
    expect(boundedAgentModelTurn(params, false).max_completion_tokens).toBe(12_000);
    expect(boundedAgentModelTurn(params, true).max_completion_tokens).toBe(8_192);
  });

  it("does not enlarge an already smaller output budget", () => {
    expect(
      boundedAgentModelTurn(
        {
          provider: "anthropic",
          model: "selected-model",
          messages: [],
          max_completion_tokens: 2048,
        },
        true,
      ).max_completion_tokens,
    ).toBe(2048);
  });

  it("rejects valid-looking tool calls when the response itself was cut short", () => {
    expect(
      isCompleteAgentModelResponse(completion("length", '{"path":"src/a.ts","content":"x"}')),
    ).toBe(false);
  });

  it.each(['{"path":', "null", "[]", '"text"'])(
    "rejects incomplete or non-object tool arguments: %s",
    (args) => {
      expect(isCompleteAgentModelResponse(completion("tool_calls", args))).toBe(false);
    },
  );

  it("accepts a complete tool call and leaves schema authorization to existing tool gates", () => {
    expect(
      isCompleteAgentModelResponse(completion("tool_calls", '{"path":"src/a.ts","content":"x"}')),
    ).toBe(true);
  });
});
