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
