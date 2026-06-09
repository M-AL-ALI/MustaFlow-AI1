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
 * guaranteed to appear in the chain as the final safety net, because it is the
 * only provider that is always configured.
 *
 * Scope guard: this only selects the model for Ora's *conversational* branch.
 * It does NOT touch the Builder pipeline, the web-search grounding path (which
 * requires a direct OpenAI Responses API call), image/vision routing, or any
 * user-facing model picker.
 */

import type { Provider } from "../ai-providers";
import { MODEL_DEFAULTS } from "../ai-providers";
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

export interface OraModelRouteInput {
  tier: OraRouteTier;
  topic: OraTopic;
  intent: OraIntent;
  confidence: OraConfidence;
  /** True when the user's message/locale is a non-English language. */
  multilingual: boolean;
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
 * Per-tier provider preference orderings. Each ordering is a full permutation
 * of the four providers so that, after availability filtering, we always have
 * a complete fallback chain.
 */
const FAST_ORDER: Provider[] = ["openai", "gemini", "deepseek", "anthropic"];
const PREMIUM_ORDER: Provider[] = ["openai", "anthropic", "gemini", "deepseek"];
const DEEP_ORDER: Provider[] = ["openai", "deepseek", "anthropic", "gemini"];
const TECHNICAL_ORDER: Provider[] = ["anthropic", "openai", "deepseek", "gemini"];
const MULTILINGUAL_ORDER: Provider[] = ["gemini", "openai", "anthropic", "deepseek"];

/**
 * Map a routing tier onto the existing agent-mode dial so non-OpenAI providers
 * pick a tier-appropriate model from MODEL_DEFAULTS.
 */
function tierToAgentMode(tier: OraRouteTier): "lite" | "power" | "pro" {
  if (tier === "deep") return "pro";
  if (tier === "fast") return "lite";
  return "power";
}

/**
 * Choose the provider preference ordering for this message. Precedence:
 *  1. Deep Thinking mode → reasoning-first ordering (explicit user intent).
 *  2. Non-English message → Gemini-first multilingual ordering.
 *  3. Technical topic → Anthropic-first ordering.
 *  4. Confident simple FAQ → fast/cheap ordering.
 *  5. Otherwise → premium default ordering.
 */
function pickProviderOrder(input: OraModelRouteInput): Provider[] {
  if (input.tier === "deep") return DEEP_ORDER;
  if (input.multilingual) return MULTILINGUAL_ORDER;
  if (input.topic === "technical") return TECHNICAL_ORDER;
  if (input.tier === "fast") return FAST_ORDER;
  return PREMIUM_ORDER;
}

/**
 * Resolve the concrete model for a provider at the given tier. OpenAI uses the
 * caller-supplied (env-aware) model; everyone else maps through MODEL_DEFAULTS.
 */
function modelFor(provider: Provider, input: OraModelRouteInput): string {
  if (provider === "openai") return input.openaiModel;
  const mode = tierToAgentMode(input.tier);
  return MODEL_DEFAULTS[provider][mode];
}

/**
 * Build the ordered candidate list for an Ora conversational message.
 *
 * Guarantees:
 *  - Only configured/reachable providers appear (availability filter).
 *  - OpenAI is always present as the final fallback (it is always configured).
 *  - Providers with an OPEN circuit are pushed to the back (deprioritized, not
 *    dropped — the breaker's own half-open probing still gets a chance, and a
 *    fully-degraded fleet still has *something* to try).
 *  - At least one candidate is always returned.
 */
export function selectOraModelRoute(input: OraModelRouteInput): ModelCandidate[] {
  const order = pickProviderOrder(input);

  // Filter to available providers, but always keep OpenAI as the safety net.
  let providers = order.filter((p) => input.available[p] || p === "openai");

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

  // Guarantee OpenAI is always reachable as the last resort.
  if (!providers.includes("openai")) providers.push("openai");

  return providers.map((provider) => ({ provider, model: modelFor(provider, input) }));
}
