/**
 * Tests for Ora's smart provider routing (Task #1402).
 *
 * Covers the two halves of the router:
 *   - `selectOraModelRoute` (model-router.ts): the PURE function that turns the
 *     classifier signals + a provider-availability snapshot into an ordered
 *     fallback chain. Verifies per-tier ordering, the technical-topic and
 *     multilingual overrides, availability filtering, open-circuit
 *     deprioritization, and the guarantee that OpenAI is always present.
 *   - `runCandidateChain` (model-router.ts): the runtime loop that chat.ts uses
 *     to advance to the next candidate when a provider throws. Exercised here
 *     with a mocked `createChatCompletion`-shaped attempt callback.
 *
 * These are pure-function tests (no DB, no network).
 */

import { afterEach, describe, it, expect, vi } from "vitest";
import {
  normalizeOraPlanTier,
  openAiModelForOraFile,
  openAiModelForOraImage,
  openAiModelForOraMemory,
  openAiModelForOraRoute,
  openAiModelForOraSearch,
  openAiModelForOraVision,
  oraImageQualityForPlan,
  selectOraFileModelRoute,
  selectOraMemoryModelRoute,
  selectOraModelRoute,
  selectOraVisionModelRoute,
  runCandidateChain,
  assertNonEmptyCompletion,
  EmptyCompletionError,
  classifyProviderError,
  type OraModelRouteInput,
  type ModelCandidate,
} from "../model-router";
import { MODEL_DEFAULTS, type Provider } from "../../ai-provider-config";

const ALL_AVAILABLE: Record<Provider, boolean> = {
  openai: true,
  anthropic: true,
  gemini: true,
  deepseek: true,
};

function makeInput(overrides: Partial<OraModelRouteInput> = {}): OraModelRouteInput {
  return {
    tier: "premium",
    subscriptionTier: "core",
    topic: "general",
    intent: "premium",
    confidence: "high",
    multilingual: false,
    available: { ...ALL_AVAILABLE },
    openCircuits: new Set<Provider>(),
    openaiModel: "gpt-5.4",
    ...overrides,
  };
}

const providersOf = (candidates: ModelCandidate[]): Provider[] => candidates.map((c) => c.provider);

