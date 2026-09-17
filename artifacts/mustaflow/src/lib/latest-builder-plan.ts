import { hasUsableZeroPlan } from "@workspace/ora-contracts";
import type { StructuredPlan } from "@/pages/projects/components/plan-card";

type PlanMessage = {
  id: string | number;
  role?: string;
  planMode?: boolean | null;
  plan?: unknown;
};

export function latestBuilderPlan(
  messages: readonly PlanMessage[] | null | undefined,
): { plan: StructuredPlan | null; messageId: string | number } | null {
  if (!messages) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant" || !message.planMode) continue;
    const payload = message.plan;
    const kind =
      payload && typeof payload === "object" ? (payload as { kind?: unknown }).kind : undefined;
    if (kind === "report" || kind === "converse" || kind === "task-queued") continue;
    // A failed/empty newer attempt must not silently revive an older plan.
    return { messageId: message.id, plan: hasUsableZeroPlan(payload) ? payload : null };
  }
  return null;
}
