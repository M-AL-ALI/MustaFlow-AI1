import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  create: vi.fn(),
  stream: vi.fn(),
}));

vi.mock("@workspace/db", () => ({ pool: { query: mocks.query } }));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: { chat: { completions: { create: vi.fn() } } },
}));
vi.mock("openai", () => ({ default: class OpenAIMock {} }));
vi.mock("@workspace/integrations-anthropic-ai", () => ({
  anthropic: { messages: { create: mocks.create, stream: mocks.stream } },
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
import { isCompleteAgentModelResponse } from "./agent-model-response-policy";

type StreamEvent = {
  type: string;
  index?: number;
  message?: { content: unknown[] };
  content_block?: Record<string, unknown>;
  delta?: { type: string; text?: string; partial_json?: string; thinking?: string };
};

function nativeMessage(stop = "tool_use") {
  return {
    model: "claude-sonnet-fixture",
    stop_reason: stop,
    content: [
      {
        type: "tool_use",
        id: "patch-1",
        name: "apply_patch",
        input: { path: "src/html.ts", before: "old", after: "new" },
      },
    ],
    usage: { input_tokens: 11, output_tokens: 7 },
  };
}

function pendingStream() {
  let resolve!: (value: ReturnType<typeof nativeMessage>) => void;
  let reject!: (reason: unknown) => void;
  let listener!: (event: StreamEvent) => void;
  const final = new Promise<ReturnType<typeof nativeMessage>>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const stream = {
    on: vi.fn((_event: string, callback: (event: StreamEvent) => void) => {
      listener = callback;
    }),
    finalMessage: vi.fn(() => final),
  };
  mocks.stream.mockReturnValue(stream);
  let begun = false;
  let raw = "";
  const begin = () => {
    if (begun) return;
    begun = true;
    listener({ type: "message_start", message: { content: [] } });
    listener({
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "patch-1", name: "apply_patch", input: {} },
    });
  };
  const emit = (event: StreamEvent) => {
    begin();
    if (event.delta?.type === "input_json_delta") raw += event.delta.partial_json ?? "";
    listener({ index: 0, ...event });
  };
  return {
    stream,
    reject,
    emit,
    resolve: (value: ReturnType<typeof nativeMessage>) => {
      begin();
      const complete = JSON.stringify(value.content[0].input);
      if (complete.startsWith(raw) && raw.length < complete.length) {
        emit({
          type: "content_block_delta",
          delta: { type: "input_json_delta", partial_json: complete.slice(raw.length) },
        });
      }
      listener({ type: "content_block_stop", index: 0 });
      listener({ type: "message_stop" });
      resolve(value);
    },
  };
}

function params(): CreateChatCompletionParams {
  return {
    provider: "anthropic",
    model: "claude-sonnet-fixture",
    taskId: 7002,
    taskMode: "eco",
    zeroCall: { tier: "eco", stage: "refine" },
    messages: [
      { role: "system", content: "Preserve all requirements." },
      {
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "read-1",
            type: "function",
            function: { name: "read_file", arguments: '{"path":"src/html.ts"}' },
          },
        ],
      },
      { role: "tool", tool_call_id: "read-1", content: "existing source" },
    ],
    tools: [
      {
        type: "function",
        function: { name: "apply_patch", parameters: { type: "object" } },
      },
    ],
    tool_choice: "required",
    max_completion_tokens: 8192,
    signal: new AbortController().signal,
    onModelProgress: vi.fn(),
  };
}

