import {
  CAPABILITY_INTENT_PATH as CONTRACT_CAPABILITY_INTENT_PATH,
  capabilitySuccessResponseSchema,
  capabilityIntentSchema,
  capabilityInvocationSchema,
  controlErrorResponseSchema,
  parseRuntimeIdentityForNamespace,
  sha256Hex,
  signControlRequest,
  verifyControlRequestSignature,
  type CapabilityIntent,
  type CapabilityInvocation,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import type { ControlDurableObject } from "./control-durable-object";
import type { CapabilityVault, ControlCoordinator, StoredHttpResponse } from "./model";

export const CAPABILITY_ENDPOINT = "/_nabuflow/capability/v1/invoke";
export const CAPABILITY_INTENT_PATH = CONTRACT_CAPABILITY_INTENT_PATH;
const MAX_CAPABILITY_BYTES = 64 * 1024;
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const AUTH_HEADERS = {
  timestamp: "x-nabuflow-timestamp",
  nonce: "x-nabuflow-nonce",
  bodySha256: "x-nabuflow-body-sha256",
  signature: "x-nabuflow-signature",
  idempotencyKey: "idempotency-key",
} as const;

interface CapabilityDependencies {
  coordinator?: ControlCoordinator;
  vault?: CapabilityVault;
  nowMs?: number;
  requestId?: string;
}

class CapabilityHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly databaseSqlstate: string | null = null,
  ) {
    super(message);
  }
}

class CapabilityBodyTooLargeError extends Error {}

function getCoordinator(env: WorkerBindings): DurableObjectStub<ControlDurableObject> {
  return env.CONTROL_COORDINATOR.get(env.CONTROL_COORDINATOR.idFromName("control-v1"));
}

function getVault(
  env: WorkerBindings,
  projectId: number,
): DurableObjectStub<CapabilityVaultDurableObject> {
  return env.CAPABILITY_VAULT.get(env.CAPABILITY_VAULT.idFromName(`project:${projectId}`));
}

function expectedContainerId(env: WorkerBindings, identity: string): string {
  return env.NABUFLOW_SANDBOX.idFromName(identity).toString();
}

function isUpgrade(request: Request): boolean {
  return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

async function readBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_CAPABILITY_BYTES) {
    throw new CapabilityBodyTooLargeError();
  }
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_CAPABILITY_BYTES) {
      await reader.cancel();
      throw new CapabilityBodyTooLargeError();
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function readSignedRequest(request: Request, body: Uint8Array) {
  const timestamp = request.headers.get(AUTH_HEADERS.timestamp);
  const nonce = request.headers.get(AUTH_HEADERS.nonce);
  const bodySha256 = request.headers.get(AUTH_HEADERS.bodySha256);
  const signature = request.headers.get(AUTH_HEADERS.signature);
  if (timestamp === null || nonce === null || bodySha256 === null || signature === null) {
    return null;
  }
  return {
    method: request.method,
    pathAndQuery: CAPABILITY_ENDPOINT,
    timestamp,
    nonce,
    bodySha256,
    signature,
    idempotencyKey: request.headers.get(AUTH_HEADERS.idempotencyKey) ?? "",
    body,
  };
}

function parseInvocation(body: Uint8Array): CapabilityInvocation {
  try {
    return capabilityInvocationSchema.parse(JSON.parse(textDecoder.decode(body)));
  } catch {
    throw new CapabilityHttpError(
      400,
      "invalid_capability_request",
      "Capability request failed strict validation",
    );
  }
}

function errorBody(error: CapabilityHttpError, requestId: string): unknown {
  return controlErrorResponseSchema.parse({
    ok: false,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    requestId,
  });
}

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}): Response {
  const responseHeaders = new Headers({
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
  });
  new Headers(headers).forEach((value, key) => responseHeaders.set(key, value));
  return Response.json(body, {
    status,
    headers: responseHeaders,
  });
}

function errorResponse(error: CapabilityHttpError, requestId: string): Response {
  return jsonResponse(error.status, errorBody(error, requestId));
}

