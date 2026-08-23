/**
 * Multi-provider model routing (Task #533).
 *
 * Wraps OpenAI / Anthropic / Gemini behind one OpenAI-shaped interface so
 * every pipeline (build / refine / plan / architect / intent / converse) can
 * route to the best provider for the job without each call site knowing the
 * provider SDK quirks.
 *
 * All three providers are reached via Replit AI Integrations proxies — no
 * extra API keys required.
 *
 * Per-stage routing is configured via env vars (see `resolveStageProvider`).
 * Each accepts `openai:gpt-5.4`, `anthropic:claude-sonnet-4-6`, or
 * `gemini:2.5-pro` style strings (the model half is optional — falls back to
 * stage default).
 *
 * Pricing is recalibrated per provider so a build run on Claude Opus is not
 * billed at the same flat rate as a build run on gpt-5-mini.
 */

import OpenAI from "openai";
import { openai } from "@workspace/integrations-openai-ai-server";
import type {
  ChatCompletion,
  ChatCompletionMessageParam,
  ChatCompletionTool,
  ChatCompletionMessageToolCall,
  ChatCompletionToolChoiceOption,
} from "openai/resources/chat/completions";
import { logger } from "./logger";
import type { AgentMode } from "./ai";
import {
  isDeepSeekAvailable,
  MODEL_DEFAULTS,
  VISION_MODEL,
  type Provider,
} from "./ai-provider-config";
import { EmptyCompletionError, type EmptyCompletionDetails } from "./empty-completion";

export { isDeepSeekAvailable, MODEL_DEFAULTS, VISION_MODEL };
export { EmptyCompletionError } from "./empty-completion";
export type { EmptyCompletionDetails } from "./empty-completion";
export type { Provider };

function assertStreamProducedContent(contentLength: number, details: EmptyCompletionDetails): void {
  if (contentLength === 0) throw new EmptyCompletionError(details);
}

/** DeepSeek's OpenAI-compatible REST endpoint. */
const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

/**
 * Lazily-constructed direct OpenAI-SDK client pointed at DeepSeek's
 * OpenAI-compatible API. DeepSeek is NOT carried by the Replit AI-integrations
 * proxy (which only fronts OpenAI/Anthropic/Gemini), so — exactly like the Ora
 * TTS path — we talk to it with a direct client keyed by `DEEPSEEK_API_KEY`.
 * Throws if the key is unset so callers can fall back to another provider.
 */
let deepseekClient: OpenAI | null = null;
function getDeepSeekClient(): OpenAI {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured");
  if (!deepseekClient) {
    deepseekClient = new OpenAI({ apiKey, baseURL: DEEPSEEK_BASE_URL });
  }
  return deepseekClient;
}

/**
 * Total message-content character count above which we route tool-free Anthropic
 * calls through the streaming-accumulation path instead of the non-streaming path.
 *
 * Rationale: the Anthropic SDK's non-streaming `messages.create()` has a built-in
 * 10-minute guard (600 s) that fires on slow large-context completions. The
 * streaming path has no such hard cut-off — it streams tokens as they arrive, so
 * the HTTP connection stays alive the whole time. For calls that exceed this
 * threshold we stream and accumulate the full response in memory, then return a
 * standard ChatCompletion-shaped object. Tool calls stay on the non-streaming path
 * because tool_use blocks arrive only at the end of the stream.
 */
export const ANTHROPIC_STREAM_THRESHOLD_CHARS = 15_000;

export type Stage = "build" | "refine" | "plan" | "architect" | "intent" | "converse";

/**
 * Vision-capable model per provider — used by the screenshot tool path.
 * DeepSeek has no vision model, so it is intentionally absent; callers that
 * need vision while routed to DeepSeek must fall back to a vision provider.
 */
const STAGE_ENV_VAR: Record<Stage, string> = {
  build: "AI_PROVIDER_BUILD",
  refine: "AI_PROVIDER_REFINE",
  plan: "AI_PROVIDER_PLAN",
  architect: "AI_PROVIDER_ARCHITECT",
  intent: "AI_PROVIDER_INTENT",
  converse: "AI_PROVIDER_CONVERSE",
};

/**
 * Parses an `AI_PROVIDER_*` value like `"anthropic:claude-sonnet-4-6"` or
 * `"openai"` (model half optional). Returns null on unparseable input so the
 * caller can fall back to the OpenAI default.
 */
export function parseProviderSpec(raw: string | undefined): {
  provider: Provider;
  model: string | null;
} | null {
  if (!raw) return null;
  const trimmed = raw.trim().toLowerCase();
  if (!trimmed) return null;
  const [providerPart, ...rest] = trimmed.split(":");
  const provider = providerPart;
  if (
    provider !== "openai" &&
    provider !== "anthropic" &&
    provider !== "gemini" &&
    provider !== "deepseek"
  ) {
    return null;
  }
  const rawModel = rest.length > 0 ? rest.join(":").trim() : null;
  const model = rawModel ? normalizeModelId(provider as Provider, rawModel) : null;
  return { provider, model: model && model.length > 0 ? model : null };
}

/**
 * Normalize per-provider short-form model aliases into the canonical id the
 * provider SDK expects. Operators frequently write `gemini:2.5-pro` or
 * `anthropic:claude-sonnet-4-6` — both forms should reach the SDK as a valid
 * id. Unknown values are passed through unchanged so a literal future model
 * id still works without a code change.
 */
function normalizeModelId(provider: Provider, id: string): string {
  const lower = id.toLowerCase().trim();
  if (provider === "gemini") {
    // Accept `3.1-pro-preview`, `gemini-3.1-pro-preview`, `models/gemini-3.1-pro-preview`.
    if (lower.startsWith("models/")) return lower.slice("models/".length);
    if (lower.startsWith("gemini-")) return lower;
    if (/^\d/.test(lower)) return `gemini-${lower}`;
    return lower;
  }
  if (provider === "anthropic") {
    // Accept `sonnet-4-6` shorthand → `claude-sonnet-4-6`.
    if (lower.startsWith("claude-")) return lower;
    if (/^(haiku|sonnet|opus)-/.test(lower)) return `claude-${lower}`;
    return lower;
  }
  return lower;
}

/**
 * Resolves the provider + model for a given stage + agent mode. Reads the
 * stage's env var; falls back to OpenAI default when unset or unparseable.
 *
 * Anthropic / Gemini availability is gated by their integration env vars —
 * if the operator selected `anthropic` but the integration is not provisioned,
 * we fall back to openai with a one-time warning so a misconfigured env never
 * takes the API offline.
 */
