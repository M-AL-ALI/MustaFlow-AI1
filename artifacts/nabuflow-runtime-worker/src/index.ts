import { ContainerProxy } from "@cloudflare/sandbox";
import type { WorkerBindings } from "./bindings";
import { ControlDurableObject } from "./control-durable-object";
import { NabuflowSandbox } from "./runtime-backend";
import { handleWorkerRequest } from "./worker";

export { ContainerProxy, ControlDurableObject, NabuflowSandbox };

export default {
  fetch(request: Request, env: WorkerBindings): Promise<Response> {
    return handleWorkerRequest(request, env);
  },
} satisfies ExportedHandler<WorkerBindings>;
