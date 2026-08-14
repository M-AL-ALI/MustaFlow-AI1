import type { ControlCoordinator, DurableOperationQueueMessage } from "./model";

export const DURABLE_OPERATION_DEPLOYMENT_RETRY_DELAY_SECONDS = 5;

export async function deferDurableOperationForWrongDeployment(input: {
  coordinator: Pick<ControlCoordinator, "recordDurableOperationDeploymentObservation">;
  message: DurableOperationQueueMessage;
  deploymentVersion: string;
  nowMs: number;
  requeue(message: DurableOperationQueueMessage, delaySeconds: number): Promise<void>;
}): Promise<"continue" | "deferred" | "ignore"> {
  const observation = await input.coordinator.recordDurableOperationDeploymentObservation(
    input.message.jobKey,
    input.deploymentVersion,
    input.nowMs,
  );
  if (observation === "matched") return "continue";
  if (observation === "not_found" || observation === "terminal") return "ignore";
  await input.requeue(input.message, DURABLE_OPERATION_DEPLOYMENT_RETRY_DELAY_SECONDS);
  return "deferred";
}