async function audit(
  coordinator: ControlCoordinator,
  requestId: string,
  outcome: string,
  status: number,
  projectId: number | null,
  stage: string | null = null,
  databaseSqlstate: string | null = null,
): Promise<void> {
  await coordinator.recordAudit({
    requestId,
    timestamp: new Date().toISOString(),
    method: "POST",
    endpoint: "capabilityInvoke",
    stage,
    outcome,
    projectId,
    role: null,
    slot: null,
    status,
    ...(databaseSqlstate === null ? {} : { databaseSqlstate }),
  });
}

async function validateCaller(
  invocation: CapabilityInvocation,
  env: WorkerBindings,
  coordinator: ControlCoordinator,
): Promise<{ projectId: number }> {
  const boundIdentity = await coordinator.getContainerBinding(invocation.caller.containerId);
  if (boundIdentity === null) {
    throw new CapabilityHttpError(
      403,
      "capability_runtime_unbound",
      "The runtime is not authorized to invoke capabilities",
    );
  }
  if (boundIdentity !== invocation.caller.runtimeIdentity) {
    throw new CapabilityHttpError(
      403,
      "capability_tenant_mismatch",
      "The requested capability scope does not match the caller",
    );
  }
  const identity = await parseRuntimeIdentityForNamespace(
    boundIdentity,
    env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
  ).catch(() => null);
  if (
    identity === null ||
    expectedContainerId(env, boundIdentity) !== invocation.caller.containerId
  ) {
    throw new CapabilityHttpError(
      403,
      "capability_runtime_unbound",
      "The runtime is not authorized to invoke capabilities",
    );
  }
  const runtime = await coordinator.getRuntime(boundIdentity);
  if (
    runtime === null ||
    runtime.descriptor.status !== "running" ||
    runtime.descriptor.identity !== boundIdentity ||
    runtime.descriptor.projectId !== identity.projectId ||
    runtime.descriptor.role !== identity.role ||
    runtime.descriptor.slot !== identity.slot
  ) {
    throw new CapabilityHttpError(
      403,
      "capability_runtime_inactive",
      "The runtime is not authorized to invoke capabilities",
    );
  }
  return { projectId: identity.projectId };
}