export function resolveStageProvider(
  stage: Stage,
  agentMode: AgentMode,
  // Optional per-call-site OpenAI fallback model. Used when (a) the resolved
  // provider is OpenAI AND (b) the env var did not supply an explicit model.
  // Lets pipelines that historically forced a specific small/fast OpenAI
  // model (e.g. intent classifier → gpt-5-nano) preserve their existing
  // default without blocking an `AI_PROVIDER_*=openai:gpt-5.4` override.
  openaiOverride?: string,
): { provider: Provider; model: string } {
  const envValue = process.env[STAGE_ENV_VAR[stage]];
  const parsed = parseProviderSpec(envValue);
  let provider: Provider = parsed?.provider ?? "openai";

  // Both BASE_URL and API_KEY are required — the integration SDKs throw at
  // import time when the API key is missing, which would crash a routed call.
  // Fall back to OpenAI gracefully when either half is missing.
  if (
    provider === "anthropic" &&
    (!process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL ||
      !process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY)
  ) {
    warnOnce(
      `${STAGE_ENV_VAR[stage]} set to anthropic but Anthropic integration is not fully provisioned (BASE_URL or API_KEY missing). Falling back to OpenAI.`,
    );
    provider = "openai";
  }
  if (
    provider === "gemini" &&
    (!process.env.AI_INTEGRATIONS_GEMINI_BASE_URL || !process.env.AI_INTEGRATIONS_GEMINI_API_KEY)
  ) {
    warnOnce(
      `${STAGE_ENV_VAR[stage]} set to gemini but Gemini integration is not fully provisioned (BASE_URL or API_KEY missing). Falling back to OpenAI.`,
    );
    provider = "openai";
  }
  // DeepSeek reaches a direct client keyed by DEEPSEEK_API_KEY. When the key is
  // absent we silently fall back to OpenAI (matches the graceful-degradation
  // pattern used for the other optional providers).
  if (provider === "deepseek" && !process.env.DEEPSEEK_API_KEY) {
    warnOnce(
      `${STAGE_ENV_VAR[stage]} set to deepseek but DEEPSEEK_API_KEY is missing. Falling back to OpenAI.`,
    );
    provider = "openai";
  }

  // Only honor the env-supplied model when the requested provider actually ran;
  // if we fell back to OpenAI, ignore any Anthropic/Gemini model string and use
  // the OpenAI default for the agent mode (otherwise OpenAI gets called with
  // an unknown model id). When no env model was supplied AND a call-site
  // openaiOverride is provided, prefer the override over the agent-mode
  // default (preserves legacy per-stage OpenAI defaults).
  let model: string;
  if (parsed?.model && parsed.provider === provider) {
    model = parsed.model;
  } else if (provider === "openai" && openaiOverride) {
    model = openaiOverride;
  } else {
    model = MODEL_DEFAULTS[provider][agentMode];
  }
  return { provider, model };
}

const warnedKeys = new Set<string>();
function warnOnce(message: string): void {
  if (warnedKeys.has(message)) return;
  warnedKeys.add(message);
  logger.warn({ component: "ai-providers" }, message);
}

// ─────────────────────────────────────────────────────────────────────────────
// Flat NabuFlow credit cost per agent mode.
//
// Provider choice affects internal model cost and telemetry, never the
// published customer price. Keep the provider argument on creditCostFor so
// existing stage-aware call sites remain source-compatible.
// ─────────────────────────────────────────────────────────────────────────────

const BASE_COST: Record<AgentMode, number> = {
  lite: 13,
  eco: 34,
  power: 160,
  pro: 475,
};

export const DEEP_REASONING_CREDIT_COST: Readonly<Partial<Record<AgentMode, number>>> = {
  eco: 60,
  power: 290,
  pro: 850,
};

