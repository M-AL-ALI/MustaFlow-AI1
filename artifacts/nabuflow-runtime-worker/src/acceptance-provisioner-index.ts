import { AcceptanceVaultDurableObject } from "./acceptance-vault-durable-object";
import type {
  AcceptanceProvisionerBindings,
  AcceptanceQueueMessage,
} from "./acceptance-provisioner-model";
import {
  AcceptanceProvisionerService,
  handleAcceptanceQueue,
  handleAcceptanceScheduled,
} from "./acceptance-provisioner-worker";
import { ControlDurableObject } from "./control-durable-object";

export { AcceptanceVaultDurableObject, ControlDurableObject };

export default {
  async fetch(request: Request, env: AcceptanceProvisionerBindings): Promise<Response> {
    try {
      return await new AcceptanceProvisionerService(env).handle(request);
    } catch {
      return new Response(
        JSON.stringify({
          ok: false,
          code: "acceptance_internal_error",
          message: "The staging acceptance operation could not be completed",
          retryable: false,
          requestId: crypto.randomUUID(),
        }),
        { status: 500, headers: { "content-type": "application/json; charset=utf-8" } },
      );
    }
  },
  queue(batch, env): Promise<void> {
    return handleAcceptanceQueue(batch, env);
  },
  scheduled(_controller, env): Promise<void> {
    return handleAcceptanceScheduled(env);
  },
} satisfies ExportedHandler<AcceptanceProvisionerBindings, AcceptanceQueueMessage>;
