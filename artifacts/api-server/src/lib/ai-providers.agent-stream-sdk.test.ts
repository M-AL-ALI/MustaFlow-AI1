import { createRequire } from "node:module";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  clientQuery: vi.fn(),
  release: vi.fn(),
  create: vi.fn(),
  stream: vi.fn(),
}));
vi.mock("@workspace/db", () => ({
  pool: {
    query: mocks.query,
    connect: vi.fn(async () => ({ query: mocks.clientQuery, release: mocks.release })),
  },
}));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
}));
vi.mock("openai", () => ({ default: class OpenAIMock {} }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: mocks.create, stream: mocks.stream } },
}));
vi.mock("./logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  createChatCompletion,
  clearBuildTokenAccumulator,
  flushBuildTokenTelemetry,
  type CreateChatCompletionParams,
} from "./ai-providers";
import { anthropicCircuit, CircuitOpenError } from "./resilience";
import { isCompleteAgentModelResponse } from "./agent-model-response-policy";
import { IncompleteAgentModelResponseError, runAgentModelRequest } from "./agent-model-request";

// Resolve from the owning integration package: exercise the installed, pinned
// SDK accumulator without initializing a credentialed client or calling a provider.
const require = createRequire(import.meta.url);
const integrationRequire = createRequire(require.resolve("@workspace/integrations-anthropic-ai"));
const sdkRoot = path.dirname(integrationRequire.resolve("@anthropic-ai/sdk"));
type NativeMessage = { content: Array<Record<string, unknown>> };
type NativeStream = {
  on(event: string, listener: (event: unknown) => void): unknown;
  finalMessage(): Promise<NativeMessage>;
};
const { MessageStream } = require(path.join(sdkRoot, "lib", "MessageStream.js")) as {
  MessageStream: { fromReadableStream(stream: ReadableStream<Uint8Array>): NativeStream };
};

type Event = Record<string, unknown>;
function eventsFor(
  fragments: string[],
  options: { omitBlockStop?: boolean; stop?: string } = {},
): Event[] {
  return [
    {
      type: "message_start",
      message: {
        id: "fixture-message",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-fixture",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: {
        type: "tool_use",
        id: "read-1",
        name: "read_file",
        input: {},
      },
    },
    ...fragments.map((partial_json) => ({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json },
    })),
    ...(options.omitBlockStop ? [] : [{ type: "content_block_stop", index: 0 }]),
    {
      type: "message_delta",
      delta: { stop_reason: options.stop ?? "tool_use", stop_sequence: null },
      usage: { output_tokens: 7 },
    },
    { type: "message_stop" },
  ];
}
function realStream(events: Event[]): NativeStream {
  // Fresh events per invocation because the SDK mutates its message snapshot.
  const wire = events.map((event) => JSON.stringify(event) + "\n").join("");
  return MessageStream.fromReadableStream(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(wire));
        controller.close();
      },
    }),
  );
}
function input(): CreateChatCompletionParams {
  return {
    provider: "anthropic",
    model: "claude-sonnet-fixture",
    taskId: 7002,
    taskMode: "eco",
    zeroCall: { tier: "eco", stage: "refine" },
    messages: [{ role: "user", content: "Read the selected file without changing it." }],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object" } } }],
    onModelProgress: vi.fn(),
    signal: new AbortController().signal,
  };
}
function argsOf(response: Awaited<ReturnType<typeof createChatCompletion>>, index = 0): string {
  const call = response.choices[0].message.tool_calls?.[index];
  if (!call || call.type !== "function") throw new Error("Expected a function call");
  return call.function.arguments;
}