const ROUTER_ENV_NAMES = [
  "ORA_FAST_MODEL",
  "ORA_FREE_MODEL",
  "ORA_CORE_MODEL",
  "ORA_WAVE_MODEL",
  "ORA_PREMIUM_MODEL",
  "ORA_CORE_DEEP_MODEL",
  "ORA_WAVE_DEEP_MODEL",
  "ORA_DEEP_MODEL",
  "ORA_FREE_VISION_MODEL",
  "ORA_CORE_VISION_MODEL",
  "ORA_WAVE_VISION_MODEL",
  "ORA_VISION_MODEL",
  "ORA_FREE_IMAGE_MODEL",
  "ORA_CORE_IMAGE_MODEL",
  "ORA_WAVE_IMAGE_MODEL",
  "ORA_IMAGE_MODEL",
  "ORA_FREE_IMAGE_EDIT_MODEL",
  "ORA_CORE_IMAGE_EDIT_MODEL",
  "ORA_WAVE_IMAGE_EDIT_MODEL",
  "ORA_IMAGE_EDIT_MODEL",
  "IMAGE_MODEL",
  "ORA_FREE_IMAGE_QUALITY",
  "ORA_CORE_IMAGE_QUALITY",
  "ORA_WAVE_IMAGE_QUALITY",
  "ORA_IMAGE_QUALITY",
  "ORA_FREE_IMAGE_EDIT_QUALITY",
  "ORA_CORE_IMAGE_EDIT_QUALITY",
  "ORA_WAVE_IMAGE_EDIT_QUALITY",
  "ORA_IMAGE_EDIT_QUALITY",
  "ORA_FREE_SEARCH_MODEL",
  "ORA_CORE_SEARCH_MODEL",
  "ORA_WAVE_SEARCH_MODEL",
  "ORA_SEARCH_MODEL",
  "ORA_FREE_MEMORY_EXTRACT_MODEL",
  "ORA_CORE_MEMORY_EXTRACT_MODEL",
  "ORA_WAVE_MEMORY_EXTRACT_MODEL",
  "ORA_MEMORY_EXTRACT_MODEL",
  "ORA_FREE_SUMMARY_MODEL",
  "ORA_CORE_SUMMARY_MODEL",
  "ORA_WAVE_SUMMARY_MODEL",
  "ORA_SUMMARY_MODEL",
  "ORA_FREE_DOC_MEMORY_MODEL",
  "ORA_CORE_DOC_MEMORY_MODEL",
  "ORA_WAVE_DOC_MEMORY_MODEL",
  "ORA_DOC_MEMORY_MODEL",
  "ORA_FREE_MEMORY_MODEL",
  "ORA_CORE_MEMORY_MODEL",
  "ORA_WAVE_MEMORY_MODEL",
  "ORA_MEMORY_MODEL",
  "ORA_FREE_FILE_GENERATION_MODEL",
  "ORA_CORE_FILE_GENERATION_MODEL",
  "ORA_WAVE_FILE_GENERATION_MODEL",
  "ORA_FILE_GENERATION_MODEL",
  "ORA_FREE_FILE_ANALYSIS_MODEL",
  "ORA_CORE_FILE_ANALYSIS_MODEL",
  "ORA_WAVE_FILE_ANALYSIS_MODEL",
  "ORA_FILE_ANALYSIS_MODEL",
  "ORA_FREE_DATASET_ANALYSIS_MODEL",
  "ORA_CORE_DATASET_ANALYSIS_MODEL",
  "ORA_WAVE_DATASET_ANALYSIS_MODEL",
  "ORA_DATASET_ANALYSIS_MODEL",
  "ORA_FREE_FILE_MODEL",
  "ORA_CORE_FILE_MODEL",
  "ORA_WAVE_FILE_MODEL",
  "ORA_FILE_MODEL",
] as const;
const ORIGINAL_ROUTER_ENV = new Map(ROUTER_ENV_NAMES.map((name) => [name, process.env[name]]));

