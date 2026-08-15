import {
  CONTROL_API_PREFIX,
  PANTRY_BUILD_INPUT_FORMAT,
  PANTRY_SCHEMA_VERSION,
  TRUSTED_BUILD_REQUEST_FORMAT,
  TRUSTED_BUILD_SCHEMA_VERSION,
  TRUSTED_BUILD_SOURCE_FORMAT,
  ZERO_GENERATION_INNER_FOLLOWER_MARGIN_MS,
  ZERO_GENERATION_ASSEMBLY_RESERVE_MS,
  ZERO_GENERATION_COMMIT_RESERVE_MS,
  ZERO_GENERATION_KITCHEN_PRODUCT_BOUND_MS,
  ZERO_GENERATION_OBSERVATION_RESERVE_MS,
  ZERO_GENERATION_START_RESERVE_MS,
  RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
  RUNTIME_START_OPERATION_BOUND_MS,
  ZERO_SEALED_BUILD_PLATFORM,
  canonicalPantryJson,
  pantryCatalogAssemblyStatusResponseSchema,
  pantryCatalogAssemblyDiagnosticsResponseSchema,
  pantryCatalogShelfRecordSchema,
  pantryCatalogStockRequestHash,
  pantryCatalogStockRequestSchema,
  pantryCatalogStockResponseSchema,
  pantryShelfContentHashesResponseSchema,
  sha256Hex,
  trustedBuildDependencyIntentHash,
  trustedBuildRequestHash,
  trustedBuildRequestSchema,
  trustedBuildSourceManifestHash,
  trustedBuildStatusResponseSchema,
  acceptedSealedReleaseSchema,
  type PantryCatalogShelfRecord,
  type PantryCatalogStockRequest,
  type PantryErrorCode,
  type PantryShelfContentHashesResponse,
  type RuntimeManifestContract,
  type TrustedBuildOutput,
  type TrustedBuildRequest,
  type ZeroGeneratedDependencyPlan,
  type AcceptedSealedRelease,
} from "@workspace/tenant-runtime-contracts";
import type { BuilderFile } from "./builder";
import {
  assertZeroGeneratedEligibility,
  inferZeroDeclaredCapabilities,
} from "./zero-capability-eligibility";
import type { ZeroGenerationTenantRuntimeProvider } from "./tenant-runtime-provider";
import { sealRuntimeArtifact } from "./runtime-artifact";
import {
  resolveTrustedPantryLayerSealProvenance,
  sealLayeredRuntimeArtifact,
  sealRuntimeArtifactLayer,
} from "./runtime-artifact-layers";

const PANTRY_PREFIX = `${CONTROL_API_PREFIX}/pantry`;
const BUILD_PREFIX = `${CONTROL_API_PREFIX}/build-plane`;
const BUILD_WAIT_MS = ZERO_GENERATION_KITCHEN_PRODUCT_BOUND_MS;
const ZERO_GENERATION_CONTROL_READ_ATTEMPT_BOUND_MS = 30_000;
const ZERO_GENERATION_CONTROL_READ_RETRY_MS = 2_000;

export class ZeroGenerationKitchenError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly evidence: Readonly<Record<string, unknown>> | null = null,
  ) {
    super(message);
    this.name = "ZeroGenerationKitchenError";
  }
}

export function zeroGenerationReservedOperationTimeout(input: {
  operation: "artifact-commit" | "runtime-start";
  nowMs: number;
  productDeadlineMs: number;
}): number {
  const reserveMs =
    input.operation === "artifact-commit"
      ? ZERO_GENERATION_COMMIT_RESERVE_MS
      : ZERO_GENERATION_START_RESERVE_MS;
  const namedProviderBoundMs =
    input.operation === "artifact-commit"
      ? RUNTIME_ARTIFACT_OPERATION_BOUND_MS
      : RUNTIME_START_OPERATION_BOUND_MS;
  const downstreamReserveMs =
    input.operation === "artifact-commit"
      ? ZERO_GENERATION_START_RESERVE_MS + ZERO_GENERATION_OBSERVATION_RESERVE_MS
      : ZERO_GENERATION_OBSERVATION_RESERVE_MS;
  const availableMs = input.productDeadlineMs - input.nowMs - downstreamReserveMs;
  if (availableMs < reserveMs || namedProviderBoundMs < reserveMs) {
    throw new ZeroGenerationKitchenError(
      "kitchen_phase_budget_exhausted",
      "Zero generation cannot enter a phase without its named reserve",
      {
        stage: input.operation,
        availableMs,
        reserveMs,
        downstreamReserveMs,
        namedProviderBoundMs,
      },
    );
  }
  return Math.min(availableMs, namedProviderBoundMs);
}

