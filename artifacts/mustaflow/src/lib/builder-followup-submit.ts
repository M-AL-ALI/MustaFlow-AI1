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
 * Stage-keyed credit cost response from the server.
 * `build` costs apply when AI_PROVIDER_BUILD is active;
 * `refine` costs apply when AI_PROVIDER_REFINE is active (may differ).
 */
export type BuilderCreditCostsByStage = {
  build: BuilderCreditCosts;
  refine: BuilderCreditCosts;
};

const DEFAULT_BUILDER_CREDIT_COSTS_BY_STAGE: BuilderCreditCostsByStage = {
  build: DEFAULT_BUILDER_CREDIT_COSTS,
  refine: DEFAULT_BUILDER_CREDIT_COSTS,
};

/**
 * React hook — fetches live builder credit cost tables keyed by stage from the
 * server. Falls back to default OpenAI pricing for both stages while loading
 * or on error so the UI is never blank.
 *
 * `build` costs apply to initial/full builds (AI_PROVIDER_BUILD).
 * `refine` costs apply to refine requests (AI_PROVIDER_REFINE).
 *
 * UI surfaces that cannot determine the stage at display time should use
 * `build` costs (the common initial-build path).
 */
export function useBuilderCreditCostsByStage(): BuilderCreditCostsByStage {
  const [costs, setCosts] = useState<BuilderCreditCostsByStage>(
    DEFAULT_BUILDER_CREDIT_COSTS_BY_STAGE,
  );
  useEffect(() => {
    authFetch("/api/billing/nabuflow/credit-costs")
      .then((r) => (r.ok ? (r.json() as Promise<BuilderCreditCostsByStage>) : null))
      .then((data) => {
        if (data?.build?.standard && data?.build?.deep && data?.refine?.standard) {
          setCosts(data);
        }
      })
      .catch(() => {
        /* keep default */
      });
  }, []);
  return costs;
}

/**
 * React hook — fetches the live builder credit cost table from the server for
 * the **build** stage (AI_PROVIDER_BUILD). Falls back to DEFAULT_BUILDER_CREDIT_COSTS
 * while loading or on error.
 *
 * For components that need both build and refine costs, use
 * `useBuilderCreditCostsByStage()` instead.
 */
export function useBuilderCreditCosts(): BuilderCreditCosts {
  const { build } = useBuilderCreditCostsByStage();
  return build;
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
  if (hasCompletedTask && routingAgentIdentity === "main") return "build";
  return undefined;
}