describe("streamed builder tools preserve complete-response authority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.create.mockReset();
    mocks.stream.mockReset();
    mocks.query.mockReset().mockResolvedValue({ rows: [], rowCount: 1 });
  });

  it("waits for the complete SDK message, preserves tool history, and reports payload-free progress", async () => {
    const native = pendingStream();
    const input = params();
    let settled = false;
    const result = createChatCompletion(input).then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(native.stream.finalMessage).toHaveBeenCalled());
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.stream).toHaveBeenCalledWith(
      expect.objectContaining({
        model: input.model,
        max_tokens: 8192,
        tool_choice: { type: "any" },
        tools: [expect.objectContaining({ name: "apply_patch", input_schema: { type: "object" } })],
        messages: [
          {
            role: "assistant",
            content: [
              { type: "tool_use", id: "read-1", name: "read_file", input: { path: "src/html.ts" } },
            ],
          },
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "read-1", content: "existing source" }],
          },
        ],
      }),
      { signal: input.signal },
    );
    native.emit({ type: "ping" });
    native.emit({ type: "content_block_delta", delta: { type: "text_delta", text: "" } });
    expect(input.onModelProgress).not.toHaveBeenCalled();
    native.emit({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    });
    native.emit({ type: "content_block_delta", delta: { type: "text_delta", text: "working" } });
    native.emit({
      type: "content_block_delta",
      delta: { type: "thinking_delta", thinking: "reasoning" },
    });
    expect(input.onModelProgress).toHaveBeenCalledTimes(3);
    expect(vi.mocked(input.onModelProgress!).mock.calls).toEqual([[], [], []]);
    expect(settled).toBe(false);
    expect(mocks.query).toHaveBeenCalledTimes(1);
    native.resolve(nativeMessage());
    const response = await result;
    expect(response.choices[0].finish_reason).toBe("tool_calls");
    const call = response.choices[0].message.tool_calls?.[0];
    expect(call?.type).toBe("function");
    if (!call || call.type !== "function") throw new Error("Expected completed function call");
    expect(JSON.parse(call.function.arguments)).toEqual({
      path: "src/html.ts",
      before: "old",
      after: "new",
    });
    expect(isCompleteAgentModelResponse(response)).toBe(true);
    expect(response.usage).toMatchObject({
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
    });
    expect(mocks.query.mock.calls[1][1].slice(1, 4)).toEqual(["completed", 11, 7]);
  });

  it("preserves truncation so valid-looking partial tools cannot be accepted", async () => {
    const native = pendingStream();
    const result = createChatCompletion(params());
    await vi.waitFor(() => expect(native.stream.finalMessage).toHaveBeenCalled());
    native.resolve(nativeMessage("max_tokens"));
    const response = await result;
    expect(response.choices[0].finish_reason).toBe("length");
    expect(isCompleteAgentModelResponse(response)).toBe(false);
  });

  it("does not expose a partial response when the SDK stream fails", async () => {
    const native = pendingStream();
    const result = createChatCompletion(params()).catch((error: unknown) => error);
    await vi.waitFor(() => expect(native.stream.finalMessage).toHaveBeenCalled());
    native.emit({
      type: "content_block_delta",
      delta: { type: "input_json_delta", partial_json: '{"path":' },
    });
    const failure = new Error("stream ended before message_stop");
    native.reject(failure);
    expect(await result).toBe(failure);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[1][1][1]).toBe("failed");
  });

  it("preserves caller cancellation and ignores output after the signal is aborted", async () => {
    const controller = new AbortController();
    const input = { ...params(), signal: controller.signal };
    const native = pendingStream();
    const result = createChatCompletion(input).catch((error: unknown) => error);
    await vi.waitFor(() => expect(native.stream.finalMessage).toHaveBeenCalled());
    const reason = new DOMException("Stopped by user", "AbortError");
    controller.abort(reason);
    native.emit({ type: "content_block_delta", delta: { type: "text_delta", text: "late" } });
    native.reject(reason);
    expect(await result).toBe(reason);
    expect(input.onModelProgress).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls[1][1][1]).toBe("interrupted");
  });

  it("does not let a failed watchdog observer replace a complete provider response", async () => {
    const native = pendingStream();
    const input = {
      ...params(),
      onModelProgress: () => {
        throw new Error("observer failed");
      },
    };
    const result = createChatCompletion(input);
    await vi.waitFor(() => expect(native.stream.finalMessage).toHaveBeenCalled());
    expect(() =>
      native.emit({ type: "content_block_delta", delta: { type: "text_delta", text: "working" } }),
    ).not.toThrow();
    native.resolve(nativeMessage());
    expect(isCompleteAgentModelResponse(await result)).toBe(true);
  });

  it("leaves non-opted-in tool callers on their existing transport", async () => {
    const input = params();
    delete input.onModelProgress;
    mocks.create.mockResolvedValue(nativeMessage());
    const response = await createChatCompletion(input);
    expect(mocks.stream).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(isCompleteAgentModelResponse(response)).toBe(true);
  });
});