function base64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function decodeBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

function sourceBytes(file: BuilderFile): Uint8Array {
  return new TextEncoder().encode(file.content.replace(/\r\n?/gu, "\n"));
}

export async function makeZeroTrustedBuildRequest(input: {
  files: readonly BuilderFile[];
  dependencyPlan: ZeroGeneratedDependencyPlan;
  shelf: PantryCatalogShelfRecord;
  createdAt: string;
}): Promise<TrustedBuildRequest> {
  const sourceFiles = input.files
    .map((file) => ({ path: file.path, mode: 0o644 as const, bytes: sourceBytes(file) }))
    .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  const payload = new Uint8Array(
    sourceFiles.reduce((total, file) => total + file.bytes.byteLength, 0),
  );
  let offset = 0;
  const files = [];
  for (const file of sourceFiles) {
    payload.set(file.bytes, offset);
    files.push({
      path: file.path,
      mode: file.mode,
      offset,
      size: file.bytes.byteLength,
      sha256: await sha256Hex(file.bytes),
    });
    offset += file.bytes.byteLength;
  }
  const manifest = {
    format: TRUSTED_BUILD_SOURCE_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    payloadBytes: payload.byteLength,
    files,
  };
  const sourceArtifactSha256 = await trustedBuildSourceManifestHash(manifest);
  const dependencyIntentSha256 = await trustedBuildDependencyIntentHash(
    input.dependencyPlan.intents,
  );
  const buildId = `pbuild_zero_${await sha256Hex(`${sourceArtifactSha256}:${dependencyIntentSha256}`)}`;
  const unsigned = {
    format: TRUSTED_BUILD_REQUEST_FORMAT,
    schemaVersion: TRUSTED_BUILD_SCHEMA_VERSION,
    input: {
      format: PANTRY_BUILD_INPUT_FORMAT,
      schemaVersion: PANTRY_SCHEMA_VERSION,
      buildId,
      sourceArtifactSha256,
      dependencyIntentSha256,
      lockfileSha256: input.shelf.lockfileSha256,
      pantryRevisionId: input.shelf.revision.content.revisionId,
      pantryRevisionRootSha256: input.shelf.revision.rootSha256,
      dependencyClosureSha256: input.shelf.revision.content.dependencyClosureSha256,
      platform: ZERO_SEALED_BUILD_PLATFORM,
      buildCommand: ["npm", "run", "build"],
      createdAt: input.createdAt,
    },
    source: { manifest, payloadBase64: base64(payload) },
    dependencyIntents: input.dependencyPlan.intents,
    output: {
      strategy: "bundle-first" as const,
      dependencyPackaging: "layer" as const,
      appDirectory: "dist",
      dependencyLayerMountPath: "node_modules" as const,
    },
  };
  return trustedBuildRequestSchema.parse({
    ...unsigned,
    requestId: `pbuildreq_${await trustedBuildRequestHash(unsigned)}`,
  });
}

function unpack(
  payload: Uint8Array,
  files: Array<{ path: string; mode: number; offset: number; size: number; sha256: string }>,
) {
  return files.map((file) => ({
    path: file.path,
    content: payload.slice(file.offset, file.offset + file.size),
    executable: file.mode === 0o755,
  }));
}

export interface ZeroKitchenRunInput {
  projectId: number;
  runtimeId: string;
  files: readonly BuilderFile[];
  dependencyPlan: ZeroGeneratedDependencyPlan;
  manifest: RuntimeManifestContract;
  pantryPublicKeys: ReadonlyMap<string, string>;
  now?: () => Date;
  monotonicNow?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  onEvidence?: (evidence: Readonly<Record<string, unknown>>) => void;
}

export interface ZeroKitchenRunResult {
  runtimeId: string;
  shelfRootSha256: string;
  dependencyClosureSha256: string;
  buildId: string;
  artifactSha256: string;
  coldBuild: boolean;
  sealedRelease: AcceptedSealedRelease;
}

export interface PantryStockProgressEvidence {
  assemblyId: string;
  stockState: "created" | "assembling";
  ingestState: "queued" | "running" | "failed";
  attempt: number;
  updatedAt: string;
  stagedObjects: number;
  failureCode: PantryErrorCode | null;
  failureRetryable: boolean | null;
  currentStage: string;
  lastTransitionAt: string;
  queueEnqueues: number;
  queueDeliveries: number;
  stageTransitions: ReadonlyArray<{
    stage: string;
    firstAt: string;
    lastAt: string;
    transitions: number;
  }>;
  metrics: Readonly<Record<string, number>>;
  innerFollowerState: string | null;
}

