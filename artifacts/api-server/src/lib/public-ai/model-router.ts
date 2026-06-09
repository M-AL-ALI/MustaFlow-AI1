/**
 * Ora model router (Task #1400).
 *
 * Classifies an Ora conversational message into a routing *tier* and picks the
 * single best provider+model, with an availability-aware ordered fallback
 * chain across all four providers (OpenAI / Anthropic / Gemini / DeepSeek).
 *
 * This is a PURE function — it takes the already-computed classifier signals
 * plus a snapshot of provider availability and open circuit breakers, and
 * returns an ordered list of candidates. The caller (chat.ts) iterates the
 * list, attempting each provider in turn until one succeeds. OpenAI is always
 * appended as the terminal safety net because it is the only provider that is
 * always configured.
 *
 * Scope guard: this only selects the model for Ora's *conversational* branch.
 * It does NOT touch the Builder pipeline, the web-search grounding path (which
 * requires a direct OpenAI Responses API call), image/vision routing, or any
 * user-facing model picker.
 */

import { isDeepSeekAvailable, MODEL_DEFAULTS, type Provider } from "../ai-providers";
import { ALL_BREAKERS } from "../resilience";
import type { OraIntent, OraConfidence, OraTopic } from "./classifier";

/** A single provider+model the caller can attempt. */
export interface ModelCandidate {
  provider: Provider;
  model: string;
}

/**
 * Routing tier derived from the conversation. Maps directly onto the existing
 * speed/quality dial the chat branch already computes:
 *  - `deep`    → Deep Thinking mode (strongest reasoning, large token budget)
 *  - `fast`    → confident simple FAQ (cheap/fast tier)
 *  - `premium` → everything else (default substantive reasoning)
 */
export type OraRouteTier = "fast" | "premium" | "deep";
export type OraPlanTier = "anonymous" | "free" | "core" | "wave";

export interface OraModelRouteInput {
  tier: OraRouteTier;
  /**
   * User's effective Ora plan tier. Anonymous visitors are represented
   * explicitly so the router can bias toward low-latency/cost providers.
   */
  subscriptionTier?: string | null;
  topic: OraTopic;
  intent: OraIntent;
  confidence: OraConfidence;
  /** True when the user's message/locale is a non-English language. */
  multilingual: boolean;
  /** True when prior uploaded document content is being carried into context. */
  hasDocumentContext?: boolean;
  /** Which providers are currently configured/reachable. */
  available: Record<Provider, boolean>;
  /** Providers whose circuit breaker is currently OPEN (deprioritized, not removed). */
  openCircuits: ReadonlySet<Provider>;
  /**
   * The OpenAI model the caller already resolved for this tier (honors
   * ORA_DEEP_MODEL / ORA_PREMIUM_MODEL env overrides and the gpt-5-mini
   * fast-path). Used verbatim for the OpenAI candidate so env overrides win.
   */
  openaiModel: string;
}

/**
 * Per-tier specialist provider preference orderings. OpenAI is intentionally
 * absent from these arrays; `selectOraModelRoute` appends it once as the
 * terminal safety-net candidate after availability filtering.
 */
const FAST_ORDER: Provider[] = ["gemini", "deepseek", "anthropic"];
const COST_SENSITIVE_ORDER: Provider[] = ["gemini", "deepseek", "anthropic"];
const CORE_GENERAL_ORDER: Provider[] = ["anthropic", "gemini", "deepseek"];
const WAVE_GENERAL_ORDER: Provider[] = ["anthropic", "gemini", "deepseek"];
const CORE_DEEP_ORDER: Provider[] = ["anthropic", "deepseek", "gemini"];
const WAVE_DEEP_ORDER: Provider[] = ["anthropic", "gemini", "deepseek"];
const COST_SENSITIVE_TECHNICAL_ORDER: Provider[] = ["deepseek", "gemini", "anthropic"];
const SPECIALIST_TECHNICAL_ORDER: Provider[] = ["anthropic", "deepseek", "gemini"];
const DOCUMENT_ORDER: Provider[] = ["gemini", "anthropic", "deepseek"];
const MULTILINGUAL_ORDER: Provider[] = ["gemini", "anthropic", "deepseek"];

export function normalizeOraPlanTier(raw: string | null | undefined): OraPlanTier {
  if (raw === "core" || raw === "wave" || raw === "free") return raw;
  return raw ? "free" : "anonymous";
}

