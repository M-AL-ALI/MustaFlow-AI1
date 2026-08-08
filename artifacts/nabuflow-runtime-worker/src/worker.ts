import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_FEATURES,
  MAX_RUNTIME_ARTIFACT_BYTES,
  MAX_RUNTIME_ARTIFACT_FILE_BYTES,
  MAX_RUNTIME_ARTIFACT_FILES,
  MAX_RUNTIME_ARTIFACT_MANIFEST_BYTES,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_PENDING_TTL_MS,
  RUNTIME_ROLES,
  activateRouteRequestSchema,
  activateRouteResponseSchema,
  capabilityProvisionResponseSchema,
  capabilityRevokeResponseSchema,
  capabilityBindingResponseSchema,
  beginRuntimeArtifactRequestSchema,
  beginRuntimeArtifactResponseSchema,
  commitRuntimeArtifactRequestSchema,
  commitRuntimeArtifactResponseSchema,
  controlErrorResponseSchema,
  deactivateRouteRequestSchema,
  deactivateRouteResponseSchema,
  deriveRuntimeIdentity,
  destroyRuntimeRequestSchema,
  destroyRuntimeResponseSchema,
  ensureRuntimeRequestSchema,
  ensureRuntimeResponseSchema,
  execRuntimeRequestSchema,
  execRuntimeResponseSchema,
  logsRuntimeRequestSchema,
  logsRuntimeResponseSchema,
  parseRuntimeIdentityForNamespace,
  removeRuntimeArtifactRequestSchema,
  removeRuntimeArtifactResponseSchema,
  provisionDatabaseCapabilityRequestSchema,
  provisionEchoCapabilityRequestSchema,
  provisionStripeCapabilityRequestSchema,
  revokeDatabaseCapabilityRequestSchema,
  revokeEchoCapabilityRequestSchema,
  revokeStripeCapabilityRequestSchema,
  sha256Hex,
  startRuntimeRequestSchema,
  startRuntimeResponseSchema,
  statusRuntimeRequestSchema,
  statusRuntimeResponseSchema,
  stopRuntimeRequestSchema,
  stopRuntimeResponseSchema,
  verifyControlRequestSignature,
  verifyRuntimeArtifactEnvelope,
  versionResponseSchema,
  updateRuntimeManifestRequestSchema,
  uploadRuntimeArtifactChunkResponseSchema,
} from "@workspace/tenant-runtime-contracts";
import type {
  ActivateRouteRequest,
  BeginRuntimeArtifactRequest,
  CommitRuntimeArtifactRequest,
  ProvisionDatabaseCapabilityRequest,
  ProvisionEchoCapabilityRequest,
  ProvisionStripeCapabilityRequest,
  RevokeDatabaseCapabilityRequest,
  RevokeEchoCapabilityRequest,
  RevokeStripeCapabilityRequest,
  DeactivateRouteRequest,
  DestroyRuntimeRequest,
  EnsureRuntimeRequest,
  ExecRuntimeRequest,
  LogsRuntimeRequest,
  RuntimeLocator,
  RemoveRuntimeArtifactRequest,
  StartRuntimeRequest,
  StatusRuntimeRequest,
  StopRuntimeRequest,
  UpdateRuntimeManifestRequest,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import { CAPABILITY_ENDPOINT, handleCapabilityRequest } from "./capability-endpoint";
import type { ControlDurableObject } from "./control-durable-object";
import type {
  CapabilityVault,
  ControlCoordinator,
  StoredHttpResponse,
  StoredRuntime,
  StoredRuntimeArtifact,
} from "./model";
import { artifactChunkKey, deleteArtifactObjects } from "./artifact-storage";
import { handlePublishedDataPlaneRequest } from "./published-data-plane";
import { handlePreviewDataPlaneRequest } from "./preview-data-plane";
import { CloudflareSandboxBackend, type RuntimeBackend } from "./runtime-backend";

const CONTROL_PREFIX = "/_nabuflow/control/v1";
const MAX_REQUEST_BYTES = 256 * 1024;
const MUTATION_ENDPOINTS = new Set<Endpoint>([
  "ensure",
  "start",
  "stop",
  "destroy",
  "exec",
  "routeActivate",
  "routeDeactivate",
  "capabilityProvision",
  "capabilityRevoke",
  "databaseCapabilityProvision",
  "databaseCapabilityRevoke",
  "stripeCapabilityProvision",
  "stripeCapabilityRevoke",
  "artifactBegin",
  "artifactChunk",
  "artifactCommit",
  "artifactRemove",
  "manifestUpdate",
]);
const textDecoder = new TextDecoder("utf-8", { fatal: true });

const AUTH_HEADERS = {
  timestamp: "x-nabuflow-timestamp",
  nonce: "x-nabuflow-nonce",
  bodySha256: "x-nabuflow-body-sha256",
  signature: "x-nabuflow-signature",
  idempotencyKey: "idempotency-key",
} as const;

type Endpoint =
  | "version"
  | "ensure"
  | "start"
  | "stop"
  | "destroy"
  | "status"
  | "exec"
  | "logs"
  | "routeActivate"
  | "routeDeactivate"
  | "capabilityProvision"
  | "capabilityRevoke"
  | "databaseCapabilityProvision"
  | "databaseCapabilityRevoke"
  | "stripeCapabilityProvision"
  | "stripeCapabilityRevoke"
  | "capabilityBinding"
  | "artifactBegin"
  | "artifactChunk"
  | "artifactCommit"
  | "artifactRemove"
  | "manifestUpdate";

interface MatchedRoute {
  endpoint: Endpoint;
  locator: RuntimeLocator | null;
  hostname?: string;
  capability?: { projectId: number; provider: string; name: string };
  artifactSha256?: string;
  chunkIndex?: number;
}

interface WorkerDependencies {
  coordinator?: ControlCoordinator;
  backend?: RuntimeBackend;
  nowMs?: number;
  requestId?: string;
  context?: RequestExecutionContext;
  vault?: CapabilityVault;
}

type ControlRequestStage =
  | "initialization"
  | "data_plane"
  | "body_read"
  | "authentication"
  | "routing"
  | "idempotency"
  | "execution"
  | "audit";

interface RequestExecutionContext {
  stage: ControlRequestStage;
}

class ControlHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
  }
}

class RequestTooLargeError extends Error {}

export async function handleWorkerRequest(
  request: Request,
  env: WorkerBindings,
  dependencies: WorkerDependencies = {},
): Promise<Response> {
  const requestId = dependencies.requestId ?? crypto.randomUUID();
  const context = dependencies.context ?? { stage: "initialization" };
  let coordinator = dependencies.coordinator;
  try {
    coordinator ??= getCoordinator(env);
    const pathname = new URL(request.url).pathname;
    if (pathname === CONTROL_PREFIX || pathname.startsWith(`${CONTROL_PREFIX}/`)) {
      return await handleControlRequest(request, env, {
        ...dependencies,
        requestId,
        coordinator,
        context,
      });
    }
    if (pathname === CAPABILITY_ENDPOINT) {
      context.stage = "data_plane";
      return await handleCapabilityRequest(request, env, {
        coordinator,
        nowMs: dependencies.nowMs,
        requestId,
      });
    }
    context.stage = "data_plane";
    const previewResponse = await handlePreviewDataPlaneRequest(request, env, {
      coordinator,
      nowMs: dependencies.nowMs,
      requestId,
    });
    if (previewResponse !== null) return previewResponse;
    return await handlePublishedDataPlaneRequest(request, env, {
      coordinator,
      nowMs: dependencies.nowMs,
      requestId,
    });
  } catch (error) {
    const failureStage = context.stage;
    try {
      coordinator ??= getCoordinator(env);
      await coordinator.recordAudit({
        requestId,
        timestamp: new Date().toISOString(),
        method: request.method,
        endpoint: "unhandled",
        stage: failureStage,
        outcome: "unexpected_worker_error",
        projectId: null,
        role: null,
        slot: null,
        status: 503,
      });
    } catch {
      // eslint-disable-next-line no-console -- this is the last-resort Worker boundary
      console.error(
        JSON.stringify({
          event: "control_worker_audit_failed",
          requestId,
          stage: failureStage,
        }),
      );
    }
    // eslint-disable-next-line no-console -- preserve an observable trace when request handling fails
    console.error(
      JSON.stringify({
        event: "control_worker_unexpected_error",
        requestId,
        stage: failureStage,
        errorType: error instanceof Error ? error.name : "UnknownError",
      }),
    );
    return errorResponse(
      503,
      "unexpected_worker_error",
      "The staging control plane encountered a transient internal error",
      true,
      requestId,
      { "retry-after": "1" },
    );
  }
}