export async function handleCapabilityRequest(
  request: Request,
  env: WorkerBindings,
  dependencies: CapabilityDependencies = {},
): Promise<Response> {
  const coordinator = dependencies.coordinator ?? getCoordinator(env);
  const boundaryRequestId = dependencies.requestId ?? crypto.randomUUID();
  const nowMs = dependencies.nowMs ?? Date.now();
  let auditRequestId = boundaryRequestId;
  let auditProjectId: number | null = null;
  let ownedIdempotency: { key: string; fingerprint: string } | null = null;

  try {
    const url = new URL(request.url);
    if (url.pathname !== CAPABILITY_ENDPOINT || url.search) {
      throw new CapabilityHttpError(
        404,
        "capability_endpoint_not_found",
        "Capability endpoint not found",
      );
    }
    if (isUpgrade(request)) {
      throw new CapabilityHttpError(
        426,
        "capability_upgrade_not_supported",
        "Capability requests do not support protocol upgrades",
      );
    }
    if (request.method !== "POST") {
      throw new CapabilityHttpError(405, "method_not_allowed", "Capability method is not allowed");
    }
    const rawBody = await readBody(request);
    const signed = readSignedRequest(request, rawBody);
    if (signed === null) {
      throw new CapabilityHttpError(401, "unauthorized", "A signed capability request is required");
    }
    const verification = await verifyControlRequestSignature(
      env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN,
      signed,
      coordinator,
      { nowMs, maxClockSkewMs: 60_000 },
    );
    if (!verification.ok) {
      if (verification.reason === "replay") {
        throw new CapabilityHttpError(
          409,
          "replay_detected",
          "This signed request was already used",
        );
      }
      if (verification.reason === "clock-skew") {
        throw new CapabilityHttpError(
          401,
          "expired_signature",
          "The capability signature is expired",
        );
      }
      throw new CapabilityHttpError(
        401,
        "invalid_signature",
        "The capability signature is invalid",
      );
    }

    const invocation = parseInvocation(rawBody);
    auditRequestId = invocation.requestId;
    if (signed.idempotencyKey !== invocation.requestId) {
      throw new CapabilityHttpError(
        400,
        "capability_idempotency_mismatch",
        "Capability idempotency key must match its request ID",
      );
    }
    const caller = await validateCaller(invocation, env, coordinator);
    auditProjectId = caller.projectId;
    if (
      invocation.requestedProjectId !== undefined &&
      invocation.requestedProjectId !== caller.projectId
    ) {
      throw new CapabilityHttpError(
        403,
        "capability_tenant_mismatch",
        "The requested capability scope does not match the caller",
      );
    }
    const fingerprint = await sha256Hex(
      `${request.method}\n${CAPABILITY_ENDPOINT}\n${signed.bodySha256}`,
    );
    const idempotencyKey = `capability:${caller.projectId}:${invocation.requestId}`;
    const lookup = await coordinator.beginIdempotency(idempotencyKey, fingerprint, nowMs);
    if (lookup.state === "replay") {
      await audit(
        coordinator,
        auditRequestId,
        "capability_idempotency_replay",
        lookup.response.status,
        caller.projectId,
      );
      return jsonResponse(lookup.response.status, lookup.response.body);
    }
    if (lookup.state === "pending" || lookup.state === "conflict") {
      throw new CapabilityHttpError(
        409,
        lookup.state === "pending"
          ? "capability_request_in_progress"
          : "capability_idempotency_conflict",
        "The capability request cannot be executed with this idempotency key",
        lookup.state === "pending",
      );
    }
    ownedIdempotency = { key: idempotencyKey, fingerprint };

    const vault = dependencies.vault ?? getVault(env, caller.projectId);
    const result =
      invocation.capability.provider === "nabuflow-harness" && invocation.capability.name === "echo"
        ? await vault.invokeEcho({ projectId: caller.projectId, invocation })
        : invocation.capability.provider === "neon-postgres" &&
            invocation.capability.name === "database"
          ? await vault.invokeDatabase({ projectId: caller.projectId, invocation })
          : invocation.capability.provider === "stripe" && invocation.capability.name === "payments"
            ? await vault.invokeStripe({ projectId: caller.projectId, invocation })
            : { state: "not_found" as const };
    let response: StoredHttpResponse;
    if (result.state === "success") {
      response = { status: 200, body: capabilitySuccessResponseSchema.parse(result.response) };
    } else if (result.state === "tenant_mismatch") {
      throw new CapabilityHttpError(
        403,
        "capability_tenant_mismatch",
        "The requested capability scope does not match the caller",
      );
    } else if (result.state === "policy_rejected") {
      throw new CapabilityHttpError(
        403,
        "capability_policy_rejected",
        "The capability action is not allowed",
      );
    } else if (result.state === "database_error") {
      const sqlstate =
        result.sqlstate !== null && /^[0-9A-Z]{5}$/u.test(result.sqlstate) ? result.sqlstate : null;
      if (sqlstate !== null) {
        // SQLSTATE is the sole approved database diagnostic field. Raw driver
        // errors, SQL text, schema names, hosts, and credentials stay excluded.
        // eslint-disable-next-line no-console
        console.warn(
          JSON.stringify({
            event: "database_broker_error",
            requestId: auditRequestId,
            projectId: caller.projectId,
            sqlstate,
          }),
        );
      }
      throw new CapabilityHttpError(
        result.status,
        result.code,
        "The database operation could not be completed",
        result.retryable,
        sqlstate,
      );
    } else if (result.state === "stripe_error") {
      throw new CapabilityHttpError(
        result.status,
        result.code,
        "The payment operation could not be completed",
        result.retryable,
      );
    } else {
      throw new CapabilityHttpError(404, "capability_not_available", "Capability is not available");
    }
    await coordinator.completeIdempotency(idempotencyKey, fingerprint, response, nowMs);
    ownedIdempotency = null;
    await audit(
      coordinator,
      auditRequestId,
      "capability_invoked",
      response.status,
      caller.projectId,
    );
    return jsonResponse(response.status, response.body);
  } catch (error) {
    const capabilityError =
      error instanceof CapabilityBodyTooLargeError
        ? new CapabilityHttpError(
            413,
            "capability_request_too_large",
            "Capability request is too large",
          )
        : error instanceof CapabilityHttpError
          ? error
          : new CapabilityHttpError(
              503,
              "capability_service_unavailable",
              "The capability service is temporarily unavailable",
              true,
            );
    if (ownedIdempotency !== null) {
      if (capabilityError.status >= 500) {
        await coordinator.abandonIdempotency(ownedIdempotency.key, ownedIdempotency.fingerprint);
      } else {
        await coordinator.completeIdempotency(
          ownedIdempotency.key,
          ownedIdempotency.fingerprint,
          {
            status: capabilityError.status,
            body: errorBody(capabilityError, auditRequestId),
          },
          nowMs,
        );
      }
    }
    await audit(
      coordinator,
      auditRequestId,
      capabilityError.code,
      capabilityError.status,
      auditProjectId,
      "capability_request",
      capabilityError.databaseSqlstate,
    );
    return errorResponse(capabilityError, auditRequestId);
  }
}