interface PantryWaitOptions {
  startedAtMs?: number;
  deadlineMs: number;
  monotonicNow: () => number;
  sleep: (milliseconds: number) => Promise<void>;
  signal?: AbortSignal;
  pollIntervalMs?: number;
  onEvidence?: (evidence: Readonly<Record<string, unknown>>) => void;
}

function cancelledError(stage: string): ZeroGenerationKitchenError {
  return new ZeroGenerationKitchenError("generation_cancelled", "Sealed generation was cancelled", {
    stage,
  });
}

function throwIfCancelled(signal: AbortSignal | undefined, stage: string): void {
  if (signal?.aborted) throw cancelledError(stage);
}

async function cancellableSleep(
  milliseconds: number,
  sleep: (milliseconds: number) => Promise<void>,
  signal: AbortSignal | undefined,
  stage: string,
): Promise<void> {
  throwIfCancelled(signal, stage);
  if (signal === undefined) {
    await sleep(milliseconds);
    return;
  }
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(cancelledError(stage));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
  try {
    await Promise.race([sleep(milliseconds), aborted]);
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function isControlError(error: unknown, status: number, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    error.status === status &&
    "code" in error &&
    error.code === code
  );
}

interface InnerFollowerEvidence {
  code: string;
  elapsedMs: number | null;
  attempts: number | null;
  lastObservedOperationState: string;
  transportCause: string | null;
}

function innerFollowerEvidence(error: unknown): InnerFollowerEvidence {
  const input = error as {
    code?: unknown;
    elapsedMs?: unknown;
    attempts?: unknown;
    lastObservedOperationState?: unknown;
    transportCause?: unknown;
  };
  return {
    code: typeof input.code === "string" ? input.code : "pantry_operation_timeout",
    elapsedMs: typeof input.elapsedMs === "number" ? input.elapsedMs : null,
    attempts: typeof input.attempts === "number" ? input.attempts : null,
    lastObservedOperationState:
      typeof input.lastObservedOperationState === "string"
        ? input.lastObservedOperationState
        : typeof input.transportCause === "string"
          ? `transport_${input.transportCause}_after_dispatch`
          : "unknown",
    transportCause: typeof input.transportCause === "string" ? input.transportCause : null,
  };
}

function isRetryablePantryTransportWeather(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { code?: unknown; retryable?: unknown };
  return (
    candidate.retryable === true &&
    typeof candidate.code === "string" &&
    [
      "control_transport_timeout",
      "control_transport_connection_reset",
      "control_transport_fetch_exception",
      "control_plane_unreachable",
    ].includes(candidate.code)
  );
}

export async function readZeroGenerationControlWithWeather(
  provider: Pick<ZeroGenerationTenantRuntimeProvider, "zeroGenerationControlRequest">,
  path: string,
  options: {
    startedAtMs: number;
    deadlineMs: number;
    monotonicNow: () => number;
    sleep: (milliseconds: number) => Promise<void>;
    signal?: AbortSignal;
    stage: string;
    timeoutCode: string;
    onEvidence?: (evidence: Readonly<Record<string, unknown>>) => void;
  },
): Promise<unknown> {
  let attempts = 0;
  let lastTransport: InnerFollowerEvidence | null = null;
  for (;;) {
    throwIfCancelled(options.signal, options.stage);
    const remainingMs = options.deadlineMs - options.monotonicNow();
    const attemptBoundMs = Math.floor(
      Math.min(
        ZERO_GENERATION_CONTROL_READ_ATTEMPT_BOUND_MS,
        remainingMs - ZERO_GENERATION_INNER_FOLLOWER_MARGIN_MS,
      ),
    );
    if (attemptBoundMs <= 0) {
      throw new ZeroGenerationKitchenError(
        options.timeoutCode,
        "Zero generation control read exceeded its owning product deadline",
        {
          stage: options.stage,
          attempts,
          elapsedMs: Math.max(0, options.monotonicNow() - options.startedAtMs),
          lastTransport,
        },
      );
    }
    attempts += 1;
    try {
      return await provider.zeroGenerationControlRequest({
        method: "GET",
        path,
        operationTimeoutMs: attemptBoundMs,
        signal: options.signal,
      });
    } catch (error) {
      if (!isRetryablePantryTransportWeather(error)) throw error;
      lastTransport = innerFollowerEvidence(error);
      options.onEvidence?.({
        stage: options.stage,
        operation: "zero-generation-control-read",
        path,
        attempt: attempts,
        remainingMs: Math.max(0, options.deadlineMs - options.monotonicNow()),
        typedError: lastTransport,
      });
    }
    const retryDelayMs = Math.min(
      ZERO_GENERATION_CONTROL_READ_RETRY_MS,
      Math.max(0, options.deadlineMs - options.monotonicNow()),
    );
    await cancellableSleep(retryDelayMs, options.sleep, options.signal, options.stage);
  }
}

async function refreshPantryDiagnostics(
  provider: Pick<ZeroGenerationTenantRuntimeProvider, "zeroGenerationControlRequest">,
  progress: PantryStockProgressEvidence,
  options: PantryWaitOptions,
): Promise<PantryStockProgressEvidence> {
  try {
    const diagnostics = pantryCatalogAssemblyDiagnosticsResponseSchema.parse(
      await provider.zeroGenerationControlRequest({
        method: "GET",
        path: `${PANTRY_PREFIX}/assemblies/${progress.assemblyId}/diagnostics`,
        operationTimeoutMs: Math.min(
          10_000,
          Math.max(0, options.deadlineMs - options.monotonicNow()),
        ),
        signal: options.signal,
      }),
    );
    return {
      ...progress,
      currentStage: diagnostics.currentStage,
      lastTransitionAt: diagnostics.lastTransitionAt,
      queueEnqueues: diagnostics.queueEnqueues,
      queueDeliveries: diagnostics.queueDeliveries,
      stageTransitions: diagnostics.stageTransitions,
      metrics: diagnostics.metrics,
    };
  } catch {
    return progress;
  }
}

/**
 * Poll the shipped Pantry assembly lifecycle under the kitchen's one product deadline.
 * There is intentionally no generator-private stock timeout: queued, running, and retryable
 * failed states remain eligible until the trusted-build product bound or cancellation wins.
 */
export async function waitForPantryShelf(
  provider: Pick<ZeroGenerationTenantRuntimeProvider, "zeroGenerationControlRequest">,
  stockRequest: PantryCatalogStockRequest,
  options: PantryWaitOptions,
): Promise<{ shelfRootSha256: string; lastProgress: PantryStockProgressEvidence | null }> {
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const startedAtMs = options.startedAtMs ?? options.monotonicNow();
  const transportEnvelopeSha256 = await sha256Hex(
    `NABUFLOW_PANTRY_STOCK_TRANSPORT_V1\n${canonicalPantryJson({
      identitySha256: stockRequest.requestSha256,
      requestedAt: stockRequest.requestedAt,
      expiresAt: stockRequest.expiresAt,
    })}`,
  );
  let lastProgress: PantryStockProgressEvidence | null = null;
  let lastInnerFollower: InnerFollowerEvidence | null = null;
  let poll = 0;
  for (;;) {
    throwIfCancelled(options.signal, "pantry-wait");
    const elapsedMs = options.monotonicNow() - startedAtMs;
    if (options.monotonicNow() >= options.deadlineMs) {
      throw new ZeroGenerationKitchenError(
        "pantry_stock_timeout",
        "Pantry dependency stocking exceeded the trusted-build product bound",
        {
          stage: "pantry-wait",
          elapsedMs,
          lastObservedProgress: lastProgress,
          innerFollower: lastInnerFollower,
        },
      );
    }

    const remainingBeforeStockMs = options.deadlineMs - options.monotonicNow();
    if (remainingBeforeStockMs <= ZERO_GENERATION_INNER_FOLLOWER_MARGIN_MS) {
      await cancellableSleep(remainingBeforeStockMs, options.sleep, options.signal, "pantry-wait");
      continue;
    }
    let stockValue: unknown;
    try {
      stockValue = await provider.zeroGenerationControlRequest({
        method: "POST",
        path: `${PANTRY_PREFIX}/stock-requests`,
        body: stockRequest,
        // The Pantry request itself is coalesced by requestSha256. A distinct
        // transport key avoids replaying an earlier pending response forever.
        idempotencyKey: `zero-stock:${stockRequest.requestSha256}:${transportEnvelopeSha256}:${poll}`,
        operationTimeoutMs: remainingBeforeStockMs - ZERO_GENERATION_INNER_FOLLOWER_MARGIN_MS,
        signal: options.signal,
      });
      lastInnerFollower = null;
    } catch (error) {
      if (
        !isControlError(error, 504, "pantry_operation_timeout") &&
        !isControlError(error, 503, "pantry_operation_terminal_unknown") &&
        !isRetryablePantryTransportWeather(error)
      )
        throw error;
      lastInnerFollower = innerFollowerEvidence(error);
      if (lastProgress !== null) {
        lastProgress = {
          ...(await refreshPantryDiagnostics(provider, lastProgress, options)),
          innerFollowerState: lastInnerFollower.lastObservedOperationState,
        };
      }
      poll += 1;
      const remainingMs = options.deadlineMs - options.monotonicNow();
      await cancellableSleep(
        Math.max(0, Math.min(pollIntervalMs, remainingMs)),
        options.sleep,
        options.signal,
        "pantry-wait",
      );
      continue;
    }
    const stockParsed = pantryCatalogStockResponseSchema.safeParse(stockValue);
    if (!stockParsed.success) {
      throw new ZeroGenerationKitchenError(
        "pantry_protocol_invalid",
        "Pantry returned an invalid stock lifecycle response",
        { stage: "pantry-wait" },
      );
    }
    const stock = stockParsed.data;
    if (stock.state === "committed") {
      return { shelfRootSha256: stock.revisionRootSha256, lastProgress };
    }

    try {
      const progressParsed = pantryCatalogAssemblyStatusResponseSchema.safeParse(
        await provider.zeroGenerationControlRequest({
          method: "GET",
          path: `${PANTRY_PREFIX}/assemblies/${stock.assemblyId}`,
          operationTimeoutMs: Math.min(
            ZERO_GENERATION_CONTROL_READ_ATTEMPT_BOUND_MS,
            Math.max(0, options.deadlineMs - options.monotonicNow()),
          ),
          signal: options.signal,
        }),
      );
      if (!progressParsed.success || progressParsed.data.assemblyId !== stock.assemblyId) {
        throw new ZeroGenerationKitchenError(
          "pantry_protocol_invalid",
          "Pantry returned an invalid assembly progress response",
          { stage: "pantry-wait", assemblyId: stock.assemblyId },
        );
      }
      const progress = progressParsed.data;
      lastProgress = {
        assemblyId: progress.assemblyId,
        stockState: stock.state,
        ingestState: progress.ingest.state,
        attempt: progress.ingest.attempt,
        updatedAt: progress.ingest.updatedAt,
        stagedObjects: progress.stagedObjects,
        failureCode: progress.ingest.failure?.code ?? null,
        failureRetryable: progress.ingest.failure?.retryable ?? null,
        currentStage:
          progress.ingest.state === "failed"
            ? "failed"
            : progress.ingest.state === "running"
              ? "resolving-metadata"
              : "queued",
        lastTransitionAt: progress.ingest.updatedAt,
        queueEnqueues: 0,
        queueDeliveries: 0,
        stageTransitions: [],
        metrics: {},
        innerFollowerState: null,
      };
      lastProgress = await refreshPantryDiagnostics(provider, lastProgress, options);
      if (progress.ingest.state === "failed" && !progress.ingest.failure.retryable) {
        throw new ZeroGenerationKitchenError(
          progress.ingest.failure.code,
          "Pantry terminally refused dependency ingestion",
          { stage: "pantry-wait", lastObservedProgress: lastProgress },
        );
      }
    } catch (error) {
      // A successful commit atomically removes the assembly before the next stock lookup can
      // observe the committed index. Treat only that narrow race as progress; all other errors
      // remain typed failures from the signed control transport. Typed transport weather is
      // retried under the kitchen's outer product deadline rather than masking its authority.
      if (isRetryablePantryTransportWeather(error)) {
        lastInnerFollower = innerFollowerEvidence(error);
        options.onEvidence?.({
          stage: "pantry-progress-read",
          operation: "zero-generation-control-read",
          attempt: poll + 1,
          remainingMs: Math.max(0, options.deadlineMs - options.monotonicNow()),
          typedError: lastInnerFollower,
        });
      } else if (!isControlError(error, 404, "catalog_not_found")) {
        throw error;
      }
    }

    poll += 1;
    const remainingMs = options.deadlineMs - options.monotonicNow();
    await cancellableSleep(
      Math.max(0, Math.min(pollIntervalMs, remainingMs)),
      options.sleep,
      options.signal,
      "pantry-wait",
    );
  }
}

async function readOutputPayload(
  provider: ZeroGenerationTenantRuntimeProvider,
  output: TrustedBuildOutput,
  scope: "app" | "layer",
  options: {
    startedAtMs: number;
    deadlineMs: number;
    monotonicNow: () => number;
    sleep: (milliseconds: number) => Promise<void>;
    signal?: AbortSignal;
    onEvidence?: (evidence: Readonly<Record<string, unknown>>) => void;
  },
  layerIndex = 0,
): Promise<Uint8Array> {
  const selected =
    scope === "app"
      ? {
          content: output.app.content,
          descriptors: output.app.chunks,
          contentSha256: await sha256Hex(canonicalPantryJson(output.app.content)),
        }
      : output.layers[layerIndex] === undefined
        ? undefined
        : {
            content: output.layers[layerIndex].content,
            descriptors: output.layers[layerIndex].chunks,
            contentSha256: output.layers[layerIndex].content.descriptor.contentSha256,
          };
  if (selected === undefined) {
    throw new ZeroGenerationKitchenError(
      "build_output_missing",
      "Trusted build output is incomplete",
    );
  }
  const { content, descriptors, contentSha256 } = selected;
  const payload = new Uint8Array(content.payloadBytes);
  let offset = 0;
  for (const descriptor of descriptors) {
    const response = (await readZeroGenerationControlWithWeather(
      provider,
      `${BUILD_PREFIX}/builds/${output.buildId}/outputs/${scope}/${contentSha256}/chunks/${descriptor.index}`,
      {
        ...options,
        stage: "build-output-read",
        timeoutCode: "build_output_timeout",
      },
    )) as { payloadBase64?: string };
    if (typeof response.payloadBase64 !== "string") {
      throw new ZeroGenerationKitchenError("build_output_missing", "Build chunk is unavailable");
    }
    const bytes = decodeBase64(response.payloadBase64);
    if (bytes.byteLength !== descriptor.bytes || (await sha256Hex(bytes)) !== descriptor.sha256) {
      throw new ZeroGenerationKitchenError(
        "build_output_invalid",
        "Build chunk verification failed",
      );
    }
    payload.set(bytes, offset);
    offset += bytes.byteLength;
  }
  if (offset !== payload.byteLength) {
    throw new ZeroGenerationKitchenError("build_output_invalid", "Build output is incomplete");
  }
  return payload;
}

export async function runZeroGenerationKitchen(
  provider: ZeroGenerationTenantRuntimeProvider,
  input: ZeroKitchenRunInput,
): Promise<ZeroKitchenRunResult> {
  const now = input.now ?? (() => new Date());
  const monotonicNow = input.monotonicNow ?? Date.now;
  const sleep =
    input.sleep ?? ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const productStartedAtMs = monotonicNow();
  const productDeadlineMs = productStartedAtMs + BUILD_WAIT_MS;
  const assemblyDeadlineMs = productStartedAtMs + ZERO_GENERATION_ASSEMBLY_RESERVE_MS;
  throwIfCancelled(input.signal, "runtime-descriptor");
  const descriptor = await provider.zeroGenerationRuntimeDescriptor(
    input.runtimeId,
    input.projectId,
  );
  if (descriptor.status !== "stopped") {
    throw new ZeroGenerationKitchenError(
      "runtime_not_stopped",
      "Sealed generation requires a stopped runtime",
    );
  }
  await provider.updateRuntimeManifest(input.runtimeId, input.projectId, {
    expectedManifestRevision: descriptor.manifestRevision,
    manifest: input.manifest,
    restart: "reject-if-running",
    operationTimeoutMs: Math.max(0, assemblyDeadlineMs - monotonicNow()),
    signal: input.signal,
  });

  const stockIdentity = {
    intents: input.dependencyPlan.intents,
    platform: ZERO_SEALED_BUILD_PLATFORM,
  };
  const requestedAt = now();
  const stockRequest = pantryCatalogStockRequestSchema.parse({
    schemaVersion: 1,
    ...stockIdentity,
    requestSha256: await pantryCatalogStockRequestHash(stockIdentity),
    requestedAt: requestedAt.toISOString(),
    expiresAt: new Date(requestedAt.getTime() + 60 * 60_000).toISOString(),
  });
  const { shelfRootSha256: shelfRoot } = await waitForPantryShelf(provider, stockRequest, {
    startedAtMs: productStartedAtMs,
    deadlineMs: assemblyDeadlineMs,
    monotonicNow,
    sleep,
    signal: input.signal,
    onEvidence: input.onEvidence,
  });
  throwIfCancelled(input.signal, "pantry-shelf-read");
  const shelfResponse = (await readZeroGenerationControlWithWeather(
    provider,
    `${PANTRY_PREFIX}/revisions/by-root/${shelfRoot}`,
    {
      startedAtMs: productStartedAtMs,
      deadlineMs: assemblyDeadlineMs,
      monotonicNow,
      sleep,
      signal: input.signal,
      stage: "pantry-shelf-read",
      timeoutCode: "pantry_stock_timeout",
      onEvidence: input.onEvidence,
    },
  )) as { shelf?: unknown };
  const shelf = pantryCatalogShelfRecordSchema.parse(shelfResponse.shelf);
  if (shelf.state.state !== "committed") {
    throw new ZeroGenerationKitchenError(
      "pantry_protocol_invalid",
      "Pantry shelf is not committed",
      { stage: "pantry-shelf-read" },
    );
  }
  const buildRequest = await makeZeroTrustedBuildRequest({
    files: input.files,
    dependencyPlan: input.dependencyPlan,
    shelf,
    createdAt: now().toISOString(),
  });
  await provider.zeroGenerationControlRequest({
    method: "POST",
    path: `${BUILD_PREFIX}/builds`,
    body: buildRequest,
    idempotencyKey: `zero-build:${buildRequest.requestId}`,
    operationTimeoutMs: Math.max(0, assemblyDeadlineMs - monotonicNow()),
    signal: input.signal,
  });
  let output: TrustedBuildOutput | null = null;
  let lastBuildState: string | null = null;
  while (monotonicNow() < assemblyDeadlineMs) {
    throwIfCancelled(input.signal, "trusted-build-wait");
    const status = trustedBuildStatusResponseSchema.parse(
      await readZeroGenerationControlWithWeather(
        provider,
        `${BUILD_PREFIX}/builds/${buildRequest.input.buildId}`,
        {
          startedAtMs: productStartedAtMs,
          deadlineMs: assemblyDeadlineMs,
          monotonicNow,
          sleep,
          signal: input.signal,
          stage: "trusted-build-wait",
          timeoutCode: "build_timeout",
          onEvidence: input.onEvidence,
        },
      ),
    );
    lastBuildState = status.state;
    if (status.state === "failed") {
      throw new ZeroGenerationKitchenError(
        status.error?.code ?? "build_failed",
        "Trusted build failed",
      );
    }
    if (status.state === "cancelled") {
      throw new ZeroGenerationKitchenError("build_cancelled", "Trusted build was cancelled");
    }
    if (status.state === "succeeded") {
      output = status.output;
      break;
    }
    await cancellableSleep(
      Math.max(0, Math.min(2_000, assemblyDeadlineMs - monotonicNow())),
      sleep,
      input.signal,
      "trusted-build-wait",
    );
  }
  if (output === null) {
    throw new ZeroGenerationKitchenError(
      "build_timeout",
      "Trusted build exceeded the named pre-delivery assembly reserve",
      {
        stage: "trusted-build-wait",
        elapsedMs: monotonicNow() - productStartedAtMs,
        lastObservedState: lastBuildState,
      },
    );
  }

  await assertZeroGeneratedEligibility({
    files: input.files,
    dependencyPlan: input.dependencyPlan,
    runtimeManifest: input.manifest,
    declaredCapabilities: inferZeroDeclaredCapabilities(input.files),
    pantryClosureVerified: true,
    dependencyOutputAttested: true,
    stage: "attested-output",
  });

  throwIfCancelled(input.signal, "build-output-read");
  const controlReadOptions = {
    startedAtMs: productStartedAtMs,
    deadlineMs: assemblyDeadlineMs,
    monotonicNow,
    sleep,
    signal: input.signal,
    onEvidence: input.onEvidence,
  };
  const appPayload = await readOutputPayload(provider, output, "app", controlReadOptions);
  const app = await sealRuntimeArtifact({
    targetRuntimeIdentity: input.runtimeId,
    manifestRevision: input.manifest.revision,
    artifactRevision: `zero-${output.outputSha256}`,
    sourceRevision: output.requestSha256,
    files: unpack(appPayload, output.app.content.files),
  });
  if (canonicalPantryJson(app.envelope.content) !== canonicalPantryJson(output.app.content)) {
    throw new ZeroGenerationKitchenError("build_output_invalid", "App reseal changed build bytes");
  }
  const attestation = pantryShelfContentHashesResponseSchema.parse(
    await readZeroGenerationControlWithWeather(
      provider,
      `${PANTRY_PREFIX}/revisions/by-root/${shelfRoot}/content-hashes`,
      {
        ...controlReadOptions,
        stage: "pantry-provenance-read",
        timeoutCode: "pantry_stock_timeout",
      },
    ),
  ) as PantryShelfContentHashesResponse;
  const provenance = await resolveTrustedPantryLayerSealProvenance({
    shelf,
    expectedShelf: output.pantryShelf,
    attestation,
    publicKeys: input.pantryPublicKeys,
  });
  const sealedLayers = [];
  for (let index = 0; index < output.layers.length; index += 1) {
    const layerOutput = output.layers[index];
    const payload = await readOutputPayload(provider, output, "layer", controlReadOptions, index);
    const layer = await sealRuntimeArtifactLayer({
      mountPath: layerOutput.content.descriptor.mountPath,
      platform: ZERO_SEALED_BUILD_PLATFORM,
      files: unpack(payload, layerOutput.content.files),
      provenance,
    });
    if (canonicalPantryJson(layer.content) !== canonicalPantryJson(layerOutput.content)) {
      throw new ZeroGenerationKitchenError(
        "build_output_invalid",
        "Layer reseal changed build bytes",
      );
    }
    sealedLayers.push(layer);
  }
  const layered = await sealLayeredRuntimeArtifact({
    app,
    layers: sealedLayers,
    pantryRevision: {
      schemaVersion: 1,
      revisionId: shelf.revision.content.revisionId,
      rootSha256: shelf.revision.rootSha256,
      state: "committed",
      stateRevision: shelf.state.stateRevision,
      updatedAt: shelf.state.updatedAt,
    },
    dependencyClosureSha256: output.pantryShelf.dependencyClosureSha256,
    buildAttestationSha256: output.buildAttestation.statementSha256,
    platform: ZERO_SEALED_BUILD_PLATFORM,
    artifactRevision: `zero-layered-${output.outputSha256}`,
  });
  throwIfCancelled(input.signal, "artifact-delivery");
  const artifactOperationTimeoutMs = zeroGenerationReservedOperationTimeout({
    operation: "artifact-commit",
    nowMs: monotonicNow(),
    productDeadlineMs,
  });
  input.onEvidence?.({
    stage: "artifact-delivery",
    operation: "layered-artifact.commit",
    runtimeIdentity: input.runtimeId,
    projectId: input.projectId,
    role: "preview",
    slot: "primary",
    sealedArtifactSha256: layered.envelope.sealedArtifactSha256,
    operationTimeoutMs: artifactOperationTimeoutMs,
    namedProviderBoundMs: RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
  });
  await provider.deployLayeredArtifact(
    input.runtimeId,
    input.projectId,
    {
      envelope: layered.envelope,
      appChunks: layered.appChunks,
      layers: layered.layers.map((layer) => ({ content: layer.content, chunks: layer.chunks })),
    },
    {
      operationTimeoutMs: artifactOperationTimeoutMs,
      signal: input.signal,
    },
  );
  throwIfCancelled(input.signal, "runtime-start");
  const startOperationTimeoutMs = zeroGenerationReservedOperationTimeout({
    operation: "runtime-start",
    nowMs: monotonicNow(),
    productDeadlineMs,
  });
  input.onEvidence?.({
    stage: "runtime-start",
    operation: "runtime-start",
    runtimeIdentity: input.runtimeId,
    projectId: input.projectId,
    role: "preview",
    slot: "primary",
    operationTimeoutMs: startOperationTimeoutMs,
    namedProviderBoundMs: RUNTIME_START_OPERATION_BOUND_MS,
  });
  await provider.start(input.runtimeId, input.projectId, {
    operationTimeoutMs: startOperationTimeoutMs,
    signal: input.signal,
  });
  return {
    runtimeId: input.runtimeId,
    shelfRootSha256: shelfRoot,
    dependencyClosureSha256: output.pantryShelf.dependencyClosureSha256,
    buildId: output.buildId,
    artifactSha256: layered.envelope.sealedArtifactSha256,
    coldBuild: output.coldBuild,
    sealedRelease: acceptedSealedReleaseSchema.parse({
      format: "nabuflow.accepted-sealed-release/v1",
      state: "accepted",
      acceptedAt: now().toISOString(),
      sourceRuntimeIdentity: input.runtimeId,
      sourceRevision: output.requestSha256,
      manifest: input.manifest,
      shelfRevisionId: shelf.revision.content.revisionId,
      shelfRootSha256: shelf.revision.rootSha256,
      shelfStateRevision: shelf.state.stateRevision,
      dependencyClosureSha256: output.pantryShelf.dependencyClosureSha256,
      buildId: output.buildId,
      buildAttestationSha256: output.buildAttestation.statementSha256,
      artifactRevision: layered.envelope.artifactRevision,
      sealedArtifactSha256: layered.envelope.sealedArtifactSha256,
      contentSha256: layered.envelope.contentSha256,
      appArtifactSha256: layered.envelope.content.appArtifact.sealedArtifactSha256,
      layerContentSha256s: layered.envelope.content.layers.map(
        (layer) => layer.descriptor.contentSha256,
      ),
    }),
  };
}
