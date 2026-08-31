import {
  CONTROL_PROTOCOL_VERSION,
  CONTROL_FEATURES,
  MAX_RUNTIME_ARTIFACT_BYTES,
  MAX_RUNTIME_ARTIFACT_FILE_BYTES,
  MAX_RUNTIME_ARTIFACT_FILES,
  MAX_RUNTIME_ARTIFACT_MANIFEST_BYTES,
  MAX_RUNTIME_ARTIFACT_LAYERED_MANIFEST_BYTES,
  TRUSTED_BUILD_MAX_REQUEST_BYTES,
  RUNTIME_ARTIFACT_CHUNK_BYTES,
  RUNTIME_ARTIFACT_PENDING_TTL_MS,
  RUNTIME_ROLES,
  RUNTIME_RECONCILIATION_SEMANTICS_VERSION,
  activateRouteRequestSchema,
  activateRouteResponseSchema,
  capabilityProvisionResponseSchema,
  capabilityRevokeResponseSchema,
  capabilityBindingResponseSchema,
  beginRuntimeArtifactRequestSchema,
  beginRuntimeArtifactResponseSchema,
  beginRuntimeLayeredArtifactRequestSchema,
  beginRuntimeLayeredArtifactResponseSchema,
  commitRuntimeArtifactRequestSchema,
  commitRuntimeArtifactResponseSchema,
  commitRuntimeLayeredArtifactRequestSchema,
  commitRuntimeLayeredArtifactResponseSchema,
  controlErrorResponseSchema,
  deactivateRouteRequestSchema,
  deactivateRouteResponseSchema,
  routeInventoryRequestSchema,
  routeInventoryResponseSchema,
  routeReadRequestSchema,
  routeReadResponseSchema,
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
  removeRuntimeLayeredArtifactRequestSchema,
  removeRuntimeLayeredArtifactResponseSchema,
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
  reconcileRuntimeRequestSchema,
  reconcileRuntimeResponseSchema,
  runtimeReconciliationAuditResponseSchema,
  runtimeReconciliationObservationSchema,
  stopRuntimeRequestSchema,
  stopRuntimeResponseSchema,
  verifyControlRequestSignature,
  verifyRuntimeArtifactEnvelope,
  verifyRuntimeLayeredArtifactEnvelope,
  versionResponseSchema,
  updateRuntimeManifestRequestSchema,
  uploadRuntimeArtifactChunkResponseSchema,
  uploadRuntimeLayeredArtifactChunkResponseSchema,
  canonicalJson,
  pantryPlatformSchema,
  pantryCatalogAssemblyDiagnosticsResponseSchema,
  pantryCatalogAssemblyStatusResponseSchema,
  pantryCatalogObjectInventoryResponseSchema,
  pantryCatalogErrorResponseSchema,
  pantryCatalogStockResponseSchema,
  pantryCatalogStockIdentityStatusResponseSchema,
  pantryShelfContentHashesResponseSchema,
  artifactCommitDiagnosticsResponseSchema,
  layeredArtifactPromotionDiagnosticsResponseSchema,
  productionDatabaseDiagnosticsResponseSchema,
  durableOperationDiscoveryRequestSchema,
  durableOperationDiscoveryResponseSchema,
  DURABLE_OPERATION_DISCOVERY_MAX_WINDOW_MS,
  DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS,
  runtimeManifestRestartDiagnosticsResponseSchema,
  runtimeStartDiagnosticsResponseSchema,
  promoteRuntimeLayeredArtifactRequestSchema,
  promoteRuntimeLayeredArtifactResponseSchema,
  ensureProductionDatabaseRequestSchema,
  releaseProductionDatabaseRequestSchema,
  productionDatabaseAllocationResponseSchema,
  productionDatabaseReleaseResponseSchema,
  productionDatabaseAllocationIdentity,
  productionDatabaseCapabilityDefinition,
  runtimeArtifactSealedHash,
  runtimeLayeredArtifactContentHash,
  runtimeLayeredArtifactMergedReleaseHash,
  runtimeLayeredArtifactSealedHash,
} from "@workspace/tenant-runtime-contracts";
import type {
  ActivateRouteRequest,
  BeginRuntimeArtifactRequest,
  BeginRuntimeLayeredArtifactRequest,
  CommitRuntimeArtifactRequest,
  CommitRuntimeLayeredArtifactRequest,
  ProvisionDatabaseCapabilityRequest,
  ProvisionEchoCapabilityRequest,
  ProvisionStripeCapabilityRequest,
  RevokeDatabaseCapabilityRequest,
  RevokeEchoCapabilityRequest,
  RevokeStripeCapabilityRequest,
  DeactivateRouteRequest,
  RouteInventoryRequest,
  RouteReadRequest,
  DestroyRuntimeRequest,
  EnsureRuntimeRequest,
  ExecRuntimeRequest,
  LogsRuntimeRequest,
  RuntimeLocator,
  RemoveRuntimeArtifactRequest,
  RemoveRuntimeLayeredArtifactRequest,
  StartRuntimeRequest,
  StatusRuntimeRequest,
  ReconcileRuntimeRequest,
  RuntimeReconciliationAuditRecord,
  RuntimeReconciliationEvidence,
  StopRuntimeRequest,
  UpdateRuntimeManifestRequest,
  PantryPlatform,
  RuntimeArtifactLayerContent,
  DurableOperationDiscoveryRequest,
  PromoteRuntimeLayeredArtifactRequest,
  EnsureProductionDatabaseRequest,
  ReleaseProductionDatabaseRequest,
  ProductionDatabaseJobRequest,
  RouteRecord,
} from "@workspace/tenant-runtime-contracts";
import { createHash } from "node:crypto";
import type { WorkerBindings } from "./bindings";
import type { CapabilityVaultDurableObject } from "./capability-vault-durable-object";
import { CAPABILITY_ENDPOINT, handleCapabilityRequest } from "./capability-endpoint";
import type { ControlDurableObject } from "./control-durable-object";
import type {
  CapabilityVault,
  StoredArtifactCommitJob,
  StoredDurableOperationJob,
  StoredRuntimeManifestRestartJob,
  StoredRuntimeStartJob,
  StoredLayeredArtifactPromotionJob,
  StoredProductionDatabaseJob,
  DurableOperationQueueMessage,
  DurableOperationRegistration,
  ControlCoordinator,
  StoredHttpResponse,
  StoredRuntime,
  StoredRuntimeArtifact,
  StoredRuntimeLayer,
  StoredRuntimeLayeredArtifact,
  RemovedRuntimeLayeredArtifact,
} from "./model";
import {
  ProductionDatabaseAllocator,
  ProductionDatabaseProviderError,
} from "./production-database-allocator";
import { deferDurableOperationForWrongDeployment } from "./durable-operation-deployment";
import { artifactChunkKey, deleteArtifactObjects } from "./artifact-storage";
import {
  deleteDependencyLayerObjects,
  deleteLayeredArtifactAppObjects,
  dependencyLayerChunkKey,
  layeredArtifactAppChunkKey,
} from "./artifact-layer-storage";
import {
  handlePublishedDataPlaneRequest,
  schedulePublishedRuntimeRecovery,
} from "./published-data-plane";
import { handlePreviewDataPlaneRequest } from "./preview-data-plane";
import { CloudflareSandboxBackend, type RuntimeBackend } from "./runtime-backend";
import { driveRoutePolicyReconciliation } from "./route-policy-reconciliation";
import {
  ARTIFACT_COMMIT_ABORT_BEFORE_PREFIX,
  ARTIFACT_COMMIT_ABORT_ALWAYS_PREFIX,
  ARTIFACT_COMMIT_ABORT_CHECKPOINT_PREFIX,
  ARTIFACT_COMMIT_ABORT_MID_PREFIX,
  StagingArtifactCommitOwnerLossError,
  StagingDurableOperationOwnerLossError,
  RUNTIME_START_ABORT_ALWAYS_PREFIX,
  RUNTIME_START_ABORT_CHECKPOINT_PREFIX,
  RUNTIME_MANIFEST_RESTART_ABORT_ALWAYS_PREFIX,
  RUNTIME_MANIFEST_RESTART_ABORT_CHECKPOINT_PREFIX,
} from "./artifact-commit-recovery";

const CONTROL_PREFIX = "/_nabuflow/control/v1";
const MAX_REQUEST_BYTES = 256 * 1024;
const MUTATION_ENDPOINTS = new Set<Endpoint>([
  "ensure",
  "start",
  "reconcile",
  "stop",
  "destroy",
  "exec",
  "routeActivate",
  "routeDeactivate",
  "capabilityProvision",
  "capabilityRevoke",
  "databaseCapabilityProvision",
  "databaseCapabilityRevoke",
  "productionDatabaseEnsure",
  "productionDatabaseRelease",
  "stripeCapabilityProvision",
  "stripeCapabilityRevoke",
  "artifactBegin",
  "artifactChunk",
  "artifactCommit",
  "artifactRemove",
  "layeredArtifactBegin",
  "layeredArtifactAppChunk",
  "layeredArtifactLayerChunk",
  "layeredArtifactCommit",
  "layeredArtifactRemove",
  "layeredArtifactPromotion",
  "manifestUpdate",
  "pantryMutation",
  "buildMutation",
]);
const DURABLE_OPERATION_ENDPOINTS = new Set<Endpoint>([
  "artifactCommit",
  "layeredArtifactCommit",
  "start",
  "layeredArtifactPromotion",
  "productionDatabaseEnsure",
  "productionDatabaseRelease",
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
  | "durableOperationDiscovery"
  | "reconciliationAudit"
  | "ensure"
  | "start"
  | "startDiagnostics"
  | "manifestUpdateDiagnostics"
  | "stop"
  | "destroy"
  | "status"
  | "reconcile"
  | "exec"
  | "logs"
  | "routeActivate"
  | "routeDeactivate"
  | "routeInventory"
  | "routeRead"
  | "capabilityProvision"
  | "capabilityRevoke"
  | "databaseCapabilityProvision"
  | "databaseCapabilityRevoke"
  | "productionDatabaseEnsure"
  | "productionDatabaseRelease"
  | "productionDatabaseDiagnostics"
  | "stripeCapabilityProvision"
  | "stripeCapabilityRevoke"
  | "capabilityBinding"
  | "artifactBegin"
  | "artifactChunk"
  | "artifactCommit"
  | "artifactCommitDiagnostics"
  | "artifactRemove"
  | "layeredArtifactBegin"
  | "layeredArtifactAppChunk"
  | "layeredArtifactLayerChunk"
  | "layeredArtifactCommit"
  | "layeredArtifactCommitDiagnostics"
  | "layeredArtifactRemove"
  | "layeredArtifactPromotion"
  | "layeredArtifactPromotionDiagnostics"
  | "manifestUpdate"
  | "pantryRead"
  | "pantryMutation"
  | "buildRead"
  | "buildMutation";

interface MatchedRoute {
  endpoint: Endpoint;
  locator: RuntimeLocator | null;
  hostname?: string;
  projectId?: number;
  auditRequestId?: string;
  capability?: { projectId: number; provider: string; name: string };
  artifactSha256?: string;
  promotionIdentity?: string;
  allocationIdentity?: string;
  layerContentSha256?: string;
  chunkIndex?: number;
  pantryPath?: string;
  pantryMethod?: string;
  pantryPrincipal?: "catalog-admin" | "builder-readonly" | "catalog-gc";
  buildPath?: string;
  buildMethod?: string;
  buildPrincipal?: "build-control" | "build-readonly" | "build-gc";
}

interface WorkerDependencies {
  coordinator?: ControlCoordinator;
  backend?: RuntimeBackend;
  nowMs?: number;
  requestId?: string;
  context?: RequestExecutionContext;
  vault?: CapabilityVault;
  productionDatabaseAllocator?: Pick<
    ProductionDatabaseAllocator,
    "ensure" | "release" | "verifyGone"
  >;
}

type CommittedRuntimeArtifact =
  | { kind: "v1"; artifact: StoredRuntimeArtifact }
  | {
      kind: "layers-v1";
      artifact: StoredRuntimeLayeredArtifact;
      layers: StoredRuntimeLayer[];
    };

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

interface DurableOperationExecution {
  job: StoredDurableOperationJob;
  ownerId: string;
}

class ControlHttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryable = false,
    readonly evidence?: RuntimeReconciliationEvidence,
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
  const backend =
    dependencies.backend ??
    new CloudflareSandboxBackend(env, () => dependencies.nowMs ?? Date.now());
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
  const idempotencyStorageKey =
    route.endpoint === "reconcile"
      ? `${RUNTIME_RECONCILIATION_SEMANTICS_VERSION}:${idempotencyKey}`
      : idempotencyKey;
  const needsIdempotency = MUTATION_ENDPOINTS.has(route.endpoint);
  const persistRequestAudit = route.endpoint !== "reconciliationAudit";
  const needsDurableOperation =
    DURABLE_OPERATION_ENDPOINTS.has(route.endpoint) ||
    (route.endpoint === "manifestUpdate" &&
      (input as UpdateRuntimeManifestRequest).restart === "restart");
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
    const durableRegistration = needsDurableOperation
      ? await durableOperationRegistrationFor(
          route,
          input,
          env,
          idempotencyStorageKey,
          idempotencyFingerprint,
          nowMs,
        )
      : null;
    const lookup =
      durableRegistration !== null
        ? await coordinator.registerDurableOperation(durableRegistration)
        : await coordinator.beginIdempotency(idempotencyStorageKey, idempotencyFingerprint, nowMs);
    const durableJob =
      "job" in lookup ? (lookup.job as StoredDurableOperationJob | undefined) : undefined;
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
    if (
      needsDurableOperation &&
      (lookup.state === "new" || lookup.state === "pending") &&
      durableJob !== undefined
    ) {
      await nudgeDurableOperation(coordinator, env, durableJob, nowMs);
      await recordAudit(
        coordinator,
        requestId,
        request.method,
        route.endpoint,
        route.locator,
        { status: 409, code: "request_in_progress" },
        route.capability?.projectId,
      );
      return errorResponse(
        409,
        "request_in_progress",
        "The durable operation is in progress",
        true,
        requestId,
        { "retry-after": "1" },
      );
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
      null,
      nowMs,
      dependencies.productionDatabaseAllocator,
      requestId,
    );
    validateResponse(route.endpoint, result.body);
    if (needsIdempotency && idempotencyFingerprint !== null) {
      await coordinator.completeIdempotency(
        idempotencyStorageKey,
        idempotencyFingerprint,
        result,
        nowMs,
      );
    }
    if (persistRequestAudit) {
      await recordAudit(
        coordinator,
        requestId,
        request.method,
        route.endpoint,
        route.locator,
        { status: result.status, code: "ok" },
        route.capability?.projectId,
      );
    }
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
        // An operation follower may have lost the original transport response
        // after the Worker accepted the mutation. Preserve every typed terminal
        // response so the same idempotency key can observe it without executing
        // the mutation twice. A deliberate new operation uses a new key.
        const body = errorBody(controlError, requestId);
        await coordinator.completeIdempotency(
          idempotencyStorageKey,
          idempotencyFingerprint,
          { status: controlError.status, body },
          nowMs,
        );
      } catch (finalizationError) {
        logControlErrorFinalizationFailure(
          requestId,
          route.endpoint,
          "idempotency",
          finalizationError,
        );
      }
    }
    if (persistRequestAudit) {
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
    }
    return errorResponse(
      controlError.status,
      controlError.code,
      controlError.message,
      controlError.retryable,
      requestId,
      {},
      controlError.evidence,
    );
  }
}