function envModel(...names: string[]): string | null {
  for (const name of names) {
    const value = process.env[name]?.trim();
    if (value) return value;
  }
  return null;
}

export function openAiModelForOraRoute(routeTier: OraRouteTier, planTier: OraPlanTier): string {
  if (routeTier === "fast") {
    return envModel("ORA_FAST_MODEL") ?? "gpt-5-mini";
  }

  if (routeTier === "deep") {
    if (planTier === "wave") {
      return (
        envModel("ORA_WAVE_DEEP_MODEL", "ORA_DEEP_MODEL", "ORA_WAVE_MODEL", "ORA_PREMIUM_MODEL") ??
        "gpt-5.4"
      );
    }
    return (
      envModel("ORA_CORE_DEEP_MODEL", "ORA_DEEP_MODEL", "ORA_CORE_MODEL", "ORA_PREMIUM_MODEL") ??
      "gpt-5.4"
    );
  }

  if (planTier === "wave") {
    return envModel("ORA_WAVE_MODEL", "ORA_PREMIUM_MODEL") ?? "gpt-5.4";
  }
  if (planTier === "core") {
    return envModel("ORA_CORE_MODEL", "ORA_PREMIUM_MODEL") ?? "gpt-5.4";
  }
  return envModel("ORA_FREE_MODEL", "ORA_FAST_MODEL") ?? "gpt-5-mini";
}

export function openAiModelForOraVision(planTier: OraPlanTier): string {
  if (planTier === "wave") {
    return (
      envModel("ORA_WAVE_VISION_MODEL", "ORA_VISION_MODEL", "ORA_WAVE_MODEL", "ORA_PREMIUM_MODEL") ??
      "gpt-5.4"
    );
  }
  if (planTier === "core") {
    return (
      envModel("ORA_CORE_VISION_MODEL", "ORA_VISION_MODEL", "ORA_CORE_MODEL", "ORA_PREMIUM_MODEL") ??
      "gpt-5.4"
    );
  }
  return envModel("ORA_FREE_VISION_MODEL", "ORA_VISION_MODEL", "ORA_PREMIUM_MODEL") ?? "gpt-5.4";
}

export function getOraProviderRoutingSnapshot(): {
  available: Record<Provider, boolean>;
  openCircuits: Set<Provider>;
} {
  const openCircuits = new Set(
    ALL_BREAKERS.filter((b) => b.toJSON().state === "open").map((b) => b.toJSON().name as Provider),
  );
  return {
    openCircuits,
    available: {
      openai: true,
      anthropic: !!(
        process.env.AI_INTEGRATIONS_ANTHROPIC_BASE_URL &&
        process.env.AI_INTEGRATIONS_ANTHROPIC_API_KEY
      ),
      gemini: !!(
        process.env.AI_INTEGRATIONS_GEMINI_BASE_URL && process.env.AI_INTEGRATIONS_GEMINI_API_KEY
      ),
      deepseek: isDeepSeekAvailable(),
    },
  };
}

function isCostSensitivePlan(plan: OraPlanTier): boolean {
  return plan === "anonymous" || plan === "free";
}

function isBuilderLikeIntent(input: OraModelRouteInput): boolean {
  return input.intent === "builder_request" || input.topic === "technical";
}

/**
 * Map a routing tier onto the existing agent-mode dial so non-OpenAI providers
 * pick a tier-appropriate model from MODEL_DEFAULTS.
 */
function tierToAgentMode(tier: OraRouteTier, plan: OraPlanTier): "lite" | "eco" | "power" | "pro" {
  if (tier === "fast") return "lite";
  if (isCostSensitivePlan(plan)) return tier === "deep" ? "power" : "eco";
  if (tier === "deep") return plan === "wave" ? "pro" : "power";
  if (plan === "wave") return "pro";
  return "power";
}

/**
 * Choose the provider preference ordering for this message. Precedence:
 *  1. Deep Thinking mode → reasoning-first ordering (explicit user intent).
 *  2. Non-English message → Gemini-first multilingual ordering.
 *  3. Carried document context -> Gemini-first long-context ordering.
 *  4. Technical/builder-like work -> specialist technical ordering.
 *  5. Confident simple FAQ -> fast/cheap ordering.
 *  6. Otherwise -> plan-aware premium default ordering.
 */