describe("real SDK streamed tool argument fidelity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockReset();
    mocks.stream.mockReset();
    mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
    mocks.clientQuery.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
    anthropicCircuit.reset();
    clearBuildTokenAccumulator(7002);
  });

  afterEach(() => {
    anthropicCircuit.reset();
    clearBuildTokenAccumulator(7002);
  });

  it.each([
    { name: "valid exponent", fragments: ['{"path":"src/app.ts","offset":1e2,"limit":20}'] },
    {
      name: "fragmented exponent",
      fragments: ['{"path":"src/app.ts","offset":1', "e", '2,"limit":20}'],
    },
  ])("preserves the original $name instead of the SDK snapshot", async ({ fragments }) => {
    mocks.stream.mockImplementation(() => realStream(eventsFor(fragments)));
    const response = await createChatCompletion(input());
    expect(argsOf(response)).toBe(fragments.join(""));
    expect(JSON.parse(argsOf(response))).toEqual({ path: "src/app.ts", offset: 100, limit: 20 });
    expect(isCompleteAgentModelResponse(response)).toBe(true);
    expect(response.usage).toMatchObject({ prompt_tokens: 11, completion_tokens: 7 });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("rejects unfinished JSON even when the real SDK repairs it and receives message_stop", async () => {
    mocks.stream.mockImplementation(() =>
      realStream(eventsFor(['{"path":"src/app.ts","offset":10'])),
    );
    await expect(createChatCompletion(input())).rejects.toBeInstanceOf(
      IncompleteAgentModelResponseError,
    );
    expect(mocks.query.mock.calls[1][1][1]).toBe("failed");
    expect(mocks.stream).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty argument delta rather than falling back to the SDK's empty object", async () => {
    mocks.stream.mockImplementation(() => realStream(eventsFor([""])));
    await expect(createChatCompletion(input())).rejects.toBeInstanceOf(
      IncompleteAgentModelResponseError,
    );
  });

  it("accepts a completed no-argument tool without deltas", async () => {
    mocks.stream.mockImplementation(() => realStream(eventsFor([])));
    expect(argsOf(await createChatCompletion(input()))).toBe("{}");
  });

  it("requires the tool block to be closed as well as the overall message", async () => {
    mocks.stream.mockImplementation(() =>
      realStream(eventsFor(['{"path":"src/app.ts"}'], { omitBlockStop: true })),
    );
    await expect(createChatCompletion(input())).rejects.toBeInstanceOf(
      IncompleteAgentModelResponseError,
    );
  });

  it("keeps argument JSON bound to each tool's index and identity", async () => {
    const events = eventsFor(['{"path":"first.ts","offset":1e2}']);
    events.splice(
      events.length - 2,
      0,
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "read-2", name: "read_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":"second.ts","offset":2e2}' },
      },
      { type: "content_block_stop", index: 1 },
    );
    mocks.stream.mockImplementation(() => realStream(events));
    const response = await createChatCompletion(input());
    expect(JSON.parse(argsOf(response, 0))).toEqual({ path: "first.ts", offset: 100 });
    expect(JSON.parse(argsOf(response, 1))).toEqual({ path: "second.ts", offset: 200 });
  });

  it("rejects a duplicate tool identity", async () => {
    const events = eventsFor(['{"path":"first.ts"}']);
    events.splice(
      events.length - 2,
      0,
      {
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "read-1", name: "read_file", input: {} },
      },
      {
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"path":"second.ts"}' },
      },
      { type: "content_block_stop", index: 1 },
    );
    mocks.stream.mockImplementation(() => realStream(events));
    await expect(createChatCompletion(input())).rejects.toBeInstanceOf(
      IncompleteAgentModelResponseError,
    );
  });

  it("rejects a final snapshot whose identity no longer matches the observed tool", async () => {
    mocks.stream.mockImplementation(() => {
      const stream = realStream(eventsFor(['{"path":"src/app.ts"}']));
      const finalMessage = stream.finalMessage.bind(stream);
      stream.finalMessage = async () => {
        const message = await finalMessage();
        message.content[0].id = "unobserved-tool";
        return message;
      };
      return stream;
    });
    await expect(createChatCompletion(input())).rejects.toBeInstanceOf(
      IncompleteAgentModelResponseError,
    );
  });

  it("retains max_tokens truncation authority even for complete JSON", async () => {
    mocks.stream.mockImplementation(() =>
      realStream(eventsFor(['{"path":"src/app.ts"}'], { stop: "max_tokens" })),
    );
    const response = await createChatCompletion(input());
    expect(response.choices[0].finish_reason).toBe("length");
    expect(isCompleteAgentModelResponse(response)).toBe(false);
  });

  it.each([false, true])(
    "uses only one run-level recovery for malformed SDK input (exhausted=%s)",
    async (exhausted) => {
      let calls = 0;
      mocks.stream.mockImplementation(() => {
        calls++;
        return realStream(
          eventsFor([
            exhausted || calls === 1
              ? '{"path":"src/app.ts"'
              : '{"path":"src/app.ts","offset":1e2}',
          ]),
        );
      });
      const onRecovery = vi.fn();
      const request = runAgentModelRequest({
        signal: new AbortController().signal,
        startedAt: Date.now(),
        deadlineAt: Date.now() + 60_000,
        context: { projectId: 61, stage: "refine", step: 1 },
        recovery: { used: false },
        onRecovery,
        request: (signal, onModelProgress) =>
          createChatCompletion({ ...input(), signal, onModelProgress }),
        isResponseComplete: isCompleteAgentModelResponse,
      });
      if (exhausted) {
        await expect(request).rejects.toMatchObject({ code: "agent_model_response_incomplete" });
      } else {
        expect(JSON.parse(argsOf(await request)).offset).toBe(100);
      }
      expect(mocks.stream).toHaveBeenCalledTimes(2);
      expect(onRecovery).toHaveBeenCalledTimes(1);
      expect(onRecovery.mock.calls[0][1]).toBe("response-incomplete");
      const terminals = mocks.query.mock.calls.filter(([sql]) =>
        String(sql).includes("UPDATE zero_model_call_receipts"),
      );
      expect(terminals.map(([, values]) => values.slice(1, 5))).toEqual([
        ["failed", 11, 7, "provider_response_incomplete"],
        [
          exhausted ? "failed" : "completed",
          11,
          7,
          exhausted ? "provider_response_incomplete" : null,
        ],
      ]);
      expect(anthropicCircuit.toJSON()).toMatchObject({ state: "closed", failures: 0 });
      await flushBuildTokenTelemetry(7002, exhausted ? "failed" : "completed");
      expect(mocks.clientQuery.mock.calls[0][1].slice(5, 7)).toEqual([22, 14]);
    },
  );
  it.each(["max_tokens", "tool_use"])(
    "retains terminal %s usage when strict tool validation rejects the answer",
    async (stop) => {
      mocks.stream.mockImplementation(() =>
        realStream(eventsFor(['{"path":"src/app.ts","offset":10'], { stop })),
      );
      await expect(createChatCompletion(input())).rejects.toBeInstanceOf(
        IncompleteAgentModelResponseError,
      );
      expect(mocks.query).toHaveBeenCalledTimes(2);
      expect(mocks.query.mock.calls[1][1].slice(1, 5)).toEqual([
        "failed",
        11,
        7,
        "provider_response_incomplete",
      ]);
      expect(anthropicCircuit.toJSON()).toMatchObject({ state: "closed", failures: 0 });
      await flushBuildTokenTelemetry(7002, "failed");
      expect(mocks.clientQuery).toHaveBeenCalledTimes(1);
      expect(mocks.clientQuery.mock.calls[0][1].slice(0, 7)).toEqual([
        7002,
        "eco",
        "anthropic",
        "claude-sonnet-fixture",
        "failed",
        11,
        7,
      ]);
    },
  );

  it("does not open the real shared circuit for repeated completed but unusable answers", async () => {
    mocks.stream.mockImplementation(() =>
      realStream(eventsFor(['{"path":"src/app.ts"'], { stop: "max_tokens" })),
    );
    for (let attempt = 0; attempt < 6; attempt++) {
      await expect(createChatCompletion(input())).rejects.toBeInstanceOf(
        IncompleteAgentModelResponseError,
      );
    }
    expect(mocks.stream).toHaveBeenCalledTimes(6);
    expect(anthropicCircuit.toJSON()).toMatchObject({ state: "closed", failures: 0 });
    await expect(anthropicCircuit.call(async () => "unrelated caller")).resolves.toBe(
      "unrelated caller",
    );
    mocks.stream.mockImplementation(() =>
      realStream(eventsFor(['{"path":"src/app.ts","offset":1e2}'])),
    );
    expect(JSON.parse(argsOf(await createChatCompletion(input()))).offset).toBe(100);
    await flushBuildTokenTelemetry(7002);
    expect(mocks.clientQuery.mock.calls[0][1].slice(5, 7)).toEqual([77, 49]);
  });

  it("retains provider failure classification for genuine failed calls", async () => {
    const failure = new Error("Provider fixture failure");
    mocks.stream.mockImplementation(() => {
      throw failure;
    });
    for (let attempt = 0; attempt < 5; attempt++) {
      await expect(createChatCompletion(input())).rejects.toBe(failure);
    }
    expect(anthropicCircuit.currentState).toBe("open");
    await expect(createChatCompletion(input())).rejects.toBeInstanceOf(CircuitOpenError);
    expect(mocks.stream).toHaveBeenCalledTimes(5);
    const terminals = mocks.query.mock.calls.filter(([sql]) =>
      String(sql).includes("UPDATE zero_model_call_receipts"),
    );
    expect(terminals).toHaveLength(6);
    expect(
      terminals.every(
        ([, values]) => values[1] === "failed" && values[2] === null && values[3] === null,
      ),
    ).toBe(true);
    await flushBuildTokenTelemetry(7002, "failed");
    expect(mocks.clientQuery).not.toHaveBeenCalled();
  });

  it("does not replay a paid call or erase known telemetry when the semantic-failure receipt cannot persist", async () => {
    mocks.query.mockImplementation(async (sql: string) => {
      if (sql.includes("UPDATE zero_model_call_receipts"))
        throw new Error("Receipt persistence fixture");
      return { rows: [], rowCount: 1 };
    });
    mocks.stream.mockImplementation(() =>
      realStream(eventsFor(['{"path":"src/app.ts"'], { stop: "max_tokens" })),
    );
    await expect(createChatCompletion(input())).rejects.toBeInstanceOf(
      IncompleteAgentModelResponseError,
    );
    expect(mocks.stream).toHaveBeenCalledTimes(1);
    expect(mocks.query).toHaveBeenCalledTimes(2);
    expect(anthropicCircuit.toJSON()).toMatchObject({ state: "closed", failures: 0 });
    await flushBuildTokenTelemetry(7002, "failed");
    expect(mocks.clientQuery.mock.calls[0][1].slice(5, 7)).toEqual([11, 7]);
  });
});