describe("Ora model helper functions", () => {
  afterEach(() => {
    for (const name of ROUTER_ENV_NAMES) {
      const original = ORIGINAL_ROUTER_ENV.get(name);
      if (original === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = original;
      }
    }
  });

  it("normalizes anonymous and unknown plan tiers", () => {
    expect(normalizeOraPlanTier(null)).toBe("anonymous");
    expect(normalizeOraPlanTier("starter")).toBe("free");
    expect(normalizeOraPlanTier("core")).toBe("core");
    expect(normalizeOraPlanTier("wave")).toBe("wave");
  });

  it("uses plan-aware OpenAI env overrides for chat routes", () => {
    process.env.ORA_FREE_MODEL = "gpt-free";
    process.env.ORA_CORE_MODEL = "gpt-core";
    process.env.ORA_WAVE_DEEP_MODEL = "gpt-wave-deep";

    expect(openAiModelForOraRoute("premium", "free")).toBe("gpt-free");
    expect(openAiModelForOraRoute("premium", "core")).toBe("gpt-core");
    expect(openAiModelForOraRoute("deep", "wave")).toBe("gpt-wave-deep");
  });

  it("keeps image analysis on a vision model instead of the fast/free chat model", () => {
    process.env.ORA_FAST_MODEL = "gpt-fast";
    process.env.ORA_FREE_MODEL = "gpt-free";
    process.env.ORA_VISION_MODEL = "gpt-vision";

    expect(openAiModelForOraRoute("premium", "free")).toBe("gpt-free");
    expect(openAiModelForOraVision("free")).toBe("gpt-vision");
  });

  it("routes vision analysis through vision-capable providers and excludes DeepSeek", () => {
    const candidates = selectOraVisionModelRoute({
      subscriptionTier: "wave",
      available: { ...ALL_AVAILABLE },
      openCircuits: new Set<Provider>(),
      openaiModel: "gpt-vision-terminal",
    });

    expect(providersOf(candidates)).toEqual(["gemini", "anthropic", "openai"]);
    expect(candidates[candidates.length - 1]).toEqual({
      provider: "openai",
      model: "gpt-vision-terminal",
    });
  });

  it("uses plan-aware OpenAI env overrides for image generation and editing", () => {
    expect(openAiModelForOraImage("generation", "free")).toBe("gpt-image-1");
    expect(openAiModelForOraImage("edit", "core")).toBe("gpt-image-1");

    process.env.ORA_WAVE_IMAGE_MODEL = "gpt-wave-image";
    process.env.ORA_CORE_IMAGE_EDIT_MODEL = "gpt-core-image-edit";
    process.env.IMAGE_MODEL = "gpt-global-image";

    expect(openAiModelForOraImage("generation", "wave")).toBe("gpt-wave-image");
    expect(openAiModelForOraImage("edit", "core")).toBe("gpt-core-image-edit");
    expect(openAiModelForOraImage("generation", "free")).toBe("gpt-global-image");
  });

  it("uses stronger image quality defaults for paid Ora plans without overriding requests", () => {
    expect(oraImageQualityForPlan("free", "generation")).toBe("standard");
    expect(oraImageQualityForPlan("core", "generation")).toBe("high");
    expect(oraImageQualityForPlan("wave", "edit")).toBe("high");
    expect(oraImageQualityForPlan("wave", "generation", "standard")).toBe("standard");

    process.env.ORA_CORE_IMAGE_QUALITY = "standard";
    process.env.ORA_WAVE_IMAGE_EDIT_QUALITY = "draft";

    expect(oraImageQualityForPlan("core", "generation")).toBe("standard");
    expect(oraImageQualityForPlan("wave", "edit")).toBe("draft");
  });

  it("uses plan-aware OpenAI env overrides for web search while preserving the default", () => {
    expect(openAiModelForOraSearch("free")).toBe("gpt-4o-mini");

    process.env.ORA_FREE_SEARCH_MODEL = "gpt-free-search";
    process.env.ORA_CORE_SEARCH_MODEL = "gpt-core-search";
    process.env.ORA_WAVE_SEARCH_MODEL = "gpt-wave-search";

    expect(openAiModelForOraSearch("free")).toBe("gpt-free-search");
    expect(openAiModelForOraSearch("core")).toBe("gpt-core-search");
    expect(openAiModelForOraSearch("wave")).toBe("gpt-wave-search");
  });

  it("uses stronger plan-aware OpenAI defaults and env overrides for memory tasks", () => {
    expect(openAiModelForOraMemory("extract", "free")).toBe("gpt-5-nano");
    expect(openAiModelForOraMemory("extract", "core")).toBe("gpt-5-mini");
    expect(openAiModelForOraMemory("conversation_summary", "wave")).toBe("gpt-5.4");

    process.env.ORA_CORE_MEMORY_EXTRACT_MODEL = "gpt-core-memory-extract";
    process.env.ORA_WAVE_SUMMARY_MODEL = "gpt-wave-summary";
    process.env.ORA_FREE_DOC_MEMORY_MODEL = "gpt-free-doc-memory";

    expect(openAiModelForOraMemory("extract", "core")).toBe("gpt-core-memory-extract");
    expect(openAiModelForOraMemory("conversation_summary", "wave")).toBe("gpt-wave-summary");
    expect(openAiModelForOraMemory("document_summary", "free")).toBe("gpt-free-doc-memory");
  });

  it("routes memory through specialist providers and keeps document memory Gemini-first", () => {
    const extraction = selectOraMemoryModelRoute({
      task: "extract",
      subscriptionTier: "core",
      available: { ...ALL_AVAILABLE },
      openCircuits: new Set<Provider>(),
    });
    expect(providersOf(extraction)).toEqual(["anthropic", "gemini", "deepseek", "openai"]);

    const documentSummary = selectOraMemoryModelRoute({
      task: "document_summary",
      subscriptionTier: "wave",
      available: { ...ALL_AVAILABLE },
      openCircuits: new Set<Provider>(),
    });
    expect(providersOf(documentSummary)).toEqual(["gemini", "anthropic", "deepseek", "openai"]);
  });

  it("uses plan-aware OpenAI env overrides for file tasks", () => {
    expect(openAiModelForOraFile("generation", "free")).toBe("gpt-5-mini");
    expect(openAiModelForOraFile("analysis", "core")).toBe("gpt-5.4");

    process.env.ORA_WAVE_FILE_GENERATION_MODEL = "gpt-wave-file-gen";
    process.env.ORA_CORE_FILE_ANALYSIS_MODEL = "gpt-core-file-analysis";
    process.env.ORA_FREE_DATASET_ANALYSIS_MODEL = "gpt-free-dataset";

    expect(openAiModelForOraFile("generation", "wave")).toBe("gpt-wave-file-gen");
    expect(openAiModelForOraFile("analysis", "core")).toBe("gpt-core-file-analysis");
    expect(openAiModelForOraFile("dataset_analysis", "free")).toBe("gpt-free-dataset");
  });

  it("routes file tasks through document-aware chains and keeps OpenAI terminal", () => {
    const documentAnalysis = selectOraFileModelRoute({
      task: "analysis",
      subscriptionTier: "core",
      available: { ...ALL_AVAILABLE },
      openCircuits: new Set<Provider>(),
    });
    expect(providersOf(documentAnalysis)).toEqual(["gemini", "anthropic", "deepseek", "openai"]);

    const tabularGeneration = selectOraFileModelRoute({
      task: "generation",
      subscriptionTier: "core",
      topic: "technical",
      available: { ...ALL_AVAILABLE },
      openCircuits: new Set<Provider>(),
    });
    expect(providersOf(tabularGeneration)).toEqual(["anthropic", "deepseek", "gemini", "openai"]);
  });
});

