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

export function shouldDeferComposerClearForCreditGate({
  agentMode,
  deepReasoning = false,
  isLikelyConverse,
  creditConfirmed,
}: {
  agentMode: string;
  deepReasoning?: boolean;
  isLikelyConverse: boolean;
  creditConfirmed: boolean;
}): boolean {
  return (
    (deepReasoning || agentMode === "power" || agentMode === "pro") &&
    !isLikelyConverse &&
    !creditConfirmed
  );
}

export const BUILDER_CREDIT_COST = {
  lite: 1,
  eco: 2,
  power: 5,
  pro: 10,
} as const;

export const DEEP_BUILDER_CREDIT_COST = {
  eco: 3,
  power: 7,
  pro: 13,
} as const;

export function builderCreditCost(
  mode: keyof typeof BUILDER_CREDIT_COST,
  deepReasoning = false,
): number {
  if (deepReasoning && mode !== "lite") return DEEP_BUILDER_CREDIT_COST[mode];
  return BUILDER_CREDIT_COST[mode];
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
