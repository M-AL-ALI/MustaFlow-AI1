import type { TrustedBuildQueueMessage, TrustedBuildWorkerBindings } from "./trusted-build-model";
import { TrustedBuildDurableObject } from "./trusted-build-durable-object";
import { TrustedBuildContainerProxy, TrustedBuildSandbox } from "./trusted-build-cell";
import { handleTrustedBuildQueue, handleTrustedBuildWorkerRequest } from "./trusted-build-worker";

export {
  TrustedBuildContainerProxy as ContainerProxy,
  TrustedBuildDurableObject,
  TrustedBuildSandbox,
};

export default {
  fetch(request: Request, env: TrustedBuildWorkerBindings): Promise<Response> {
    return handleTrustedBuildWorkerRequest(request, env);
  },
  queue(batch, env): Promise<void> {
    return handleTrustedBuildQueue(batch, env);
  },
} satisfies ExportedHandler<TrustedBuildWorkerBindings, TrustedBuildQueueMessage>;
