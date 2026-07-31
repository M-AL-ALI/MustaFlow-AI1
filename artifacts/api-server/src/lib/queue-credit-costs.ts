import type { AgentMode } from "./ai";
import { creditCostFor, resolveStageProvider } from "./ai-providers";

export interface QueueCreditCostInput {
  taskCount: number;
  hasFiles: boolean;
  agentMode: AgentMode;
  deepReasoning: boolean;
}

/**
 * Calculates the batch preflight cost using the same stage-aware pricing as
 * queue drain. Empty projects build once then refine; existing projects refine
 * every queued task.
 */
export function estimateQueueCreditCost({
  taskCount,
  hasFiles,
  agentMode,
  deepReasoning,
}: QueueCreditCostInput): number {
  const { provider: buildProvider } = resolveStageProvider("build", agentMode);
  const { provider: refineProvider } = resolveStageProvider("refine", agentMode);
  const buildCost = creditCostFor(agentMode, buildProvider, deepReasoning);
  const refineCost = creditCostFor(agentMode, refineProvider, deepReasoning);

  return (hasFiles ? 0 : buildCost) + (taskCount - (hasFiles ? 0 : 1)) * refineCost;
}