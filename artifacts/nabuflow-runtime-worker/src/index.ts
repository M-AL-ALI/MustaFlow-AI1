import type { WorkerBindings } from "./bindings";
import type { DurableOperationQueueMessage } from "./model";
import { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import { ControlDurableObject } from "./control-durable-object";
import { ContainerProxy as NabuflowContainerProxy, NabuflowSandbox } from "./runtime-backend";
import { handleDurableOperationQueue, handleWorkerRequest } from "./worker";

export {
  CapabilityVaultDurableObject,
  NabuflowContainerProxy as ContainerProxy,
  ControlDurableObject,
  NabuflowSandbox,
};

export default {
  fetch(request: Request, env: WorkerBindings): Promise<Response> {
    return handleWorkerRequest(request, env);
  },
  queue(batch, env): Promise<void> {
    return handleDurableOperationQueue(batch, env);
  },
} satisfies ExportedHandler<WorkerBindings, DurableOperationQueueMessage>;