export async function handleCapabilityIntentFromContainer(
  request: Request,
  env: WorkerBindings,
  containerId: string,
  dependencies: CapabilityDependencies = {},
): Promise<Response> {
  const coordinator = dependencies.coordinator ?? getCoordinator(env);
  const requestId = dependencies.requestId ?? crypto.randomUUID();
  const nowMs = dependencies.nowMs ?? Date.now();
  try {
    const url = new URL(request.url);
    if (url.pathname !== CAPABILITY_INTENT_PATH || url.search) {
      throw new CapabilityHttpError(
        404,
        "capability_intent_not_found",
        "Capability intent endpoint not found",
      );
    }
    if (isUpgrade(request)) {
      throw new CapabilityHttpError(
        426,
        "capability_upgrade_not_supported",
        "Capability requests do not support protocol upgrades",
      );
    }
    if (request.method !== "POST") {
      throw new CapabilityHttpError(405, "method_not_allowed", "Capability method is not allowed");
    }
    const body = await readBody(request);
    let intent: CapabilityIntent;
    try {
      intent = capabilityIntentSchema.parse(JSON.parse(textDecoder.decode(body)));
    } catch {
      throw new CapabilityHttpError(
        400,
        "invalid_capability_intent",
        "Capability intent failed strict validation",
      );
    }
    const runtimeIdentity = await coordinator.getContainerBinding(containerId);
    if (runtimeIdentity === null) {
      throw new CapabilityHttpError(
        403,
        "capability_runtime_unbound",
        "The runtime is not authorized to invoke capabilities",
      );
    }
    const invocation = capabilityInvocationSchema.parse({
      ...intent,
      caller: { containerId, runtimeIdentity },
    });
    const serialized = JSON.stringify(invocation);
    const timestamp = String(nowMs);
    const nonce = `capability-${crypto.randomUUID()}`;
    const bodySha256 = await sha256Hex(serialized);
    const fields = {
      method: "POST",
      pathAndQuery: CAPABILITY_ENDPOINT,
      timestamp,
      nonce,
      bodySha256,
      idempotencyKey: invocation.requestId,
    };
    const signature = await signControlRequest(env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN, fields);
    return handleCapabilityRequest(
      new Request(`https://capability.worker.internal${CAPABILITY_ENDPOINT}`, {
        method: "POST",
        body: serialized,
        headers: {
          "content-type": "application/json",
          [AUTH_HEADERS.timestamp]: timestamp,
          [AUTH_HEADERS.nonce]: nonce,
          [AUTH_HEADERS.bodySha256]: bodySha256,
          [AUTH_HEADERS.signature]: signature,
          [AUTH_HEADERS.idempotencyKey]: invocation.requestId,
        },
      }),
      env,
      {
        coordinator,
        vault: dependencies.vault,
        nowMs,
        requestId: invocation.requestId,
      },
    );
  } catch (error) {
    const capabilityError =
      error instanceof CapabilityBodyTooLargeError
        ? new CapabilityHttpError(
            413,
            "capability_request_too_large",
            "Capability request is too large",
          )
        : error instanceof CapabilityHttpError
          ? error
          : new CapabilityHttpError(
              503,
              "capability_service_unavailable",
              "The capability service is temporarily unavailable",
              true,
            );
    await audit(
      coordinator,
      requestId,
      capabilityError.code,
      capabilityError.status,
      null,
      "capability_intent",
    );
    return errorResponse(capabilityError, requestId);
  }
}
