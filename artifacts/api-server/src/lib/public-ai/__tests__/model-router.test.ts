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

import { describe, it, expect, vi } from "vitest";
import {
  selectOraModelRoute,
  runCandidateChain,
  type OraModelRouteInput,
  type ModelCandidate,
} from "../model-router";
import { MODEL_DEFAULTS, type Provider } from "../../ai-providers";

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
    { provider: "gemini", model: "gemini-2.5-pro" },
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