export async function handleDurableOperationQueue(
  batch: MessageBatch<DurableOperationQueueMessage>,
  env: WorkerBindings,
  dependencies: Pick<
    WorkerDependencies,
    "coordinator" | "backend" | "nowMs" | "vault" | "productionDatabaseAllocator"
  > = {},
): Promise<void> {
  const coordinator = dependencies.coordinator ?? getCoordinator(env);
  const backend = dependencies.backend ?? new CloudflareSandboxBackend(env);
  for (const message of batch.messages) {
    const body = message.body;
    if (
      body?.schemaVersion !== 1 ||
      !body.jobKey.startsWith("durable-operation-job:") ||
      !/^nrf-[a-z0-9-]+$/u.test(body.runtimeIdentity) ||
      (body.kind !== "v1" &&
        body.kind !== "layers-v1" &&
        body.kind !== "runtime-start" &&
        body.kind !== "runtime-manifest-restart" &&
        body.kind !== "layered-artifact-promotion" &&
        body.kind !== "production-database") ||
      (body.kind === "runtime-start"
        ? body.subjectKey !== "start"
        : body.kind === "runtime-manifest-restart"
          ? body.subjectKey !== "manifest-restart"
          : !/^[0-9a-f]{64}$/u.test(body.subjectKey))
    ) {
      message.ack();
      continue;
    }
    const ownerId = crypto.randomUUID();
    const nowMs = dependencies.nowMs ?? Date.now();
    const deploymentDisposition = await deferDurableOperationForWrongDeployment({
      coordinator,
      message: body,
      deploymentVersion: env.CF_VERSION_METADATA.id,
      nowMs,
    });
    if (deploymentDisposition === "ignore") {
      message.ack();
      continue;
    }
    if (deploymentDisposition === "deferred") {
      message.ack();
      continue;
    }
    const claim = await coordinator.claimDurableOperationDriver(body.jobKey, ownerId, nowMs);
    if (claim.state === "not_found" || claim.state === "terminal") {
      message.ack();
      continue;
    }
    if (claim.state === "busy") {
      // The independently scheduled lease alarm owns redelivery if the live driver disappears.
      message.ack();
      continue;
    }
    const job = claim.job;
    if (
      job.runtimeIdentity !== body.runtimeIdentity ||
      job.subjectKey !== body.subjectKey ||
      job.kind !== body.kind
    ) {
      const response = errorBody(
        new ControlHttpError(
          503,
          "durable_operation_queue_invalid",
          "Durable operation queue metadata is invalid",
        ),
        ownerId,
      );
      await coordinator.failDurableOperation(
        job.jobKey,
        ownerId,
        job.attempt,
        { status: 503, body: response },
        nowMs,
      );
      message.ack();
      continue;
    }
    const parsedIdentity = await parseRuntimeIdentityForNamespace(
      job.runtimeIdentity,
      env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    );
    const locator: RuntimeLocator = {
      projectId: parsedIdentity.projectId,
      role: parsedIdentity.role,
      slot: parsedIdentity.slot,
    };
    const endpoint: Endpoint =
      job.kind === "v1"
        ? "artifactCommit"
        : job.kind === "layers-v1"
          ? "layeredArtifactCommit"
          : job.kind === "runtime-start"
            ? "start"
            : job.kind === "runtime-manifest-restart"
              ? "manifestUpdate"
              : job.kind === "layered-artifact-promotion"
                ? "layeredArtifactPromotion"
                : (job as StoredProductionDatabaseJob).request.action === "ensure"
                  ? "productionDatabaseEnsure"
                  : "productionDatabaseRelease";
    const route: MatchedRoute = {
      endpoint,
      locator,
      ...(job.kind === "v1" || job.kind === "layers-v1"
        ? { artifactSha256: job.sealedArtifactSha256 }
        : {}),
    };
    const input:
      | CommitRuntimeArtifactRequest
      | CommitRuntimeLayeredArtifactRequest
      | StartRuntimeRequest
      | UpdateRuntimeManifestRequest
      | PromoteRuntimeLayeredArtifactRequest
      | ProductionDatabaseJobRequest =
      job.kind === "runtime-start" || job.kind === "runtime-manifest-restart"
        ? job.request
        : job.kind === "layered-artifact-promotion" || job.kind === "production-database"
          ? job.request
          : {
              locator,
              expectedDeploymentVersion: job.expectedDeploymentVersion,
              sealedArtifactSha256: job.sealedArtifactSha256,
            };
    const execution: DurableOperationExecution = { job, ownerId };
    // eslint-disable-next-line no-console -- metadata-only durable driver evidence
    console.log(
      JSON.stringify({
        event:
          claim.state === "adopted"
            ? "durable_operation_driver_adopted"
            : "durable_operation_driver_claimed",
        kind: job.kind,
        attempt: job.attempt,
        checkpoint: job.checkpoint,
      }),
    );
    const heartbeat = startDurableOperationHeartbeat(coordinator, execution, dependencies.nowMs);
    try {
      let result: StoredHttpResponse;
      try {
        result = await executeEndpoint(
          endpoint,
          input,
          env,
          coordinator,
          backend,
          dependencies.vault,
          route,
          execution,
          dependencies.nowMs ?? Date.now(),
          dependencies.productionDatabaseAllocator,
        );
        validateResponse(endpoint, result.body);
      } catch (error) {
        if (error instanceof StagingDurableOperationOwnerLossError) {
          // Deliberately leave this queue delivery unacknowledged. Queue redelivery and the
          // coordinator alarm are independent recovery paths and both resume by checkpoint.
          // eslint-disable-next-line no-console -- metadata-only staging recovery evidence
          console.error(
            JSON.stringify({
              event: "durable_operation_staging_driver_terminated",
              kind: job.kind,
              attempt: job.attempt,
              checkpoint: execution.job.checkpoint,
              stage: error.stage,
            }),
          );
          throw error;
        }
        const controlError = toControlError(error);
        try {
          await coordinator.failDurableOperation(
            job.jobKey,
            ownerId,
            job.attempt,
            { status: controlError.status, body: errorBody(controlError, ownerId) },
            Date.now(),
          );
        } catch (finalizationError) {
          logControlErrorFinalizationFailure(ownerId, endpoint, "idempotency", finalizationError);
          throw finalizationError;
        }
        message.ack();
        continue;
      }
      try {
        const finalization = await coordinator.completeDurableOperation(
          job.jobKey,
          ownerId,
          job.attempt,
          result,
          Date.now(),
        );
        if (finalization !== "completed") {
          // A newer generation or the durable deadline already owns the terminal result. The
          // stale delivery is acknowledged; it must never replace that result with an exception.
          message.ack();
          continue;
        }
      } catch (finalizationError) {
        logControlErrorFinalizationFailure(ownerId, endpoint, "idempotency", finalizationError);
        throw finalizationError;
      }
      message.ack();
    } finally {
      await heartbeat.stop();
    }
  }
}

type ControlInput =
  | Record<string, never>
  | Uint8Array
  | DurableOperationDiscoveryRequest
  | BeginRuntimeArtifactRequest
  | CommitRuntimeArtifactRequest
  | RemoveRuntimeArtifactRequest
  | UpdateRuntimeManifestRequest
  | ActivateRouteRequest
  | DeactivateRouteRequest
  | RouteInventoryRequest
  | RouteReadRequest
  | EnsureRuntimeRequest
  | StartRuntimeRequest
  | StopRuntimeRequest
  | DestroyRuntimeRequest
  | StatusRuntimeRequest
  | ReconcileRuntimeRequest
  | ExecRuntimeRequest
  | LogsRuntimeRequest
  | ProvisionEchoCapabilityRequest
  | RevokeEchoCapabilityRequest
  | ProvisionDatabaseCapabilityRequest
  | RevokeDatabaseCapabilityRequest
  | EnsureProductionDatabaseRequest
  | ReleaseProductionDatabaseRequest
  | ProvisionStripeCapabilityRequest
  | RevokeStripeCapabilityRequest
  | PromoteRuntimeLayeredArtifactRequest;

function getCoordinator(env: WorkerBindings): DurableObjectStub<ControlDurableObject> {
  return env.CONTROL_COORDINATOR.get(env.CONTROL_COORDINATOR.idFromName("control-v1"));
}

function durableOperationQueueMessage(
  job: StoredDurableOperationJob,
): DurableOperationQueueMessage {
  return {
    schemaVersion: 1,
    jobKey: job.jobKey,
    runtimeIdentity: job.runtimeIdentity,
    subjectKey: job.subjectKey,
    kind: job.kind,
  };
}

async function nudgeDurableOperation(
  coordinator: ControlCoordinator,
  env: WorkerBindings,
  job: StoredDurableOperationJob,
  nowMs: number,
): Promise<void> {
  await coordinator.recordDurableOperationNudge(job.jobKey, nowMs);
  try {
    await env.DURABLE_OPERATION_QUEUE?.send(durableOperationQueueMessage(job));
  } catch {
    // The coordinator watchdog retries this nudge independently of the request.
    // eslint-disable-next-line no-console -- metadata-only queue availability evidence
    console.error(
      JSON.stringify({
        event: "durable_operation_queue_nudge_failed",
        kind: job.kind,
        checkpoint: job.checkpoint,
        attempt: job.attempt,
      }),
    );
  }
}

async function scheduleRuntimeReconciliationRepair(input: {
  coordinator: ControlCoordinator;
  env: WorkerBindings;
  identity: string;
  runtime: StoredRuntime;
  request: ReconcileRuntimeRequest;
  nowMs: number;
}): Promise<{ jobKey: string; state: "active" | "succeeded" | "failed"; attempt: number }> {
  assertArtifactInfrastructure(input.env);
  if (input.runtime.artifactRevision === null || input.runtime.artifactSha256 === null) {
    throw new ControlHttpError(
      409,
      "runtime_reconciliation_artifact_missing",
      "Runtime reconciliation cannot restart without a committed artifact",
      false,
    );
  }
  const request = startRuntimeRequestSchema.parse({
    locator: input.request.locator,
    expectedDeploymentVersion: input.env.CF_VERSION_METADATA.id,
    artifactRevision: input.runtime.artifactRevision,
    artifactSha256: input.runtime.artifactSha256,
  });
  const key = `${RUNTIME_RECONCILIATION_SEMANTICS_VERSION}:${input.request.reconciliationId}:runtime-start-repair`;
  const fingerprint = await sha256Hex(
    canonicalJson({
      action: "restart-and-rebind",
      runtimeIdentity: input.identity,
      request,
    }),
  );
  const claim = await input.coordinator.registerDurableOperation({
    key,
    fingerprint,
    kind: "runtime-start",
    runtimeIdentity: input.identity,
    subjectKey: "start",
    request,
    expectedDeploymentVersion: request.expectedDeploymentVersion,
    nowMs: input.nowMs,
  });
  if (claim.state === "conflict") {
    throw new ControlHttpError(
      409,
      "runtime_reconciliation_repair_conflict",
      "Runtime reconciliation repair identity conflicts with another request",
      false,
    );
  }
  if (claim.state === "replay" && (claim.response.status < 200 || claim.response.status >= 300)) {
    throw new ControlHttpError(
      503,
      "runtime_reconciliation_repair_failed",
      "The durable runtime reconciliation repair reached a typed failure",
      true,
    );
  }
  const job =
    "job" in claim && claim.job !== undefined
      ? claim.job
      : await input.coordinator.getLatestDurableOperation("runtime-start", input.identity, "start");
  if (job === null || job.kind !== "runtime-start") {
    throw new ControlHttpError(
      503,
      "runtime_reconciliation_repair_unavailable",
      "The durable runtime reconciliation repair could not be observed",
      true,
    );
  }
  if (job.state === "active") {
    await nudgeDurableOperation(input.coordinator, input.env, job, input.nowMs);
  }
  return { jobKey: job.jobKey, state: job.state, attempt: job.attempt };
}

async function durableOperationRegistrationFor(
  route: MatchedRoute,
  input: ControlInput,
  env: WorkerBindings,
  key: string,
  fingerprint: string,
  nowMs: number,
): Promise<DurableOperationRegistration> {
  const runtimeIdentity = await runtimeIdentityForRoute(route, env);
  if (route.endpoint === "start") {
    const request = input as StartRuntimeRequest;
    return {
      key,
      fingerprint,
      kind: "runtime-start",
      runtimeIdentity,
      subjectKey: "start",
      request,
      expectedDeploymentVersion: request.expectedDeploymentVersion,
      nowMs,
    };
  }
  if (route.endpoint === "manifestUpdate") {
    const request = input as UpdateRuntimeManifestRequest;
    return {
      key,
      fingerprint,
      kind: "runtime-manifest-restart",
      runtimeIdentity,
      subjectKey: "manifest-restart",
      request,
      expectedDeploymentVersion: request.expectedDeploymentVersion,
      nowMs,
    };
  }
  if (route.endpoint === "layeredArtifactPromotion") {
    const request = input as PromoteRuntimeLayeredArtifactRequest;
    return {
      key,
      fingerprint,
      kind: "layered-artifact-promotion",
      runtimeIdentity,
      subjectKey: request.promotionIdentity,
      request,
      expectedDeploymentVersion: request.expectedDeploymentVersion,
      nowMs,
    };
  }
  if (
    route.endpoint === "productionDatabaseEnsure" ||
    route.endpoint === "productionDatabaseRelease"
  ) {
    const request = input as ProductionDatabaseJobRequest;
    return {
      key,
      fingerprint,
      kind: "production-database",
      runtimeIdentity,
      subjectKey: request.allocationIdentity,
      request,
      expectedDeploymentVersion: request.expectedDeploymentVersion,
      nowMs,
    };
  }
  const request = input as CommitRuntimeArtifactRequest | CommitRuntimeLayeredArtifactRequest;
  return {
    key,
    fingerprint,
    kind: route.endpoint === "artifactCommit" ? "v1" : "layers-v1",
    runtimeIdentity,
    subjectKey: request.sealedArtifactSha256,
    sealedArtifactSha256: request.sealedArtifactSha256,
    expectedDeploymentVersion: request.expectedDeploymentVersion,
    nowMs,
  };
}

async function runtimeIdentityForRoute(route: MatchedRoute, env: WorkerBindings): Promise<string> {
  if (route.locator === null) {
    throw new ControlHttpError(400, "invalid_request", "Runtime operation route is incomplete");
  }
  return deriveRuntimeIdentity({
    namespace: env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    ...route.locator,
  });
}

function startDurableOperationHeartbeat(
  coordinator: ControlCoordinator,
  execution: DurableOperationExecution,
  fixedNowMs: number | undefined,
): { stop(): Promise<void> } {
  const localStartedAt = Date.now();
  let stopped = false;
  let chain = Promise.resolve();
  const timer = setInterval(() => {
    const nowMs =
      fixedNowMs === undefined ? Date.now() : fixedNowMs + (Date.now() - localStartedAt);
    chain = chain.then(async () => {
      if (stopped) return;
      // Keep the renewal RPC anchored to this queue delivery and retry transient RPC weather
      // inside the lease window. A generation/owner mismatch is authoritative and is not retried.
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const renewed = await coordinator.renewDurableOperation(
            execution.job.jobKey,
            execution.ownerId,
            execution.job.attempt,
            nowMs,
          );
          if (renewed !== "renewed") return;
          return;
        } catch {
          if (attempt === 3) return;
          await new Promise((resolve) => setTimeout(resolve, attempt * 100));
        }
      }
    });
  }, 5_000);
  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await chain;
    },
  };
}

function stagingCommitRecoveryEnabled(env: WorkerBindings): boolean {
  return env.NABUFLOW_STAGING_ARTIFACT_COMMIT_RECOVERY_PROBE === "enabled";
}

function maybeAbortStagingCommitBeforeMaterializer(
  env: WorkerBindings,
  artifactRevision: string,
  job: StoredArtifactCommitJob,
): void {
  if (
    stagingCommitRecoveryEnabled(env) &&
    job.attempt === 1 &&
    artifactRevision.startsWith(ARTIFACT_COMMIT_ABORT_BEFORE_PREFIX)
  ) {
    throw new StagingArtifactCommitOwnerLossError("before-materializer");
  }
}

function maybeAbortStagingCommitAtCheckpoint(
  env: WorkerBindings,
  artifactRevision: string,
  job: StoredArtifactCommitJob,
): void {
  if (
    stagingCommitRecoveryEnabled(env) &&
    ((job.attempt === 1 &&
      artifactRevision.startsWith(
        `${ARTIFACT_COMMIT_ABORT_CHECKPOINT_PREFIX}${job.checkpoint}-`,
      )) ||
      (job.checkpoint === "initialized" &&
        artifactRevision.startsWith(ARTIFACT_COMMIT_ABORT_ALWAYS_PREFIX)))
  ) {
    throw new StagingArtifactCommitOwnerLossError(`checkpoint-${job.checkpoint}`);
  }
}

function stagingMaterializationOptions(
  env: WorkerBindings,
  artifactRevision: string,
  job: StoredArtifactCommitJob,
): { stagingAbortAfterFiles: number } | undefined {
  return stagingCommitRecoveryEnabled(env) &&
    job.attempt === 1 &&
    artifactRevision.startsWith(ARTIFACT_COMMIT_ABORT_MID_PREFIX)
    ? { stagingAbortAfterFiles: 1 }
    : undefined;
}

function maybeAbortStagingRuntimeStartAtCheckpoint(
  env: WorkerBindings,
  job: StoredRuntimeStartJob,
): void {
  if (
    env.NABUFLOW_STAGING_RUNTIME_LIFECYCLE_RECOVERY_PROBE === "enabled" &&
    ((job.attempt === 1 &&
      job.request.artifactRevision.startsWith(
        `${RUNTIME_START_ABORT_CHECKPOINT_PREFIX}${job.checkpoint}-`,
      )) ||
      (job.checkpoint === "initialized" &&
        job.request.artifactRevision.startsWith(RUNTIME_START_ABORT_ALWAYS_PREFIX)))
  ) {
    throw new StagingDurableOperationOwnerLossError(`checkpoint-${job.checkpoint}`);
  }
}

function maybeAbortStagingRuntimeManifestRestartAtCheckpoint(
  env: WorkerBindings,
  job: StoredRuntimeManifestRestartJob,
): void {
  if (
    env.NABUFLOW_STAGING_RUNTIME_LIFECYCLE_RECOVERY_PROBE === "enabled" &&
    ((job.attempt === 1 &&
      job.request.manifest.revision.startsWith(
        `${RUNTIME_MANIFEST_RESTART_ABORT_CHECKPOINT_PREFIX}${job.checkpoint}-`,
      )) ||
      (job.checkpoint === "initialized" &&
        job.request.manifest.revision.startsWith(RUNTIME_MANIFEST_RESTART_ABORT_ALWAYS_PREFIX)))
  ) {
    throw new StagingDurableOperationOwnerLossError(`checkpoint-${job.checkpoint}`);
  }
}

function logDurableOperationCheckpoint(job: StoredDurableOperationJob): void {
  // eslint-disable-next-line no-console -- metadata-only durable checkpoint evidence
  console.log(
    JSON.stringify({
      event: "durable_operation_checkpoint",
      kind: job.kind,
      attempt: job.attempt,
      checkpoint: job.checkpoint,
    }),
  );
}

function logArtifactCommitCheckpoint(job: StoredArtifactCommitJob): void {
  // eslint-disable-next-line no-console -- metadata-only durable checkpoint evidence
  console.log(
    JSON.stringify({
      event: "artifact_commit_checkpoint",
      kind: job.kind,
      attempt: job.attempt,
      checkpoint: job.checkpoint,
      payloads: job.payloadContentSha256s?.length ?? 0,
    }),
  );
}

function getCapabilityVault(
  env: WorkerBindings,
  projectId: number,
): DurableObjectStub<CapabilityVaultDurableObject> {
  return env.CAPABILITY_VAULT.get(env.CAPABILITY_VAULT.idFromName(`project:${projectId}`));
}

const PRODUCTION_DATABASE_CHECKPOINTS = [
  "initialized",
  "ownership-verified",
  "provider-complete",
  "provider-verified",
  "vault-complete",
  "finalized",
] as const;

async function advanceProductionDatabaseCheckpoint(
  coordinator: ControlCoordinator,
  execution: DurableOperationExecution & { job: StoredProductionDatabaseJob },
  target: StoredProductionDatabaseJob["checkpoint"],
): Promise<void> {
  while (execution.job.checkpoint !== target) {
    const current = PRODUCTION_DATABASE_CHECKPOINTS.indexOf(execution.job.checkpoint);
    const targetIndex = PRODUCTION_DATABASE_CHECKPOINTS.indexOf(target);
    if (current < 0 || targetIndex < current) {
      throw new Error("Production database checkpoint transition is invalid");
    }
    const checkpoint = PRODUCTION_DATABASE_CHECKPOINTS[current + 1];
    if (checkpoint === undefined) throw new Error("Production database checkpoint is unavailable");
    execution.job = (await coordinator.checkpointDurableOperation({
      jobKey: execution.job.jobKey,
      ownerId: execution.ownerId,
      ownerGeneration: execution.job.attempt,
      checkpoint,
      nowMs: Date.now(),
    })) as StoredProductionDatabaseJob;
    logDurableOperationCheckpoint(execution.job);
  }
}

function productionDatabaseControlError(error: unknown): ControlHttpError {
  if (error instanceof ProductionDatabaseProviderError) {
    return new ControlHttpError(error.status, error.code, error.message, error.retryable);
  }
  return new ControlHttpError(
    503,
    "production_database_internal_error",
    "The production database operation failed closed",
    false,
  );
}