export function creditCostFor(
  mode: AgentMode,
  provider: Provider = "openai",
  deepReasoning = false,
): number {
  void provider;
  if (deepReasoning && mode !== "lite") {
    return DEEP_REASONING_CREDIT_COST[mode] ?? BASE_COST[mode];
  }
  return BASE_COST[mode];
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-build token telemetry accumulator — NabuFlow R2 Phase D.
//
// Every createChatCompletion call that carries a taskId adds its prompt +
// completion token counts to this map. flushBuildTokenTelemetry() is called
// once at build completion to upsert one row to build_token_telemetry and
// clear the in-memory entry.
// ─────────────────────────────────────────────────────────────────────────────

interface BuildTokenAccumulator {
  mode: string;
  inputTokens: number;
  outputTokens: number;
  /**
   * Running USD cost total, accumulated per call at capture time using each
   * call's own model/rate. This avoids mispricing multi-model builds where a
   * cheap planner is followed by an expensive code-generation call (or vice
   * versa); the total is correct regardless of call order.
   */
  computedUsdCost: number;
  attribution: Map<string, { provider: string; model: string; tokens: number }>;
}

export type BuildTokenTelemetryStatus = "completed" | "canceled" | "failed";

export interface BuildTokenTelemetrySnapshot {
  taskId: number;
  mode: string;
  provider: string;
  model: string;
  status: BuildTokenTelemetryStatus;
  inputTokens: number;
  outputTokens: number;
  computedUsdCost: number;
}
export interface CreateChatCompletionParams {
  provider: Provider;
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  tool_choice?: ChatCompletionToolChoiceOption;
  response_format?: { type: "json_object" } | { type: "text" };
  max_completion_tokens?: number;
  signal?: AbortSignal;
  /**
   * When true, disables Gemini 3's silent "thinking" phase by setting
   * thinkingBudget:0. Without this, Gemini 3 Flash Preview consumes the
   * entire token budget on reasoning, leaving no tokens for the actual reply
   * (content = "" → null). Mirror of the same flag on StreamChatCompletionParams.
   * Ignored by all other providers.
   */
  disableThinking?: boolean;
  /** OpenAI reasoning effort. Used only for Pro + Deep Builder planning. */
  reasoning_effort?: "low" | "medium" | "high";
  /**
   * Optional NabuFlow task id. When set, prompt + completion token counts from
   * this call are accumulated in memory and can be flushed to
   * `build_token_telemetry` via `flushBuildTokenTelemetry(taskId)` at build
   * completion. Does not affect the call itself.
   */
  taskId?: number;
  /**
   * Agent mode at call time (lite | eco | power | pro). Stored alongside the
   * token accumulator so the telemetry row carries the correct mode label.
   * Ignored when taskId is absent.
   */
  taskMode?: string;
}

/**
 * Returns a Chat-Completion-shaped response regardless of which underlying
 * provider executed the call. Tool schemas and tool_calls are translated to
 * the OpenAI shape on the way out so callers can keep using
 * `ChatCompletionMessageToolCall` everywhere.
 *
 * AbortSignal is honoured by all three providers.
 */
export async function createChatCompletion(
  params: CreateChatCompletionParams,
): Promise<ChatCompletion> {
  // Wrap AI provider calls with a per-provider circuit breaker + retry.
  // Each provider gets its own breaker so an Anthropic outage does not open
  // the OpenAI breaker and vice versa.
  const {
    openaiCircuit,
    anthropicCircuit,
    geminiCircuit,
    deepseekCircuit,
    withRetry,
    isTransientError,
  } = await import("./resilience");
  const circuit =
    params.provider === "anthropic"
      ? anthropicCircuit
      : params.provider === "gemini"
        ? geminiCircuit
        : params.provider === "deepseek"
          ? deepseekCircuit
          : openaiCircuit;

  const result = await circuit.call(() =>
    withRetry(
      () => {
        if (params.provider === "openai") {
          return openai.chat.completions.create(
            {
              model: params.model,
              messages: params.messages,
              tools: params.tools,
              tool_choice: params.tool_choice,
              response_format: params.response_format,
              max_completion_tokens: params.max_completion_tokens,
              reasoning_effort: params.reasoning_effort,
            },
            { signal: params.signal },
          );
        }
        if (params.provider === "anthropic") {
          // Route large tool-free calls through the streaming-accumulation path to
          // avoid the SDK's built-in 10-minute non-streaming guard. Tool-call paths
          // stay on non-streaming because tool_use blocks arrive at end of stream.
          const hasTools = (params.tools?.length ?? 0) > 0;
          if (!hasTools) {
            const totalChars = params.messages.reduce(
              (sum, m) =>
                sum +
                (typeof m.content === "string"
                  ? m.content.length
                  : JSON.stringify(m.content).length),
              0,
            );
            if (totalChars >= ANTHROPIC_STREAM_THRESHOLD_CHARS) {
              logger.info(
                {
                  chars: totalChars,
                  threshold: ANTHROPIC_STREAM_THRESHOLD_CHARS,
                  model: params.model,
                },
                "anthropic: large context detected — routing through streaming-accumulation path",
              );
              return callAnthropicAccumulated(params);
            }
          }
          return callAnthropic(params);
        }
        if (params.provider === "deepseek") {
          return callDeepSeek(params);
        }
        return callGemini(params);
      },
      {
        maxAttempts: 2,
        baseDelayMs: 1000,
        shouldRetry: isTransientError,
        label: `ai-completion:${params.provider}:${params.model}`,
        signal: params.signal,
      },
    ),
  );

  // Accumulate token telemetry when a taskId is provided (NabuFlow R2 Phase D).
  // The returned usage object is the source of truth — all provider adapters
  // route through synthesizeChatCompletion which always populates usage.
  if (params.taskId != null) {
    const usage = result.usage;
    if (usage) {
      accumulateBuildTokens(params.taskId, {
        mode: params.taskMode ?? "unknown",
        provider: params.provider,
        model: params.model,
        inputTokens: usage.prompt_tokens ?? 0,
        outputTokens: usage.completion_tokens ?? 0,
      });
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────────
// Streaming variant — returns an async iterable of text deltas, regardless of
// provider. Used by the converse SSE path (Task #533 step 4).
// ─────────────────────────────────────────────────────────────────────────────

export interface StreamChatCompletionParams {
  provider: Provider;
  model: string;
  messages: ChatCompletionMessageParam[];
  max_completion_tokens?: number;
  signal?: AbortSignal;
  /**
   * Prefer a fast first token over extended provider reasoning. When true, the
   * Gemini adapter disables Gemini 3's silent "thinking" phase (which otherwise
   * adds ~4-5s of time-to-first-token), so live token-by-token streaming starts
   * promptly instead of showing an empty bubble. Currently only affects Gemini;
   * other providers ignore it. Off by default so deep-reasoning callers (e.g.
   * the Builder code-generation stream) keep full thinking.
   */
  disableThinking?: boolean;
  /** OpenAI reasoning effort for latency-sensitive streaming callers. */
  reasoning_effort?: "low" | "medium" | "high";
  /**
   * NabuFlow R2 Phase D: when set, token usage captured from the provider's
   * streaming response is accumulated in the in-memory BuildTokenAccumulator
   * for this task so that flushBuildTokenTelemetry() can persist it on
   * build completion.
   */
  taskId?: number;
  /** Build mode (lite/eco/power/pro). Ignored when taskId is absent. */
  taskMode?: string;
}

/**
 * Provider-agnostic streaming chat completion. Yields incremental text deltas
 * so callers can pipe them into their existing SSE channel without caring
 * which provider executed the request.
 *
 * BILLING SCOPE: this path is used exclusively by the Ora/converse SSE
 * channel, which is NOT metered by NabuFlow credits. Builder build/refine
 * generation always goes through `createChatCompletion` (non-streaming), which
 * accumulates per-call token telemetry in `accumulateBuildTokens`. Do NOT add
 * NabuFlow metering here — it would double-charge or misattribute costs.
 */
export async function* streamChatCompletion(
  params: StreamChatCompletionParams,
): AsyncGenerator<string, void, void> {
  if (params.provider === "openai") {
    const stream = await openai.chat.completions.create({
      model: params.model,
      messages: params.messages as any, // eslint-disable-line @typescript-eslint/no-explicit-any
      stream: true,
      stream_options: { include_usage: true },
      ...(params.max_completion_tokens != null
        ? { max_completion_tokens: params.max_completion_tokens }
        : {}),
      ...(params.reasoning_effort != null ? { reasoning_effort: params.reasoning_effort } : {}),
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let reasoningTokens: number | undefined;
    let finishReason: string | null = null;
    let refusal = false;
    let contentLength = 0;
    for await (const chunk of stream) {
      const choice = chunk.choices[0];
      const delta = choice?.delta?.content;
      if (delta) {
        contentLength += delta.length;
        yield delta;
      }
      if (choice?.delta?.refusal) refusal = true;
      if (choice?.finish_reason != null) finishReason = choice.finish_reason;
      // The final chunk (when stream_options.include_usage is set) has usage.
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens ?? 0;
        outputTokens = chunk.usage.completion_tokens ?? 0;
        reasoningTokens = chunk.usage.completion_tokens_details?.reasoning_tokens ?? undefined;
      }
    }
    if (params.taskId != null && (inputTokens > 0 || outputTokens > 0)) {
      accumulateBuildTokens(params.taskId, {
        mode: params.taskMode ?? "unknown",
        provider: "openai",
        model: params.model,
        inputTokens,
        outputTokens,
      });
    }
    assertStreamProducedContent(contentLength, {
      finishReason,
      outputTokens,
      reasoningTokens,
      refusal,
    });
    return;
  }

  if (params.provider === "anthropic") {
    yield* streamAnthropic(params);
    return;
  }

  if (params.provider === "deepseek") {
    yield* streamDeepSeek(params);
    return;
  }

  yield* streamGemini(params);
}

/**
 * DeepSeek streaming via its OpenAI-compatible API. Mirrors the OpenAI branch
 * but uses the direct DeepSeek client and `max_tokens` (DeepSeek does not
 * accept `max_completion_tokens`).
 */
async function* streamDeepSeek(
  params: StreamChatCompletionParams,
): AsyncGenerator<string, void, void> {
  const client = getDeepSeekClient();
  const stream = await client.chat.completions.create({
    model: params.model,
    messages: params.messages as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    stream: true,
    stream_options: { include_usage: true },
    ...(params.max_completion_tokens != null ? { max_tokens: params.max_completion_tokens } : {}),
  });
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;
  let contentLength = 0;
  for await (const chunk of stream) {
    const choice = chunk.choices[0];
    const delta = choice?.delta?.content;
    if (delta) {
      contentLength += delta.length;
      yield delta;
    }
    if (choice?.finish_reason != null) finishReason = choice.finish_reason;
    if (chunk.usage) {
      inputTokens = chunk.usage.prompt_tokens ?? 0;
      outputTokens = chunk.usage.completion_tokens ?? 0;
    }
  }
  if (params.taskId != null && (inputTokens > 0 || outputTokens > 0)) {
    accumulateBuildTokens(params.taskId, {
      mode: params.taskMode ?? "unknown",
      provider: "deepseek",
      model: params.model,
      inputTokens,
      outputTokens,
    });
  }
  assertStreamProducedContent(contentLength, { finishReason, outputTokens });
}

async function* streamAnthropic(
  params: StreamChatCompletionParams,
): AsyncGenerator<string, void, void> {
  const { anthropic } = await import("@workspace/integrations-anthropic-ai");

  const systemParts: string[] = [];
  // Task #533: streaming path matches non-streaming — translate multimodal
  // content blocks into Anthropic image blocks so converse SSE with image
  // attachments keeps vision semantics across providers.
  const turns: Array<{ role: "user" | "assistant"; content: unknown }> = [];
  for (const msg of params.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        turns.push({ role: "user", content: openAiContentToAnthropicBlocks(msg.content) });
      } else {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        turns.push({ role: "user", content });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      turns.push({ role: "assistant", content });
    }
  }

  const defaultMaxTokens = /haiku/i.test(params.model) ? 8192 : 16000;

  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: string | null = null;
  let contentLength = 0;
  const stream = anthropic.messages.stream({
    model: params.model,
    system: systemParts.join("\n\n") || undefined,
    messages: turns as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    max_tokens: params.max_completion_tokens ?? defaultMaxTokens,
  });
  for await (const event of stream) {
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const text = event.delta.text;
      if (typeof text === "string" && text.length > 0) {
        contentLength += text.length;
        yield text;
      }
    }
    // Capture token counts: message_start has input_tokens; message_delta has output_tokens.
    if (event?.type === "message_start" && event.message?.usage) {
      inputTokens = event.message.usage.input_tokens ?? 0;
    }
    if (event?.type === "message_delta" && event.usage) {
      outputTokens = event.usage.output_tokens ?? 0;
    }
    if (event?.type === "message_delta") {
      const stopReason = (event as { delta?: { stop_reason?: string | null } }).delta?.stop_reason;
      if (stopReason != null) finishReason = stopReason;
    }
  }
  if (params.taskId != null && (inputTokens > 0 || outputTokens > 0)) {
    accumulateBuildTokens(params.taskId, {
      mode: params.taskMode ?? "unknown",
      provider: "anthropic",
      model: params.model,
      inputTokens,
      outputTokens,
    });
  }
  assertStreamProducedContent(contentLength, { finishReason, outputTokens });
}

async function* streamGemini(
  params: StreamChatCompletionParams,
): AsyncGenerator<string, void, void> {
  const { ai } = await import("@workspace/integrations-gemini-ai");

  const systemParts: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contents: any[] = [];
  for (const msg of params.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "user") {
      // Task #533: streaming path matches non-streaming — translate image_url
      // blocks into Gemini inlineData parts so converse SSE with image
      // attachments keeps vision semantics across providers.
      if (Array.isArray(msg.content)) {
        contents.push({ role: "user", parts: openAiContentToGeminiParts(msg.content) });
      } else {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        contents.push({ role: "user", parts: [{ text: content }] });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      contents.push({ role: "model", parts: [{ text: content }] });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: Record<string, any> = {
    maxOutputTokens: params.max_completion_tokens ?? 1200,
  };
  if (params.disableThinking) {
    // Disable Gemini 3's "thinking" phase. With thinking enabled the model
    // reasons silently for several seconds before emitting any output token
    // (~9s time-to-first-token observed for gemini-3-flash-preview vs ~5s with
    // it off). For live token-by-token chat that silent gap reads as "nothing
    // is streaming" and can outlast the client's patience, so latency-sensitive
    // callers trade extended reasoning for a fast first token. Both router-
    // selectable Gemini 3 models (flash + 3.1-pro preview) accept
    // thinkingBudget:0. Deep-reasoning callers (e.g. Builder code generation)
    // leave this off to keep full thinking.
    config.thinkingConfig = { thinkingBudget: 0 };
  }
  if (systemParts.length > 0) {
    config.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream: any = await ai.models.generateContentStream({
    model: params.model,
    contents,
    config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  let inputTokens = 0;
  let outputTokens = 0;
  let reasoningTokens: number | undefined;
  let finishReason: string | null = null;
  let contentLength = 0;
  for await (const chunk of stream) {
    const parts = (chunk as any).candidates?.[0]?.content?.parts ?? []; // eslint-disable-line @typescript-eslint/no-explicit-any
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.length > 0) {
        contentLength += part.text.length;
        yield part.text;
      }
    }
    const candidateFinishReason = (chunk as any).candidates?.[0]?.finishReason; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (typeof candidateFinishReason === "string") finishReason = candidateFinishReason;
    const meta = (chunk as any).usageMetadata; // eslint-disable-line @typescript-eslint/no-explicit-any
    if (meta) {
      inputTokens = meta.promptTokenCount ?? 0;
      outputTokens = meta.candidatesTokenCount ?? 0;
      reasoningTokens = meta.thoughtsTokenCount ?? undefined;
    }
  }
  if (params.taskId != null && (inputTokens > 0 || outputTokens > 0)) {
    accumulateBuildTokens(params.taskId, {
      mode: params.taskMode ?? "unknown",
      provider: "gemini",
      model: params.model,
      inputTokens,
      outputTokens,
    });
  }
  assertStreamProducedContent(contentLength, {
    finishReason,
    outputTokens,
    reasoningTokens,
  });
}

async function callAnthropic(params: CreateChatCompletionParams): Promise<ChatCompletion> {
  const { anthropic } = await import("@workspace/integrations-anthropic-ai");

  // Split out system messages — Anthropic takes them as a separate field.
  const systemParts: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const msg of params.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      // Tool results become a user message containing a tool_result block.
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      turns.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id,
            content,
          },
        ],
      });
      continue;
    }
    if (msg.role === "assistant") {
      const blocks: Array<Record<string, unknown>> = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        blocks.push({ type: "text", text: msg.content });
      }
      const toolCalls = msg.tool_calls ?? [];
      for (const tc of toolCalls) {
        if (tc.type !== "function") continue;
        // eslint-disable-next-line no-useless-assignment
        let inputJson: unknown = {};
        try {
          inputJson = JSON.parse(tc.function.arguments || "{}");
        } catch {
          inputJson = { _raw: tc.function.arguments };
        }
        blocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: inputJson,
        });
      }
      turns.push({
        role: "assistant",
        content: blocks.length > 0 ? blocks : [{ type: "text", text: "" }],
      });
      continue;
    }
    if (msg.role === "user") {
      // Task #533: translate OpenAI-style content blocks (text + image_url
      // data: URIs from the agent loop's vision wiring) into Anthropic's
      // image blocks. Falls back to plain string for non-array content.
      if (Array.isArray(msg.content)) {
        const blocks = openAiContentToAnthropicBlocks(msg.content);
        turns.push({ role: "user", content: blocks });
      } else {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        turns.push({ role: "user", content });
      }
    }
  }

  // JSON-mode shim — Anthropic has no `response_format: json_object`. We
  // append a strong instruction to the system prompt instead.
  if (params.response_format?.type === "json_object") {
    systemParts.push(
      "You MUST respond with a single valid JSON object only — no prose, no markdown fences. Begin your response with `{` and end it with `}`.",
    );
  }

  const anthropicTools = (params.tools ?? [])
    .filter((t): t is Extract<ChatCompletionTool, { type: "function" }> => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      input_schema: (t.function.parameters as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));

  // Pick a max_tokens that the model can actually honour.
  // Haiku-class models cap at 8 192; Sonnet/Opus Claude-4+ support 16 000.
  // Using 32 000 causes HTTP 400 from haiku and trips the circuit breaker.
  const defaultMaxTokens = /haiku/i.test(params.model) ? 8192 : 16000;
  const request: Record<string, unknown> = {
    model: params.model,
    max_tokens: params.max_completion_tokens ?? defaultMaxTokens,
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: turns,
  };
  if (anthropicTools.length > 0) request.tools = anthropicTools;
  if (params.tool_choice && anthropicTools.length > 0) {
    if (params.tool_choice === "required") request.tool_choice = { type: "any" };
    else if (params.tool_choice === "none") request.tool_choice = { type: "none" };
    else if (params.tool_choice === "auto") request.tool_choice = { type: "auto" };
    else if (typeof params.tool_choice === "object" && params.tool_choice.type === "function") {
      request.tool_choice = { type: "tool", name: params.tool_choice.function.name };
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const res: any = await anthropic.messages.create(request as any, {
    signal: params.signal,
  });

  if (res.stop_reason === "max_tokens") {
    logger.warn(
      { model: params.model, outputTokens: res.usage?.output_tokens },
      "anthropic: response truncated at max_tokens — tool call arguments may be incomplete",
    );
  }

  let text = "";
  const outToolCalls: ChatCompletionMessageToolCall[] = [];
  for (const block of res.content ?? []) {
    if (block.type === "text") text += block.text ?? "";
    else if (block.type === "tool_use") {
      outToolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input ?? {}),
        },
      });
    }
  }

  return synthesizeChatCompletion({
    model: res.model ?? params.model,
    content: text,
    toolCalls: outToolCalls,
    finishReason: res.stop_reason === "tool_use" ? "tool_calls" : "stop",
    promptTokens: res.usage?.input_tokens ?? 0,
    completionTokens: res.usage?.output_tokens ?? 0,
  });
}

