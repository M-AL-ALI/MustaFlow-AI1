import {
  NABUFLOW_BUILD_MODE_COSTS,
  NABUFLOW_PLAN_IDS,
  NABUFLOW_PLANS,
  type NabuflowPlanConfig,
} from "./nabuflow-plans";

export function publicNabuflowPlanShape(plan: NabuflowPlanConfig) {
  return {
    id: plan.id,
    name: plan.name,
    available: plan.available,
    priceUsd: plan.priceUsd,
    includedMonthlyCredits: plan.includedMonthlyCredits,
    overageUsdPerCredit: plan.overageUsdPerCredit,
    rolloverCycles: plan.rolloverCycles,
    rolloverMaxCredits: plan.rolloverMaxCredits,
    parallelBuildLimit: plan.parallelBuildLimit,
    queuePriority: plan.queuePriority,
    defaultSpendCapUsdCents: Math.round(plan.defaultSpendCapUsd * 100),
    maxSpendCapUsdCents: Math.round(plan.maxSpendCapUsd * 100),
    ladder: {
      proBuildsPerCycle: plan.ladder.proBuildsPerCycle,
      deepBuildsPerCycle: plan.ladder.deepBuildsPerCycle,
      proDeepCombo: plan.ladder.proDeepCombo,
    },
  };
}

/** One public catalog for both anonymous pricing and authenticated consumers. */
export async function publicNabuflowPlanCatalog() {
  const { creditCostFor, resolveStageProvider } = await import("./ai-providers");

  function resolvedModeCosts(stage: "build" | "refine") {
    const { provider } = resolveStageProvider(stage, "power");
    return NABUFLOW_BUILD_MODE_COSTS.map((entry) => ({
      ...entry,
      credits: creditCostFor(
        entry.mode.toLowerCase() as Parameters<typeof creditCostFor>[0],
        provider,
      ),
    }));
  }

  return {
    plans: NABUFLOW_PLAN_IDS.map((id) => publicNabuflowPlanShape(NABUFLOW_PLANS[id])),
    modeCosts: {
      build: resolvedModeCosts("build"),
      refine: resolvedModeCosts("refine"),
    },
  };
}