describe("selectOraModelRoute — tier ordering", () => {
  it("orders the fast tier gemini -> deepseek -> anthropic -> openai", () => {
    const candidates = selectOraModelRoute(
      makeInput({ tier: "fast", intent: "simple_faq", confidence: "high" }),
    );
    expect(providersOf(candidates)).toEqual(["gemini", "deepseek", "anthropic", "openai"]);
  });

  it("orders the premium (default) tier anthropic -> gemini -> deepseek -> openai", () => {
    const candidates = selectOraModelRoute(makeInput({ tier: "premium" }));
    expect(providersOf(candidates)).toEqual(["anthropic", "gemini", "deepseek", "openai"]);
  });

  it("orders the core deep tier anthropic -> deepseek -> gemini -> openai", () => {
    const candidates = selectOraModelRoute(makeInput({ tier: "deep" }));
    expect(providersOf(candidates)).toEqual(["anthropic", "deepseek", "gemini", "openai"]);
  });

  it("orders the wave deep tier anthropic -> gemini -> deepseek -> openai", () => {
    const candidates = selectOraModelRoute(makeInput({ tier: "deep", subscriptionTier: "wave" }));
    expect(providersOf(candidates)).toEqual(["anthropic", "gemini", "deepseek", "openai"]);
  });

  it("deep tier wins even when the topic is technical or the message is multilingual", () => {
    const candidates = selectOraModelRoute(
      makeInput({ tier: "deep", topic: "technical", multilingual: true }),
    );
    expect(providersOf(candidates)).toEqual(["anthropic", "deepseek", "gemini", "openai"]);
  });

  it("keeps free premium traffic on the cost-sensitive provider order", () => {
    const candidates = selectOraModelRoute(makeInput({ subscriptionTier: "free" }));
    expect(providersOf(candidates)).toEqual(["gemini", "deepseek", "anthropic", "openai"]);
  });
});

