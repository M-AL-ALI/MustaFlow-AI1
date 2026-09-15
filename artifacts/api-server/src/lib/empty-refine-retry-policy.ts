interface EmptyRefineRetryInput {
  usesAgentLoop: boolean;
  specializedStaticProject: boolean;
  userPrompt: string;
  changedFilesCount: number;
  removedPathsCount: number;
}

/**
 * The agent loop already owns its bounded generation and validation attempts.
 * An empty diff is also valid for a build/validation-only request. Do not start
 * another loop, reset its budget, or force an unrelated edit from a build verb.
 * Keep the existing single-retry policy for the separate legacy pipelines.
 */
export function shouldRetryEmptyRefine(input: EmptyRefineRetryInput): boolean {
  if (input.usesAgentLoop && !input.specializedStaticProject) return false;
  if (input.changedFilesCount !== 0 || input.removedPathsCount !== 0) return false;

  const buildVerb =
    /\b(add|remove|delete|create|build|make|generate|change|update|modify|fix|refactor|implement|set\s*up|setup|install|integrate|wire|connect|enable|disable|hide|show|render|style|design|move|rename|replace|swap|upgrade|migrate|extract|split|merge)\b/i;
  const question =
    /^\s*(what|how|why|when|where|who|which|can\s+you\s+explain|could\s+you\s+explain|do\s+you|does\s+it|is\s+there|are\s+there|tell\s+me|explain)\b/i;
  return (
    buildVerb.test(input.userPrompt) &&
    !question.test(input.userPrompt) &&
    !/\?\s*$/.test(input.userPrompt)
  );
}