function pickProviderOrder(input: OraModelRouteInput): Provider[] {
  const plan = normalizeOraPlanTier(input.subscriptionTier);
  if (input.tier === "deep") return plan === "wave" ? WAVE_DEEP_ORDER : CORE_DEEP_ORDER;
  if (input.multilingual) return MULTILINGUAL_ORDER;
  if (input.hasDocumentContext) return DOCUMENT_ORDER;
  if (isBuilderLikeIntent(input)) {
    return isCostSensitivePlan(plan) ? COST_SENSITIVE_TECHNICAL_ORDER : SPECIALIST_TECHNICAL_ORDER;
  }
  if (input.tier === "fast") return FAST_ORDER;
  if (isCostSensitivePlan(plan)) return COST_SENSITIVE_ORDER;
  return plan === "wave" ? WAVE_GENERAL_ORDER : CORE_GENERAL_ORDER;
}

/**
 * Resolve the concrete model for a provider at the given tier. OpenAI uses the
 * caller-supplied (env-aware) model; everyone else maps through MODEL_DEFAULTS.
 */
function modelFor(provider: Provider, input: OraModelRouteInput): string {
  if (provider === "openai") return input.openaiModel;
  const mode = tierToAgentMode(input.tier, normalizeOraPlanTier(input.subscriptionTier));
  return MODEL_DEFAULTS[provider][mode];
}

/**
 * Build the ordered candidate list for an Ora conversational message.
 *
 * Guarantees:
 *  - Only configured/reachable providers appear (availability filter).
 *  - OpenAI is always present as the final safety-net candidate.
 *  - Providers with an OPEN circuit are pushed to the back (deprioritized, not
 *    dropped — the breaker's own half-open probing still gets a chance, and a
 *    fully-degraded fleet still has *something* to try).
 *  - At least one candidate is always returned.
 */
export function selectOraModelRoute(input: OraModelRouteInput): ModelCandidate[] {
  const order = pickProviderOrder(input);

  // Filter to available specialist providers. OpenAI is appended once below.
  let providers = order.filter((p) => p !== "openai" && input.available[p]);

  // Deduplicate while preserving order (defensive — orderings are permutations).
  providers = providers.filter((p, i) => providers.indexOf(p) === i);

  // Stable partition: providers with a closed circuit first, open-circuit ones
  // last. Array.prototype.sort is stable in modern V8, so relative order within
  // each group is preserved.
  providers.sort((a, b) => {
    const aOpen = input.openCircuits.has(a) ? 1 : 0;
    const bOpen = input.openCircuits.has(b) ? 1 : 0;
    return aOpen - bOpen;
  });

  // Guarantee OpenAI is always reachable as the terminal safety net.
  providers.push("openai");

  return providers.map((provider) => ({ provider, model: modelFor(provider, input) }));
}

/** Outcome of a successful run through the candidate fallback chain. */
export interface CandidateChainResult<T> {
  /** The value returned by the attempt that succeeded. */
  result: T;
  /** The candidate (provider+model) that produced the successful result. */
  candidate: ModelCandidate;
  /** Zero-based index of the winning candidate in the chain. */
  index: number;
  /** True when the winner was not the first-choice provider (index > 0). */
  usedFallback: boolean;
}

/**
 * Iterate the ordered candidate chain, attempting each provider+model in turn
 * until one succeeds. This is the runtime half of the smart router: the caller
 * supplies an `attempt` callback (which wraps `createChatCompletion` for a given
 * candidate) and an optional `onError` hook for logging each failed attempt.
 *
 * Returns the first successful result along with which candidate produced it and
 * whether a fallback was used. If every candidate throws, the last error is
 * re-thrown so the caller can surface a single failure to the user.
 */
export async function runCandidateChain<T>(
  candidates: ModelCandidate[],
  attempt: (candidate: ModelCandidate, index: number) => Promise<T>,
  onError?: (candidate: ModelCandidate, index: number, err: unknown) => void,
): Promise<CandidateChainResult<T>> {
  let lastErr: unknown = null;
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    try {
      const result = await attempt(candidate, i);
      return { result, candidate, index: i, usedFallback: i > 0 };
    } catch (candidateErr) {
      lastErr = candidateErr;
      onError?.(candidate, i, candidateErr);
    }
  }
  throw lastErr ?? new Error("All Ora model candidates failed");
}