describe("selectOraModelRoute — topic / language overrides", () => {
  it("puts Anthropic first for a technical topic (non-deep tier)", () => {
    const candidates = selectOraModelRoute(makeInput({ topic: "technical" }));
    expect(providersOf(candidates)).toEqual(["anthropic", "deepseek", "gemini", "openai"]);
  });

  it("puts Gemini first for a multilingual message", () => {
    const candidates = selectOraModelRoute(makeInput({ multilingual: true }));
    expect(providersOf(candidates)).toEqual(["gemini", "anthropic", "deepseek", "openai"]);
  });

  it("prioritizes the multilingual ordering over a technical topic", () => {
    const candidates = selectOraModelRoute(makeInput({ multilingual: true, topic: "technical" }));
    expect(providersOf(candidates)).toEqual(["gemini", "anthropic", "deepseek", "openai"]);
  });

  it("prioritizes a technical topic over the fast tier", () => {
    const candidates = selectOraModelRoute(
      makeInput({ tier: "fast", topic: "technical", intent: "simple_faq" }),
    );
    expect(providersOf(candidates)).toEqual(["anthropic", "deepseek", "gemini", "openai"]);
  });

  it("uses a cost-sensitive technical order for free users", () => {
    const candidates = selectOraModelRoute(
      makeInput({ subscriptionTier: "free", topic: "technical" }),
    );
    expect(providersOf(candidates)).toEqual(["deepseek", "gemini", "anthropic", "openai"]);
  });

  it("puts Gemini first when document context is being carried", () => {
    const candidates = selectOraModelRoute(makeInput({ hasDocumentContext: true }));
    expect(providersOf(candidates)).toEqual(["gemini", "anthropic", "deepseek", "openai"]);
  });
});

describe("selectOraModelRoute — availability filtering", () => {
  it("drops DeepSeek when it is unavailable", () => {
    const candidates = selectOraModelRoute(
      makeInput({ available: { ...ALL_AVAILABLE, deepseek: false } }),
    );
    expect(providersOf(candidates)).toEqual(["anthropic", "gemini", "openai"]);
  });

  it("drops Anthropic and Gemini when both are unavailable", () => {
    const candidates = selectOraModelRoute(
      makeInput({ available: { ...ALL_AVAILABLE, anthropic: false, gemini: false } }),
    );
    expect(providersOf(candidates)).toEqual(["deepseek", "openai"]);
  });

  it("falls back to OpenAI-only when every other provider is unavailable", () => {
    const candidates = selectOraModelRoute(
      makeInput({
        available: { openai: true, anthropic: false, gemini: false, deepseek: false },
      }),
    );
    expect(providersOf(candidates)).toEqual(["openai"]);
  });

  it("keeps OpenAI even if its availability flag is somehow false", () => {
    const candidates = selectOraModelRoute(
      makeInput({
        available: { openai: false, anthropic: false, gemini: false, deepseek: false },
      }),
    );
    expect(providersOf(candidates)).toEqual(["openai"]);
  });
});

describe("selectOraModelRoute — open-circuit deprioritization", () => {
  it("pushes an open-circuit provider to the back without dropping it", () => {
    // OpenAI is always terminal; an open circuit keeps it present but last.
    const candidates = selectOraModelRoute(
      makeInput({ openCircuits: new Set<Provider>(["openai"]) }),
    );
    expect(providersOf(candidates)).toEqual(["anthropic", "gemini", "deepseek", "openai"]);
  });

  it("preserves relative order among closed circuits when one is open", () => {
    const candidates = selectOraModelRoute(
      makeInput({ openCircuits: new Set<Provider>(["anthropic"]) }),
    );
    expect(providersOf(candidates)).toEqual(["gemini", "deepseek", "anthropic", "openai"]);
  });

  it("keeps relative order among multiple open circuits (stable partition)", () => {
    const candidates = selectOraModelRoute(
      makeInput({ openCircuits: new Set<Provider>(["openai", "anthropic"]) }),
    );
    // Closed first (gemini, deepseek in premium order), then open non-OpenAI
    // providers, then the terminal OpenAI safety net.
    expect(providersOf(candidates)).toEqual(["gemini", "deepseek", "anthropic", "openai"]);
  });
});