async function executeProductionDatabaseJob(input: {
  request: ProductionDatabaseJobRequest;
  env: WorkerBindings;
  coordinator: ControlCoordinator;
  execution: DurableOperationExecution & { job: StoredProductionDatabaseJob };
  vault: CapabilityVault;
  allocator: Pick<ProductionDatabaseAllocator, "ensure" | "release" | "verifyGone">;
}): Promise<StoredHttpResponse> {
  const expectedIdentity = await productionDatabaseAllocationIdentity({
    format: "nabuflow.production-database-allocation/v1",
    deploymentNamespace: "production",
    projectId: input.request.projectId,
  });
  if (input.request.allocationIdentity !== expectedIdentity) {
    throw new ControlHttpError(
      409,
      "production_database_identity_conflict",
      "Production database identity does not match the project",
      false,
    );
  }
  try {
    let allocation = await input.vault.getProductionDatabaseAllocation({
      projectId: input.request.projectId,
      allocationIdentity: input.request.allocationIdentity,
    });
    if (input.request.action === "ensure") {
      if (allocation?.state === "releasing") {
        throw new ControlHttpError(
          409,
          "production_database_release_in_progress",
          "Production database release is already in progress",
          true,
        );
      }
      await advanceProductionDatabaseCheckpoint(
        input.coordinator,
        input.execution,
        "ownership-verified",
      );
      let reused = allocation !== null;
      if (allocation === null) {
        const material = await input.allocator.ensure({
          projectId: input.request.projectId,
          allocationIdentity: input.request.allocationIdentity,
        });
        await advanceProductionDatabaseCheckpoint(
          input.coordinator,
          input.execution,
          "provider-complete",
        );
        await advanceProductionDatabaseCheckpoint(
          input.coordinator,
          input.execution,
          "provider-verified",
        );
        const handoff = await input.vault.provisionProductionDatabase({
          projectId: input.request.projectId,
          revision: material.allocation.revision,
          definition: productionDatabaseCapabilityDefinition,
          allocation: material.allocation,
          credential: { kind: "neon-connection-string", value: material.connectionString },
        });
        reused = material.reused || handoff.state === "replayed";
        allocation = material.allocation;
      } else {
        await advanceProductionDatabaseCheckpoint(
          input.coordinator,
          input.execution,
          "provider-verified",
        );
      }
      await advanceProductionDatabaseCheckpoint(
        input.coordinator,
        input.execution,
        "vault-complete",
      );
      await advanceProductionDatabaseCheckpoint(input.coordinator, input.execution, "finalized");
      return {
        status: 200,
        body: productionDatabaseAllocationResponseSchema.parse({
          ok: true,
          projectId: input.request.projectId,
          allocationIdentity: input.request.allocationIdentity,
          state: "ready",
          capability: { provider: "neon-postgres", name: "database" },
          revision: allocation.revision,
          providerProjectId: allocation.providerProjectId,
          reused,
        }),
      };
    }

    const providerProjectId = allocation?.providerProjectId ?? null;
    if (allocation !== null && allocation.state !== "releasing") {
      allocation = await input.vault.beginProductionDatabaseRelease({
        projectId: input.request.projectId,
        allocationIdentity: input.request.allocationIdentity,
      });
    }
    await advanceProductionDatabaseCheckpoint(
      input.coordinator,
      input.execution,
      "ownership-verified",
    );
    if (allocation !== null) {
      await input.allocator.release(allocation);
    }
    await advanceProductionDatabaseCheckpoint(
      input.coordinator,
      input.execution,
      "provider-complete",
    );
    if (allocation !== null && !(await input.allocator.verifyGone(allocation))) {
      throw new ProductionDatabaseProviderError(
        503,
        "production_database_cleanup_incomplete",
        true,
        "provider_rejected",
      );
    }
    await advanceProductionDatabaseCheckpoint(
      input.coordinator,
      input.execution,
      "provider-verified",
    );
    if (allocation !== null) {
      const released = await input.vault.completeProductionDatabaseRelease({
        projectId: input.request.projectId,
        allocationIdentity: input.request.allocationIdentity,
      });
      if (released === "conflict") {
        throw new ControlHttpError(
          409,
          "production_database_identity_conflict",
          "Production database ownership changed during release",
          false,
        );
      }
    }
    await advanceProductionDatabaseCheckpoint(input.coordinator, input.execution, "vault-complete");
    await advanceProductionDatabaseCheckpoint(input.coordinator, input.execution, "finalized");
    return {
      status: 200,
      body: productionDatabaseReleaseResponseSchema.parse({
        ok: true,
        projectId: input.request.projectId,
        allocationIdentity: input.request.allocationIdentity,
        state: "released",
        providerProjectId,
        verifiedGone: true,
      }),
    };
  } catch (error) {
    if (error instanceof ControlHttpError) throw error;
    throw productionDatabaseControlError(error);
  }
}

function matchPantryRoute(method: string, pathname: string): MatchedRoute {
  const prefix = `${CONTROL_PREFIX}/pantry`;
  const suffix = pathname.slice(prefix.length);
  const readPatterns = [
    /^\/health$/u,
    /^\/diagnostics$/u,
    /^\/diagnostics\/objects$/u,
    /^\/stock-identities\/[0-9a-f]{64}$/u,
    /^\/assemblies\/passembly_[0-9a-f]{64}$/u,
    /^\/assemblies\/passembly_[0-9a-f]{64}\/diagnostics$/u,
    /^\/assemblies\/passembly_[0-9a-f]{64}\/resource-evidence$/u,
    /^\/revisions\/by-root\/[0-9a-f]{64}$/u,
    /^\/revisions\/by-root\/[0-9a-f]{64}\/content-hashes$/u,
    /^\/revisions\/pantry-\d{4}-\d{2}-\d{2}\.[1-9]\d*$/u,
  ];
  const mutationPatterns: ReadonlyArray<{ method: string; pattern: RegExp }> = [
    { method: "POST", pattern: /^\/diagnostics\/r2-probe$/u },
    { method: "POST", pattern: /^\/stock-requests$/u },
    { method: "POST", pattern: /^\/build-resources$/u },
    {
      method: "PUT",
      pattern: /^\/assemblies\/passembly_[0-9a-f]{64}\/objects\/[0-9a-f]{64}\/[a-z-]+$/u,
    },
    {
      method: "POST",
      pattern: /^\/assemblies\/passembly_[0-9a-f]{64}\/commit$/u,
    },
    { method: "POST", pattern: /^\/revisions\/[0-9a-f]{64}\/state$/u },
    { method: "POST", pattern: /^\/revisions\/[0-9a-f]{64}\/references$/u },
    { method: "DELETE", pattern: /^\/revisions\/[0-9a-f]{64}\/references$/u },
    { method: "POST", pattern: /^\/stamps\/verify$/u },
    { method: "POST", pattern: /^\/gc$/u },
  ];
  const pantryPath = `/internal/v1${suffix}`;
  if (method === "GET" && readPatterns.some((pattern) => pattern.test(suffix))) {
    return {
      endpoint: "pantryRead",
      locator: null,
      pantryPath,
      pantryMethod: method,
      pantryPrincipal:
        suffix === "/diagnostics" ||
        suffix === "/diagnostics/objects" ||
        suffix.endsWith("/resource-evidence") ||
        suffix === "/health"
          ? "catalog-admin"
          : "builder-readonly",
    };
  }
  const mutation = mutationPatterns.find(
    (candidate) => candidate.method === method && candidate.pattern.test(suffix),
  );
  if (mutation !== undefined) {
    return {
      endpoint: "pantryMutation",
      locator: null,
      pantryPath,
      pantryMethod: method,
      pantryPrincipal:
        suffix === "/gc"
          ? "catalog-gc"
          : suffix === "/stamps/verify"
            ? "builder-readonly"
            : "catalog-admin",
    };
  }
  const knownPath =
    readPatterns.some((pattern) => pattern.test(suffix)) ||
    mutationPatterns.some((candidate) => candidate.pattern.test(suffix));
  if (knownPath) {
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  throw new ControlHttpError(404, "not_found", "Control endpoint not found");
}

function matchBuildRoute(method: string, pathname: string): MatchedRoute {
  const prefix = `${CONTROL_PREFIX}/build-plane`;
  const suffix = pathname.slice(prefix.length);
  const readPatterns = [
    /^\/health$/u,
    /^\/diagnostics$/u,
    /^\/builds\/pbuild_[A-Za-z0-9_-]{22,128}$/u,
    /^\/builds\/pbuild_[A-Za-z0-9_-]{22,128}\/outputs\/(?:app|layer)\/[0-9a-f]{64}\/chunks\/[0-9]+$/u,
  ];
  const mutationPatterns: ReadonlyArray<{ method: string; pattern: RegExp }> = [
    { method: "POST", pattern: /^\/builds$/u },
    { method: "DELETE", pattern: /^\/builds\/pbuild_[A-Za-z0-9_-]{22,128}$/u },
    { method: "POST", pattern: /^\/gc$/u },
  ];
  const buildPath = `/internal/v1${suffix}`;
  if (method === "GET" && readPatterns.some((pattern) => pattern.test(suffix))) {
    return {
      endpoint: "buildRead",
      locator: null,
      buildPath,
      buildMethod: method,
      buildPrincipal:
        suffix === "/diagnostics" || suffix === "/health" ? "build-control" : "build-readonly",
    };
  }
  const mutation = mutationPatterns.find(
    (candidate) => candidate.method === method && candidate.pattern.test(suffix),
  );
  if (mutation !== undefined) {
    return {
      endpoint: "buildMutation",
      locator: null,
      buildPath,
      buildMethod: method,
      buildPrincipal: suffix === "/gc" ? "build-gc" : "build-control",
    };
  }
  const knownPath =
    readPatterns.some((pattern) => pattern.test(suffix)) ||
    mutationPatterns.some((candidate) => candidate.pattern.test(suffix));
  if (knownPath) {
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  throw new ControlHttpError(404, "not_found", "Control endpoint not found");
}

function matchRoute(method: string, pathname: string): MatchedRoute {
  if (method === "GET" && pathname === `${CONTROL_PREFIX}/version`) {
    return { endpoint: "version", locator: null };
  }
  if (pathname === `${CONTROL_PREFIX}/durable-operations`) {
    if (method !== "GET") {
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    }
    return { endpoint: "durableOperationDiscovery", locator: null };
  }
  const reconciliationAuditMatch = new RegExp(
    `^${CONTROL_PREFIX}/audit/reconciliations/([A-Za-z0-9][A-Za-z0-9_-]{0,199})$`,
  ).exec(pathname);
  if (reconciliationAuditMatch) {
    if (method !== "GET") {
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    }
    return {
      endpoint: "reconciliationAudit",
      locator: null,
      auditRequestId: reconciliationAuditMatch[1],
    };
  }
  if (pathname.startsWith(`${CONTROL_PREFIX}/pantry/`)) {
    return matchPantryRoute(method, pathname);
  }
  if (pathname.startsWith(`${CONTROL_PREFIX}/build-plane/`)) {
    return matchBuildRoute(method, pathname);
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
  const routeInventoryMatch = new RegExp(`^${CONTROL_PREFIX}/projects/([1-9][0-9]*)/routes$`).exec(
    pathname,
  );
  if (routeInventoryMatch) {
    if (method !== "GET") {
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    }
    return {
      endpoint: "routeInventory",
      locator: null,
      projectId: Number(routeInventoryMatch[1]),
    };
  }
  const deactivateRouteMatch = new RegExp(`^${CONTROL_PREFIX}/routes/([^/]+)$`).exec(pathname);
  if (deactivateRouteMatch) {
    if (method === "DELETE") {
      return { endpoint: "routeDeactivate", locator: null, hostname: deactivateRouteMatch[1] };
    }
    if (method === "GET") {
      return { endpoint: "routeRead", locator: null, hostname: deactivateRouteMatch[1] };
    }
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  const productionDatabaseMatch = new RegExp(
    `^${CONTROL_PREFIX}/capabilities/([1-9][0-9]*)/neon-postgres/database/production-allocation$`,
  ).exec(pathname);
  if (productionDatabaseMatch) {
    const projectId = Number(productionDatabaseMatch[1]);
    const locator: RuntimeLocator = { projectId, role: "production", slot: "blue" };
    const capability = { projectId, provider: "neon-postgres", name: "database" };
    if (method === "PUT") {
      return { endpoint: "productionDatabaseEnsure", locator, capability };
    }
    if (method === "DELETE") {
      return { endpoint: "productionDatabaseRelease", locator, capability };
    }
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  const productionDatabaseDiagnosticsMatch = new RegExp(
    `^${CONTROL_PREFIX}/capabilities/([1-9][0-9]*)/neon-postgres/database/production-allocation/([0-9a-f]{64})/diagnostics$`,
  ).exec(pathname);
  if (productionDatabaseDiagnosticsMatch) {
    if (method !== "GET") {
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    }
    return {
      endpoint: "productionDatabaseDiagnostics",
      locator: {
        projectId: Number(productionDatabaseDiagnosticsMatch[1]),
        role: "production",
        slot: "blue",
      },
      allocationIdentity: productionDatabaseDiagnosticsMatch[2],
    };
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
  const promotionDiagnosticsMatch = new RegExp(
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/production/(blue|green)/promotions/layered/([0-9a-f]{64})/diagnostics$`,
  ).exec(pathname);
  if (promotionDiagnosticsMatch) {
    if (method !== "GET") {
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    }
    return {
      endpoint: "layeredArtifactPromotionDiagnostics",
      locator: {
        projectId: Number(promotionDiagnosticsMatch[1]),
        role: "production",
        slot: promotionDiagnosticsMatch[2] as "blue" | "green",
      },
      promotionIdentity: promotionDiagnosticsMatch[3],
    };
  }
  const promotionMatch = new RegExp(
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/production/(blue|green)/promotions/layered$`,
  ).exec(pathname);
  if (promotionMatch) {
    if (method !== "POST") {
      throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
    }
    return {
      endpoint: "layeredArtifactPromotion",
      locator: {
        projectId: Number(promotionMatch[1]),
        role: "production",
        slot: promotionMatch[2] as "blue" | "green",
      },
    };
  }
  const layeredArtifactMatch = new RegExp(
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/(preview|production)/(primary|blue|green)/layered-artifacts/([0-9a-f]{64})(?:/(begin|commit|commit-diagnostics|app/chunks/([0-9]+)|layers/([0-9a-f]{64})/chunks/([0-9]+)))?$`,
  ).exec(pathname);
  if (layeredArtifactMatch) {
    const locator = {
      projectId: Number(layeredArtifactMatch[1]),
      role: layeredArtifactMatch[2] as RuntimeLocator["role"],
      slot: layeredArtifactMatch[3] as RuntimeLocator["slot"],
    };
    const artifactSha256 = layeredArtifactMatch[4];
    const suffix = layeredArtifactMatch[5];
    if (method === "POST" && suffix === "begin") {
      return { endpoint: "layeredArtifactBegin", locator, artifactSha256 };
    }
    if (method === "POST" && suffix === "commit") {
      return { endpoint: "layeredArtifactCommit", locator, artifactSha256 };
    }
    if (method === "GET" && suffix === "commit-diagnostics") {
      return { endpoint: "layeredArtifactCommitDiagnostics", locator, artifactSha256 };
    }
    if (method === "PUT" && suffix?.startsWith("app/chunks/") && layeredArtifactMatch[6]) {
      return {
        endpoint: "layeredArtifactAppChunk",
        locator,
        artifactSha256,
        chunkIndex: Number(layeredArtifactMatch[6]),
      };
    }
    if (
      method === "PUT" &&
      suffix?.startsWith("layers/") &&
      layeredArtifactMatch[7] &&
      layeredArtifactMatch[8]
    ) {
      return {
        endpoint: "layeredArtifactLayerChunk",
        locator,
        artifactSha256,
        layerContentSha256: layeredArtifactMatch[7],
        chunkIndex: Number(layeredArtifactMatch[8]),
      };
    }
    if (method === "DELETE" && suffix === undefined) {
      return { endpoint: "layeredArtifactRemove", locator, artifactSha256 };
    }
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  const artifactMatch = new RegExp(
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/(preview|production)/(primary|blue|green)/artifacts/([0-9a-f]{64})(?:/(begin|commit|commit-diagnostics|chunks/([0-9]+)))?$`,
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
    if (method === "GET" && suffix === "commit-diagnostics")
      return { endpoint: "artifactCommitDiagnostics", locator, artifactSha256 };
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
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/(preview|production)/(primary|blue|green)/(manifest|manifest-diagnostics)$`,
  ).exec(pathname);
  if (manifestMatch) {
    const locator = {
      projectId: Number(manifestMatch[1]),
      role: manifestMatch[2] as RuntimeLocator["role"],
      slot: manifestMatch[3] as RuntimeLocator["slot"],
    };
    if (method === "PUT" && manifestMatch[4] === "manifest") {
      return { endpoint: "manifestUpdate", locator };
    }
    if (method === "GET" && manifestMatch[4] === "manifest-diagnostics") {
      return { endpoint: "manifestUpdateDiagnostics", locator };
    }
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  const match = new RegExp(
    `^${CONTROL_PREFIX}/runtimes/([1-9][0-9]*)/(preview|production)/(primary|blue|green)(?:/(start|start-diagnostics|stop|exec|logs|capability-binding|reconcile))?$`,
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
  if (method === "POST" && suffix === "reconcile") return { endpoint: "reconcile", locator };
  if (method === "GET" && suffix === "start-diagnostics") {
    return { endpoint: "startDiagnostics", locator };
  }
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

async function proxyPantryRequest(
  endpoint: "pantryRead" | "pantryMutation",
  body: Uint8Array,
  env: WorkerBindings,
  route: MatchedRoute | undefined,
): Promise<StoredHttpResponse> {
  if (
    route?.pantryPath === undefined ||
    route.pantryMethod === undefined ||
    route.pantryPrincipal === undefined ||
    !env.PANTRY_CATALOG ||
    typeof env.PANTRY_CATALOG.fetch !== "function"
  ) {
    throw new ControlHttpError(
      503,
      "pantry_infrastructure_unavailable",
      "The Pantry catalog service is not configured",
      false,
    );
  }
  const request = new Request(`https://pantry.internal${route.pantryPath}`, {
    method: route.pantryMethod,
    headers: {
      "content-type": route.pantryPath.includes("/objects/")
        ? "application/octet-stream"
        : "application/json",
      "x-nabuflow-pantry-principal": route.pantryPrincipal,
    },
    ...(endpoint === "pantryRead" ? {} : { body: body.slice().buffer }),
  });
  let response: Response;
  try {
    response = await env.PANTRY_CATALOG.fetch(request);
  } catch {
    throw new ControlHttpError(
      503,
      "pantry_infrastructure_unavailable",
      "The Pantry catalog service is unavailable",
      true,
    );
  }
  const responseBytes = new Uint8Array(await response.arrayBuffer());
  if (responseBytes.byteLength > 2 * 1024 * 1024) {
    throw new ControlHttpError(
      503,
      "pantry_infrastructure_unavailable",
      "The Pantry catalog response exceeded its trusted limit",
      false,
    );
  }
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(textDecoder.decode(responseBytes));
  } catch {
    throw new ControlHttpError(
      503,
      "pantry_infrastructure_unavailable",
      "The Pantry catalog returned an invalid response",
      false,
    );
  }
  if (!response.ok) {
    const parsed = pantryCatalogErrorResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ControlHttpError(
        503,
        "pantry_infrastructure_unavailable",
        "The Pantry catalog returned an invalid error response",
        false,
      );
    }
    throw new ControlHttpError(
      response.status,
      parsed.data.code,
      parsed.data.message,
      parsed.data.retryable,
    );
  }
  if (route.pantryPath === "/internal/v1/stock-requests") {
    const parsed = pantryCatalogStockResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ControlHttpError(
        503,
        "pantry_infrastructure_unavailable",
        "The Pantry catalog returned an invalid stock response",
        false,
      );
    }
    responseBody = parsed.data;
  } else if (/^\/internal\/v1\/stock-identities\/[0-9a-f]{64}$/u.test(route.pantryPath)) {
    const parsed = pantryCatalogStockIdentityStatusResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ControlHttpError(
        503,
        "pantry_infrastructure_unavailable",
        "The Pantry catalog returned an invalid identity response",
        false,
      );
    }
    responseBody = parsed.data;
  } else if (
    /^\/internal\/v1\/assemblies\/passembly_[0-9a-f]{64}\/diagnostics$/u.test(route.pantryPath)
  ) {
    const parsed = pantryCatalogAssemblyDiagnosticsResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ControlHttpError(
        503,
        "pantry_infrastructure_unavailable",
        "The Pantry catalog returned an invalid diagnostic response",
        false,
      );
    }
    responseBody = parsed.data;
  } else if (route.pantryPath === "/internal/v1/diagnostics/objects") {
    const parsed = pantryCatalogObjectInventoryResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ControlHttpError(
        503,
        "pantry_infrastructure_unavailable",
        "The Pantry catalog returned an invalid object inventory",
        false,
      );
    }
    responseBody = parsed.data;
  } else if (/^\/internal\/v1\/assemblies\/passembly_[0-9a-f]{64}$/u.test(route.pantryPath)) {
    const parsed = pantryCatalogAssemblyStatusResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ControlHttpError(
        503,
        "pantry_infrastructure_unavailable",
        "The Pantry catalog returned an invalid progress response",
        false,
      );
    }
    responseBody = parsed.data;
  } else if (route.pantryPath.endsWith("/content-hashes")) {
    const parsed = pantryShelfContentHashesResponseSchema.safeParse(responseBody);
    if (!parsed.success) {
      throw new ControlHttpError(
        503,
        "pantry_infrastructure_unavailable",
        "The Pantry catalog returned an invalid provenance response",
        false,
      );
    }
    responseBody = parsed.data;
  }
  return { status: response.status, body: responseBody };
}

