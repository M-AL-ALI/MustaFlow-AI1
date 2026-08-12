import {
  AcceptanceVaultDurableObject,
  readAcceptanceVaultKek,
} from "./acceptance-vault-durable-object";
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

export const ACCEPTANCE_READINESS_PATH = "/_nabuflow/acceptance/v1/readyz";

function acceptanceVaultKekStatus(value: unknown): "absent" | "malformed" | "valid" {
  if (value === undefined) return "absent";
  if (typeof value !== "string") return "malformed";
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    bytes = readAcceptanceVaultKek(value);
    return "valid";
  } catch {
    return "malformed";
  } finally {
    bytes?.fill(0);
  }
}

function readinessResponse(env: AcceptanceProvisionerBindings): Response {
  const kek = acceptanceVaultKekStatus(
    (env as AcceptanceProvisionerBindings & { ACCEPTANCE_VAULT_KEK?: unknown })
      .ACCEPTANCE_VAULT_KEK,
  );
  return new Response(
    JSON.stringify({
      ready: true,
      gate: env.ACCEPTANCE_STAGING_ENABLED === "true" ? "enabled" : "disabled",
      kek,
    }),
    { status: 200, headers: { "content-type": "application/json; charset=utf-8" } },
  );
}

export default {
  async fetch(request: Request, env: AcceptanceProvisionerBindings): Promise<Response> {
    if (request.method === "GET" && new URL(request.url).pathname === ACCEPTANCE_READINESS_PATH) {
      return readinessResponse(env);
    }
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