describe("selectOraModelRoute — guarantees", () => {
  it("always ends the chain with OpenAI as the final candidate", () => {
    const inputs: OraModelRouteInput[] = [
      makeInput({ tier: "fast", intent: "simple_faq" }),
      makeInput({ tier: "premium" }),
      makeInput({ tier: "deep" }),
      makeInput({ topic: "technical" }),
      makeInput({ multilingual: true }),
      makeInput({ openCircuits: new Set<Provider>(["openai"]) }),
      makeInput({ available: { ...ALL_AVAILABLE, anthropic: false } }),
    ];
    for (const input of inputs) {
      const candidates = selectOraModelRoute(input);
      expect(candidates.length).toBeGreaterThan(0);
      expect(candidates[candidates.length - 1].provider).toBe("openai");
    }
  });

  it("ends the chain with OpenAI when OpenAI is the only available provider", () => {
    const candidates = selectOraModelRoute(
      makeInput({
        available: { openai: true, anthropic: false, gemini: false, deepseek: false },
      }),
    );
    expect(candidates[candidates.length - 1].provider).toBe("openai");
  });

  it("ends the chain with OpenAI when its circuit is open (deprioritized to last)", () => {
    const candidates = selectOraModelRoute(
      makeInput({ openCircuits: new Set<Provider>(["openai"]) }),
    );
    expect(candidates[candidates.length - 1].provider).toBe("openai");
  });

  it("never repeats a provider in the chain", () => {
    const candidates = selectOraModelRoute(makeInput({ tier: "deep" }));
    const seen = providersOf(candidates);
    expect(new Set(seen).size).toBe(seen.length);
  });

  it("uses the caller-supplied (env-aware) OpenAI model verbatim", () => {
    const candidates = selectOraModelRoute(makeInput({ openaiModel: "gpt-custom-override" }));
    const openai = candidates.find((c) => c.provider === "openai");
    expect(openai?.model).toBe("gpt-custom-override");
  });

  it("maps non-OpenAI providers to their tier-appropriate MODEL_DEFAULTS", () => {
    const candidates = selectOraModelRoute(makeInput({ tier: "deep" }));
    const byProvider = Object.fromEntries(candidates.map((c) => [c.provider, c.model]));
    expect(byProvider.deepseek).toBe(MODEL_DEFAULTS.deepseek.power);
    expect(byProvider.anthropic).toBe(MODEL_DEFAULTS.anthropic.power);
    expect(byProvider.gemini).toBe(MODEL_DEFAULTS.gemini.power);
  });

  it("maps wave deep non-OpenAI providers to pro MODEL_DEFAULTS", () => {
    const candidates = selectOraModelRoute(makeInput({ tier: "deep", subscriptionTier: "wave" }));
    const byProvider = Object.fromEntries(candidates.map((c) => [c.provider, c.model]));
    expect(byProvider.deepseek).toBe(MODEL_DEFAULTS.deepseek.pro);
    expect(byProvider.anthropic).toBe(MODEL_DEFAULTS.anthropic.pro);
    expect(byProvider.gemini).toBe(MODEL_DEFAULTS.gemini.pro);
  });

  it("maps the fast tier onto the lite agent mode for non-OpenAI providers", () => {
    const candidates = selectOraModelRoute(makeInput({ tier: "fast", intent: "simple_faq" }));
    const byProvider = Object.fromEntries(candidates.map((c) => [c.provider, c.model]));
    expect(byProvider.gemini).toBe(MODEL_DEFAULTS.gemini.lite);
    expect(byProvider.deepseek).toBe(MODEL_DEFAULTS.deepseek.lite);
    expect(byProvider.anthropic).toBe(MODEL_DEFAULTS.anthropic.lite);
  });
});