async function proxyBuildRequest(
  endpoint: "buildRead" | "buildMutation",
  body: Uint8Array,
  env: WorkerBindings,
  route: MatchedRoute | undefined,
): Promise<StoredHttpResponse> {
  if (
    route?.buildPath === undefined ||
    route.buildMethod === undefined ||
    route.buildPrincipal === undefined ||
    !env.TRUSTED_BUILD_PLANE ||
    typeof env.TRUSTED_BUILD_PLANE.fetch !== "function"
  ) {
    throw new ControlHttpError(
      503,
      "build_infrastructure_unavailable",
      "The trusted build plane is not configured",
      false,
    );
  }
  const request = new Request(`https://build.internal${route.buildPath}`, {
    method: route.buildMethod,
    headers: {
      "content-type": "application/json",
      "x-nabuflow-build-principal": route.buildPrincipal,
    },
    ...(endpoint === "buildRead" ? {} : { body: body.slice().buffer }),
  });
  let response: Response;
  try {
    response = await env.TRUSTED_BUILD_PLANE.fetch(request);
  } catch {
    throw new ControlHttpError(
      503,
      "build_infrastructure_unavailable",
      "The trusted build plane is unavailable",
      true,
    );
  }
  const responseBytes = new Uint8Array(await response.arrayBuffer());
  if (responseBytes.byteLength > 2 * 1024 * 1024) {
    throw new ControlHttpError(
      503,
      "build_infrastructure_unavailable",
      "The trusted build response exceeded its limit",
      false,
    );
  }
  let responseBody: unknown;
  try {
    responseBody = JSON.parse(textDecoder.decode(responseBytes));
  } catch {
    throw new ControlHttpError(
      503,
      "build_infrastructure_unavailable",
      "The trusted build plane returned an invalid response",
      false,
    );
  }
  if (!response.ok) {
    const candidate = responseBody as {
      code?: unknown;
      message?: unknown;
      retryable?: unknown;
    };
    if (
      typeof candidate.code !== "string" ||
      typeof candidate.message !== "string" ||
      typeof candidate.retryable !== "boolean"
    ) {
      throw new ControlHttpError(
        503,
        "build_infrastructure_unavailable",
        "The trusted build plane returned an invalid error",
        false,
      );
    }
    throw new ControlHttpError(
      response.status,
      candidate.code,
      candidate.message,
      candidate.retryable,
    );
  }
  return { status: response.status, body: responseBody };
}

