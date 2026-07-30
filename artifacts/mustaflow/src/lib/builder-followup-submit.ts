import { useState, useEffect } from "react";
import { authFetch } from "@/lib/api-fetch";

export type BuilderComposerIntent =
  | "converse"
  | "plan"
  | "build"
  | "debug"
  | "refactor"
  | "review"
  | "explain"
  | "fix_tests"
  | "fix_types"
  | "fix_lint";

type LocalComposerIntent = "converse" | "plan" | "build" | null;

export type BuilderSendIntentOptions = {
  planMode?: true;
  agentIntent?: BuilderComposerIntent;
};

// ─── Credit cost types ────────────────────────────────────────────────────────

export type BuilderCreditCosts = {
  standard: { lite: number; eco: number; power: number; pro: number };
  deep: { eco: number; power: number; pro: number };
};

/**
 * Static fallback matching server ai-providers.ts BASE_COST /
 * DEEP_REASONING_CREDIT_COST. Used while the async fetch is in flight and as
 * the source of truth for non-React call sites.
 */
export const DEFAULT_BUILDER_CREDIT_COSTS: BuilderCreditCosts = {
  standard: { lite: 13, eco: 34, power: 160, pro: 475 },
  deep: { eco: 60, power: 290, pro: 850 },
};

/**
 * Kept for the `BuilderAgentMode` type derivation in builder-mode-icon.tsx.
 * Values are current (match server); prefer useBuilderCreditCosts() in
 * React components so the UI always reflects the live server table.
 */
export const BUILDER_CREDIT_COST = {
  lite: 13,
  eco: 34,
  power: 160,
  pro: 475,
} as const;

export const DEEP_BUILDER_CREDIT_COST = {
  eco: 60,
  power: 290,
  pro: 850,
} as const;

/** Pure helper — use inside useMemo / callbacks where a hook can't be called. */
export function getCreditCost(
  costs: BuilderCreditCosts,
  mode: keyof BuilderCreditCosts["standard"],
  deepReasoning = false,
): number {
  if (deepReasoning && mode !== "lite") {
    return costs.deep[mode as keyof BuilderCreditCosts["deep"]] ?? costs.standard[mode];
  }
  return costs.standard[mode];
}

/** Static version kept for back-compat; prefer getCreditCost() + hook. */
export function builderCreditCost(
  mode: keyof typeof BUILDER_CREDIT_COST,
  deepReasoning = false,
): number {
  return getCreditCost(DEFAULT_BUILDER_CREDIT_COSTS, mode, deepReasoning);
}

/**
 * React hook — fetches the live builder credit cost table from the server.
 * Falls back to DEFAULT_BUILDER_CREDIT_COSTS while loading or on error so
 * the UI is never blank.
 */
export function useBuilderCreditCosts(): BuilderCreditCosts {
  const [costs, setCosts] = useState<BuilderCreditCosts>(DEFAULT_BUILDER_CREDIT_COSTS);
  useEffect(() => {
    authFetch("/api/billing/nabuflow/credit-costs")
      .then((r) => (r.ok ? (r.json() as Promise<BuilderCreditCosts>) : null))
      .then((data) => {
        if (data?.standard && data?.deep) setCosts(data);
      })
      .catch(() => {
        /* keep default */
      });
  }, []);
  return costs;
}

/**
 * Converts the composer's resolved intent into the options consumed by the
 * workspace send pipeline. Keeping this mapping outside the page prevents a
 * valid intent from silently falling through to the streaming classifier.
 */
export function mapIntentToSendOptions({
  intent,
  hasImages,
}: {
  intent: BuilderComposerIntent | undefined;
  hasImages: boolean;
}): BuilderSendIntentOptions {
  if (hasImages) return { agentIntent: "build" };
  if (!intent) return {};
  if (intent === "plan") return { planMode: true, agentIntent: "plan" };
  return { agentIntent: intent };
}

/**
 * A completed Builder task turns the next Main Agent-routed message into a
 * refine build unless the prompt is explicitly conversational or planning.
 * This bypasses the streaming-classifier fallback and goes directly through
 * the task-creating messages mutation.
 */
export function resolveBuilderComposerIntent({
  activeIntent,
  localIntent,
  hasCompletedTask,
  routingAgentIdentity,
}: {
  activeIntent: BuilderComposerIntent | null;
  localIntent: LocalComposerIntent;
  hasCompletedTask: boolean;
  routingAgentIdentity?: string | null;
}): BuilderComposerIntent | undefined {
  if (activeIntent) return activeIntent;
  if (localIntent === "converse" || localIntent === "plan" || localIntent === "build") {
    return localIntent;
  }
  if (hasCompletedTask && routingAgentIdentity !== "planning") return "build";
  return undefined;
}