describe("runCandidateChain — chat.ts fallback loop", () => {
  const chain: ModelCandidate[] = [
    { provider: "openai", model: "gpt-5.4" },
    { provider: "anthropic", model: "claude-opus-4-7" },
    { provider: "gemini", model: "gemini-3.1-pro-preview" },
  ];

  it("returns the first candidate when it succeeds (no fallback)", async () => {
    const attempt = vi.fn(async (c: ModelCandidate) => `reply-from-${c.provider}`);
    const result = await runCandidateChain(chain, attempt);

    expect(attempt).toHaveBeenCalledTimes(1);
    expect(result.candidate.provider).toBe("openai");
    expect(result.index).toBe(0);
    expect(result.usedFallback).toBe(false);
    expect(result.result).toBe("reply-from-openai");
  });

  it("advances to the next candidate when a provider throws", async () => {
    const attempt = vi.fn(async (c: ModelCandidate) => {
      if (c.provider === "openai") throw new Error("openai down");
      return `reply-from-${c.provider}`;
    });
    const onError = vi.fn();

    const result = await runCandidateChain(chain, attempt, onError);

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result.candidate.provider).toBe("anthropic");
    expect(result.index).toBe(1);
    expect(result.usedFallback).toBe(true);
    expect(result.result).toBe("reply-from-anthropic");
    // onError is invoked once for the failed first attempt.
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].provider).toBe("openai");
    expect(onError.mock.calls[0][1]).toBe(0);
  });

  it("skips multiple failing providers until one succeeds", async () => {
    const attempt = vi.fn(async (c: ModelCandidate) => {
      if (c.provider !== "gemini") throw new Error(`${c.provider} down`);
      return "reply-from-gemini";
    });

    const result = await runCandidateChain(chain, attempt);

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result.candidate.provider).toBe("gemini");
    expect(result.index).toBe(2);
    expect(result.usedFallback).toBe(true);
  });

  it("re-throws the last error when every candidate fails", async () => {
    const attempt = vi.fn(async (c: ModelCandidate) => {
      throw new Error(`${c.provider} down`);
    });

    await expect(runCandidateChain(chain, attempt)).rejects.toThrow("gemini down");
    expect(attempt).toHaveBeenCalledTimes(3);
  });

  it("throws a default error when given an empty candidate chain", async () => {
    const attempt = vi.fn();
    await expect(runCandidateChain([], attempt)).rejects.toThrow("All Ora model candidates failed");
    expect(attempt).not.toHaveBeenCalled();
  });
});

describe("assertNonEmptyCompletion — blank HTTP-200 fallthrough guard", () => {
  const makeCompletion = (content: string | null, toolCalls?: unknown[]) => ({
    choices: [
      {
        message: {
          content,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
      },
    ],
  });

  it("does not throw when the completion has non-blank text content", () => {
    expect(() => assertNonEmptyCompletion(makeCompletion("Here is your answer."))).not.toThrow();
  });

  it("throws EmptyCompletionError when content is null and there are no tool calls", () => {
    expect(() => assertNonEmptyCompletion(makeCompletion(null))).toThrow(EmptyCompletionError);
  });

  it("throws when content is whitespace-only and there are no tool calls", () => {
    expect(() => assertNonEmptyCompletion(makeCompletion("   \n  "))).toThrow(EmptyCompletionError);
  });

  it("does not throw when content is blank but tool calls are present", () => {
    expect(() =>
      assertNonEmptyCompletion(makeCompletion("", [{ id: "call_1", type: "function" }])),
    ).not.toThrow();
  });

  it("classifies EmptyCompletionError as 'empty_completion'", () => {
    expect(classifyProviderError(new EmptyCompletionError())).toBe("empty_completion");
  });

  it("advances runCandidateChain to the next provider on a blank completion (chat.ts pattern)", async () => {
    // Mirrors the chat.ts attempt closure: call the provider, then assert the
    // completion is non-empty. A blank HTTP-200 from the first provider must
    // fall through to the next candidate instead of 'succeeding' with empty text.
    const chain: ModelCandidate[] = [
      { provider: "gemini", model: "gemini-3-flash-preview" },
      { provider: "anthropic", model: "claude-haiku-4-5" },
    ];
    const attempt = vi.fn(async (c: ModelCandidate) => {
      const completion =
        c.provider === "gemini" ? makeCompletion(null) : makeCompletion("real answer");
      assertNonEmptyCompletion(completion);
      return completion;
    });
    const onError = vi.fn();

    const result = await runCandidateChain(chain, attempt, onError);

    expect(attempt).toHaveBeenCalledTimes(2);
    expect(result.candidate.provider).toBe("anthropic");
    expect(result.usedFallback).toBe(true);
    expect(result.result.choices[0].message.content).toBe("real answer");
    // The failed gemini attempt classifies cleanly for structured logging.
    expect(classifyProviderError(onError.mock.calls[0][2])).toBe("empty_completion");
  });
});
