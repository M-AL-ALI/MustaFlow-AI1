import type { ControlCoordinator, DurableOperationQueueMessage } from "./model";

export async function deferDurableOperationForWrongDeployment(input: {
  coordinator: Pick<ControlCoordinator, "recordDurableOperationDeploymentObservation">;
  message: DurableOperationQueueMessage;
  deploymentVersion: string;
  nowMs: number;
}): Promise<"continue" | "deferred" | "ignore"> {
  const observation = await input.coordinator.recordDurableOperationDeploymentObservation(
    input.message.jobKey,
    input.deploymentVersion,
    input.nowMs,
    input.message.deploymentDeferralCount,
  );
  if (observation === "matched") return "continue";
  if (observation === "not_found" || observation === "terminal") return "ignore";
  return "deferred";
}