function parseInput(route: MatchedRoute, url: URL, rawBody: Uint8Array): ControlInput {
  if (route.endpoint === "version") {
    assertNoQuery(url);
    assertEmptyBody(rawBody);
    return {};
  }
  if (route.endpoint === "durableOperationDiscovery") {
    assertEmptyBody(rawBody);
    let unknownQuery = false;
    url.searchParams.forEach((_value, key) => {
      if (!new Set(["since", "limit", "kind"]).has(key)) unknownQuery = true;
    });
    if (unknownQuery || !url.searchParams.has("since")) {
      throw new ControlHttpError(400, "invalid_request", "Invalid discovery query");
    }
    return parseStrict(durableOperationDiscoveryRequestSchema, {
      since: url.searchParams.get("since"),
      ...(url.searchParams.has("limit") ? { limit: Number(url.searchParams.get("limit")) } : {}),
      ...(url.searchParams.has("kind") ? { kind: url.searchParams.get("kind") } : {}),
    });
  }
  if (route.endpoint === "reconciliationAudit") {
    assertNoQuery(url);
    assertEmptyBody(rawBody);
    return {};
  }
  if (
    route.endpoint === "pantryRead" ||
    route.endpoint === "pantryMutation" ||
    route.endpoint === "buildRead" ||
    route.endpoint === "buildMutation"
  ) {
    assertNoQuery(url);
    if (route.endpoint === "pantryRead" || route.endpoint === "buildRead") assertEmptyBody(rawBody);
    return rawBody;
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

  if (
    route.endpoint === "productionDatabaseEnsure" ||
    route.endpoint === "productionDatabaseRelease"
  ) {
    assertNoQuery(url);
    const body = parseJsonBody(rawBody);
    const parsed =
      route.endpoint === "productionDatabaseEnsure"
        ? parseStrict(ensureProductionDatabaseRequestSchema, body)
        : parseStrict(releaseProductionDatabaseRequestSchema, body);
    if (parsed.projectId !== route.locator.projectId) {
      throw new ControlHttpError(400, "project_mismatch", "Path and body projects differ");
    }
    return parsed;
  }

  if (route.endpoint === "status" || route.endpoint === "capabilityBinding") {
    assertNoQuery(url);
    assertEmptyBody(rawBody);
    return parseStrict(statusRuntimeRequestSchema, { locator: route.locator });
  }
  if (
    route.endpoint === "artifactCommitDiagnostics" ||
    route.endpoint === "layeredArtifactCommitDiagnostics" ||
    route.endpoint === "layeredArtifactPromotionDiagnostics" ||
    route.endpoint === "productionDatabaseDiagnostics" ||
    route.endpoint === "startDiagnostics" ||
    route.endpoint === "manifestUpdateDiagnostics"
  ) {
    assertNoQuery(url);
    assertEmptyBody(rawBody);
    return {};
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

  if (
    route.endpoint === "artifactChunk" ||
    route.endpoint === "layeredArtifactAppChunk" ||
    route.endpoint === "layeredArtifactLayerChunk"
  ) {
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
    route.endpoint !== "reconcile" &&
    route.endpoint !== "stop" &&
    route.endpoint !== "destroy" &&
    route.endpoint !== "exec" &&
    route.endpoint !== "artifactBegin" &&
    route.endpoint !== "artifactCommit" &&
    route.endpoint !== "artifactRemove" &&
    route.endpoint !== "layeredArtifactBegin" &&
    route.endpoint !== "layeredArtifactCommit" &&
    route.endpoint !== "layeredArtifactRemove" &&
    route.endpoint !== "layeredArtifactPromotion" &&
    route.endpoint !== "manifestUpdate"
  ) {
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
  const parsed = parseMutationInput(route.endpoint, body);
  const parsedLocator =
    route.endpoint === "layeredArtifactPromotion"
      ? (parsed as PromoteRuntimeLayeredArtifactRequest).targetLocator
      : (parsed as Exclude<typeof parsed, PromoteRuntimeLayeredArtifactRequest>).locator;
  if (
    parsedLocator.projectId !== route.locator.projectId ||
    parsedLocator.role !== route.locator.role ||
    parsedLocator.slot !== route.locator.slot
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
  if (route.endpoint === "routeInventory") {
    if (route.projectId === undefined) {
      throw new ControlHttpError(400, "invalid_project", "Project scope is required");
    }
    assertEmptyBody(rawBody);
    let unknownQuery = false;
    url.searchParams.forEach((_value, key) => {
      if (!new Set(["cursor", "scanLimit"]).has(key)) unknownQuery = true;
    });
    if (unknownQuery) {
      throw new ControlHttpError(400, "invalid_request", "Unknown route inventory parameter");
    }
    return parseStrict(routeInventoryRequestSchema, {
      projectId: route.projectId,
      ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor") } : {}),
      ...(url.searchParams.has("scanLimit")
        ? { scanLimit: Number(url.searchParams.get("scanLimit")) }
        : {}),
    });
  }
  if (route.hostname === undefined) {
    throw new ControlHttpError(400, "invalid_locator", "Route hostname is required");
  }
  assertNoQuery(url);
  if (route.endpoint === "routeRead") {
    assertEmptyBody(rawBody);
    return parseStrict(routeReadRequestSchema, { hostname: route.hostname });
  }
  if (route.endpoint !== "routeActivate" && route.endpoint !== "routeDeactivate") {
    throw new ControlHttpError(405, "method_not_allowed", "Control method is not allowed");
  }
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
    | "reconcile"
    | "stop"
    | "destroy"
    | "exec"
    | "artifactBegin"
    | "artifactCommit"
    | "artifactRemove"
    | "layeredArtifactBegin"
    | "layeredArtifactCommit"
    | "layeredArtifactRemove"
    | "layeredArtifactPromotion"
    | "manifestUpdate",
  body: unknown,
):
  | EnsureRuntimeRequest
  | StartRuntimeRequest
  | ReconcileRuntimeRequest
  | StopRuntimeRequest
  | DestroyRuntimeRequest
  | ExecRuntimeRequest
  | BeginRuntimeArtifactRequest
  | CommitRuntimeArtifactRequest
  | RemoveRuntimeArtifactRequest
  | BeginRuntimeLayeredArtifactRequest
  | CommitRuntimeLayeredArtifactRequest
  | RemoveRuntimeLayeredArtifactRequest
  | PromoteRuntimeLayeredArtifactRequest
  | UpdateRuntimeManifestRequest {
  if (endpoint === "ensure") return parseStrict(ensureRuntimeRequestSchema, body);
  if (endpoint === "start") return parseStrict(startRuntimeRequestSchema, body);
  if (endpoint === "reconcile") return parseStrict(reconcileRuntimeRequestSchema, body);
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
  if (endpoint === "layeredArtifactBegin") {
    return parseStrict(beginRuntimeLayeredArtifactRequestSchema, body);
  }
  if (endpoint === "layeredArtifactCommit") {
    return parseStrict(commitRuntimeLayeredArtifactRequestSchema, body);
  }
  if (endpoint === "layeredArtifactRemove") {
    return parseStrict(removeRuntimeLayeredArtifactRequestSchema, body);
  }
  if (endpoint === "layeredArtifactPromotion") {
    return parseStrict(promoteRuntimeLayeredArtifactRequestSchema, body);
  }
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
  artifactCommitExecution?: DurableOperationExecution | null,
  nowMs = Date.now(),
  injectedProductionDatabaseAllocator?: Pick<
    ProductionDatabaseAllocator,
    "ensure" | "release" | "verifyGone"
  >,
  requestId?: string,
): Promise<StoredHttpResponse> {
  if (endpoint === "reconciliationAudit") {
    if (matchedRoute?.auditRequestId === undefined) {
      throw new ControlHttpError(400, "invalid_request", "Audit request identity is required");
    }
    const record = await coordinator.getRuntimeReconciliation(matchedRoute.auditRequestId);
    if (record === null) {
      throw new ControlHttpError(
        404,
        "runtime_reconciliation_audit_not_found",
        "Runtime reconciliation audit record was not found",
      );
    }
    return {
      status: 200,
      body: runtimeReconciliationAuditResponseSchema.parse({ ok: true, record }),
    };
  }
  assertArtifactInfrastructure(env);
  if (endpoint.startsWith("layeredArtifact")) assertLayeredArtifactInfrastructure(env);
  const deploymentVersion = env.CF_VERSION_METADATA.id;
  if (endpoint === "version") {
    return {
      status: 200,
      body: {
        protocolVersion: CONTROL_PROTOCOL_VERSION,
        deploymentVersion,
        provider: "cloudflare",
        supportedRoles: [...RUNTIME_ROLES],
        features: CONTROL_FEATURES.filter((feature) => {
          if (feature === "artifact-layers-v1") return configuredLayerPlatform(env) !== null;
          if (feature === "artifact-promotion-v1") {
            return (
              configuredLayerPlatform(env) !== null && env.DURABLE_OPERATION_QUEUE !== undefined
            );
          }
          if (feature === "artifact-commit-diagnostics-v1") {
            return env.DURABLE_OPERATION_QUEUE !== undefined;
          }
          if (feature === "durable-operation-discovery-v1") {
            return env.DURABLE_OPERATION_QUEUE !== undefined;
          }
          if (feature === "runtime-lifecycle-jobs-v1") {
            return env.DURABLE_OPERATION_QUEUE !== undefined;
          }
          if (feature === "trusted-build-v1") {
            return env.TRUSTED_BUILD_PLANE !== undefined;
          }
          if (feature === "production-database-v1") {
            const rehearsal =
              env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE === "staging" &&
              env.NABUFLOW_STAGING_PRODUCTION_DATABASE_REHEARSAL === "enabled";
            return (
              env.DURABLE_OPERATION_QUEUE !== undefined &&
              env.NABUFLOW_PRODUCTION_DATABASE_ALLOCATION_ENABLED === "enabled" &&
              (env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE === "production" || rehearsal) &&
              typeof env.NABUFLOW_PRODUCTION_NEON_MANAGEMENT_KEY === "string" &&
              typeof env.NABUFLOW_PRODUCTION_NEON_ORGANIZATION_ID === "string" &&
              typeof env.NABUFLOW_PRODUCTION_NEON_REGION_ID === "string" &&
              typeof env.NABUFLOW_PRODUCTION_NEON_HISTORY_RETENTION_SECONDS === "string" &&
              typeof env.NABUFLOW_PRODUCTION_DATABASE_MAX_PROJECTS === "string"
            );
          }
          return true;
        }),
      },
    };
  }
  if (endpoint === "pantryRead" || endpoint === "pantryMutation") {
    return proxyPantryRequest(endpoint, input as Uint8Array, env, matchedRoute);
  }
  if (endpoint === "buildRead" || endpoint === "buildMutation") {
    return proxyBuildRequest(endpoint, input as Uint8Array, env, matchedRoute);
  }
  if (endpoint === "durableOperationDiscovery") {
    const request = input as DurableOperationDiscoveryRequest;
    const sinceMs = Date.parse(request.since);
    if (
      !Number.isFinite(sinceMs) ||
      sinceMs > nowMs ||
      nowMs - sinceMs > DURABLE_OPERATION_DISCOVERY_MAX_WINDOW_MS
    ) {
      throw new ControlHttpError(
        400,
        "invalid_discovery_window",
        "Durable-operation discovery window is invalid",
      );
    }
    const jobs = await coordinator.listRecentDurableOperations({
      sinceMs,
      untilMs: nowMs,
      limit: request.limit,
      ...(request.kind === undefined ? {} : { kind: request.kind }),
    });
    return {
      status: 200,
      body: durableOperationDiscoveryResponseSchema.parse({
        ok: true,
        window: {
          since: new Date(sinceMs).toISOString(),
          until: new Date(nowMs).toISOString(),
          limit: request.limit,
        },
        jobs: jobs.map((job) => ({
          jobKey: job.jobKey,
          kind: job.kind,
          runtimeIdentity: job.runtimeIdentity,
          subjectKey: job.subjectKey,
          createdAt: new Date(
            job.createdAtMs ?? job.deadlineMs - DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS,
          ).toISOString(),
          updatedAt: new Date(job.updatedAtMs).toISOString(),
          state: job.state,
          checkpoint: job.checkpoint,
          attempt: job.attempt,
        })),
      }),
    };
  }
  if (endpoint === "routeInventory") {
    const request = input as RouteInventoryRequest;
    const inventory = await coordinator.listRoutesByProject(request);
    return {
      status: 200,
      body: routeInventoryResponseSchema.parse({
        ok: true,
        projectId: request.projectId,
        routes: inventory.routes,
        nextCursor: inventory.nextCursor,
        complete: inventory.complete,
      }),
    };
  }
  if (endpoint === "routeRead") {
    const request = input as RouteReadRequest;
    return {
      status: 200,
      body: routeReadResponseSchema.parse({
        ok: true,
        route: await coordinator.getRoute(request.hostname),
      }),
    };
  }
  if (endpoint === "routeActivate") {
    return activatePublishedRoute(input as ActivateRouteRequest, env, coordinator, backend, nowMs);
  }
  if (endpoint === "routeDeactivate") {
    return deactivatePublishedRoute(
      input as DeactivateRouteRequest,
      env,
      coordinator,
      backend,
      nowMs,
    );
  }
  if (endpoint === "layeredArtifactPromotion") {
    if (
      artifactCommitExecution === undefined ||
      artifactCommitExecution === null ||
      artifactCommitExecution.job.kind !== "layered-artifact-promotion"
    ) {
      throw new Error("Layered artifact promotion job is unavailable");
    }
    return promoteLayeredArtifact(
      input as PromoteRuntimeLayeredArtifactRequest,
      env,
      coordinator,
      artifactCommitExecution as DurableOperationExecution & {
        job: StoredLayeredArtifactPromotionJob;
      },
    );
  }
  if (endpoint === "productionDatabaseEnsure" || endpoint === "productionDatabaseRelease") {
    if (
      artifactCommitExecution === undefined ||
      artifactCommitExecution === null ||
      artifactCommitExecution.job.kind !== "production-database"
    ) {
      throw new Error("Production database durable job is unavailable");
    }
    const request = input as ProductionDatabaseJobRequest;
    if (
      (endpoint === "productionDatabaseEnsure" && request.action !== "ensure") ||
      (endpoint === "productionDatabaseRelease" && request.action !== "release")
    ) {
      throw new ControlHttpError(
        400,
        "production_database_action_mismatch",
        "Production database action does not match the route",
      );
    }
    return executeProductionDatabaseJob({
      request,
      env,
      coordinator,
      execution: artifactCommitExecution as DurableOperationExecution & {
        job: StoredProductionDatabaseJob;
      },
      vault: injectedVault ?? getCapabilityVault(env, request.projectId),
      allocator: injectedProductionDatabaseAllocator ?? new ProductionDatabaseAllocator(env),
    });
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
    if (result === "cleanup_unavailable") {
      throw new ControlHttpError(
        503,
        "stripe_cleanup_unavailable",
        "Stripe test resources could not be verified gone",
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
  if (endpoint === "layeredArtifactPromotionDiagnostics") {
    const promotionIdentity = matchedRoute?.promotionIdentity;
    if (promotionIdentity === undefined) {
      throw new ControlHttpError(400, "invalid_request", "Artifact promotion route is incomplete");
    }
    const job = await coordinator.getLatestDurableOperation(
      "layered-artifact-promotion",
      identity,
      promotionIdentity,
    );
    if (
      job === null ||
      job.kind !== "layered-artifact-promotion" ||
      job.runtimeIdentity !== identity
    ) {
      throw new ControlHttpError(
        404,
        "artifact_promotion_not_found",
        "Artifact promotion was not found",
      );
    }
    const terminalBody = job.response?.body as { code?: unknown } | undefined;
    return {
      status: 200,
      body: layeredArtifactPromotionDiagnosticsResponseSchema.parse({
        ok: true,
        job: {
          kind: job.kind,
          runtimeIdentity: job.runtimeIdentity,
          promotionIdentity: job.subjectKey,
          state: job.state,
          checkpoint: job.checkpoint,
          attempt: job.attempt,
          leaseUntil: job.leaseUntilMs === null ? null : new Date(job.leaseUntilMs).toISOString(),
          deadline: new Date(job.deadlineMs).toISOString(),
          updatedAt: new Date(job.updatedAtMs).toISOString(),
          terminal:
            job.response === undefined
              ? null
              : {
                  status: job.response.status,
                  code:
                    typeof terminalBody?.code === "string"
                      ? terminalBody.code
                      : job.state === "succeeded"
                        ? "ok"
                        : "artifact_promotion_failed",
                },
          events: job.events,
        },
      }),
    };
  }
  if (endpoint === "productionDatabaseDiagnostics") {
    const allocationIdentity = matchedRoute?.allocationIdentity;
    if (allocationIdentity === undefined) {
      throw new ControlHttpError(
        400,
        "invalid_request",
        "Production database diagnostics route is incomplete",
      );
    }
    const job = await coordinator.getLatestDurableOperation(
      "production-database",
      identity,
      allocationIdentity,
    );
    if (job === null || job.kind !== "production-database" || job.runtimeIdentity !== identity) {
      throw new ControlHttpError(
        404,
        "production_database_job_not_found",
        "Production database operation was not found",
      );
    }
    const terminalBody = job.response?.body as { code?: unknown } | undefined;
    return {
      status: 200,
      body: productionDatabaseDiagnosticsResponseSchema.parse({
        ok: true,
        job: {
          kind: job.kind,
          runtimeIdentity: job.runtimeIdentity,
          allocationIdentity: job.subjectKey,
          action: job.request.action,
          state: job.state,
          checkpoint: job.checkpoint,
          attempt: job.attempt,
          leaseUntil: job.leaseUntilMs === null ? null : new Date(job.leaseUntilMs).toISOString(),
          deadline: new Date(job.deadlineMs).toISOString(),
          updatedAt: new Date(job.updatedAtMs).toISOString(),
          terminal:
            job.response === undefined
              ? null
              : {
                  status: job.response.status,
                  code:
                    typeof terminalBody?.code === "string"
                      ? terminalBody.code
                      : job.state === "succeeded"
                        ? "ok"
                        : "production_database_failed",
                },
          events: job.events,
        },
      }),
    };
  }
  if (endpoint === "artifactCommitDiagnostics" || endpoint === "layeredArtifactCommitDiagnostics") {
    const sealedArtifactSha256 = matchedRoute?.artifactSha256;
    if (sealedArtifactSha256 === undefined) {
      throw new ControlHttpError(400, "invalid_request", "Artifact commit route is incomplete");
    }
    const job = await coordinator.getLatestDurableOperation(
      endpoint === "artifactCommitDiagnostics" ? "v1" : "layers-v1",
      identity,
      sealedArtifactSha256,
    );
    const expectedKind = endpoint === "artifactCommitDiagnostics" ? "v1" : "layers-v1";
    if (job === null || job.kind !== expectedKind || job.runtimeIdentity !== identity) {
      throw new ControlHttpError(404, "artifact_commit_not_found", "Artifact commit was not found");
    }
    const terminalBody = job.response?.body as { code?: unknown } | undefined;
    return {
      status: 200,
      body: artifactCommitDiagnosticsResponseSchema.parse({
        ok: true,
        job: {
          kind: job.kind,
          runtimeIdentity: job.runtimeIdentity,
          sealedArtifactSha256: job.sealedArtifactSha256,
          state: job.state,
          checkpoint: job.checkpoint,
          attempt: job.attempt,
          leaseUntil: job.leaseUntilMs === null ? null : new Date(job.leaseUntilMs).toISOString(),
          deadline: new Date(job.deadlineMs).toISOString(),
          updatedAt: new Date(job.updatedAtMs).toISOString(),
          terminal:
            job.response === undefined
              ? null
              : {
                  status: job.response.status,
                  code:
                    typeof terminalBody?.code === "string"
                      ? terminalBody.code
                      : job.state === "succeeded"
                        ? "ok"
                        : "artifact_commit_failed",
                },
          events: job.events,
        },
      }),
    };
  }
  if (endpoint === "startDiagnostics") {
    const job = await coordinator.getLatestDurableOperation("runtime-start", identity, "start");
    if (job === null || job.kind !== "runtime-start" || job.runtimeIdentity !== identity) {
      throw new ControlHttpError(404, "runtime_start_not_found", "Runtime start was not found");
    }
    const terminalBody = job.response?.body as { code?: unknown } | undefined;
    return {
      status: 200,
      body: runtimeStartDiagnosticsResponseSchema.parse({
        ok: true,
        job: {
          kind: job.kind,
          runtimeIdentity: job.runtimeIdentity,
          artifactRevision: job.request.artifactRevision,
          artifactSha256: job.request.artifactSha256,
          state: job.state,
          checkpoint: job.checkpoint,
          attempt: job.attempt,
          leaseUntil: job.leaseUntilMs === null ? null : new Date(job.leaseUntilMs).toISOString(),
          deadline: new Date(job.deadlineMs).toISOString(),
          updatedAt: new Date(job.updatedAtMs).toISOString(),
          terminal:
            job.response === undefined
              ? null
              : {
                  status: job.response.status,
                  code:
                    typeof terminalBody?.code === "string"
                      ? terminalBody.code
                      : job.state === "succeeded"
                        ? "ok"
                        : "runtime_start_failed",
                },
          events: job.events,
        },
      }),
    };
  }
  if (endpoint === "manifestUpdateDiagnostics") {
    const job = await coordinator.getLatestDurableOperation(
      "runtime-manifest-restart",
      identity,
      "manifest-restart",
    );
    if (
      job === null ||
      job.kind !== "runtime-manifest-restart" ||
      job.runtimeIdentity !== identity
    ) {
      throw new ControlHttpError(
        404,
        "runtime_manifest_update_not_found",
        "Runtime manifest restart was not found",
      );
    }
    const terminalBody = job.response?.body as { code?: unknown } | undefined;
    return {
      status: 200,
      body: runtimeManifestRestartDiagnosticsResponseSchema.parse({
        ok: true,
        job: {
          kind: job.kind,
          runtimeIdentity: job.runtimeIdentity,
          expectedManifestRevision: job.request.expectedManifestRevision,
          manifestRevision: job.request.manifest.revision,
          state: job.state,
          checkpoint: job.checkpoint,
          attempt: job.attempt,
          leaseUntil: job.leaseUntilMs === null ? null : new Date(job.leaseUntilMs).toISOString(),
          deadline: new Date(job.deadlineMs).toISOString(),
          updatedAt: new Date(job.updatedAtMs).toISOString(),
          terminal:
            job.response === undefined
              ? null
              : {
                  status: job.response.status,
                  code:
                    typeof terminalBody?.code === "string"
                      ? terminalBody.code
                      : job.state === "succeeded"
                        ? "ok"
                        : "runtime_manifest_update_failed",
                },
          events: job.events,
        },
      }),
    };
  }
  if (endpoint === "layeredArtifactBegin") {
    const request = input as BeginRuntimeLayeredArtifactRequest;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    if (
      matchedRoute?.artifactSha256 !== request.envelope.sealedArtifactSha256 ||
      request.envelope.targetRuntimeIdentity !== identity
    ) {
      throw artifactRuntimeMismatch();
    }
    if (!(await verifyRuntimeLayeredArtifactEnvelope(request.envelope))) {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Layered artifact integrity verification failed",
      );
    }
    assertLayerPlatform(request.envelope.content.platform, env);
    if (request.envelope.content.layers.some((layer) => layer.descriptor.compression !== "none")) {
      throw new ControlHttpError(
        422,
        "layer_compression_unsupported",
        "Dependency layer compression is not supported by this deployment",
      );
    }
    await requireRuntime(coordinator, identity);
    const record: StoredRuntimeLayeredArtifact = {
      runtimeIdentity: identity,
      envelope: request.envelope,
      state: "pending",
      receivedAppChunks: request.envelope.content.appArtifact.content.chunks.map(() => null),
      expiresAtMs: Date.now() + RUNTIME_ARTIFACT_PENDING_TTL_MS,
    };
    const result = await coordinator.beginLayeredArtifact(record);
    if (result === "conflict") {
      throw new ControlHttpError(
        409,
        "artifact_conflict",
        "Layered artifact address is already bound to different metadata",
      );
    }
    const layerContentSha256ToUpload: string[] = [];
    for (const content of request.envelope.content.layers) {
      const layer = await coordinator.getRuntimeLayer(content.descriptor.contentSha256);
      if (layer === null || layer.state !== "committed") {
        layerContentSha256ToUpload.push(content.descriptor.contentSha256);
      }
    }
    return {
      status: 200,
      body: {
        ok: true,
        sealedArtifactSha256: request.envelope.sealedArtifactSha256,
        appChunksExpected: request.envelope.content.appArtifact.content.chunks.length,
        layersExpected: request.envelope.content.layers.length,
        layerContentSha256ToUpload,
      },
    };
  }
  if (endpoint === "layeredArtifactAppChunk" || endpoint === "layeredArtifactLayerChunk") {
    if (
      matchedRoute?.artifactSha256 === undefined ||
      matchedRoute.chunkIndex === undefined ||
      !(input instanceof Uint8Array)
    ) {
      throw new ControlHttpError(
        400,
        "invalid_request",
        "Layered artifact chunk route is incomplete",
      );
    }
    const artifact = await coordinator.getLayeredArtifact(identity, matchedRoute.artifactSha256);
    if (artifact === null || artifact.runtimeIdentity !== identity) throw artifactRuntimeMismatch();
    const chunkIndex = matchedRoute.chunkIndex;
    const isAppChunk = endpoint === "layeredArtifactAppChunk";
    const appContent = artifact.envelope.content.appArtifact.content;
    const layerContent = !isAppChunk
      ? artifact.envelope.content.layers.find(
          (layer) => layer.descriptor.contentSha256 === matchedRoute.layerContentSha256,
        )
      : null;
    if (!isAppChunk && layerContent === undefined) {
      throw artifactRuntimeMismatch();
    }
    const content = layerContent ?? appContent;
    const expectedLength = expectedChunkLength(
      content.payloadBytes,
      content.chunkBytes,
      content.chunks.length,
      chunkIndex,
    );
    if (expectedLength === null || input.byteLength !== expectedLength) {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Layered artifact chunk does not match the sealed envelope",
      );
    }
    const chunkSha256 = await sha256Hex(input);
    if (chunkSha256 !== content.chunks[chunkIndex]) {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Layered artifact chunk does not match the sealed envelope",
      );
    }
    const contentSha256 =
      layerContent?.descriptor.contentSha256 ?? artifact.envelope.content.appArtifact.contentSha256;
    const key = isAppChunk
      ? layeredArtifactAppChunkKey(identity, artifact.envelope.sealedArtifactSha256, chunkIndex)
      : dependencyLayerChunkKey(layerContent!.descriptor.contentSha256, chunkIndex);
    await env.NABUFLOW_RUNTIME_ARTIFACTS.put(key, input.slice().buffer);
    const recorded = isAppChunk
      ? await coordinator.recordLayeredArtifactAppChunk(
          identity,
          artifact.envelope.sealedArtifactSha256,
          chunkIndex,
          chunkSha256,
        )
      : await coordinator.recordRuntimeLayerChunk(
          identity,
          artifact.envelope.sealedArtifactSha256,
          layerContent!.descriptor.contentSha256,
          chunkIndex,
          chunkSha256,
        );
    if (recorded === "not_found") throw artifactRuntimeMismatch();
    if (recorded === "conflict") {
      throw new ControlHttpError(
        409,
        "artifact_chunk_conflict",
        "Layered artifact chunk conflicts",
      );
    }
    return {
      status: 200,
      body: {
        ok: true,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        contentSha256,
        chunkIndex,
      },
    };
  }
  if (endpoint === "layeredArtifactCommit") {
    if (
      artifactCommitExecution === undefined ||
      artifactCommitExecution === null ||
      (artifactCommitExecution.job.kind !== "v1" &&
        artifactCommitExecution.job.kind !== "layers-v1")
    ) {
      throw new Error("Layered artifact commit job is unavailable");
    }
    const request = input as CommitRuntimeLayeredArtifactRequest;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    if (matchedRoute?.artifactSha256 !== request.sealedArtifactSha256) {
      throw artifactRuntimeMismatch();
    }
    const artifact = await coordinator.getLayeredArtifact(identity, request.sealedArtifactSha256);
    if (artifact === null || artifact.runtimeIdentity !== identity) throw artifactRuntimeMismatch();
    maybeAbortStagingCommitAtCheckpoint(
      env,
      artifact.envelope.artifactRevision,
      artifactCommitExecution.job,
    );
    const checkpoint = async (
      next: StoredArtifactCommitJob["checkpoint"],
      payloadContentSha256s?: string[],
    ) => {
      const updated = await coordinator.checkpointDurableOperation({
        jobKey: artifactCommitExecution.job.jobKey,
        ownerId: artifactCommitExecution.ownerId,
        ownerGeneration: artifactCommitExecution.job.attempt,
        checkpoint: next,
        ...(payloadContentSha256s === undefined ? {} : { payloadContentSha256s }),
        nowMs: Date.now(),
      });
      if (updated.kind !== "v1" && updated.kind !== "layers-v1") {
        throw new Error("Artifact commit job changed kind");
      }
      artifactCommitExecution.job = updated;
      logArtifactCommitCheckpoint(updated);
      maybeAbortStagingCommitAtCheckpoint(env, artifact.envelope.artifactRevision, updated);
    };
    const commit = await coordinator.commitLayeredArtifact(identity, request.sealedArtifactSha256);
    if (commit === "incomplete") {
      const removed = await coordinator.removeLayeredArtifact(
        identity,
        request.sealedArtifactSha256,
      );
      if (removed !== null) await deleteRemovedLayeredArtifact(env, removed);
      throw new ControlHttpError(
        409,
        "artifact_incomplete",
        "Layered artifact upload is incomplete",
      );
    }
    if (commit === "not_found") throw artifactRuntimeMismatch();
    if (commit === "conflict") {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Dependency layer metadata does not match the sealed envelope",
      );
    }
    if (artifactCommitExecution.job.checkpoint === "initialized") {
      try {
        await verifyStoredArtifactChunks(
          env.NABUFLOW_RUNTIME_ARTIFACTS,
          artifact.envelope.content.appArtifact.content,
          (index) => layeredArtifactAppChunkKey(identity, request.sealedArtifactSha256, index),
        );
        for (const content of artifact.envelope.content.layers) {
          await verifyStoredLayerIntegrity(env.NABUFLOW_RUNTIME_ARTIFACTS, content);
        }
      } catch (error) {
        const removed = await coordinator.removeLayeredArtifact(
          identity,
          request.sealedArtifactSha256,
        );
        if (removed !== null) await deleteRemovedLayeredArtifact(env, removed);
        throw error;
      }
      await checkpoint("verification-complete");
    }
    const runtime = await requireRuntime(coordinator, identity);
    const materialized = artifact.envelope.manifestRevision === runtime.manifest.revision;
    let filesWritten = 0;
    let layersMaterialized = 0;
    if (materialized) {
      const layers = await loadCommittedLayers(coordinator, artifact);
      let ticket =
        artifactCommitExecution.job.payloadContentSha256s === undefined
          ? null
          : {
              payloadContentSha256s: artifactCommitExecution.job.payloadContentSha256s,
            };
      if (artifactCommitExecution.job.checkpoint === "verification-complete") {
        ticket = await backend.stageLayeredMaterialization(runtime, artifact, layers);
        await checkpoint("payloads-transferred", ticket.payloadContentSha256s);
      } else if (artifactCommitExecution.job.checkpoint === "payloads-transferred") {
        const restaged = await backend.stageLayeredMaterialization(runtime, artifact, layers);
        if (
          ticket === null ||
          canonicalJson(restaged.payloadContentSha256s) !==
            canonicalJson(ticket.payloadContentSha256s)
        ) {
          throw new Error("Adopted layered artifact payload hashes changed");
        }
        ticket = restaged;
      }
      if (artifactCommitExecution.job.checkpoint === "payloads-transferred") {
        if (ticket === null) throw new Error("Layered materialization ticket is unavailable");
        maybeAbortStagingCommitBeforeMaterializer(
          env,
          artifact.envelope.artifactRevision,
          artifactCommitExecution.job,
        );
        const result = await backend.unpackLayeredMaterialization(
          runtime,
          artifact,
          layers,
          ticket,
          stagingMaterializationOptions(
            env,
            artifact.envelope.artifactRevision,
            artifactCommitExecution.job,
          ),
        );
        filesWritten = result.filesWritten;
        layersMaterialized = result.layersMaterialized;
        await checkpoint("unpack-complete");
      } else {
        filesWritten =
          artifact.envelope.content.appArtifact.content.files.length +
          artifact.envelope.content.layers.reduce((total, layer) => total + layer.files.length, 0);
        layersMaterialized = artifact.envelope.content.layers.length;
      }
    } else if (artifactCommitExecution.job.checkpoint === "verification-complete") {
      await checkpoint("payloads-transferred", []);
      await checkpoint("unpack-complete");
    }
    if (artifactCommitExecution.job.checkpoint === "unpack-complete") {
      if (materialized) {
        runtime.artifactRevision = artifact.envelope.artifactRevision;
        runtime.artifactSha256 = artifact.envelope.sealedArtifactSha256;
        runtime.artifactKind = "layers-v1";
        await coordinator.putRuntime(identity, runtime);
      }
      await checkpoint("finalized");
    }
    return {
      status: 200,
      body: {
        ok: true,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        contentSha256: artifact.envelope.contentSha256,
        filesWritten,
        layersMaterialized,
        materialized,
      },
    };
  }
  if (endpoint === "layeredArtifactRemove") {
    const request = input as RemoveRuntimeLayeredArtifactRequest;
    if (matchedRoute?.artifactSha256 !== request.sealedArtifactSha256) {
      throw artifactRuntimeMismatch();
    }
    const runtime = await coordinator.getRuntime(identity);
    if (
      runtime !== null &&
      (runtime.descriptor.status === "running" || runtime.descriptor.status === "starting") &&
      runtime.artifactSha256 === request.sealedArtifactSha256
    ) {
      throw new ControlHttpError(
        409,
        "runtime_busy",
        "Stop the runtime before removing its layered artifact",
      );
    }
    const removed = await coordinator.removeLayeredArtifact(identity, request.sealedArtifactSha256);
    if (removed === null) throw artifactRuntimeMismatch();
    await deleteRemovedLayeredArtifact(env, removed);
    return { status: 200, body: { ok: true } };
  }
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
    if (
      artifactCommitExecution === undefined ||
      artifactCommitExecution === null ||
      (artifactCommitExecution.job.kind !== "v1" &&
        artifactCommitExecution.job.kind !== "layers-v1")
    ) {
      throw new Error("Artifact commit job is unavailable");
    }
    const request = input as CommitRuntimeArtifactRequest;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    if (matchedRoute?.artifactSha256 !== request.sealedArtifactSha256)
      throw artifactRuntimeMismatch();
    const artifact = await coordinator.getArtifact(identity, request.sealedArtifactSha256);
    if (artifact === null || artifact.runtimeIdentity !== identity) throw artifactRuntimeMismatch();
    maybeAbortStagingCommitAtCheckpoint(
      env,
      artifact.envelope.artifactRevision,
      artifactCommitExecution.job,
    );
    const checkpoint = async (
      next: StoredArtifactCommitJob["checkpoint"],
      payloadContentSha256s?: string[],
    ) => {
      const updated = await coordinator.checkpointDurableOperation({
        jobKey: artifactCommitExecution.job.jobKey,
        ownerId: artifactCommitExecution.ownerId,
        ownerGeneration: artifactCommitExecution.job.attempt,
        checkpoint: next,
        ...(payloadContentSha256s === undefined ? {} : { payloadContentSha256s }),
        nowMs: Date.now(),
      });
      if (updated.kind !== "v1" && updated.kind !== "layers-v1") {
        throw new Error("Artifact commit job changed kind");
      }
      artifactCommitExecution.job = updated;
      logArtifactCommitCheckpoint(updated);
      maybeAbortStagingCommitAtCheckpoint(env, artifact.envelope.artifactRevision, updated);
    };
    const commit = await coordinator.commitArtifact(identity, request.sealedArtifactSha256);
    if (commit === "incomplete") {
      await deleteArtifactObjects(env.NABUFLOW_RUNTIME_ARTIFACTS, artifact);
      await coordinator.removeArtifact(identity, request.sealedArtifactSha256);
      throw new ControlHttpError(409, "artifact_incomplete", "Artifact upload is incomplete");
    }
    if (commit === "not_found") throw artifactRuntimeMismatch();
    if (artifactCommitExecution.job.checkpoint === "initialized") {
      try {
        await verifyStoredArtifactChunks(
          env.NABUFLOW_RUNTIME_ARTIFACTS,
          artifact.envelope.content,
          (index) => artifactChunkKey(identity, artifact.envelope.sealedArtifactSha256, index),
        );
      } catch (error) {
        await deleteArtifactObjects(env.NABUFLOW_RUNTIME_ARTIFACTS, artifact);
        await coordinator.removeArtifact(identity, request.sealedArtifactSha256);
        throw error;
      }
      await checkpoint("verification-complete");
    }
    const runtime = await requireRuntime(coordinator, identity);
    const materialized = artifact.envelope.manifestRevision === runtime.manifest.revision;
    let filesWritten = 0;
    if (materialized) {
      let ticket =
        artifactCommitExecution.job.payloadContentSha256s === undefined
          ? null
          : { payloadContentSha256s: artifactCommitExecution.job.payloadContentSha256s };
      if (artifactCommitExecution.job.checkpoint === "verification-complete") {
        ticket = await backend.stageMaterialization(runtime, artifact);
        await checkpoint("payloads-transferred", ticket.payloadContentSha256s);
      } else if (artifactCommitExecution.job.checkpoint === "payloads-transferred") {
        const restaged = await backend.stageMaterialization(runtime, artifact);
        if (
          ticket === null ||
          canonicalJson(restaged.payloadContentSha256s) !==
            canonicalJson(ticket.payloadContentSha256s)
        ) {
          throw new Error("Adopted artifact payload hashes changed");
        }
        ticket = restaged;
      }
      if (artifactCommitExecution.job.checkpoint === "payloads-transferred") {
        if (ticket === null) throw new Error("Materialization ticket is unavailable");
        maybeAbortStagingCommitBeforeMaterializer(
          env,
          artifact.envelope.artifactRevision,
          artifactCommitExecution.job,
        );
        const result = await backend.unpackMaterialization(
          runtime,
          artifact,
          ticket,
          stagingMaterializationOptions(
            env,
            artifact.envelope.artifactRevision,
            artifactCommitExecution.job,
          ),
        );
        filesWritten = result.filesWritten;
        await checkpoint("unpack-complete");
      } else {
        filesWritten = artifact.envelope.content.files.length;
      }
    } else if (artifactCommitExecution.job.checkpoint === "verification-complete") {
      await checkpoint("payloads-transferred", []);
      await checkpoint("unpack-complete");
    }
    if (artifactCommitExecution.job.checkpoint === "unpack-complete") {
      if (materialized) {
        runtime.artifactRevision = artifact.envelope.artifactRevision;
        runtime.artifactSha256 = artifact.envelope.sealedArtifactSha256;
        runtime.artifactKind = "v1";
        await coordinator.putRuntime(identity, runtime);
      }
      await checkpoint("finalized");
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
    if (
      artifactCommitExecution !== undefined &&
      artifactCommitExecution !== null &&
      artifactCommitExecution.job.kind === "runtime-manifest-restart"
    ) {
      const execution = artifactCommitExecution as DurableOperationExecution & {
        job: StoredRuntimeManifestRestartJob;
      };
      const checkpoint = async (
        next: StoredRuntimeManifestRestartJob["checkpoint"],
        runtimeWasRunning?: boolean,
        rollbackReleaseSha256?: string | null,
      ): Promise<void> => {
        const updated = await coordinator.checkpointDurableOperation({
          jobKey: execution.job.jobKey,
          ownerId: execution.ownerId,
          ownerGeneration: execution.job.attempt,
          checkpoint: next,
          ...(runtimeWasRunning === undefined ? {} : { runtimeWasRunning }),
          ...(rollbackReleaseSha256 === undefined ? {} : { rollbackReleaseSha256 }),
          nowMs: Date.now(),
        });
        if (updated.kind !== "runtime-manifest-restart") {
          throw new Error("Runtime manifest restart durable job changed kind");
        }
        execution.job = updated;
        logDurableOperationCheckpoint(execution.job);
        maybeAbortStagingRuntimeManifestRestartAtCheckpoint(env, execution.job);
      };
      const committedRestartArtifact = async (): Promise<CommittedRuntimeArtifact> => {
        if (request.sealedArtifactSha256 === undefined) {
          throw new ControlHttpError(
            409,
            "artifact_not_committed",
            "A committed artifact for the next manifest is required",
          );
        }
        const artifact = await getCommittedRuntimeArtifact(
          coordinator,
          identity,
          request.sealedArtifactSha256,
        );
        if (
          artifact === null ||
          artifact.artifact.envelope.manifestRevision !== request.manifest.revision
        ) {
          throw new ControlHttpError(
            409,
            "artifact_not_committed",
            "A committed artifact for the next manifest is required",
          );
        }
        return artifact;
      };
      maybeAbortStagingRuntimeManifestRestartAtCheckpoint(env, execution.job);
      try {
        if (execution.job.checkpoint === "initialized") {
          const current = await requireRuntime(coordinator, identity);
          if (current.descriptor.status === "starting") {
            throw new ControlHttpError(
              409,
              "runtime_busy",
              "Runtime manifest update is already in progress",
              true,
            );
          }
          if (current.manifest.revision !== request.expectedManifestRevision) {
            throw new ControlHttpError(
              409,
              "manifest_revision_conflict",
              "Runtime manifest revision changed before update",
            );
          }
          if (
            current.manifest.resourceProfile !== request.manifest.resourceProfile ||
            current.manifest.public !== request.manifest.public
          ) {
            throw new ControlHttpError(
              400,
              "manifest_immutable_field",
              "Manifest update attempted to change an immutable field",
            );
          }
          const wasRunning = current.descriptor.status === "running";
          const rollbackReleaseSha256 = wasRunning ? current.artifactSha256 : null;
          if (rollbackReleaseSha256 !== null && !/^[0-9a-f]{64}$/u.test(rollbackReleaseSha256)) {
            throw new ControlHttpError(
              409,
              "artifact_not_committed",
              "The current runtime release cannot be retained for rollback",
            );
          }
          if (wasRunning) {
            await committedRestartArtifact();
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
          await checkpoint("runtime-unbound", wasRunning, rollbackReleaseSha256);
        }
        if (execution.job.checkpoint === "runtime-unbound") {
          const current = await requireRuntime(coordinator, identity);
          const wasRunning = execution.job.runtimeWasRunning === true;
          if (current.manifest.revision === request.expectedManifestRevision) {
            let artifact: CommittedRuntimeArtifact | null = null;
            if (wasRunning) artifact = await committedRestartArtifact();
            current.manifest = request.manifest;
            current.descriptor.servicePort = request.manifest.servicePort;
            current.descriptor.manifestRevision = request.manifest.revision;
            current.descriptor.status = wasRunning ? "starting" : "stopped";
            current.descriptor.readyAt = null;
            current.descriptor.lastError = null;
            current.processId = null;
            if (artifact !== null) {
              current.artifactRevision = artifact.artifact.envelope.artifactRevision;
              current.artifactSha256 = artifact.artifact.envelope.sealedArtifactSha256;
              current.artifactKind = artifact.kind;
            }
            const persisted = await coordinator.putRuntimeIfManifestRevision(
              identity,
              request.expectedManifestRevision,
              current,
            );
            if (persisted !== "updated") {
              throw new ControlHttpError(
                persisted === "not_found" ? 404 : 409,
                persisted === "not_found" ? "runtime_not_found" : "manifest_revision_conflict",
                persisted === "not_found"
                  ? "Runtime not found"
                  : "Runtime manifest revision changed before update",
              );
            }
          } else if (current.manifest.revision !== request.manifest.revision) {
            throw new ControlHttpError(
              409,
              "manifest_revision_conflict",
              "Runtime manifest revision changed before update",
            );
          }
          await checkpoint("manifest-persisted");
        }
        if (execution.job.checkpoint === "manifest-persisted") {
          if (execution.job.runtimeWasRunning !== true) {
            await checkpoint("finalized");
          } else {
            const current = await requireRuntime(coordinator, identity);
            const artifact = await committedRestartArtifact();
            await materializeCommittedRuntimeArtifact(
              backend,
              current,
              artifact,
              execution.job.rollbackReleaseSha256,
            );
            await checkpoint("materialized");
          }
        }
        if (execution.job.checkpoint === "materialized") {
          const current = await requireRuntime(coordinator, identity);
          const started = await backend.start(current);
          current.processId = started.processId;
          current.descriptor.status = "running";
          current.descriptor.readyAt = started.readyAt;
          current.descriptor.lastError = null;
          await coordinator.putRuntime(identity, current);
          await coordinator.bindContainer(runtimeContainerId(env, identity), identity);
          await reconcileStartedRuntimeKeepAlive(current, coordinator, backend);
          await checkpoint("process-started");
        }
        if (execution.job.checkpoint === "process-started") {
          await coordinator.appendSystemLog(
            identity,
            "Tenant service restarted after manifest update.",
          );
          await checkpoint("finalized");
        }
        return {
          status: 200,
          body: { runtime: (await requireRuntime(coordinator, identity)).descriptor },
        };
      } catch (error) {
        if (error instanceof StagingDurableOperationOwnerLossError) throw error;
        if (
          execution.job.checkpoint === "initialized" ||
          execution.job.checkpoint === "runtime-unbound"
        ) {
          throw error;
        }
        await coordinator.unbindContainer(runtimeContainerId(env, identity), identity);
        const current = await requireRuntime(coordinator, identity);
        await safelyStopFailedRuntime(backend, current);
        current.descriptor.status = "error";
        current.descriptor.lastError = "Runtime failed after manifest update";
        current.processId = null;
        await coordinator.putRuntime(identity, current);
        throw new ControlHttpError(
          502,
          "runtime_restart_failed",
          "Runtime failed after manifest update",
          true,
        );
      }
    }
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
    const rollbackReleaseSha256 = wasRunning ? runtime.artifactSha256 : null;
    if (rollbackReleaseSha256 !== null && !/^[0-9a-f]{64}$/u.test(rollbackReleaseSha256)) {
      throw new ControlHttpError(
        409,
        "artifact_not_committed",
        "The current runtime release cannot be retained for rollback",
      );
    }
    if (wasRunning && request.restart !== "restart") {
      throw new ControlHttpError(
        409,
        "runtime_busy",
        "Explicit restart is required to update a running runtime",
        true,
      );
    }
    let restartArtifact: CommittedRuntimeArtifact | null = null;
    if (wasRunning) {
      if (request.sealedArtifactSha256 === undefined) {
        throw new ControlHttpError(
          409,
          "artifact_not_committed",
          "A committed artifact for the next manifest is required",
        );
      }
      restartArtifact = await getCommittedRuntimeArtifact(
        coordinator,
        identity,
        request.sealedArtifactSha256,
      );
      if (
        restartArtifact === null ||
        restartArtifact.artifact.envelope.manifestRevision !== request.manifest.revision
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
      runtime.artifactRevision = restartArtifact.artifact.envelope.artifactRevision;
      runtime.artifactSha256 = restartArtifact.artifact.envelope.sealedArtifactSha256;
      runtime.artifactKind = restartArtifact.kind;
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
        await materializeCommittedRuntimeArtifact(
          backend,
          runtime,
          restartArtifact,
          rollbackReleaseSha256,
        );
        const started = await backend.start(runtime);
        runtime.processId = started.processId;
        runtime.descriptor.status = "running";
        runtime.descriptor.readyAt = started.readyAt;
        await coordinator.putRuntime(identity, runtime);
        await coordinator.bindContainer(runtimeContainerId(env, identity), identity);
        await reconcileStartedRuntimeKeepAlive(runtime, coordinator, backend);
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
      artifactKind: null,
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
    if (
      artifactCommitExecution === undefined ||
      artifactCommitExecution === null ||
      artifactCommitExecution.job.kind !== "runtime-start"
    ) {
      throw new Error("Runtime start durable job is unavailable");
    }
    const execution = artifactCommitExecution as DurableOperationExecution & {
      job: StoredRuntimeStartJob;
    };
    const request = execution.job.request;
    assertDeploymentVersion(request.expectedDeploymentVersion, deploymentVersion);
    const checkpoint = async (next: StoredRuntimeStartJob["checkpoint"]): Promise<void> => {
      const updated = await coordinator.checkpointDurableOperation({
        jobKey: execution.job.jobKey,
        ownerId: execution.ownerId,
        ownerGeneration: execution.job.attempt,
        checkpoint: next,
        nowMs: Date.now(),
      });
      if (updated.kind !== "runtime-start") {
        throw new Error("Runtime start durable job changed kind");
      }
      execution.job = updated;
      logDurableOperationCheckpoint(execution.job);
      maybeAbortStagingRuntimeStartAtCheckpoint(env, execution.job);
    };
    maybeAbortStagingRuntimeStartAtCheckpoint(env, execution.job);
    try {
      let artifact: CommittedRuntimeArtifact | null = null;
      if (execution.job.checkpoint === "initialized") {
        artifact = await getCommittedRuntimeArtifact(coordinator, identity, request.artifactSha256);
        if (
          artifact === null ||
          artifact.artifact.runtimeIdentity !== identity ||
          artifact.artifact.envelope.artifactRevision !== request.artifactRevision ||
          artifact.artifact.envelope.manifestRevision !== runtime.manifest.revision
        ) {
          throw new ControlHttpError(
            409,
            "artifact_not_committed",
            "A committed artifact for this runtime manifest is required",
          );
        }
        runtime.artifactRevision = request.artifactRevision;
        runtime.artifactSha256 = request.artifactSha256;
        runtime.artifactKind = artifact.kind;
        runtime.descriptor.status = "starting";
        runtime.descriptor.lastError = null;
        runtime.descriptor.readyAt = null;
        await coordinator.putRuntime(identity, runtime);
        await coordinator.appendSystemLog(identity, "Starting the tenant service.");
        await checkpoint("artifact-verified");
      }
      if (execution.job.checkpoint === "artifact-verified") {
        artifact ??= await getCommittedRuntimeArtifact(
          coordinator,
          identity,
          request.artifactSha256,
        );
        if (artifact === null) {
          throw new ControlHttpError(
            409,
            "artifact_not_committed",
            "A committed artifact for this runtime manifest is required",
          );
        }
        const current = await requireRuntime(coordinator, identity);
        await materializeCommittedRuntimeArtifact(backend, current, artifact);
        await checkpoint("materialized");
      }
      if (execution.job.checkpoint === "materialized") {
        const current = await requireRuntime(coordinator, identity);
        const started = await backend.start(current);
        current.processId = started.processId;
        current.stdoutLength = 0;
        current.stderrLength = 0;
        current.descriptor.status = "running";
        current.descriptor.readyAt = started.readyAt;
        current.descriptor.lastError = null;
        await coordinator.putRuntime(identity, current);
        await coordinator.bindContainer(runtimeContainerId(env, identity), identity);
        await reconcileStartedRuntimeKeepAlive(current, coordinator, backend);
        await checkpoint("process-started");
      }
      if (execution.job.checkpoint === "process-started") {
        await coordinator.appendSystemLog(identity, "Tenant service is ready.");
        await checkpoint("finalized");
      }
      return {
        status: 200,
        body: { runtime: (await requireRuntime(coordinator, identity)).descriptor },
      };
    } catch (error) {
      if (error instanceof StagingDurableOperationOwnerLossError) throw error;
      if (error instanceof ControlHttpError && error.code === "artifact_not_committed") {
        throw error;
      }
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
    const layeredArtifacts = await coordinator.listLayeredArtifacts(identity);
    for (const artifact of layeredArtifacts) {
      const removed = await coordinator.removeLayeredArtifact(
        identity,
        artifact.envelope.sealedArtifactSha256,
      );
      if (removed !== null) await deleteRemovedLayeredArtifact(env, removed);
    }
    await coordinator.deleteRuntime(identity);
    return { status: 200, body: { ok: true } };
  }
  if (endpoint === "status") {
    return {
      status: 200,
      body: { runtime: structuredClone(runtime.descriptor) },
    };
  }
  if (endpoint === "reconcile") {
    const request = input as ReconcileRuntimeRequest;
    if (requestId === undefined) {
      throw new Error("Runtime reconciliation request identity is unavailable");
    }
    const createdAt = new Date(nowMs).toISOString();
    await coordinator.beginRuntimeReconciliation({
      requestId,
      reconciliationId: request.reconciliationId,
      semanticsVersion: RUNTIME_RECONCILIATION_SEMANTICS_VERSION,
      locator: request.locator,
      createdAt,
      updatedAt: createdAt,
      trail: [],
      terminal: null,
    });
    try {
      if (
        runtime.descriptor.status !== request.expectedStatus ||
        runtime.descriptor.manifestRevision !== request.expectedManifestRevision
      ) {
        throw new ControlHttpError(
          409,
          "runtime_reconciliation_conflict",
          "Runtime state changed before reconciliation",
          true,
        );
      }
      const observation = await backend.reconcile(runtime, async (entry) => {
        const sanitized = runtimeReconciliationObservationSchema.parse({
          attempt: entry.attempt,
          observedAt: entry.observedAt,
          stage: entry.stage,
          cause: entry.cause,
          status: entry.status,
          sources: entry.sources,
          decisionInputs: {
            storedStatus: entry.decisionInputs.storedStatus,
            storedProcessIdentity: entry.decisionInputs.storedProcessIdentity,
            providerProcess: entry.decisionInputs.providerProcess,
            health: entry.decisionInputs.health,
          },
          decision: entry.decision,
          repairAction: entry.repairAction,
        });
        await coordinator.appendRuntimeReconciliationObservation(requestId, sanitized);
      });
      if (!observation.conclusive) {
        // An ambiguous provider observation is evidence, not a terminal verdict.
        // No runtime, capability binding, or runtime log is changed on this path.
        throw new ControlHttpError(
          503,
          "runtime_reconciliation_inconclusive",
          `Runtime reconciliation remained ambiguous after ${observation.attempts} observations (${observation.stage}:${observation.cause})`,
          true,
        );
      }

      const containerId = runtimeContainerId(env, identity);
      const previousBinding = await coordinator.getContainerBinding(containerId);
      let outcome:
        | "restored"
        | "repair-scheduled"
        | "healthy-idle"
        | "confirmed-stopped"
        | "confirmed-error"
        | "unchanged";
      let capability: "bound" | "unbound";
      let repairJob: {
        jobKey: string;
        state: "active" | "succeeded" | "failed";
        attempt: number;
      } | null = null;
      let responseStatus = 200;
      if (observation.repairAction === "restart-and-rebind") {
        repairJob = await scheduleRuntimeReconciliationRepair({
          coordinator,
          env,
          identity,
          runtime,
          request,
          nowMs,
        });
        outcome = "repair-scheduled";
        capability = previousBinding === identity ? "bound" : "unbound";
        responseStatus = repairJob.state === "succeeded" ? 200 : 202;
      } else if (observation.repairAction === "settle-idle") {
        runtime.descriptor.status = "stopped";
        runtime.descriptor.lastError = null;
        runtime.descriptor.readyAt = null;
        runtime.processId = null;
        await coordinator.putRuntime(identity, runtime);
        await coordinator.unbindContainer(containerId, identity);
        outcome = "healthy-idle";
        capability = "unbound";
      } else if (observation.ready && observation.processId !== null) {
        const alreadyTruthful =
          runtime.descriptor.status === "running" &&
          runtime.descriptor.lastError === null &&
          runtime.processId === observation.processId &&
          previousBinding === identity;
        runtime.descriptor.status = "running";
        runtime.descriptor.lastError = null;
        runtime.descriptor.readyAt ??= new Date(nowMs).toISOString();
        runtime.processId = observation.processId;
        await coordinator.putRuntime(identity, runtime);
        await coordinator.bindContainer(containerId, identity);
        outcome = alreadyTruthful ? "unchanged" : "restored";
        capability = "bound";
      } else {
        const cleanStop =
          observation.stage === "process" &&
          (observation.cause === "process_missing" || observation.cause === "process_not_running");
        const nextStatus = cleanStop ? "stopped" : "error";
        const nextError = cleanStop
          ? null
          : `Runtime reconciliation failed (${observation.stage}:${observation.cause})`;
        const alreadyTruthful =
          runtime.descriptor.status === nextStatus &&
          runtime.descriptor.lastError === nextError &&
          runtime.descriptor.readyAt === null &&
          runtime.processId === null &&
          previousBinding === null;
        runtime.descriptor.status = nextStatus;
        runtime.descriptor.lastError = nextError;
        runtime.descriptor.readyAt = null;
        runtime.processId = null;
        await coordinator.putRuntime(identity, runtime);
        await coordinator.unbindContainer(containerId, identity);
        outcome = alreadyTruthful
          ? "unchanged"
          : cleanStop
            ? "confirmed-stopped"
            : "confirmed-error";
        capability = "unbound";
      }
      await coordinator.appendSystemLog(
        identity,
        `Governed runtime reconciliation ${request.reconciliationId} completed (outcome=${outcome}, stage=${observation.stage}, cause=${observation.cause}, repair=${observation.repairAction}, attempts=${observation.attempts}).`,
      );
      const record = await coordinator.completeRuntimeReconciliation(requestId, {
        at: new Date().toISOString(),
        status: responseStatus,
        code: "ok",
        retryable: false,
      });
      return {
        status: responseStatus,
        body: {
          ok: true,
          reconciliationId: request.reconciliationId,
          outcome,
          observation: {
            attempts: observation.attempts,
            stage: observation.stage,
            cause: observation.cause,
            status: observation.status,
            repairAction: observation.repairAction,
          },
          capability,
          runtime: structuredClone(runtime.descriptor),
          repairJob,
          evidence: reconciliationEvidence(record),
        },
      };
    } catch (error) {
      const classified = toControlError(error);
      const record = await coordinator.completeRuntimeReconciliation(requestId, {
        at: new Date().toISOString(),
        status: classified.status,
        code: classified.code,
        retryable: classified.retryable,
      });
      throw new ControlHttpError(
        classified.status,
        classified.code,
        classified.message,
        classified.retryable,
        reconciliationEvidence(record),
      );
    }
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

async function promoteLayeredArtifact(
  request: PromoteRuntimeLayeredArtifactRequest,
  env: WorkerBindings,
  coordinator: ControlCoordinator,
  execution: DurableOperationExecution & { job: StoredLayeredArtifactPromotionJob },
): Promise<StoredHttpResponse> {
  assertDeploymentVersion(request.expectedDeploymentVersion, env.CF_VERSION_METADATA.id);
  const sourceIdentity = await deriveRuntimeIdentity({
    namespace: env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    ...request.sourceLocator,
  });
  const targetIdentity = await deriveRuntimeIdentity({
    namespace: env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
    ...request.targetLocator,
  });
  if (execution.job.runtimeIdentity !== targetIdentity) {
    throw new ControlHttpError(
      409,
      "artifact_promotion_identity_conflict",
      "Promotion job is bound to a different production runtime",
    );
  }
  const source = await coordinator.getLayeredArtifact(
    sourceIdentity,
    request.sourceSealedArtifactSha256,
  );
  if (source === null || source.state !== "committed") {
    throw new ControlHttpError(
      404,
      "artifact_promotion_source_not_found",
      "Accepted sealed release is not present in the dock",
    );
  }
  const sourceEnvelope = source.envelope;
  if (!(await verifyRuntimeLayeredArtifactEnvelope(sourceEnvelope))) {
    throw new ControlHttpError(
      422,
      "artifact_promotion_source_integrity_mismatch",
      "Accepted sealed release failed envelope verification",
    );
  }

  const { sealedArtifactSha256: _sourceAppSealedArtifactSha256, ...sourceAppUnsigned } =
    sourceEnvelope.content.appArtifact;
  const targetAppUnsigned = {
    ...sourceAppUnsigned,
    targetRuntimeIdentity: targetIdentity,
    manifestRevision: request.targetManifest.revision,
    artifactRevision: request.targetArtifactRevision,
  };
  const targetApp = {
    ...targetAppUnsigned,
    sealedArtifactSha256: await runtimeArtifactSealedHash(targetAppUnsigned),
  };
  const { finalMergedReleaseSha256: _sourceMergedReleaseSha256, ...sourceContent } =
    sourceEnvelope.content;
  const targetContentWithoutMergedHash = {
    ...sourceContent,
    appArtifact: targetApp,
  };
  const targetContent = {
    ...targetContentWithoutMergedHash,
    finalMergedReleaseSha256: await runtimeLayeredArtifactMergedReleaseHash(
      targetContentWithoutMergedHash,
    ),
  };
  const targetContentSha256 = await runtimeLayeredArtifactContentHash(targetContent);
  const { sealedArtifactSha256: _sourceSealedArtifactSha256, ...sourceEnvelopeUnsigned } =
    sourceEnvelope;
  const targetUnsigned = {
    ...sourceEnvelopeUnsigned,
    content: targetContent,
    contentSha256: targetContentSha256,
    targetRuntimeIdentity: targetIdentity,
    manifestRevision: request.targetManifest.revision,
    artifactRevision: request.targetArtifactRevision,
  };
  const targetEnvelope = {
    ...targetUnsigned,
    sealedArtifactSha256: await runtimeLayeredArtifactSealedHash(targetUnsigned),
  };
  if (!(await verifyRuntimeLayeredArtifactEnvelope(targetEnvelope))) {
    throw new ControlHttpError(
      500,
      "artifact_promotion_envelope_invalid",
      "Production artifact rebinding did not produce a valid sealed envelope",
    );
  }

  const checkpoint = async (
    next: StoredLayeredArtifactPromotionJob["checkpoint"],
  ): Promise<void> => {
    const updated = await coordinator.checkpointDurableOperation({
      jobKey: execution.job.jobKey,
      ownerId: execution.ownerId,
      ownerGeneration: execution.job.attempt,
      checkpoint: next,
      nowMs: Date.now(),
    });
    if (updated.kind !== "layered-artifact-promotion") {
      throw new Error("Artifact promotion job changed kind");
    }
    execution.job = updated;
  };

  if (execution.job.checkpoint === "initialized") {
    try {
      await verifyStoredArtifactChunks(
        env.NABUFLOW_RUNTIME_ARTIFACTS,
        sourceEnvelope.content.appArtifact.content,
        (index) =>
          layeredArtifactAppChunkKey(sourceIdentity, sourceEnvelope.sealedArtifactSha256, index),
      );
      for (const layer of sourceEnvelope.content.layers) {
        await verifyStoredLayerIntegrity(env.NABUFLOW_RUNTIME_ARTIFACTS, layer);
      }
    } catch (error) {
      if (error instanceof ControlHttpError) {
        throw new ControlHttpError(
          error.status,
          "artifact_promotion_source_integrity_mismatch",
          "Accepted sealed release payload failed integrity verification",
          error.retryable,
        );
      }
      throw error;
    }
    await checkpoint("source-verified");
  }

  if (execution.job.checkpoint === "source-verified") {
    const targetRuntime = await requireRuntime(coordinator, targetIdentity);
    if (
      targetRuntime.manifest.revision !== request.targetManifest.revision ||
      canonicalJson(targetRuntime.manifest) !== canonicalJson(request.targetManifest)
    ) {
      throw new ControlHttpError(
        409,
        "artifact_promotion_manifest_conflict",
        "Production runtime manifest does not match the promotion target",
      );
    }
    const begun = await coordinator.beginLayeredArtifact({
      runtimeIdentity: targetIdentity,
      envelope: targetEnvelope,
      state: "pending",
      receivedAppChunks: targetEnvelope.content.appArtifact.content.chunks.map(() => null),
      expiresAtMs: Date.now() + RUNTIME_ARTIFACT_PENDING_TTL_MS,
    });
    if (begun === "conflict") {
      throw new ControlHttpError(
        409,
        "artifact_promotion_target_conflict",
        "Production artifact address is bound to different metadata",
      );
    }
    await checkpoint("target-created");
  }

  if (execution.job.checkpoint === "target-created") {
    const target = await coordinator.getLayeredArtifact(
      targetIdentity,
      targetEnvelope.sealedArtifactSha256,
    );
    if (target === null) {
      throw new ControlHttpError(
        409,
        "artifact_promotion_target_missing",
        "Production artifact reservation disappeared",
        true,
      );
    }
    if (target.state === "committed") {
      try {
        await verifyStoredArtifactChunks(
          env.NABUFLOW_RUNTIME_ARTIFACTS,
          targetEnvelope.content.appArtifact.content,
          (index) =>
            layeredArtifactAppChunkKey(targetIdentity, targetEnvelope.sealedArtifactSha256, index),
        );
      } catch (error) {
        if (error instanceof ControlHttpError) {
          throw new ControlHttpError(
            error.status,
            "artifact_promotion_target_integrity_mismatch",
            "Immutable production artifact bytes failed integrity verification",
            error.retryable,
          );
        }
        throw error;
      }
    } else {
      for (
        let index = 0;
        index < sourceEnvelope.content.appArtifact.content.chunks.length;
        index += 1
      ) {
        const expectedSha256 = sourceEnvelope.content.appArtifact.content.chunks[index];
        const sourceKey = layeredArtifactAppChunkKey(
          sourceIdentity,
          sourceEnvelope.sealedArtifactSha256,
          index,
        );
        const targetKey = layeredArtifactAppChunkKey(
          targetIdentity,
          targetEnvelope.sealedArtifactSha256,
          index,
        );
        const sourceObject = await env.NABUFLOW_RUNTIME_ARTIFACTS.get(sourceKey);
        if (sourceObject === null) {
          throw new ControlHttpError(
            409,
            "artifact_promotion_source_incomplete",
            "Accepted sealed release payload is incomplete",
          );
        }
        const sourceBytes = new Uint8Array(await sourceObject.arrayBuffer());
        if ((await sha256Hex(sourceBytes)) !== expectedSha256) {
          throw new ControlHttpError(
            422,
            "artifact_promotion_source_integrity_mismatch",
            "Accepted sealed release payload failed integrity verification",
          );
        }
        const existing = await env.NABUFLOW_RUNTIME_ARTIFACTS.get(targetKey);
        if (existing !== null) {
          const existingBytes = new Uint8Array(await existing.arrayBuffer());
          if ((await sha256Hex(existingBytes)) !== expectedSha256) {
            throw new ControlHttpError(
              422,
              "artifact_promotion_target_integrity_mismatch",
              "Immutable production artifact bytes conflict with the promotion",
            );
          }
        } else {
          await env.NABUFLOW_RUNTIME_ARTIFACTS.put(targetKey, sourceBytes.slice().buffer, {
            sha256: expectedSha256,
            onlyIf: { etagDoesNotMatch: "*" },
            customMetadata: { sha256: expectedSha256 },
          });
          const readback = await env.NABUFLOW_RUNTIME_ARTIFACTS.get(targetKey);
          if (
            readback === null ||
            (await sha256Hex(new Uint8Array(await readback.arrayBuffer()))) !== expectedSha256
          ) {
            throw new ControlHttpError(
              503,
              "artifact_promotion_storage_unavailable",
              "Production artifact could not be reverified after storage",
              true,
            );
          }
        }
        const recorded = await coordinator.recordLayeredArtifactAppChunk(
          targetIdentity,
          targetEnvelope.sealedArtifactSha256,
          index,
          expectedSha256,
        );
        if (recorded === "not_found" || recorded === "conflict") {
          throw new ControlHttpError(
            409,
            "artifact_promotion_target_conflict",
            "Production artifact reservation changed during promotion",
            recorded === "not_found",
          );
        }
      }
    }
    await checkpoint("payloads-copied");
  }

  if (execution.job.checkpoint === "payloads-copied") {
    const committed = await coordinator.commitLayeredArtifact(
      targetIdentity,
      targetEnvelope.sealedArtifactSha256,
    );
    if (committed !== "committed") {
      throw new ControlHttpError(
        committed === "incomplete" ? 409 : 422,
        committed === "incomplete"
          ? "artifact_promotion_target_incomplete"
          : "artifact_promotion_target_integrity_mismatch",
        "Production artifact could not be committed",
      );
    }
    await checkpoint("finalized");
  }

  return {
    status: 200,
    body: promoteRuntimeLayeredArtifactResponseSchema.parse({
      ok: true,
      promotionIdentity: request.promotionIdentity,
      sourceSealedArtifactSha256: request.sourceSealedArtifactSha256,
      targetSealedArtifactSha256: targetEnvelope.sealedArtifactSha256,
      targetContentSha256,
      artifactRevision: request.targetArtifactRevision,
      appChunksCopied: targetEnvelope.content.appArtifact.content.chunks.length,
      layersReused: targetEnvelope.content.layers.length,
      envelope: targetEnvelope,
    }),
  };
}

function runtimeContainerId(env: WorkerBindings, identity: string): string {
  return env.NABUFLOW_SANDBOX.idFromName(identity).toString();
}

const ROUTE_KEEPALIVE_RECONCILIATION_PASSES = 3;

async function productionSlotIdentities(env: WorkerBindings, projectId: number): Promise<string[]> {
  return Promise.all(
    (["blue", "green"] as const).map((slot) =>
      deriveRuntimeIdentity({
        namespace: env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
        projectId,
        role: "production",
        slot,
      }),
    ),
  );
}

async function productionSlotIdentitiesFromExpected(
  env: WorkerBindings,
  expectedIdentity: string,
): Promise<string[]> {
  const parsed = await parseRuntimeIdentityForNamespace(
    expectedIdentity,
    env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE,
  ).catch(() => null);
  if (parsed === null || parsed.role !== "production") return [expectedIdentity];
  return productionSlotIdentities(env, parsed.projectId);
}

function sameRoute(left: RouteRecord | null, right: RouteRecord): boolean {
  return (
    left !== null &&
    left.hostname === right.hostname &&
    left.projectId === right.projectId &&
    left.role === right.role &&
    left.activeSlot === right.activeSlot &&
    left.manifestRevision === right.manifestRevision &&
    left.servicePort === right.servicePort &&
    left.sandboxIdentity === right.sandboxIdentity
  );
}

async function persistRuntimeKeepAlive(
  backend: RuntimeBackend,
  identity: string,
  keepAlive: boolean,
): Promise<void> {
  try {
    await backend.setKeepAlive(identity, keepAlive);
  } catch {
    throw new ControlHttpError(
      503,
      "route_keepalive_reconciliation_failed",
      "Published route container policy could not be reconciled",
      true,
    );
  }
}

/**
 * Starting a Sandbox deliberately resets keepAlive to false. Production runtimes
 * must then converge to the route registry's current truth before the start can
 * complete, or a recovered active route would become sleepable ten minutes later.
 * A second read closes activation/deactivation races without making start infer
 * policy from stale descriptor state.
 */
async function reconcileStartedRuntimeKeepAlive(
  runtime: StoredRuntime,
  coordinator: ControlCoordinator,
  backend: RuntimeBackend,
): Promise<void> {
  if (runtime.descriptor.role !== "production") return;
  for (let pass = 0; pass < ROUTE_KEEPALIVE_RECONCILIATION_PASSES; pass += 1) {
    const before = await coordinator.hasRouteForSandboxIdentity(runtime.descriptor.identity);
    await persistRuntimeKeepAlive(backend, runtime.descriptor.identity, before);
    const after = await coordinator.hasRouteForSandboxIdentity(runtime.descriptor.identity);
    if (after === before) return;
  }
  throw new ControlHttpError(
    503,
    "route_keepalive_reconciliation_busy",
    "Published route container policy changed too many times to reconcile",
    true,
  );
}

async function drivePublishedRoutePolicyAfterCas(
  hostname: string,
  coordinator: ControlCoordinator,
  backend: RuntimeBackend,
  nowMs: number,
): Promise<void> {
  const result = await driveRoutePolicyReconciliation({
    coordinator,
    backend,
    hostname,
    nowMs: () => nowMs,
  });
  if (result !== "terminal") return;
  throw new ControlHttpError(
    503,
    "route_policy_reconciliation_exhausted",
    "Published route container policy reached its retry cap",
    false,
  );
}

async function activatePublishedRoute(
  request: ActivateRouteRequest,
  env: WorkerBindings,
  coordinator: ControlCoordinator,
  backend: RuntimeBackend,
  nowMs: number,
): Promise<StoredHttpResponse> {
  const route = request.route;
  if (
    route.role !== "production" ||
    (route.activeSlot !== "blue" && route.activeSlot !== "green")
  ) {
    throw new ControlHttpError(
      400,
      "production_slot_required",
      "Published routes require a production blue/green runtime",
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
    parsedIdentity.slot !== route.activeSlot
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
    runtime.descriptor.slot !== route.activeSlot ||
    runtime.descriptor.projectId !== route.projectId ||
    runtime.descriptor.manifestRevision !== route.manifestRevision ||
    runtime.manifest.revision !== route.manifestRevision ||
    runtime.descriptor.servicePort !== route.servicePort ||
    runtime.manifest.servicePort !== route.servicePort
  ) {
    throw new ControlHttpError(
      409,
      "published_runtime_not_ready",
      "The selected production runtime is not ready for route activation",
      true,
    );
  }

  const currentRoute = await coordinator.getRoute(route.hostname);
  const slotIdentities = await productionSlotIdentities(env, route.projectId);
  if (!sameRoute(currentRoute, route)) {
    const availability = await backend.availability(runtime);
    if (!availability.ready) {
      await coordinator.appendSystemLog(
        route.sandboxIdentity,
        `Published route activation rejected runtime availability (stage=${availability.stage}, cause=${availability.cause}).`,
      );
      const recovery = await schedulePublishedRuntimeRecovery(runtime, env, {
        coordinator,
        nowMs,
      });
      if (recovery === "exhausted") {
        throw new ControlHttpError(
          409,
          "published_runtime_recovery_exhausted",
          "Published runtime recovery reached its retry cap",
          false,
        );
      }
      throw new ControlHttpError(
        409,
        "published_runtime_not_ready",
        recovery === "scheduled"
          ? "The selected production runtime is recovering before route activation"
          : "The selected production runtime is not ready for route activation",
        true,
      );
    }
  }

  // Route truth and its bounded provider-policy intent commit together. The provider boundary is
  // deliberately after the CAS, so a failed or abandoned candidate can never be made persistent.
  const state = await coordinator.activateRoute(route, request.expectedPreviousManifestRevision, {
    identities: [
      ...slotIdentities,
      ...(currentRoute === null ? [] : [currentRoute.sandboxIdentity]),
    ],
    nowMs,
  });
  if (state === "conflict") {
    throw new ControlHttpError(
      409,
      "route_activation_conflict",
      "The published route changed before activation",
      true,
    );
  }
  await drivePublishedRoutePolicyAfterCas(route.hostname, coordinator, backend, nowMs);
  return { status: 200, body: { ok: true, route } };
}

async function deactivatePublishedRoute(
  request: DeactivateRouteRequest,
  env: WorkerBindings,
  coordinator: ControlCoordinator,
  backend: RuntimeBackend,
  nowMs: number,
): Promise<StoredHttpResponse> {
  const slotIdentities = await productionSlotIdentitiesFromExpected(
    env,
    request.expectedSandboxIdentity,
  );
  const state = await coordinator.deactivateRoute(
    request.hostname,
    request.expectedManifestRevision,
    request.expectedSandboxIdentity,
    { identities: slotIdentities, nowMs },
  );
  if (state === "conflict") {
    throw new ControlHttpError(
      409,
      "route_deactivation_conflict",
      "The published route changed before removal",
      true,
    );
  }
  await drivePublishedRoutePolicyAfterCas(request.hostname, coordinator, backend, nowMs);
  return { status: 200, body: { ok: true, hostname: request.hostname } };
}

function validateResponse(endpoint: Endpoint, body: unknown): void {
  if (
    endpoint === "pantryRead" ||
    endpoint === "pantryMutation" ||
    endpoint === "buildRead" ||
    endpoint === "buildMutation"
  ) {
    if (
      typeof body !== "object" ||
      body === null ||
      Array.isArray(body) ||
      (body as { ok?: unknown }).ok !== true
    ) {
      throw new ControlHttpError(
        500,
        "invalid_worker_response",
        "Pantry service produced an invalid response",
      );
    }
    return;
  }
  const schema = {
    version: versionResponseSchema,
    durableOperationDiscovery: durableOperationDiscoveryResponseSchema,
    reconciliationAudit: runtimeReconciliationAuditResponseSchema,
    ensure: ensureRuntimeResponseSchema,
    start: startRuntimeResponseSchema,
    startDiagnostics: runtimeStartDiagnosticsResponseSchema,
    stop: stopRuntimeResponseSchema,
    destroy: destroyRuntimeResponseSchema,
    status: statusRuntimeResponseSchema,
    reconcile: reconcileRuntimeResponseSchema,
    exec: execRuntimeResponseSchema,
    logs: logsRuntimeResponseSchema,
    routeActivate: activateRouteResponseSchema,
    routeDeactivate: deactivateRouteResponseSchema,
    routeInventory: routeInventoryResponseSchema,
    routeRead: routeReadResponseSchema,
    capabilityProvision: capabilityProvisionResponseSchema,
    capabilityRevoke: capabilityRevokeResponseSchema,
    databaseCapabilityProvision: capabilityProvisionResponseSchema,
    databaseCapabilityRevoke: capabilityRevokeResponseSchema,
    productionDatabaseEnsure: productionDatabaseAllocationResponseSchema,
    productionDatabaseRelease: productionDatabaseReleaseResponseSchema,
    stripeCapabilityProvision: capabilityProvisionResponseSchema,
    stripeCapabilityRevoke: capabilityRevokeResponseSchema,
    capabilityBinding: capabilityBindingResponseSchema,
    artifactBegin: beginRuntimeArtifactResponseSchema,
    artifactChunk: uploadRuntimeArtifactChunkResponseSchema,
    artifactCommit: commitRuntimeArtifactResponseSchema,
    artifactCommitDiagnostics: artifactCommitDiagnosticsResponseSchema,
    artifactRemove: removeRuntimeArtifactResponseSchema,
    layeredArtifactBegin: beginRuntimeLayeredArtifactResponseSchema,
    layeredArtifactAppChunk: uploadRuntimeLayeredArtifactChunkResponseSchema,
    layeredArtifactLayerChunk: uploadRuntimeLayeredArtifactChunkResponseSchema,
    layeredArtifactCommit: commitRuntimeLayeredArtifactResponseSchema,
    layeredArtifactCommitDiagnostics: artifactCommitDiagnosticsResponseSchema,
    layeredArtifactRemove: removeRuntimeLayeredArtifactResponseSchema,
    layeredArtifactPromotion: promoteRuntimeLayeredArtifactResponseSchema,
    layeredArtifactPromotionDiagnostics: layeredArtifactPromotionDiagnosticsResponseSchema,
    productionDatabaseDiagnostics: productionDatabaseDiagnosticsResponseSchema,
    manifestUpdate: ensureRuntimeResponseSchema,
    manifestUpdateDiagnostics: runtimeManifestRestartDiagnosticsResponseSchema,
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

function configuredLayerPlatform(env: WorkerBindings): PantryPlatform | null {
  if (!env.NABUFLOW_RUNTIME_LAYER_PLATFORM) return null;
  try {
    const parsed = pantryPlatformSchema.safeParse(JSON.parse(env.NABUFLOW_RUNTIME_LAYER_PLATFORM));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function assertLayeredArtifactInfrastructure(env: WorkerBindings): void {
  if (configuredLayerPlatform(env) === null) {
    throw new ControlHttpError(
      503,
      "artifact_layer_infrastructure_unavailable",
      "The runtime dependency-layer infrastructure is not configured",
      false,
    );
  }
}

function assertLayerPlatform(platform: PantryPlatform, env: WorkerBindings): void {
  const configured = configuredLayerPlatform(env);
  if (configured === null || canonicalJson(platform) !== canonicalJson(configured)) {
    throw new ControlHttpError(
      422,
      "artifact_layer_platform_mismatch",
      "Dependency layers do not target this runtime platform",
    );
  }
}

function expectedChunkLength(
  payloadBytes: number,
  chunkBytes: number,
  chunks: number,
  chunkIndex: number,
): number | null {
  if (chunkIndex < 0 || chunkIndex >= chunks) return null;
  const isFinal = chunkIndex === chunks - 1;
  return isFinal ? payloadBytes % chunkBytes || chunkBytes : chunkBytes;
}

async function loadCommittedLayers(
  coordinator: ControlCoordinator,
  artifact: StoredRuntimeLayeredArtifact,
): Promise<StoredRuntimeLayer[]> {
  const layers: StoredRuntimeLayer[] = [];
  for (const content of artifact.envelope.content.layers) {
    const layer = await coordinator.getRuntimeLayer(content.descriptor.contentSha256);
    if (layer === null || layer.state !== "committed") {
      throw new ControlHttpError(
        409,
        "artifact_not_committed",
        "A committed dependency layer is required",
      );
    }
    layers.push(layer);
  }
  return layers;
}

async function getCommittedRuntimeArtifact(
  coordinator: ControlCoordinator,
  identity: string,
  sealedArtifactSha256: string,
): Promise<CommittedRuntimeArtifact | null> {
  const v1 = await coordinator.getArtifact(identity, sealedArtifactSha256);
  if (v1 !== null && v1.state === "committed") return { kind: "v1", artifact: v1 };
  const layered = await coordinator.getLayeredArtifact(identity, sealedArtifactSha256);
  if (layered === null || layered.state !== "committed") return null;
  return {
    kind: "layers-v1",
    artifact: layered,
    layers: await loadCommittedLayers(coordinator, layered),
  };
}

async function materializeCommittedRuntimeArtifact(
  backend: RuntimeBackend,
  runtime: StoredRuntime,
  artifact: CommittedRuntimeArtifact,
  rollbackReleaseSha256?: string | null,
): Promise<void> {
  const materializationRuntime =
    rollbackReleaseSha256 === undefined
      ? runtime
      : { ...runtime, artifactSha256: rollbackReleaseSha256 };
  if (artifact.kind === "v1") {
    await backend.materialize(materializationRuntime, artifact.artifact);
    return;
  }
  await backend.materializeLayered(materializationRuntime, artifact.artifact, artifact.layers);
}

async function verifyStoredLayerIntegrity(
  bucket: R2Bucket,
  content: RuntimeArtifactLayerContent,
): Promise<void> {
  const payloadHash = createHash("sha256");
  let verifiedBytes = 0;
  for (let index = 0; index < content.chunks.length; index += 1) {
    const object = await bucket.get(
      dependencyLayerChunkKey(content.descriptor.contentSha256, index),
    );
    if (object === null) {
      throw new ControlHttpError(
        409,
        "artifact_incomplete",
        "Dependency layer upload is incomplete",
      );
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const expectedLength = expectedChunkLength(
      content.payloadBytes,
      content.chunkBytes,
      content.chunks.length,
      index,
    );
    if (
      expectedLength === null ||
      bytes.byteLength !== expectedLength ||
      (await sha256Hex(bytes)) !== content.chunks[index]
    ) {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Dependency layer object failed integrity verification",
      );
    }
    payloadHash.update(bytes);
    verifiedBytes += bytes.byteLength;
  }
  if (
    verifiedBytes !== content.payloadBytes ||
    payloadHash.digest("hex") !== content.descriptor.contentSha256
  ) {
    throw new ControlHttpError(
      422,
      "artifact_integrity_mismatch",
      "Dependency layer content failed integrity verification",
    );
  }
}

async function verifyStoredArtifactChunks(
  bucket: R2Bucket,
  content: { chunks: string[]; payloadBytes: number; chunkBytes: number },
  keyForChunk: (chunkIndex: number) => string,
): Promise<void> {
  for (let index = 0; index < content.chunks.length; index += 1) {
    const object = await bucket.get(keyForChunk(index));
    if (object === null) {
      throw new ControlHttpError(409, "artifact_incomplete", "Artifact upload is incomplete");
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    const expectedLength = expectedChunkLength(
      content.payloadBytes,
      content.chunkBytes,
      content.chunks.length,
      index,
    );
    if (
      expectedLength === null ||
      bytes.byteLength !== expectedLength ||
      (await sha256Hex(bytes)) !== content.chunks[index]
    ) {
      throw new ControlHttpError(
        422,
        "artifact_integrity_mismatch",
        "Artifact object failed integrity verification",
      );
    }
  }
}

async function deleteRemovedLayeredArtifact(
  env: WorkerBindings,
  removed: RemovedRuntimeLayeredArtifact,
): Promise<void> {
  await deleteLayeredArtifactAppObjects(env.NABUFLOW_RUNTIME_ARTIFACTS, removed.artifact);
  for (const layer of removed.unreferencedLayers) {
    await deleteDependencyLayerObjects(env.NABUFLOW_RUNTIME_ARTIFACTS, layer);
  }
}

function requestBodyLimit(pathname: string): number {
  if (
    new RegExp(
      `^${CONTROL_PREFIX}/pantry/assemblies/passembly_[0-9a-f]{64}/objects/[0-9a-f]{64}/[a-z-]+$`,
    ).test(pathname)
  ) {
    return 16 * 1024 * 1024;
  }
  if (/\/artifacts\/[0-9a-f]{64}\/chunks\/[0-9]+$/u.test(pathname))
    return RUNTIME_ARTIFACT_CHUNK_BYTES;
  if (/\/artifacts\/[0-9a-f]{64}\/begin$/u.test(pathname))
    return MAX_RUNTIME_ARTIFACT_MANIFEST_BYTES;
  if (
    /\/layered-artifacts\/[0-9a-f]{64}\/(?:app\/|layers\/[0-9a-f]{64}\/)?chunks\/[0-9]+$/u.test(
      pathname,
    )
  ) {
    return RUNTIME_ARTIFACT_CHUNK_BYTES;
  }
  if (/\/layered-artifacts\/[0-9a-f]{64}\/begin$/u.test(pathname)) {
    return MAX_RUNTIME_ARTIFACT_LAYERED_MANIFEST_BYTES;
  }
  if (pathname === `${CONTROL_PREFIX}/build-plane/builds`) {
    return TRUSTED_BUILD_MAX_REQUEST_BYTES;
  }
  return MAX_REQUEST_BYTES;
}

function assertArtifactInfrastructure(env: WorkerBindings): void {
  if (
    typeof env.CF_VERSION_METADATA?.id !== "string" ||
    env.CF_VERSION_METADATA.id.length === 0 ||
    typeof env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE !== "string" ||
    env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE.length === 0 ||
    !env.DURABLE_OPERATION_QUEUE ||
    typeof env.DURABLE_OPERATION_QUEUE.send !== "function" ||
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

function reconciliationEvidence(
  record: RuntimeReconciliationAuditRecord,
): RuntimeReconciliationEvidence {
  if (record.terminal === null) {
    throw new Error("Runtime reconciliation terminal evidence is unavailable");
  }
  return {
    semanticsVersion: record.semanticsVersion,
    reconciliationId: record.reconciliationId,
    trail: structuredClone(record.trail),
    terminal: structuredClone(record.terminal),
  };
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
    ...(error.evidence === undefined ? {} : { evidence: error.evidence }),
  });
}

function errorResponse(
  status: number,
  code: string,
  message: string,
  retryable: boolean,
  requestId: string,
  headers: HeadersInit = {},
  evidence?: RuntimeReconciliationEvidence,
): Response {
  return jsonResponse(
    status,
    errorBody(new ControlHttpError(status, code, message, retryable, evidence), requestId),
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
  try {
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
  } catch {
    // Audit persistence is best-effort at the response boundary. A transient DO rejection must
    // never replace a response the control plane has already classified and constructed.
    // eslint-disable-next-line no-console -- metadata-only audit availability evidence
    console.error(
      JSON.stringify({
        event: "control_audit_write_failed",
        requestId,
        endpoint,
        status: outcome.status,
      }),
    );
  }
}