/**
 * Streaming-accumulation path for large Anthropic calls.
 *
 * Drives `anthropic.messages.stream()` directly (bypassing the generic
 * `streamChatCompletion` wrapper) so it can intercept the usage metadata events
 * that the Anthropic streaming API emits:
 *
 *   • `message_start`  → `event.message.usage.input_tokens`  (prompt tokens)
 *   • `message_delta`  → `event.usage.output_tokens`          (completion tokens)
 *
 * This resolves the Phase 2B-1 gap where `promptTokens` and `completionTokens`
 * were hardcoded to 0. Token counts are now captured from the stream and
 * forwarded to `synthesizeChatCompletion` so post-call logs are complete.
 *
 * If `input_tokens` is absent from the stream (e.g. the provider omits it),
 * we fall back to 0 and log a warning rather than faking a value.
 *
 * Handles `response_format: json_object` by injecting the JSON shim into the
 * system message — the native Anthropic streaming API has no response_format
 * parameter, so the shim is the only way to enforce JSON output.
 *
 * Tool calls are NOT supported here (callers route tool calls to callAnthropic).
 */
async function callAnthropicAccumulated(
  params: CreateChatCompletionParams,
): Promise<ChatCompletion> {
  const { anthropic } = await import("@workspace/integrations-anthropic-ai");

  // ── 1. Build system parts + turns (mirrors callAnthropic / streamAnthropic) ─

  const JSON_SHIM =
    "You MUST respond with a single valid JSON object only — no prose, no markdown fences. Begin your response with `{` and end it with `}`.";

  const systemParts: string[] = [];
  const turns: Array<{ role: "user" | "assistant"; content: unknown }> = [];

  for (const msg of params.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "user") {
      if (Array.isArray(msg.content)) {
        turns.push({ role: "user", content: openAiContentToAnthropicBlocks(msg.content) });
      } else {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        turns.push({ role: "user", content });
      }
      continue;
    }
    if (msg.role === "assistant") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      turns.push({ role: "assistant", content });
    }
    // tool messages are not expected here — callAnthropicAccumulated is only
    // called for tool-free paths (checked by the caller before routing).
  }

  // Inject JSON-mode shim when response_format: json_object is requested.
  if (params.response_format?.type === "json_object") {
    systemParts.push(JSON_SHIM);
  }

  const defaultMaxTokens = /haiku/i.test(params.model) ? 8192 : 16000;

  // ── 2. Open the stream and accumulate text + usage metadata ──────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream: any = await anthropic.messages.stream(
    {
      model: params.model,
      max_tokens: params.max_completion_tokens ?? defaultMaxTokens,
      system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
      messages: turns,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    { signal: params.signal },
  );

  let fullText = "";
  let promptTokens = 0;
  let completionTokens = 0;
  let promptTokensCaptured = false;

  for await (const event of stream) {
    if (params.signal?.aborted) break;

    // message_start carries the prompt (input) token count.
    if (event?.type === "message_start") {
      const inputTokens = event?.message?.usage?.input_tokens;
      if (typeof inputTokens === "number") {
        promptTokens = inputTokens;
        promptTokensCaptured = true;
      }
      continue;
    }

    // content_block_delta carries incremental text.
    if (event?.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const text = event.delta.text;
      if (typeof text === "string" && text.length > 0) fullText += text;
      continue;
    }

    // message_delta carries the completion (output) token count.
    if (event?.type === "message_delta") {
      const outputTokens = event?.usage?.output_tokens;
      if (typeof outputTokens === "number") {
        completionTokens = outputTokens;
      }
    }
  }

  if (!promptTokensCaptured) {
    logger.warn(
      { model: params.model },
      "anthropic streaming-accumulation: message_start usage.input_tokens absent — prompt token count unavailable, defaulting to 0",
    );
  }

  return synthesizeChatCompletion({
    model: params.model,
    content: fullText,
    toolCalls: [],
    finishReason: "stop",
    promptTokens,
    completionTokens,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Gemini adapter
// ─────────────────────────────────────────────────────────────────────────────

async function callGemini(params: CreateChatCompletionParams): Promise<ChatCompletion> {
  const { ai } = await import("@workspace/integrations-gemini-ai");

  const systemParts: string[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const contents: any[] = [];

  for (const msg of params.messages) {
    if (msg.role === "system") {
      if (typeof msg.content === "string") systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch {
        parsed = { result: content };
      }
      contents.push({
        role: "user",
        parts: [
          {
            functionResponse: {
              name: lookupToolName(params.messages, msg.tool_call_id) ?? "tool",
              response: typeof parsed === "object" && parsed !== null ? parsed : { result: parsed },
            },
          },
        ],
      });
      continue;
    }
    if (msg.role === "assistant") {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const parts: any[] = [];
      if (typeof msg.content === "string" && msg.content.length > 0) {
        parts.push({ text: msg.content });
      }
      for (const tc of msg.tool_calls ?? []) {
        if (tc.type !== "function") continue;
        // eslint-disable-next-line no-useless-assignment
        let argsObj: unknown = {};
        try {
          argsObj = JSON.parse(tc.function.arguments || "{}");
        } catch {
          argsObj = {};
        }
        parts.push({
          functionCall: { name: tc.function.name, args: argsObj },
        });
      }
      contents.push({
        role: "model",
        parts: parts.length > 0 ? parts : [{ text: "" }],
      });
      continue;
    }
    if (msg.role === "user") {
      // Task #533: translate OpenAI content blocks into Gemini parts —
      // text parts pass through; image_url data: URIs become inlineData parts.
      if (Array.isArray(msg.content)) {
        const parts = openAiContentToGeminiParts(msg.content);
        contents.push({ role: "user", parts });
      } else {
        const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content);
        contents.push({ role: "user", parts: [{ text: content }] });
      }
    }
  }

  if (params.response_format?.type === "json_object") {
    systemParts.push(
      "Respond with a single valid JSON object only — no prose, no markdown fences.",
    );
  }

  const functionDeclarations = (params.tools ?? [])
    .filter((t): t is Extract<ChatCompletionTool, { type: "function" }> => t.type === "function")
    .map((t) => ({
      name: t.function.name,
      description: t.function.description ?? "",
      parameters: (t.function.parameters as Record<string, unknown>) ?? {
        type: "object",
        properties: {},
      },
    }));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const config: Record<string, any> = {
    maxOutputTokens: params.max_completion_tokens ?? 8192,
  };
  if (params.disableThinking) {
    // Gemini 3 Flash Preview uses a silent "thinking" phase that can consume
    // the entire token budget when max_completion_tokens is low (e.g. 450),
    // leaving the actual reply empty (content = "" → null → 502). Mirrors the
    // same flag already used on the streaming path (streamGemini / streamChatCompletion).
    config.thinkingConfig = { thinkingBudget: 0 };
    // Non-streaming generateContent has been observed returning an entirely
    // empty completion for gemini-3-* at very low ceilings (e.g. 75) even with
    // thinkingBudget:0 — the model still reserves internal headroom that eats
    // the whole budget. maxOutputTokens is a ceiling, not a target, so raising a
    // small floor here leaves room for actual reply tokens without forcing
    // longer answers. The empty-completion fallback in the candidate chain still
    // guards the residual case. Streaming (streamGemini) is unaffected.
    config.maxOutputTokens = Math.max(config.maxOutputTokens as number, 256);
  }
  if (systemParts.length > 0) {
    config.systemInstruction = { parts: [{ text: systemParts.join("\n\n") }] };
  }
  if (functionDeclarations.length > 0) {
    config.tools = [{ functionDeclarations }];
  }
  if (params.response_format?.type === "json_object") {
    config.responseMimeType = "application/json";
  }

  const res = await ai.models.generateContent({
    model: params.model,
    contents,
    config,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  let text = "";
  const outToolCalls: ChatCompletionMessageToolCall[] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const candidate: any = (res as any).candidates?.[0] ?? null;
  const partList = candidate?.content?.parts ?? [];
  let idx = 0;
  for (const part of partList) {
    if (typeof part.text === "string") text += part.text;
    if (part.functionCall) {
      outToolCalls.push({
        id: `gemini_${Date.now()}_${idx++}`,
        type: "function",
        function: {
          name: part.functionCall.name ?? "tool",
          arguments: JSON.stringify(part.functionCall.args ?? {}),
        },
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const usage = (res as any).usageMetadata ?? {};
  return synthesizeChatCompletion({
    model: params.model,
    content: text,
    toolCalls: outToolCalls,
    finishReason: outToolCalls.length > 0 ? "tool_calls" : "stop",
    promptTokens: usage.promptTokenCount ?? 0,
    completionTokens: usage.candidatesTokenCount ?? 0,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// DeepSeek adapter
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Non-streaming DeepSeek completion via its OpenAI-compatible API. The wire
 * shape matches OpenAI's `chat.completions.create`, so the returned
 * `ChatCompletion` is passed straight through. DeepSeek uses `max_tokens`
 * (not `max_completion_tokens`) and does not support OpenAI's `tool_choice`
 * variety beyond auto, which Ora's conversational path does not rely on.
 */
async function callDeepSeek(params: CreateChatCompletionParams): Promise<ChatCompletion> {
  const client = getDeepSeekClient();
  return client.chat.completions.create(
    {
      model: params.model,
      messages: params.messages,
      tools: params.tools,
      tool_choice: params.tool_choice,
      response_format: params.response_format,
      max_tokens: params.max_completion_tokens,
    },
    { signal: params.signal },
  ) as Promise<ChatCompletion>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Content-block translation (image_url support, Task #533)
// ─────────────────────────────────────────────────────────────────────────────

// Parses a `data:<mime>;base64,<payload>` URI. Returns null for http(s) URLs
// or malformed input — the agent loop only ever emits data: URIs for its
// own screenshots, so we don't fan out to URL fetching here.
function parseDataUri(url: string): { mimeType: string; base64: string } | null {
  if (!url.startsWith("data:")) return null;
  const comma = url.indexOf(",");
  if (comma < 0) return null;
  const header = url.slice(5, comma);
  const payload = url.slice(comma + 1);
  const semi = header.indexOf(";");
  const mimeType = (semi >= 0 ? header.slice(0, semi) : header) || "image/png";
  const isBase64 = header.includes(";base64");
  if (!isBase64) return null;
  return { mimeType, base64: payload };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openAiContentToAnthropicBlocks(content: any[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ type: "text", text: block.text });
    } else if (block.type === "image_url" && block.image_url?.url) {
      const parsed = parseDataUri(String(block.image_url.url));
      if (parsed) {
        out.push({
          type: "image",
          source: { type: "base64", media_type: parsed.mimeType, data: parsed.base64 },
        });
      } else {
        out.push({
          type: "text",
          text: `[image at ${String(block.image_url.url).slice(0, 200)} — non-data URI not inlined]`,
        });
      }
    }
  }
  return out.length > 0 ? out : [{ type: "text", text: "" }];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function openAiContentToGeminiParts(content: any[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const block of content) {
    if (!block || typeof block !== "object") continue;
    if (block.type === "text" && typeof block.text === "string") {
      out.push({ text: block.text });
    } else if (block.type === "image_url" && block.image_url?.url) {
      const parsed = parseDataUri(String(block.image_url.url));
      if (parsed) {
        out.push({ inlineData: { mimeType: parsed.mimeType, data: parsed.base64 } });
      } else {
        out.push({
          text: `[image at ${String(block.image_url.url).slice(0, 200)} — non-data URI not inlined]`,
        });
      }
    }
  }
  return out.length > 0 ? out : [{ text: "" }];
}

// Gemini's functionResponse requires a `name` (the tool the result is for).
// Walk the previously-sent messages to find the matching tool_call by id.
function lookupToolName(messages: ChatCompletionMessageParam[], toolCallId: string): string | null {
  for (const m of messages) {
    if (m.role !== "assistant") continue;
    for (const tc of m.tool_calls ?? []) {
      if (tc.type !== "function") continue;
      if (tc.id === toolCallId) return tc.function.name;
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function synthesizeChatCompletion(opts: {
  model: string;
  content: string;
  toolCalls: ChatCompletionMessageToolCall[];
  finishReason: "stop" | "tool_calls" | "length";
  promptTokens: number;
  completionTokens: number;
}): ChatCompletion {
  return {
    id: `chatcmpl-shim-${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: opts.model,
    choices: [
      {
        index: 0,
        finish_reason: opts.finishReason,
        logprobs: null,
        message: {
          role: "assistant",
          content: opts.content,
          refusal: null,
          tool_calls: opts.toolCalls.length > 0 ? opts.toolCalls : undefined,
        },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    ],
    usage: {
      prompt_tokens: opts.promptTokens,
      completion_tokens: opts.completionTokens,
      total_tokens: opts.promptTokens + opts.completionTokens,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

const FALLBACK_USD_INPUT = 0.001;

/**
 * Add token counts from one model call to the per-task accumulator.
 * Can be called directly by streaming paths that don't return usage metadata
 * through the normal createChatCompletion return value.
 */
export function accumulateBuildTokens(
  taskId: number,
  opts: {
    mode: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
  },
): void {
  // Compute this call's USD cost at capture time using the call's own model
  // rates. This prevents multi-model builds (planner → code-gen, escalation,
  // correction passes) from mispricing all tokens at the final model's rate.
  const callCost = computeModelUsdCost(opts.model, opts.inputTokens, opts.outputTokens);
  const attributionKey = `${opts.provider}\u0000${opts.model}`;
  const callTokens = opts.inputTokens + opts.outputTokens;
  const existing = buildTokenAccumulators.get(taskId);
  if (existing) {
    existing.inputTokens += opts.inputTokens;
    existing.outputTokens += opts.outputTokens;
    existing.computedUsdCost += callCost;
    const currentAttribution = existing.attribution.get(attributionKey);
    existing.attribution.set(attributionKey, {
      provider: opts.provider,
      model: opts.model,
      tokens: (currentAttribution?.tokens ?? 0) + callTokens,
    });
    if (opts.mode) existing.mode = opts.mode;
  } else {
    buildTokenAccumulators.set(taskId, {
      mode: opts.mode,
      inputTokens: opts.inputTokens,
      outputTokens: opts.outputTokens,
      computedUsdCost: callCost,
      attribution: new Map([
        [attributionKey, { provider: opts.provider, model: opts.model, tokens: callTokens }],
      ]),
    });
  }
}

const buildTokenAccumulators = new Map<number, BuildTokenAccumulator>();

function lookupUsdPer1K(model: string, side: "input" | "output"): number {
  const lower = model.toLowerCase();
  const table = side === "input" ? USD_PER_1K_INPUT : USD_PER_1K_OUTPUT;
  for (const [pattern, rate] of table) {
    if (lower.includes(pattern)) return rate;
  }
  return side === "input" ? FALLBACK_USD_INPUT : FALLBACK_USD_OUTPUT;
}

/** Removes a task's accumulator without persistence (tests/emergency cleanup). */
export function clearBuildTokenAccumulator(taskId: number): void {
  buildTokenAccumulators.delete(taskId);
}

export function dominantBuildTokenAttribution(
  attribution: ReadonlyMap<string, { provider: string; model: string; tokens: number }>,
): { provider: string; model: string } {
  const ranked = [...attribution.values()].sort(
    (a, b) =>
      b.tokens - a.tokens || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
  );
  return {
    provider: ranked[0]?.provider ?? "unknown",
    model: ranked[0]?.model ?? "unknown",
  };
}

export async function persistBuildTokenTelemetrySnapshot(
  snapshot: BuildTokenTelemetrySnapshot,
): Promise<void> {
  const { pool } = await import("@workspace/db");
  const client = await pool.connect();
  try {
    await client.query(
      `INSERT INTO build_token_telemetry
         (task_id, mode, provider, model, status, input_tokens, output_tokens,
          computed_usd_cost, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (task_id) DO UPDATE SET
         mode              = EXCLUDED.mode,
         provider          = EXCLUDED.provider,
         model             = EXCLUDED.model,
         status            = EXCLUDED.status,
         input_tokens      = EXCLUDED.input_tokens,
         output_tokens     = EXCLUDED.output_tokens,
         computed_usd_cost = EXCLUDED.computed_usd_cost,
         recorded_at       = now()`,
      [
        snapshot.taskId,
        snapshot.mode,
        snapshot.provider,
        snapshot.model,
        snapshot.status,
        snapshot.inputTokens,
        snapshot.outputTokens,
        snapshot.computedUsdCost.toFixed(8),
      ],
    );
  } finally {
    client.release();
  }
}

/**
 * Flush every terminal outcome. DB writes get a bounded retry; exhaustion is
 * handed to the durable settlement outbox before the accumulator is cleared.
 */
export async function flushBuildTokenTelemetry(
  taskId: number,
  status: BuildTokenTelemetryStatus = "completed",
): Promise<void> {
  const acc = buildTokenAccumulators.get(taskId);
  if (!acc) return;

  const dominant = dominantBuildTokenAttribution(acc.attribution);
  const snapshot: BuildTokenTelemetrySnapshot = {
    taskId,
    mode: acc.mode,
    provider: dominant.provider,
    model: dominant.model,
    status,
    inputTokens: acc.inputTokens,
    outputTokens: acc.outputTokens,
    computedUsdCost: acc.computedUsdCost,
  };

  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await persistBuildTokenTelemetrySnapshot(snapshot);
      buildTokenAccumulators.delete(taskId);
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 25));
      }
    }
  }

  try {
    const { enqueueBillingSettlement } = await import("./billing-settlement-outbox");
    await enqueueBillingSettlement({
      kind: "build_token_telemetry",
      dedupeKey: `build-token-telemetry:${taskId}`,
      taskId,
      context: snapshot as unknown as Record<string, unknown>,
      error: lastError,
    });
    buildTokenAccumulators.delete(taskId);
  } catch (outboxError) {
    logger.error(
      { err: outboxError, cause: lastError, taskId, status },
      "flushBuildTokenTelemetry: DB retries and durable enqueue failed",
    );
  }
}

const USD_PER_1K_OUTPUT: Array<[pattern: string, rate: number]> = [
  ["gpt-4o-mini", 0.0006],
  ["gpt-4o", 0.01],
  ["gpt-4.5", 0.03],
  ["gpt-5-nano", 0.0006],
  ["gpt-5", 0.012],
  ["o4-mini", 0.0044],
  ["o3", 0.04],
  ["claude-opus", 0.075],
  ["claude-sonnet", 0.015],
  ["claude-haiku", 0.00125],
  ["gemini-2.5-pro", 0.01],
  ["gemini-2.5-flash", 0.0003],
  ["gemini-3", 0.002],
  ["gemini", 0.0014],
  ["deepseek", 0.00028],
];

/**
 * Estimate USD cost for a model call using static list-price approximations.
 * For calibration reporting only — not used for billing.
 */
export function computeModelUsdCost(
  model: string,
  inputTokens: number,
  outputTokens: number,
): number {
  return (
    (inputTokens / 1000) * lookupUsdPer1K(model, "input") +
    (outputTokens / 1000) * lookupUsdPer1K(model, "output")
  );
}

const FALLBACK_USD_OUTPUT = 0.003;

const USD_PER_1K_INPUT: Array<[pattern: string, rate: number]> = [
  // OpenAI
  ["gpt-4o-mini", 0.00015],
  ["gpt-4o", 0.0025],
  ["gpt-4.5", 0.0075],
  ["gpt-5-nano", 0.00015],
  ["gpt-5", 0.003],
  ["o4-mini", 0.0011],
  ["o3", 0.01],
  // Anthropic
  ["claude-opus", 0.015],
  ["claude-sonnet", 0.003],
  ["claude-haiku", 0.00025],
  // Gemini
  ["gemini-2.5-pro", 0.00125],
  ["gemini-2.5-flash", 0.000075],
  ["gemini-3", 0.0005],
  ["gemini", 0.00035],
  // DeepSeek
  ["deepseek", 0.00014],
];