export async function handleControlRequest(
  request: Request,
  env: WorkerBindings,
  dependencies: WorkerDependencies = {},
): Promise<Response> {
  const requestId = dependencies.requestId ?? crypto.randomUUID();
  const context = dependencies.context ?? { stage: "initialization" };
  const nowMs = dependencies.nowMs ?? Date.now();
  const coordinator = dependencies.coordinator ?? getCoordinator(env);
  const backend = dependencies.backend ?? new CloudflareSandboxBackend(env);
  const url = new URL(request.url);
  const pathAndQuery = `${url.pathname}${url.search}`;
  let rawBody: Uint8Array;

  context.stage = "body_read";
  try {
    rawBody = await readCappedBody(request, requestBodyLimit(url.pathname));
  } catch (error) {
    if (error instanceof RequestTooLargeError) {
      return errorResponse(
        413,
        "request_too_large",
        "Control request body is too large",
        false,
        requestId,
      );
    }
    return errorResponse(
      400,
      "invalid_body",
      "Control request body could not be read",
      false,
      requestId,
    );
  }

  context.stage = "authentication";
  if (
    typeof env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN !== "string" ||
    env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN.length < 32
  ) {
    return errorResponse(
      503,
      "control_configuration_unavailable",
      "The staging control plane is not configured",
      false,
      requestId,
    );
  }
  const signed = readSignedRequest(request, pathAndQuery, rawBody);
  if (signed === null) {
    return errorResponse(
      401,
      "unauthorized",
      "A signed control request is required",
      false,
      requestId,
    );
  }

  const verification = await verifyControlRequestSignature(
    env.CLOUDFLARE_RUNTIME_CONTROL_TOKEN,
    signed,
    coordinator,
    { nowMs, maxClockSkewMs: 60_000 },
  );
  if (!verification.ok) {
    if (verification.reason === "replay") {
      return errorResponse(
        409,
        "replay_detected",
        "This signed request was already used",
        false,
        requestId,
      );
    }
    if (verification.reason === "clock-skew") {
      return errorResponse(
        401,
        "expired_signature",
        "The control request signature is expired",
        false,
        requestId,
      );
    }
    return errorResponse(
      401,
      "invalid_signature",
      "The control request signature is invalid",
      false,
      requestId,
    );
  }

  let route: MatchedRoute;
  let input: ControlInput;
  context.stage = "routing";
  try {
    route = matchRoute(request.method, url.pathname);
    input = parseInput(route, url, rawBody);
  } catch (error) {
    const controlError = toControlError(error);
    await recordAudit(coordinator, requestId, request.method, "unmatched", null, controlError);
    return errorResponse(
      controlError.status,
      controlError.code,
      controlError.message,
      controlError.retryable,
      requestId,
    );
  }

  const idempotencyKey = request.headers.get(AUTH_HEADERS.idempotencyKey) ?? "";
  const needsIdempotency = MUTATION_ENDPOINTS.has(route.endpoint);
  let idempotencyFingerprint: string | null = null;
  if (needsIdempotency) {
    context.stage = "idempotency";
    if (!idempotencyKey) {
      const error = new ControlHttpError(
        400,
        "idempotency_key_required",
        "A mutation idempotency key is required",
      );
      await recordAudit(
        coordinator,
        requestId,
        request.method,
        route.endpoint,
        route.locator,
        error,
        route.capability?.projectId,
      );
      return errorResponse(error.status, error.code, error.message, error.retryable, requestId);
    }
    idempotencyFingerprint = await sha256Hex(
      `${request.method}\n${pathAndQuery}\n${signed.bodySha256}`,
    );
    const lookup = await coordinator.beginIdempotency(
      idempotencyKey,
      idempotencyFingerprint,
      nowMs,
    );
    if (lookup.state === "replay") {
      await recordAudit(
        coordinator,
        requestId,
        request.method,
        route.endpoint,
        route.locator,
        {
          status: lookup.response.status,
          code: "idempotency_replay",
        },
        route.capability?.projectId,
      );
      return jsonResponse(lookup.response.status, lookup.response.body);
    }
    if (lookup.state === "conflict" || lookup.state === "pending") {
      const code = lookup.state === "conflict" ? "idempotency_conflict" : "request_in_progress";
      const status = 409;
      await recordAudit(
        coordinator,
        requestId,
        request.method,
        route.endpoint,
        route.locator,
        { status, code },
        route.capability?.projectId,
      );
      return errorResponse(
        status,
        code,
        lookup.state === "conflict"
          ? "The idempotency key was used for a different request"
          : "The idempotent request is still in progress",
        lookup.state === "pending",
        requestId,
      );
    }
  }

  context.stage = "execution";
  try {
    const result = await executeEndpoint(
      route.endpoint,
      input,
      env,
      coordinator,
      backend,
      dependencies.vault,
      route,
    );
    validateResponse(route.endpoint, result.body);
    if (needsIdempotency && idempotencyFingerprint !== null) {
      await coordinator.completeIdempotency(idempotencyKey, idempotencyFingerprint, result, nowMs);
    }
    await recordAudit(
      coordinator,
      requestId,
      request.method,
      route.endpoint,
      route.locator,
      { status: result.status, code: "ok" },
      route.capability?.projectId,
    );
    return jsonResponse(result.status, result.body);
  } catch (error) {
    if (!(error instanceof ControlHttpError)) {
      // Keep unexpected control failures diagnosable without emitting request or artifact content.
      // eslint-disable-next-line no-console -- metadata-only trace for the top-level boundary
      console.error(
        JSON.stringify({
          event: "control_endpoint_unexpected_error",
          requestId,
          endpoint: route.endpoint,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
    const controlError = toControlError(error);
    if (needsIdempotency && idempotencyFingerprint !== null) {
      try {
        if (controlError.status >= 500) {
          await coordinator.abandonIdempotency(idempotencyKey, idempotencyFingerprint);
        } else {
          const body = errorBody(controlError, requestId);
          await coordinator.completeIdempotency(
            idempotencyKey,
            idempotencyFingerprint,
            { status: controlError.status, body },
            nowMs,
          );
        }
      } catch (finalizationError) {
        logControlErrorFinalizationFailure(
          requestId,
          route.endpoint,
          "idempotency",
          finalizationError,
        );
      }
    }
    try {
      await recordAudit(
        coordinator,
        requestId,
        request.method,
        route.endpoint,
        route.locator,
        controlError,
        route.capability?.projectId,
      );
    } catch (finalizationError) {
      logControlErrorFinalizationFailure(requestId, route.endpoint, "audit", finalizationError);
    }
    return errorResponse(
      controlError.status,
      controlError.code,
      controlError.message,
      controlError.retryable,
      requestId,
    );
  }
}

type ControlInput =
  | Record<string, never>
  | Uint8Array
  | BeginRuntimeArtifactRequest
  | CommitRuntimeArtifactRequest
  | RemoveRuntimeArtifactRequest
  | UpdateRuntimeManifestRequest
  | ActivateRouteRequest
  | DeactivateRouteRequest
  | EnsureRuntimeRequest
  | StartRuntimeRequest
  | StopRuntimeRequest
  | DestroyRuntimeRequest
  | StatusRuntimeRequest
  | ExecRuntimeRequest
  | LogsRuntimeRequest
  | ProvisionEchoCapabilityRequest
  | RevokeEchoCapabilityRequest
  | ProvisionDatabaseCapabilityRequest
  | RevokeDatabaseCapabilityRequest
  | ProvisionStripeCapabilityRequest
  | RevokeStripeCapabilityRequest;

function getCoordinator(env: WorkerBindings): DurableObjectStub<ControlDurableObject> {
  return env.CONTROL_COORDINATOR.get(env.CONTROL_COORDINATOR.idFromName("control-v1"));
}

function getCapabilityVault(
  env: WorkerBindings,
  projectId: number,
): DurableObjectStub<CapabilityVaultDurableObject> {
  return env.CAPABILITY_VAULT.get(env.CAPABILITY_VAULT.idFromName(`project:${projectId}`));
}

function matchRoute(method: string, pathname: string): MatchedRoute {
  if (method === "GET" && pathname === `${CONTROL_PREFIX}/version`) {
    return { endpoint: "version", locator: null };
  }
  const activateRouteMatch = new RegExp(`^${CONTROL_PREFIX}/routes/([^/]+)/activate$`).exec(
    pathname,
  );
  if (activateRouteMatch) {
    if (method !== "POST") {
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    }
    return { endpoint: "routeActivate", locator: null, hostname: activateRouteMatch[1] };
  }
  const deactivateRouteMatch = new RegExp(`^${CONTROL_PREFIX}/routes/([^/]+)$`).exec(pathname);
  if (deactivateRouteMatch) {
    if (method !== "DELETE") {
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    }
    return { endpoint: "routeDeactivate", locator: null, hostname: deactivateRouteMatch[1] };
  }
  const capabilityMatch = new RegExp(
    `^${CONTROL_PREFIX}/capabilities/([1-9][0-9]*)/([a-z][a-z0-9-]*)/([a-z][a-z0-9-]*)$`,
  ).exec(pathname);
  if (capabilityMatch) {
    const capability = {
      projectId: Number(capabilityMatch[1]),
      provider: capabilityMatch[2],
      name: capabilityMatch[3],
    };
    const isEcho = capability.provider === "nabuflow-harness" && capability.name === "echo";
    const isDatabase = capability.provider === "neon-postgres" && capability.name === "database";
    const isStripe = capability.provider === "stripe" && capability.name === "payments";
    if (!isEcho && !isDatabase && !isStripe) {
      throw new ControlHttpError(400, "unsupported_capability", "Capability is not supported");
    }
    if (method === "PUT") {
      return {
        endpoint: isEcho
          ? "capabilityProvision"
          : isDatabase
            ? "databaseCapabilityProvision"
            : "stripeCapabilityProvision",
        locator: null,
        capability,
      };
    }
    if (method === "DELETE") {
      return {
        endpoint: isEcho
          ? "capabilityRevoke"
          : isDatabase
            ? "databaseCapabilityRevoke"
            : "stripeCapabilityRevoke",
        locator: null,
        capability,
      };
    }
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  const artifactMatch = new RegExp(
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/(preview|production)/(primary|blue|green)/artifacts/([0-9a-f]{64})(?:/(begin|commit|chunks/([0-9]+)))?$`,
  ).exec(pathname);
  if (artifactMatch) {
    const locator = {
      projectId: Number(artifactMatch[1]),
      role: artifactMatch[2] as RuntimeLocator["role"],
      slot: artifactMatch[3] as RuntimeLocator["slot"],
    };
    const artifactSha256 = artifactMatch[4];
    const suffix = artifactMatch[5];
    if (method === "POST" && suffix === "begin")
      return { endpoint: "artifactBegin", locator, artifactSha256 };
    if (method === "POST" && suffix === "commit")
      return { endpoint: "artifactCommit", locator, artifactSha256 };
    if (method === "PUT" && suffix?.startsWith("chunks/") && artifactMatch[6] !== undefined)
      return {
        endpoint: "artifactChunk",
        locator,
        artifactSha256,
        chunkIndex: Number(artifactMatch[6]),
      };
    if (method === "DELETE" && suffix === undefined)
      return { endpoint: "artifactRemove", locator, artifactSha256 };
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  const manifestMatch = new RegExp(
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/(preview|production)/(primary|blue|green)/manifest$`,
  ).exec(pathname);
  if (manifestMatch) {
    if (method !== "PUT")
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    return {
      endpoint: "manifestUpdate",
      locator: {
        projectId: Number(manifestMatch[1]),
        role: manifestMatch[2] as RuntimeLocator["role"],
        slot: manifestMatch[3] as RuntimeLocator["slot"],
      },
    };
  }
  const match = new RegExp(
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/(preview|production)/(primary|blue|green)(?:/(start|stop|exec|logs|capability-binding))?$`,
  ).exec(pathname);
  if (!match) throw new ControlHttpError(404, "not_found", "Control endpoint not found");

  const locator = {
    projectId: Number(match[1]),
    role: match[2] as RuntimeLocator["role"],
    slot: match[3] as RuntimeLocator["slot"],
  };
  const suffix = match[4];
  if (method === "PUT" && suffix === undefined) return { endpoint: "ensure", locator };
  if (method === "POST" && suffix === "start") return { endpoint: "start", locator };
  if (method === "POST" && suffix === "stop") return { endpoint: "stop", locator };
  if (method === "DELETE" && suffix === undefined) return { endpoint: "destroy", locator };
  if (method === "GET" && suffix === undefined) return { endpoint: "status", locator };
  if (method === "POST" && suffix === "exec") return { endpoint: "exec", locator };
  if (method === "GET" && suffix === "logs") return { endpoint: "logs", locator };
  if (method === "GET" && suffix === "capability-binding") {
    return { endpoint: "capabilityBinding", locator };
  }
  throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
}

function parseInput(route: MatchedRoute, url: URL, rawBody: Uint8Array): ControlInput {
  if (route.endpoint === "version") {
    assertNoQuery(url);
    assertEmptyBody(rawBody);
    return {};
  }
  if (route.locator === null) {
    if (
      route.endpoint === "capabilityProvision" ||
      route.endpoint === "capabilityRevoke" ||
      route.endpoint === "databaseCapabilityProvision" ||
      route.endpoint === "databaseCapabilityRevoke" ||
      route.endpoint === "stripeCapabilityProvision" ||
      route.endpoint === "stripeCapabilityRevoke"
    ) {
      return parseCapabilityControlInput(route, url, rawBody);
    }
    return parseRouteInput(route, url, rawBody);
  }

  if (route.endpoint === "status" || route.endpoint === "capabilityBinding") {
    assertNoQuery(url);
    assertEmptyBody(rawBody);
    return parseStrict(statusRuntimeRequestSchema, { locator: route.locator });
  }
  if (route.endpoint === "logs") {
    assertEmptyBody(rawBody);
    let unknownQuery = false;
    url.searchParams.forEach((_value, key) => {
      if (!new Set(["cursor", "limit", "follow"]).has(key)) {
        unknownQuery = true;
      }
    });
    if (unknownQuery) {
      throw new ControlHttpError(400, "invalid_request", "Unknown control query parameter");
    }
    const follow = url.searchParams.get("follow");
    if (follow !== null && follow !== "true" && follow !== "false") {
      throw new ControlHttpError(400, "invalid_request", "The follow query must be true or false");
    }
    const raw = {
      locator: route.locator,
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
      ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
      ...(follow === null ? {} : { follow: follow === "true" }),
    };
    return parseStrict(logsRuntimeRequestSchema, raw);
  }

  if (route.endpoint === "artifactChunk") {
    assertNoQuery(url);
    if (rawBody.byteLength === 0)
      throw new ControlHttpError(400, "invalid_request", "Artifact chunk body is required");
    return rawBody;
  }

  assertNoQuery(url);
  const body = parseJsonBody(rawBody);
  if (
    route.endpoint !== "ensure" &&
    route.endpoint !== "start" &&
    route.endpoint !== "stop" &&
    route.endpoint !== "destroy" &&
    route.endpoint !== "exec" &&
    route.endpoint !== "artifactBegin" &&
    route.endpoint !== "artifactCommit" &&
    route.endpoint !== "artifactRemove" &&
    route.endpoint !== "manifestUpdate"
  ) {
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  const parsed = parseMutationInput(route.endpoint, body);
  if (
    parsed.locator.projectId !== route.locator.projectId ||
    parsed.locator.role !== route.locator.role ||
    parsed.locator.slot !== route.locator.slot
  ) {
    throw new ControlHttpError(400, "locator_mismatch", "Path and body runtime locators differ");
  }
  return parsed;
}

function parseCapabilityControlInput(
  route: MatchedRoute,
  url: URL,
  rawBody: Uint8Array,
):
  | ProvisionEchoCapabilityRequest
  | RevokeEchoCapabilityRequest
  | ProvisionDatabaseCapabilityRequest
  | RevokeDatabaseCapabilityRequest
  | ProvisionStripeCapabilityRequest
  | RevokeStripeCapabilityRequest {
  if (route.capability === undefined) {
    throw new ControlHttpError(400, "invalid_capability", "Capability scope is required");
  }
  assertNoQuery(url);
  const body = parseJsonBody(rawBody);
  const parsed =
    route.endpoint === "capabilityProvision"
      ? parseStrict(provisionEchoCapabilityRequestSchema, body)
      : route.endpoint === "databaseCapabilityProvision"
        ? parseStrict(provisionDatabaseCapabilityRequestSchema, body)
        : route.endpoint === "stripeCapabilityProvision"
          ? parseStrict(provisionStripeCapabilityRequestSchema, body)
          : route.endpoint === "stripeCapabilityRevoke"
            ? parseStrict(revokeStripeCapabilityRequestSchema, body)
            : route.endpoint === "databaseCapabilityRevoke"
              ? parseStrict(revokeDatabaseCapabilityRequestSchema, body)
              : parseStrict(revokeEchoCapabilityRequestSchema, body);
  if (parsed.projectId !== route.capability.projectId) {
    throw new ControlHttpError(400, "project_mismatch", "Path and body projects differ");
  }
  if (
    (route.endpoint === "capabilityProvision" ||
      route.endpoint === "databaseCapabilityProvision" ||
      route.endpoint === "stripeCapabilityProvision") &&
    (
      parsed as
        | ProvisionEchoCapabilityRequest
        | ProvisionDatabaseCapabilityRequest
        | ProvisionStripeCapabilityRequest
    ).definition.provider !== route.capability.provider
  ) {
    throw new ControlHttpError(400, "capability_mismatch", "Path and body capabilities differ");
  }
  if (
    (route.endpoint === "capabilityProvision" ||
      route.endpoint === "databaseCapabilityProvision" ||
      route.endpoint === "stripeCapabilityProvision") &&
    (
      parsed as
        | ProvisionEchoCapabilityRequest
        | ProvisionDatabaseCapabilityRequest
        | ProvisionStripeCapabilityRequest
    ).definition.name !== route.capability.name
  ) {
    throw new ControlHttpError(400, "capability_mismatch", "Path and body capabilities differ");
  }
  return parsed;
}

function parseRouteInput(route: MatchedRoute, url: URL, rawBody: Uint8Array): ControlInput {
  if (
    (route.endpoint !== "routeActivate" && route.endpoint !== "routeDeactivate") ||
    route.hostname === undefined
  ) {
    throw new ControlHttpError(400, "invalid_locator", "Runtime locator is required");
  }
  assertNoQuery(url);
  const body = parseJsonBody(rawBody);
  if (route.endpoint === "routeActivate") {
    const parsed = parseStrict(activateRouteRequestSchema, body);
    if (parsed.route.hostname !== route.hostname) {
      throw new ControlHttpError(400, "hostname_mismatch", "Path and body hostnames differ");
    }
    return parsed;
  }
  const parsed = parseStrict(deactivateRouteRequestSchema, body);
  if (parsed.hostname !== route.hostname) {
    throw new ControlHttpError(400, "hostname_mismatch", "Path and body hostnames differ");
  }
  return parsed;
}

function parseMutationInput(
  endpoint:
    | "ensure"
    | "start"
    | "stop"
    | "destroy"
    | "exec"
    | "artifactBegin"
    | "artifactCommit"
    | "artifactRemove"
    | "manifestUpdate",
  body: unknown,
):
  | EnsureRuntimeRequest
  | StartRuntimeRequest
  | StopRuntimeRequest
  | DestroyRuntimeRequest
  | ExecRuntimeRequest
  | BeginRuntimeArtifactRequest
  | CommitRuntimeArtifactRequest
  | RemoveRuntimeArtifactRequest
  | UpdateRuntimeManifestRequest {
  if (endpoint === "ensure") return parseStrict(ensureRuntimeRequestSchema, body);
  if (endpoint === "start") return parseStrict(startRuntimeRequestSchema, body);
  if (endpoint === "stop") return parseStrict(stopRuntimeRequestSchema, body);
  if (endpoint === "destroy") return parseStrict(destroyRuntimeRequestSchema, body);
  if (endpoint === "artifactBegin") {
    const result = beginRuntimeArtifactRequestSchema.safeParse(body);
    if (!result.success) {
      const content = (body as { envelope?: { content?: Record<string, unknown> } } | null)
        ?.envelope?.content;
      const files = content?.files;
      const exceedsDeclaredLimit =
        (typeof content?.payloadBytes === "number" &&
          content.payloadBytes > MAX_RUNTIME_ARTIFACT_BYTES) ||
        (Array.isArray(files) && files.length > MAX_RUNTIME_ARTIFACT_FILES) ||
        (Array.isArray(files) &&
          files.some(
            (file) =>
              typeof file === "object" &&
              file !== null &&
              typeof (file as { size?: unknown }).size === "number" &&
              (file as { size: number }).size > MAX_RUNTIME_ARTIFACT_FILE_BYTES,
          ));
      if (exceedsDeclaredLimit) {
        throw new ControlHttpError(413, "artifact_too_large", "Artifact exceeds staging limits");
      }
      return parseStrict(beginRuntimeArtifactRequestSchema, body);
    }
    return result.data;
  }
  if (endpoint === "artifactCommit") return parseStrict(commitRuntimeArtifactRequestSchema, body);
  if (endpoint === "artifactRemove") return parseStrict(removeRuntimeArtifactRequestSchema, body);
  if (endpoint === "manifestUpdate") return parseStrict(updateRuntimeManifestRequestSchema, body);
  return parseStrict(execRuntimeRequestSchema, body);
}

async function executeEndpoint(
  endpoint: Endpoint,
  input: ControlInput,
  env: WorkerBindings,
  coordinator: ControlCoordinator,
  backend: RuntimeBackend,
  injectedVault?: CapabilityVault,
  matchedRoute?: MatchedRoute,
): Promise<StoredHttpResponse> {
  assertArtifactInfrastructure(env);
  const deploymentVersion = env.CF_VERSION_METADATA.id;
  if (endpoint === "version") {
    return {
      status: 200,
      body: {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        deploymentVersion,
        provider: "cloudflare",
        supportedRoles: [...RUNTIME_ROLES],
        features: [...CONTROL_FEATURES],
      },
    };
  }
  if (endpoint === "routeActivate") {
    return activatePublishedRoute(input as ActivateRouteRequest, env, coordinator);
  }
  if (endpoint === "routeDeactivate") {
    return deactivatePublishedRoute(input as DeactivateRouteRequest, coordinator);
  }
  if (endpoint === "capabilityProvision") {
    const request = input as ProvisionEchoCapabilityRequest;
    const result = await (
      injectedVault ?? getCapabilityVault(env, request.projectId)
    ).provisionEcho(request);
    return {
      status: 200,
      body: {
        ok: true,
        projectId: request.projectId,
        capability: {
          provider: request.definition.provider,
          name: request.definition.name,
        },
        revision: request.revision,
        keyId: result.keyId,
      },
    };
  }
  if (endpoint === "databaseCapabilityProvision") {
    const request = input as ProvisionDatabaseCapabilityRequest;
    const result = await (
      injectedVault ?? getCapabilityVault(env, request.projectId)
    ).provisionDatabase(request);
    return {
      status: 200,
      body: {
        ok: true,
        projectId: request.projectId,
        capability: {
          provider: request.definition.provider,
          name: request.definition.name,
        },
        revision: request.revision,
        keyId: result.keyId,
      },
    };
  }
  if (endpoint === "stripeCapabilityProvision") {
    const request = input as ProvisionStripeCapabilityRequest;
    const result = await (
      injectedVault ?? getCapabilityVault(env, request.projectId)
    ).provisionStripe(request);
    return {
      status: 200,
      body: {
        ok: true,
        projectId: request.projectId,
        capability: {
          provider: request.definition.provider,
          name: request.definition.name,
        },
        revision: request.revision,
        keyId: result.keyId,
      },
    };
  }
  if (endpoint === "capabilityRevoke") {
    const request = input as RevokeEchoCapabilityRequest;
    const result = await (injectedVault ?? getCapabilityVault(env, request.projectId)).revokeEcho(
      request,
    );
    if (result === "not_found") {
      throw new ControlHttpError(404, "capability_not_found", "Capability is not available");
    }
    if (result === "conflict") {
      throw new ControlHttpError(
        409,
        "capability_revision_conflict",
        "Capability revision changed before revocation",
      );
    }
    return {
      status: 200,
      body: {
        ok: true,
        projectId: request.projectId,
        capability: { provider: "nabuflow-harness", name: "echo" },
      },
    };
  }
  if (endpoint === "databaseCapabilityRevoke") {
    const request = input as RevokeDatabaseCapabilityRequest;
    const result = await (
      injectedVault ?? getCapabilityVault(env, request.projectId)
    ).revokeDatabase(request);
    if (result === "not_found") {
      throw new ControlHttpError(404, "capability_not_found", "Capability is not available");
    }
    if (result === "conflict") {
      throw new ControlHttpError(
        409,
        "capability_revision_conflict",
        "Capability revision changed before revocation",
      );
    }
    return {
      status: 200,
      body: {
        ok: true,
        projectId: request.projectId,
        capability: { provider: "neon-postgres", name: "database" },
      },
    };
  }
  if (endpoint === "stripeCapabilityRevoke") {
    const request = input as RevokeStripeCapabilityRequest;
    const result = await (injectedVault ?? getCapabilityVault(env, request.projectId)).revokeStripe(
      request,
    );
    if (result === "not_found") {
      throw new ControlHttpError(404, "capability_not_found", "Capability is not available");
    }
    if (result === "conflict") {
      throw new ControlHttpError(
        409,
        "capability_revision_conflict",
        "Capability revision changed before revocation",
      );
    }
    return {
      status: 200,
      body: {
        ok: true,
        projectId: request.projectId,
        capability: { provider: "stripe", name: "payments" },
      },
    };
  }

  const locator = matchedRoute?.locator ?? (input as { locator: RuntimeLocator }).locator;
  if (locator === null) {
    throw new ControlHttpError(400, "invalid_request", "Runtime locator is required");
  }
  const identity = await deriveRuntimeIdentity({
    namespace: env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    ...locator,
  });
  if (endpoint === "artifactBegin") {
    const request = input as BeginRuntimeArtifactRequest;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    if (
      matchedRoute?.artifactSha256 !== request.envelope.sealedArtifactSha256 ||
      request.envelope.targetRuntimeIdentity !== identity
    ) {
      throw artifactRuntimeMismatch();
    }
    if (!(await verifyRuntimeArtifactEnvelope(request.envelope))) {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Artifact integrity verification failed",
      );
    }
    await requireRuntime(coordinator, identity);
    const record: StoredRuntimeArtifact = {
      runtimeIdentity: identity,
      envelope: request.envelope,
      state: "pending",
      receivedChunks: request.envelope.content.chunks.map(() => null),
      expiresAtMs: Date.now() + RUNTIME_ARTIFACT_PENDING_TTL_MS,
    };
    const result = await coordinator.beginArtifact(record);
    if (result === "conflict") {
      throw new ControlHttpError(
        409,
        "artifact_conflict",
        "Artifact address is already bound to different metadata",
      );
    }
    return {
      status: 200,
      body: {
        ok: true,
        sealedArtifactSha256: request.envelope.sealedArtifactSha256,
        chunksExpected: request.envelope.content.chunks.length,
      },
    };
  }
  if (endpoint === "artifactChunk") {
    if (
      matchedRoute?.artifactSha256 === undefined ||
      matchedRoute.chunkIndex === undefined ||
      !(input instanceof Uint8Array)
    ) {
      throw new ControlHttpError(400, "invalid_request", "Artifact chunk route is incomplete");
    }
    const artifact = await coordinator.getArtifact(identity, matchedRoute.artifactSha256);
    if (artifact === null || artifact.runtimeIdentity !== identity) throw artifactRuntimeMismatch();
    const chunkIndex = matchedRoute.chunkIndex;
    const isFinal = chunkIndex === artifact.envelope.content.chunks.length - 1;
    const finalLength =
      artifact.envelope.content.payloadBytes % artifact.envelope.content.chunkBytes ||
      artifact.envelope.content.chunkBytes;
    const expectedLength = isFinal ? finalLength : artifact.envelope.content.chunkBytes;
    if (
      chunkIndex >= artifact.envelope.content.chunks.length ||
      input.byteLength !== expectedLength
    ) {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Artifact chunk does not match the sealed envelope",
      );
    }
    const chunkSha256 = await sha256Hex(input);
    if (chunkSha256 !== artifact.envelope.content.chunks[chunkIndex]) {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Artifact chunk does not match the sealed envelope",
      );
    }
    await env.NABUFLOW_RUNTIME_ARTIFACTS.put(
      artifactChunkKey(identity, artifact.envelope.sealedArtifactSha256, chunkIndex),
      input.slice().buffer,
    );
    const recorded = await coordinator.recordArtifactChunk(
      identity,
      artifact.envelope.sealedArtifactSha256,
      chunkIndex,
      chunkSha256,
    );
    if (recorded === "not_found") throw artifactRuntimeMismatch();
    if (recorded === "conflict") {
      throw new ControlHttpError(409, "artifact_chunk_conflict", "Artifact chunk conflicts");
    }
    return {
      status: 200,
      body: {
        ok: true,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        chunkIndex,
      },
    };
  }
  if (endpoint === "artifactCommit") {
    const request = input as CommitRuntimeArtifactRequest;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    if (matchedRoute?.artifactSha256 !== request.sealedArtifactSha256)
      throw artifactRuntimeMismatch();
    const artifact = await coordinator.getArtifact(identity, request.sealedArtifactSha256);
    if (artifact === null || artifact.runtimeIdentity !== identity) throw artifactRuntimeMismatch();
    const commit = await coordinator.commitArtifact(identity, request.sealedArtifactSha256);
    if (commit === "incomplete") {
      await deleteArtifactObjects(env.NABUFLOW_RUNTIME_ARTIFACTS, artifact);
      await coordinator.removeArtifact(identity, request.sealedArtifactSha256);
      throw new ControlHttpError(409, "artifact_incomplete", "Artifact upload is incomplete");
    }
    if (commit === "not_found") throw artifactRuntimeMismatch();
    const runtime = await requireRuntime(coordinator, identity);
    const materialized = artifact.envelope.manifestRevision === runtime.manifest.revision;
    let filesWritten = 0;
    if (materialized) {
      const result = await backend.materialize(runtime, artifact);
      filesWritten = result.filesWritten;
      runtime.artifactRevision = artifact.envelope.artifactRevision;
      runtime.artifactSha256 = artifact.envelope.sealedArtifactSha256;
      await coordinator.putRuntime(identity, runtime);
    }
    return {
      status: 200,
      body: {
        ok: true,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        contentSha256: artifact.envelope.contentSha256,
        filesWritten,
        materialized,
      },
    };
  }
  if (endpoint === "artifactRemove") {
    const request = input as RemoveRuntimeArtifactRequest;
    if (matchedRoute?.artifactSha256 !== request.sealedArtifactSha256)
      throw artifactRuntimeMismatch();
    const runtime = await coordinator.getRuntime(identity);
    if (
      runtime !== null &&
      (runtime.descriptor.status === "running" || runtime.descriptor.status === "starting") &&
      runtime.artifactSha256 === request.sealedArtifactSha256
    ) {
      throw new ControlHttpError(
        409,
        "runtime_busy",
        "Stop the runtime before removing its artifact",
      );
    }
    const artifact = await coordinator.getArtifact(identity, request.sealedArtifactSha256);
    if (artifact === null) throw artifactRuntimeMismatch();
    await deleteArtifactObjects(env.NABUFLOW_RUNTIME_ARTIFACTS, artifact);
    await coordinator.removeArtifact(identity, request.sealedArtifactSha256);
    return { status: 200, body: { ok: true } };
  }
  if (endpoint === "manifestUpdate") {
    const request = input as UpdateRuntimeManifestRequest;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    const runtime = await requireRuntime(coordinator, identity);
    if (runtime.descriptor.status === "starting") {
      throw new ControlHttpError(
        409,
        "runtime_busy",
        "Runtime manifest update is already in progress",
        true,
      );
    }
    if (runtime.manifest.revision !== request.expectedManifestRevision) {
      throw new ControlHttpError(
        409,
        "manifest_revision_conflict",
        "Runtime manifest revision changed before update",
      );
    }
    if (
      runtime.manifest.resourceProfile !== request.manifest.resourceProfile ||
      runtime.manifest.public !== request.manifest.public
    ) {
      throw new ControlHttpError(
        400,
        "manifest_immutable_field",
        "Manifest update attempted to change an immutable field",
      );
    }
    const wasRunning = runtime.descriptor.status === "running";
    if (wasRunning && request.restart !== "restart") {
      throw new ControlHttpError(
        409,
        "runtime_busy",
        "Explicit restart is required to update a running runtime",
        true,
      );
    }
    let restartArtifact: StoredRuntimeArtifact | null = null;
    if (wasRunning) {
      if (request.sealedArtifactSha256 === undefined) {
        throw new ControlHttpError(
          409,
          "artifact_not_committed",
          "A committed artifact for the next manifest is required",
        );
      }
      restartArtifact = await coordinator.getArtifact(identity, request.sealedArtifactSha256);
      if (
        restartArtifact === null ||
        restartArtifact.state !== "committed" ||
        restartArtifact.envelope.manifestRevision !== request.manifest.revision
      ) {
        throw new ControlHttpError(
          409,
          "artifact_not_committed",
          "A committed artifact for the next manifest is required",
        );
      }
      const unbound = await coordinator.unbindContainer(
        runtimeContainerId(env, identity),
        identity,
      );
      if (!unbound) {
        throw new ControlHttpError(
          409,
          "runtime_busy",
          "Runtime binding changed before manifest update",
          true,
        );
      }
    }
    runtime.manifest = request.manifest;
    runtime.descriptor.servicePort = request.manifest.servicePort;
    runtime.descriptor.manifestRevision = request.manifest.revision;
    runtime.descriptor.status = wasRunning ? "starting" : "stopped";
    runtime.descriptor.readyAt = null;
    runtime.descriptor.lastError = null;
    runtime.processId = null;
    if (restartArtifact !== null) {
      runtime.artifactRevision = restartArtifact.envelope.artifactRevision;
      runtime.artifactSha256 = restartArtifact.envelope.sealedArtifactSha256;
    }
    const persisted = await coordinator.putRuntimeIfManifestRevision(
      identity,
      request.expectedManifestRevision,
      runtime,
    );
    if (persisted !== "updated") {
      if (wasRunning) await coordinator.bindContainer(runtimeContainerId(env, identity), identity);
      throw new ControlHttpError(
        persisted === "not_found" ? 404 : 409,
        persisted === "not_found" ? "runtime_not_found" : "manifest_revision_conflict",
        persisted === "not_found"
          ? "Runtime not found"
          : "Runtime manifest revision changed before update",
      );
    }
    if (restartArtifact !== null) {
      try {
        // Materialization already kills every tenant process before replacing the sealed release.
        // Fully stopping the Sandbox here makes the immediately-following filesystem RPC race the
        // container shutdown and fail before the first release-directory operation.
        await backend.materialize(runtime, restartArtifact);
        const started = await backend.start(runtime);
        runtime.processId = started.processId;
        runtime.descriptor.status = "running";
        runtime.descriptor.readyAt = started.readyAt;
        await coordinator.putRuntime(identity, runtime);
        await coordinator.bindContainer(runtimeContainerId(env, identity), identity);
      } catch {
        await coordinator.unbindContainer(runtimeContainerId(env, identity), identity);
        await safelyStopFailedRuntime(backend, runtime);
        runtime.descriptor.status = "error";
        runtime.descriptor.lastError = "Runtime failed after manifest update";
        runtime.processId = null;
        await coordinator.putRuntime(identity, runtime);
        throw new ControlHttpError(
          502,
          "runtime_restart_failed",
          "Runtime failed after manifest update",
          true,
        );
      }
    }
    return { status: 200, body: { runtime: runtime.descriptor } };
  }
  if (endpoint === "ensure") {
    const request = input as EnsureRuntimeRequest;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    const existing = await coordinator.getRuntime(identity);
    if (
      existing !== null &&
      existing.manifest.revision !== request.manifest.revision &&
      (existing.descriptor.status === "running" || existing.descriptor.status === "starting")
    ) {
      throw new ControlHttpError(
        409,
        "runtime_busy",
        "Stop the runtime before changing its manifest",
        true,
      );
    }
    const runtime: StoredRuntime = existing ?? {
      descriptor: {
        identity,
        ...locator,
        status: "stopped",
        servicePort: request.manifest.servicePort,
        manifestRevision: request.manifest.revision,
        deploymentVersion,
        endpoint: null,
        readyAt: null,
        lastError: null,
      },
      manifest: request.manifest,
      artifactRevision: null,
      artifactSha256: null,
      processId: null,
      stdoutLength: 0,
      stderrLength: 0,
      nextLogSequence: 0,
      logs: [],
    };
    runtime.manifest = request.manifest;
    runtime.descriptor = {
      ...runtime.descriptor,
      ...locator,
      identity,
      status: existing?.descriptor.status ?? "stopped",
      servicePort: request.manifest.servicePort,
      manifestRevision: request.manifest.revision,
      deploymentVersion,
      lastError: null,
    };
    await coordinator.putRuntime(identity, runtime);
    await coordinator.appendSystemLog(identity, "Runtime ensured in the staging control plane.");
    return {
      status: 200,
      body: { runtime: (await requireRuntime(coordinator, identity)).descriptor },
    };
  }

  const runtime = await requireRuntime(coordinator, identity);
  if (endpoint === "capabilityBinding") {
    const containerId = runtimeContainerId(env, identity);
    const binding = await coordinator.getContainerBinding(containerId);
    const active = binding === identity && runtime.descriptor.status === "running";
    return {
      status: 200,
      body: {
        runtimeIdentity: identity,
        active,
        containerId: active ? containerId : null,
      },
    };
  }
  if (endpoint === "start") {
    const request = input as StartRuntimeRequest;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    const artifact = await coordinator.getArtifact(identity, request.artifactSha256);
    if (
      artifact === null ||
      artifact.state !== "committed" ||
      artifact.runtimeIdentity !== identity ||
      artifact.envelope.artifactRevision !== request.artifactRevision ||
      artifact.envelope.manifestRevision !== runtime.manifest.revision
    ) {
      throw new ControlHttpError(
        409,
        "artifact_not_committed",
        "A committed artifact for this runtime manifest is required",
      );
    }
    runtime.artifactRevision = request.artifactRevision;
    runtime.artifactSha256 = request.artifactSha256;
    runtime.descriptor.status = "starting";
    runtime.descriptor.lastError = null;
    runtime.descriptor.readyAt = null;
    await coordinator.putRuntime(identity, runtime);
    await coordinator.appendSystemLog(identity, "Starting the tenant service.");
    try {
      await backend.materialize(runtime, artifact);
      const started = await backend.start(runtime);
      const current = await requireRuntime(coordinator, identity);
      current.processId = started.processId;
      current.stdoutLength = 0;
      current.stderrLength = 0;
      current.descriptor.status = "running";
      current.descriptor.readyAt = started.readyAt;
      current.descriptor.lastError = null;
      await coordinator.putRuntime(identity, current);
      await coordinator.bindContainer(runtimeContainerId(env, identity), identity);
      await coordinator.appendSystemLog(identity, "Tenant service is ready.");
      return {
        status: 200,
        body: { runtime: (await requireRuntime(coordinator, identity)).descriptor },
      };
    } catch (error) {
      await coordinator.unbindContainer(runtimeContainerId(env, identity), identity);
      await safelyStopFailedRuntime(backend, runtime);
      const current = await requireRuntime(coordinator, identity);
      current.descriptor.status = "error";
      current.descriptor.lastError = safeErrorMessage(error);
      await coordinator.putRuntime(identity, current);
      await coordinator.appendSystemLog(identity, "Tenant service failed to start.");
      throw new ControlHttpError(
        502,
        "runtime_start_failed",
        "Tenant service failed to start",
        true,
      );
    }
  }
  if (endpoint === "stop") {
    await coordinator.unbindContainer(runtimeContainerId(env, identity), identity);
    if (runtime.descriptor.status !== "stopped") await backend.stop(runtime);
    runtime.descriptor.status = "stopped";
    runtime.descriptor.readyAt = null;
    runtime.processId = null;
    await coordinator.putRuntime(identity, runtime);
    await coordinator.appendSystemLog(identity, "Tenant service stopped.");
    return {
      status: 200,
      body: { runtime: (await requireRuntime(coordinator, identity)).descriptor },
    };
  }
  if (endpoint === "destroy") {
    await coordinator.unbindContainer(runtimeContainerId(env, identity), identity);
    await backend.destroy(runtime);
    const artifacts = await coordinator.listArtifacts(identity);
    for (const artifact of artifacts) {
      await deleteArtifactObjects(env.NABUFLOW_RUNTIME_ARTIFACTS, artifact);
      await coordinator.removeArtifact(identity, artifact.envelope.sealedArtifactSha256);
    }
    await coordinator.deleteRuntime(identity);
    return { status: 200, body: { ok: true } };
  }
  if (endpoint === "status") {
    if (runtime.descriptor.status === "running" || runtime.descriptor.status === "starting") {
      const status = await backend.status(runtime);
      if (!status.running) {
        await coordinator.unbindContainer(runtimeContainerId(env, identity), identity);
        runtime.descriptor.status = status.lastError === null ? "stopped" : "error";
        runtime.descriptor.lastError = status.lastError;
        runtime.descriptor.readyAt = null;
        runtime.processId = null;
        await coordinator.putRuntime(identity, runtime);
      }
    }
    return {
      status: 200,
      body: { runtime: (await requireRuntime(coordinator, identity)).descriptor },
    };
  }
  if (endpoint === "exec") {
    if (runtime.descriptor.status !== "running") {
      throw new ControlHttpError(409, "runtime_not_running", "The runtime must be running", true);
    }
    const result = await backend.exec(runtime, input as ExecRuntimeRequest);
    await coordinator.appendSystemLog(
      identity,
      result.exitCode === null
        ? "Command did not produce an exit code."
        : `Command finished with exit code ${result.exitCode}.`,
    );
    return { status: 200, body: result };
  }
  if (endpoint === "logs") {
    const request = input as LogsRuntimeRequest;
    const processLogs = await backend.logs(runtime);
    await coordinator.mergeProcessLogs(identity, processLogs.stdout, processLogs.stderr);
    return {
      status: 200,
      body: await coordinator.listRuntimeLogs(identity, request.cursor, request.limit),
    };
  }
  throw new ControlHttpError(404, "not_found", "Control endpoint not found");
}

function runtimeContainerId(env: WorkerBindings, identity: string): string {
  return env.NABUFLOW_SANDBOX.idFromName(identity).toString();
}

async function activatePublishedRoute(
  request: ActivateRouteRequest,
  env: WorkerBindings,
  coordinator: ControlCoordinator,
): Promise<StoredHttpResponse> {
  const route = request.route;
  if (route.role !== "production" || route.activeSlot !== "blue") {
    throw new ControlHttpError(
      400,
      "production_blue_required",
      "Published routes require the production-blue runtime",
    );
  }
  const parsedIdentity = await parseRuntimeIdentityForNamespace(
    route.sandboxIdentity,
    env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
  ).catch(() => null);
  if (
    parsedIdentity === null ||
    parsedIdentity.projectId !== route.projectId ||
    parsedIdentity.role !== "production" ||
    parsedIdentity.slot !== "blue"
  ) {
    throw new ControlHttpError(
      400,
      "invalid_route_identity",
      "Published route identity is invalid for this deployment",
    );
  }

  const runtime = await coordinator.getRuntime(route.sandboxIdentity);
  if (
    runtime === null ||
    runtime.descriptor.status !== "running" ||
    runtime.descriptor.role !== "production" ||
    runtime.descriptor.slot !== "blue" ||
    runtime.descriptor.projectId !== route.projectId ||
    runtime.descriptor.manifestRevision !== route.manifestRevision ||
    runtime.manifest.revision !== route.manifestRevision ||
    runtime.descriptor.servicePort !== route.servicePort ||
    runtime.manifest.servicePort !== route.servicePort
  ) {
    throw new ControlHttpError(
      409,
      "published_runtime_not_ready",
      "The production-blue runtime is not ready for route activation",
      true,
    );
  }

  const state = await coordinator.activateRoute(route, request.expectedPreviousManifestRevision);
  if (state === "conflict") {
    throw new ControlHttpError(
      409,
      "route_activation_conflict",
      "The published route changed before activation",
      true,
    );
  }
  return { status: 200, body: { ok: true, route } };
}

async function deactivatePublishedRoute(
  request: DeactivateRouteRequest,
  coordinator: ControlCoordinator,
): Promise<StoredHttpResponse> {
  const state = await coordinator.deactivateRoute(
    request.hostname,
    request.expectedManifestRevision,
    request.expectedSandboxIdentity,
  );
  if (state === "not_found") {
    throw new ControlHttpError(404, "published_route_not_found", "Published route not found");
  }
  if (state === "conflict") {
    throw new ControlHttpError(
      409,
      "route_deactivation_conflict",
      "The published route changed before removal",
      true,
    );
  }
  return { status: 200, body: { ok: true, hostname: request.hostname } };
}

function validateResponse(endpoint: Endpoint, body: unknown): void {
  const schema = {
    version: versionResponseSchema,
    ensure: ensureRuntimeResponseSchema,
    start: startRuntimeResponseSchema,
    stop: stopRuntimeResponseSchema,
    destroy: destroyRuntimeResponseSchema,
    status: statusRuntimeResponseSchema,
    exec: execRuntimeResponseSchema,
    logs: logsRuntimeResponseSchema,
    routeActivate: activateRouteResponseSchema,
    routeDeactivate: deactivateRouteResponseSchema,
    capabilityProvision: capabilityProvisionResponseSchema,
    capabilityRevoke: capabilityRevokeResponseSchema,
    databaseCapabilityProvision: capabilityProvisionResponseSchema,
    databaseCapabilityRevoke: capabilityRevokeResponseSchema,
    stripeCapabilityProvision: capabilityProvisionResponseSchema,
    stripeCapabilityRevoke: capabilityRevokeResponseSchema,
    capabilityBinding: capabilityBindingResponseSchema,
    artifactBegin: beginRuntimeArtifactResponseSchema,
    artifactChunk: uploadRuntimeArtifactChunkResponseSchema,
    artifactCommit: commitRuntimeArtifactResponseSchema,
    artifactRemove: removeRuntimeArtifactResponseSchema,
    manifestUpdate: ensureRuntimeResponseSchema,
  }[endpoint];
  const result = schema.safeParse(body);
  if (!result.success)
    throw new ControlHttpError(
      500,
      "invalid_worker_response",
      "Worker produced an invalid response",
    );
}

function artifactRuntimeMismatch(): ControlHttpError {
  return new ControlHttpError(
    403,
    "artifact_runtime_mismatch",
    "Artifact is not available for this runtime",
  );
}

function requestBodyLimit(pathname: string): number {
  if (/\/artifacts\/[0-9a-f]{64}\/chunks\/[0-9]+$/u.test(pathname))
    return RUNTIME_ARTIFACT_CHUNK_BYTES;
  if (/\/artifacts\/[0-9a-f]{64}\/begin$/u.test(pathname))
    return MAX_RUNTIME_ARTIFACT_MANIFEST_BYTES;
  return MAX_REQUEST_BYTES;
}

function assertArtifactInfrastructure(env: WorkerBindings): void {
  if (
    typeof env.CF_VERSION_METADATA?.id !== "string" ||
    env.CF_VERSION_METADATA.id.length === 0 ||
    typeof env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE !== "string" ||
    env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE.length === 0 ||
    !env.NABUFLOW_RUNTIME_ARTIFACTS ||
    typeof env.NABUFLOW_RUNTIME_ARTIFACTS.get !== "function" ||
    typeof env.NABUFLOW_RUNTIME_ARTIFACTS.put !== "function" ||
    typeof env.NABUFLOW_RUNTIME_ARTIFACTS.delete !== "function"
  ) {
    throw new ControlHttpError(
      503,
      "artifact_infrastructure_unavailable",
      "The runtime artifact infrastructure is not configured",
      false,
    );
  }
}

async function safelyStopFailedRuntime(
  backend: RuntimeBackend,
  runtime: StoredRuntime,
): Promise<void> {
  try {
    await backend.stop(runtime);
  } catch {
    // Preserve the typed start/restart failure; the runtime remains unbound and the cleanup path
    // can retry the stop or destroy operation without exposing the failed process to traffic.
  }
}

function logControlErrorFinalizationFailure(
  requestId: string,
  endpoint: Endpoint,
  operation: "idempotency" | "audit",
  error: unknown,
): void {
  // The client-facing error has already been classified. These Durable Object writes are
  // best-effort finalization and must never replace that primary typed response.
  // eslint-disable-next-line no-console -- metadata-only last-resort observability
  console.error(
    JSON.stringify({
      event: "control_error_finalization_failed",
      requestId,
      endpoint,
      operation,
      errorType: error instanceof Error ? error.name : "UnknownError",
    }),
  );
}

async function requireRuntime(
  coordinator: ControlCoordinator,
  identity: string,
): Promise<StoredRuntime> {
  const runtime = await coordinator.getRuntime(identity);
  if (runtime === null) throw new ControlHttpError(404, "runtime_not_found", "Runtime not found");
  return runtime;
}

function assertDeploymentVersion(expected: string, actual: string): void {
  if (expected !== actual) {
    throw new ControlHttpError(
      409,
      "worker_version_not_ready",
      "The requested Worker version has not propagated yet",
      true,
    );
  }
}

function readSignedRequest(
  request: Request,
  pathAndQuery: string,
  body: Uint8Array,
): {
  method: string;
  pathAndQuery: string;
  timestamp: string;
  nonce: string;
  bodySha256: string;
  idempotencyKey: string;
  signature: string;
  body: Uint8Array;
} | null {
  const timestamp = request.headers.get(AUTH_HEADERS.timestamp);
  const nonce = request.headers.get(AUTH_HEADERS.nonce);
  const bodySha256 = request.headers.get(AUTH_HEADERS.bodySha256);
  const signature = request.headers.get(AUTH_HEADERS.signature);
  if (timestamp === null || nonce === null || bodySha256 === null || signature === null)
    return null;
  return {
    method: request.method,
    pathAndQuery,
    timestamp,
    nonce,
    bodySha256,
    idempotencyKey: request.headers.get(AUTH_HEADERS.idempotencyKey) ?? "",
    signature,
    body,
  };
}

async function readCappedBody(request: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maxBytes) throw new RequestTooLargeError();
  if (request.body === null) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new RequestTooLargeError();
    }
    chunks.push(value);
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseJsonBody(rawBody: Uint8Array): unknown {
  if (rawBody.byteLength === 0)
    throw new ControlHttpError(400, "invalid_request", "JSON body is required");
  try {
    return JSON.parse(textDecoder.decode(rawBody)) as unknown;
  } catch {
    throw new ControlHttpError(
      400,
      "invalid_request",
      "Control request must contain valid UTF-8 JSON",
    );
  }
}

function parseStrict<T>(
  schema: { safeParse(value: unknown): { success: true; data: T } | { success: false } },
  value: unknown,
): T {
  const result = schema.safeParse(value);
  if (!result.success)
    throw new ControlHttpError(400, "invalid_request", "Control request failed strict validation");
  return result.data;
}

function assertNoQuery(url: URL): void {
  if (url.search)
    throw new ControlHttpError(
      400,
      "invalid_request",
      "This control endpoint does not accept query parameters",
    );
}

function assertEmptyBody(rawBody: Uint8Array): void {
  if (rawBody.byteLength !== 0)
    throw new ControlHttpError(
      400,
      "invalid_request",
      "This control endpoint does not accept a body",
    );
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : "Unknown runtime error";
}

function toControlError(error: unknown): ControlHttpError {
  if (error instanceof ControlHttpError) return error;
  return new ControlHttpError(500, "internal_error", "The staging control plane failed", true);
}

function errorBody(error: ControlHttpError, requestId: string): unknown {
  return controlErrorResponseSchema.parse({
    ok: false,
    code: error.code,
    message: error.message,
    retryable: error.retryable,
    requestId,
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  requestId: string,
  headers: HeadersInit = {},
): Response {
  return jsonResponse(
    status,
    errorBody(new ControlHttpError(status, code, message, retryable), requestId),
    headers,
  );
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

async function recordAudit(
  coordinator: ControlCoordinator,
  requestId: string,
  method: string,
  endpoint: string,
  locator: RuntimeLocator | null,
  outcome: { status: number; code: string },
  projectIdOverride?: number,
): Promise<void> {
  await coordinator.recordAudit({
    requestId,
    timestamp: new Date().toISOString(),
    method,
    endpoint,
    stage: null,
    outcome: outcome.code,
    projectId: locator?.projectId ?? projectIdOverride ?? null,
    role: locator?.role ?? null,
    slot: locator?.slot ?? null,
    status: outcome.status,
  });
}
