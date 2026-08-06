import type { WorkerBindings } from "./bindings";
import { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import { ControlDurableObject } from "./control-durable-object";
import { ContainerProxy as NabuflowContainerProxy, NabuflowSandbox } from "./runtime-backend";
import { handleWorkerRequest } from "./worker";

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
} satisfies ExportedHandler<WorkerBindings>;
