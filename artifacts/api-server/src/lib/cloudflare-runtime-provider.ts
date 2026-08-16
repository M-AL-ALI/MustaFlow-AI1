import {
  CONTROL_API_PREFIX,
  CONTROL_FEATURES,
  RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
  RUNTIME_CONTROL_OPERATION_BOUND_MS,
  RUNTIME_START_OPERATION_BOUND_MS,
  ZERO_GENERATION_CONTROL_OPERATION_BOUND_MS,
  ZERO_SEALED_RUNTIME_PORT,
  canonicalJson,
  beginRuntimeArtifactResponseSchema,
  beginRuntimeLayeredArtifactResponseSchema,
  commitRuntimeArtifactResponseSchema,
  commitRuntimeLayeredArtifactResponseSchema,
  controlErrorResponseSchema,
  deriveRuntimeIdentity,
  execRuntimeResponseSchema,
  parseRuntimeIdentityForNamespace,
  runtimeDescriptorSchema,
  runtimeArtifactEnvelopeSchema,
  runtimeArtifactLayerContentSchema,
  runtimeLayeredArtifactEnvelopeSchema,
  sha256Hex,
  signControlRequest,
  versionResponseSchema,
  uploadRuntimeArtifactChunkResponseSchema,
  uploadRuntimeLayeredArtifactChunkResponseSchema,
  verifyRuntimeArtifactEnvelope,
  verifyRuntimeLayeredArtifactEnvelope,
  acceptedSealedReleaseSchema,
  promoteRuntimeLayeredArtifactResponseSchema,
  activateRouteResponseSchema,
  deactivateRouteResponseSchema,
  productionDatabaseAllocationIdentity,
  productionDatabaseAllocationResponseSchema,
  productionDatabaseReleaseResponseSchema,
  PRODUCTION_DATABASE_PROVIDER_OPERATION_BOUND_MS,
  type RuntimeManifestContract,
  type RuntimeDescriptor,
  type RuntimeLocator,
  type TenantRuntimeConfig,
  type ProductionArtifactRelease,
} from "@workspace/tenant-runtime-contracts";
import { resolveProjectRuntimeManifest } from "./runtime-manifest";
import { sealRuntimeArtifact } from "./runtime-artifact";
import { logger } from "./logger";
import {
  RuntimeProviderUnavailableError,
  type ArtifactDeployingTenantRuntimeProvider,
  type LayeredArtifactDeployingTenantRuntimeProvider,
  type RuntimeArtifactDeployment,
  type RuntimeArtifactDeploymentResult,
  type RuntimeLayeredArtifactDeployment,
  type RuntimeLayeredArtifactDeploymentResult,
  type RuntimeCreateResult,
  type RuntimeExecResult,
  type RuntimeFile,
  type RuntimeInfo,
  type RuntimeInstallOptions,
  type RuntimeLogLevel,
  type RuntimeOperationOptions,
  type RuntimeProductionOptions,
  type RuntimeServiceOptions,
  type RuntimeStartOptions,
  type RuntimeStatus,
  type RuntimeSubsystemStatus,
  type TenantRuntimeProvider,
  type ZeroGenerationTenantRuntimeProvider,
  type ProductionArtifactPromotingTenantRuntimeProvider,
  type ProductionDatabaseCapabilityTenantRuntimeProvider,
} from "./tenant-runtime-provider";

type CloudflareConfig = NonNullable<TenantRuntimeConfig["cloudflare"]>;

const CLOCK_SKEW_LIMIT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONTROL_RETRY_DELAYS_MS = [100, 250, 500] as const;
const MAX_RETRY_AFTER_MS = 1_000;
const OPERATION_FOLLOW_DELAY_MS = 1_000;
export const CLOUDFLARE_RUNTIME_MIN_TRANSPORT_DISPATCH_MS = 10;

interface ControlOperationFollowOptions {
  operation: string;
  operationBoundMs: number;
  operationTimeoutMs?: number;
  signal?: AbortSignal;
  timeoutCode: string;
  terminalUnknownCode: string;
  cancelledCode: string;
}

interface CloudflareRuntimeProviderDependencies {
  sleep?: (delayMs: number) => Promise<void>;
  /** Test/acceptance clock; production defaults byte-for-byte to Date.now. */
  now?: () => number;
  /** Monotonic operation clock; independent from the control signing clock. */
  monotonicNow?: () => number;
}

export type CloudflareRuntimeTransportCause =
  | "client_abort"
  | "request_timeout"
  | "connection_reset"
  | "fetch_exception"
  | "unreachable";

export class CloudflareRuntimeControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    message: string,
    readonly transportCause: CloudflareRuntimeTransportCause | null = null,
  ) {
    super(message);
    this.name = "CloudflareRuntimeControlError";
  }
}

export class CloudflareRuntimePreDispatchError extends CloudflareRuntimeControlError {
  constructor(readonly errorClass: string) {
    super(
      500,
      "control_pre_dispatch_error",
      false,
      `Cloudflare control request failed before dispatch: ${errorClass}`,
    );
    this.name = "CloudflareRuntimePreDispatchError";
  }
}

function sanitizedErrorClass(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  return /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(error.name) ? error.name : "Error";
}

function preDispatchError(error: unknown): CloudflareRuntimePreDispatchError {
  return error instanceof CloudflareRuntimePreDispatchError
    ? error
    : new CloudflareRuntimePreDispatchError(sanitizedErrorClass(error));
}

function positiveIntegerTimerMs(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const floored = Math.floor(value);
  return floored >= 1 ? floored : null;
}

function nestedErrorCode(error: unknown): string | null {
  let candidate: unknown = error;
  for (let depth = 0; depth < 3 && candidate instanceof Error; depth += 1) {
    const code = (candidate as Error & { code?: unknown }).code;
    if (typeof code === "string") return code;
    candidate = candidate.cause;
  }
  return null;
}

function classifyTransportFailure(error: unknown): {
  cause: Exclude<CloudflareRuntimeTransportCause, "client_abort">;
  code: string;
} {
  const code = nestedErrorCode(error);
  if (
    (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "ETIMEDOUT"
  ) {
    return { cause: "request_timeout", code: "control_transport_timeout" };
  }
  if (code === "ECONNRESET" || code === "UND_ERR_SOCKET") {
    return { cause: "connection_reset", code: "control_transport_connection_reset" };
  }
  if (error instanceof TypeError) {
    return { cause: "fetch_exception", code: "control_transport_fetch_exception" };
  }
  return { cause: "unreachable", code: "control_plane_unreachable" };
}

export class CloudflareRuntimeOperationTimeoutError extends CloudflareRuntimeControlError {
  constructor(
    readonly operation: string,
    code: string,
    readonly elapsedMs: number,
    readonly attempts: number,
    readonly lastObservedOperationState: string,
    readonly operationTimeoutMs: number,
    readonly namedProviderBoundMs: number,
    readonly transportCauseCounts: Readonly<
      Partial<Record<CloudflareRuntimeTransportCause, number>>
    >,
  ) {
    super(504, code, true, `Cloudflare ${operation} exceeded its operation bound`);
    this.name = "CloudflareRuntimeOperationTimeoutError";
  }
}

export class CloudflareRuntimeOperationTerminalUnknownError extends CloudflareRuntimeControlError {
  constructor(
    readonly operation: string,
    code: string,
    readonly elapsedMs: number,
    readonly attempts: number,
    readonly lastObservedOperationState: string,
    readonly operationTimeoutMs: number,
    readonly namedProviderBoundMs: number,
    readonly transportCauseCounts: Readonly<
      Partial<Record<CloudflareRuntimeTransportCause, number>>
    >,
    readonly successfulObservationCount: number,
  ) {
    super(
      503,
      code,
      true,
      `Cloudflare ${operation} terminal state is unknown after a control observation blackout`,
    );
    this.name = "CloudflareRuntimeOperationTerminalUnknownError";
  }
}

function retryAfterMs(response: Response, fallbackMs: number): number {
  const raw = response.headers.get("retry-after");
  if (raw === null) return fallbackMs;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return fallbackMs;
  return Math.max(fallbackMs, Math.min(seconds * 1_000, MAX_RETRY_AFTER_MS));
}

function isCloudflareWorkerException(status: number, body: string): boolean {
  return (
    status === 500 && /(?:Worker threw exception|Error\s*1101|error-code[^>]*>1101)/i.test(body)
  );
}

function parseJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function invalidLayeredArtifact(): CloudflareRuntimeControlError {
  return new CloudflareRuntimeControlError(
    400,
    "invalid_layered_artifact",
    false,
    "Layered runtime artifact failed local validation",
  );
}

async function validateArtifactChunks(
  chunks: Uint8Array[],
  payloadBytes: number,
  chunkBytes: number,
  expectedHashes: string[],
  collect = false,
): Promise<Uint8Array> {
  if (chunks.length !== expectedHashes.length) throw invalidLayeredArtifact();
  const payload = new Uint8Array(collect ? payloadBytes : 0);
  let offset = 0;
  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    const isFinal = chunkIndex === chunks.length - 1;
    const expectedLength = isFinal ? payloadBytes % chunkBytes || chunkBytes : chunkBytes;
    if (
      chunk.byteLength !== expectedLength ||
      (await sha256Hex(chunk)) !== expectedHashes[chunkIndex]
    ) {
      throw invalidLayeredArtifact();
    }
    if (collect) payload.set(chunk, offset);
    offset += chunk.byteLength;
  }
  if (offset !== payloadBytes) throw invalidLayeredArtifact();
  return payload;
}

function commandForStack(stack?: string | null): string[] {
  if (stack === "python-flask") return ["python", "app.py"];
  if (stack === "python-fastapi") return ["uvicorn", "main:app", "--host", "0.0.0.0"];
  return ["npm", "run", "dev", "--", "--host", "0.0.0.0"];
}

function toInfo(runtime: RuntimeDescriptor): RuntimeInfo {
  return {
    runtimeId: runtime.identity,
    status: runtime.status,
    endpoint: runtime.endpoint,
    servicePort: runtime.servicePort,
  };
}

export class CloudflareRuntimeProvider
  implements
    TenantRuntimeProvider,
    ArtifactDeployingTenantRuntimeProvider,
    LayeredArtifactDeployingTenantRuntimeProvider,
    ZeroGenerationTenantRuntimeProvider,
    ProductionArtifactPromotingTenantRuntimeProvider,
    ProductionDatabaseCapabilityTenantRuntimeProvider
{
  readonly providerId = "cloudflare";
  private subsystemStatus: RuntimeSubsystemStatus | null = null;
  private deploymentVersion: string | null = null;
  private clockOffsetMs = 0;
  private controlFeatures = new Set<string>();
  private readonly deployedArtifacts = new Map<
    string,
    {
      artifactRevision: string;
      sealedArtifactSha256: string;
      feature: (typeof CONTROL_FEATURES)[number];
    }
  >();

  private readonly sleep: (delayMs: number) => Promise<void>;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly config: CloudflareConfig,
    dependencies: CloudflareRuntimeProviderDependencies = {},
  ) {
    this.sleep =
      dependencies.sleep ??
      ((delayMs) => {
        const timerMs = positiveIntegerTimerMs(delayMs);
        return timerMs === null
          ? Promise.resolve()
          : new Promise((resolve) => setTimeout(resolve, timerMs));
      });
    this.now = dependencies.now ?? Date.now;
    this.monotonicNow = dependencies.monotonicNow ?? (() => performance.now());
  }

  private sleepFor(delayMs: number): Promise<void> {
    const timerMs = positiveIntegerTimerMs(delayMs);
    return timerMs === null ? Promise.resolve() : this.sleep(timerMs);
  }

  private unavailable(capability: string): never {
    throw new RuntimeProviderUnavailableError(this.providerId, capability);
  }

  private async locator(runtimeId: string, expectedProjectId?: number): Promise<RuntimeLocator> {
    const parsed = await parseRuntimeIdentityForNamespace(
      runtimeId,
      this.config.deploymentNamespace,
    );
    if (expectedProjectId !== undefined && parsed.projectId !== expectedProjectId) {
      throw new Error("Runtime identity does not belong to the requested project");
    }
    return { projectId: parsed.projectId, role: parsed.role, slot: parsed.slot };
  }

  private path(locator: RuntimeLocator, suffix = ""): string {
    return `${CONTROL_API_PREFIX}/runtimes/${locator.projectId}/${locator.role}/${locator.slot}${suffix}`;
  }

  private async refreshVersion(): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      let target: URL;
      let signal: AbortSignal;
      try {
        target = new URL(`${this.config.controlUrl}${CONTROL_API_PREFIX}/version`);
        const timeoutMs = positiveIntegerTimerMs(REQUEST_TIMEOUT_MS);
        if (timeoutMs === null) throw new RangeError("Control version timeout is invalid");
        signal = AbortSignal.timeout(timeoutMs);
      } catch (error) {
        throw preDispatchError(error);
      }
      let response: Response;
      try {
        response = await fetch(target, { signal });
      } catch (error) {
        if (attempt < CONTROL_RETRY_DELAYS_MS.length) {
          await this.sleepFor(CONTROL_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        const transport = classifyTransportFailure(error);
        throw new CloudflareRuntimeControlError(
          503,
          transport.code,
          true,
          error instanceof Error
            ? `Cloudflare control clock probe failed: ${error.name}`
            : "Cloudflare control clock probe failed",
          transport.cause,
        );
      }
      if (response.status >= 500) {
        const rawBody = await response.text();
        const error = new CloudflareRuntimeControlError(
          response.status,
          isCloudflareWorkerException(response.status, rawBody)
            ? "cloudflare_worker_exception"
            : "unexpected_control_5xx",
          true,
          "Cloudflare runtime control is temporarily unavailable",
        );
        if (attempt < CONTROL_RETRY_DELAYS_MS.length) {
          await this.sleepFor(retryAfterMs(response, CONTROL_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw error;
      }

      const workerDate = response.headers.get("date");
      const workerTime = workerDate === null ? Number.NaN : Date.parse(workerDate);
      if (!Number.isFinite(workerTime)) throw new Error("Cloudflare control response omitted Date");
      const offset = workerTime - this.now();
      if (Math.abs(offset) > CLOCK_SKEW_LIMIT_MS) {
        throw new Error(`Cloudflare control clock skew exceeds ${CLOCK_SKEW_LIMIT_MS}ms`);
      }
      this.clockOffsetMs = offset;
      break;
    }

    const version = await this.request({
      path: `${CONTROL_API_PREFIX}/version`,
      parse: versionResponseSchema,
    });
    this.deploymentVersion = version.deploymentVersion;
    this.controlFeatures = new Set(version.features);
    return version.deploymentVersion;
  }

  private async requireControlFeature(feature: (typeof CONTROL_FEATURES)[number]): Promise<void> {
    if (this.deploymentVersion === null) await this.refreshVersion();
    if (!this.controlFeatures.has(feature)) {
      throw new CloudflareRuntimeControlError(
        503,
        "control_feature_unavailable",
        false,
        `Cloudflare control feature ${feature} is unavailable`,
      );
    }
  }

  private async request<T>(input: {
    method?: string;
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    signal?: AbortSignal;
    transportTimeoutMs?: number;
    retryDelaysMs?: readonly number[];
    operation?: ControlOperationFollowOptions;
    parse: { parse(value: unknown): T };
  }): Promise<T> {
    const method = input.method ?? "GET";
    let body: string;
    try {
      body = input.body === undefined ? "" : JSON.stringify(input.body);
    } catch (error) {
      throw preDispatchError(error);
    }
    const encoded = {
      ...input,
      method,
      body,
      contentType: body ? "application/json" : undefined,
    };
    if (input.idempotencyKey !== undefined) {
      if (input.operation === undefined) {
        throw new Error("Idempotent control mutations require an operation follower");
      }
      return this.followOperation(
        { ...encoded, idempotencyKey: input.idempotencyKey },
        input.operation,
      );
    }
    return this.requestEncoded(encoded);
  }

  private async requestBytes<T>(input: {
    method: string;
    path: string;
    body: Uint8Array;
    idempotencyKey: string;
    operation: ControlOperationFollowOptions;
    parse: { parse(value: unknown): T };
  }): Promise<T> {
    return this.followOperation(
      { ...input, contentType: "application/octet-stream" },
      input.operation,
    );
  }

  private async requestEncoded<T>(input: {
    method: string;
    path: string;
    body: string | Uint8Array;
    contentType?: string;
    idempotencyKey?: string;
    signal?: AbortSignal;
    transportTimeoutMs?: number;
    retryDelaysMs?: readonly number[];
    parse: { parse(value: unknown): T };
  }): Promise<T> {
    const method = input.method;
    const body = input.body;
    let bodySha256: string;
    try {
      bodySha256 = await sha256Hex(body);
    } catch (error) {
      throw preDispatchError(error);
    }
    const idempotencyKey = input.idempotencyKey ?? "";
    const retryDelays = input.retryDelaysMs ?? CONTROL_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt += 1) {
      let target: URL;
      let requestInit: RequestInit;
      try {
        const timestamp = String(this.now() + this.clockOffsetMs);
        const nonce = crypto.randomUUID();
        const signature = await signControlRequest(this.config.controlToken, {
          method,
          pathAndQuery: input.path,
          timestamp,
          nonce,
          bodySha256,
          idempotencyKey,
        });
        const transportTimeoutMs = positiveIntegerTimerMs(
          Math.min(input.transportTimeoutMs ?? REQUEST_TIMEOUT_MS, REQUEST_TIMEOUT_MS),
        );
        if (
          transportTimeoutMs === null ||
          transportTimeoutMs < CLOUDFLARE_RUNTIME_MIN_TRANSPORT_DISPATCH_MS
        ) {
          throw new RangeError("Cloudflare transport dispatch budget is below its minimum");
        }
        target = new URL(`${this.config.controlUrl}${input.path}`);
        const transportSignal = AbortSignal.timeout(transportTimeoutMs);
        const headers = new Headers({
          ...(input.contentType ? { "content-type": input.contentType } : {}),
          "x-nabuflow-timestamp": timestamp,
          "x-nabuflow-nonce": nonce,
          "x-nabuflow-body-sha256": bodySha256,
          "x-nabuflow-signature": signature,
          ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
        });
        requestInit = {
          method,
          body: typeof body === "string" ? body || undefined : (body.slice().buffer as ArrayBuffer),
          signal:
            input.signal === undefined
              ? transportSignal
              : AbortSignal.any([input.signal, transportSignal]),
          headers,
        };
      } catch (error) {
        throw preDispatchError(error);
      }
      let response: Response;
      try {
        response = await fetch(target, requestInit);
      } catch (error) {
        if (input.signal?.aborted) {
          throw new CloudflareRuntimeControlError(
            499,
            "control_operation_cancelled",
            false,
            "Cloudflare runtime control operation was cancelled",
            "client_abort",
          );
        }
        if (attempt < retryDelays.length) {
          await this.sleepFor(retryDelays[attempt]);
          continue;
        }
        const transport = classifyTransportFailure(error);
        throw new CloudflareRuntimeControlError(
          503,
          transport.code,
          true,
          error instanceof Error
            ? `Cloudflare runtime control request failed: ${error.name}`
            : "Cloudflare runtime control request failed",
          transport.cause,
        );
      }

      const rawBody = await response.text();
      const payload = parseJson(rawBody);
      if (response.ok) return input.parse.parse(payload);

      const parsedError = controlErrorResponseSchema.safeParse(payload);
      const error = parsedError.success
        ? new CloudflareRuntimeControlError(
            response.status,
            parsedError.data.code,
            parsedError.data.retryable,
            parsedError.data.message,
          )
        : new CloudflareRuntimeControlError(
            response.status,
            isCloudflareWorkerException(response.status, rawBody)
              ? "cloudflare_worker_exception"
              : response.status >= 500
                ? "unexpected_control_5xx"
                : "malformed_control_error",
            response.status >= 500,
            `Cloudflare runtime control returned HTTP ${response.status}`,
          );
      const transientInvalidSignature = error.status === 401 && error.code === "invalid_signature";
      if (attempt < retryDelays.length && (error.retryable || transientInvalidSignature)) {
        await this.sleepFor(retryAfterMs(response, retryDelays[attempt]));
        continue;
      }
      throw error;
    }
  }

  private async descriptorRequest(
    locator: RuntimeLocator,
    method: string,
    suffix: string,
    body?: unknown,
    operation?: ControlOperationFollowOptions,
    idempotencyKey?: string,
  ): Promise<RuntimeDescriptor> {
    const result = await this.request({
      method,
      path: this.path(locator, suffix),
      body,
      idempotencyKey: method === "GET" ? undefined : (idempotencyKey ?? crypto.randomUUID()),
      operation,
      parse: {
        parse: (value: unknown) =>
          runtimeDescriptorSchema.parse((value as { runtime: unknown }).runtime),
      },
    });
    return result;
  }

  private operationOptions(
    operation: string,
    operationBoundMs: number,
    timeoutCode: string,
    cancelledCode: string,
    options?: RuntimeOperationOptions,
  ): ControlOperationFollowOptions {
    return {
      operation,
      operationBoundMs,
      operationTimeoutMs: options?.operationTimeoutMs,
      signal: options?.signal,
      timeoutCode,
      terminalUnknownCode: timeoutCode.endsWith("_timeout")
        ? `${timeoutCode.slice(0, -"_timeout".length)}_terminal_unknown`
        : `${timeoutCode}_terminal_unknown`,
      cancelledCode,
    };
  }

  private operationCancelled(
    options: ControlOperationFollowOptions,
  ): CloudflareRuntimeControlError {
    return new CloudflareRuntimeControlError(
      499,
      options.cancelledCode,
      false,
      `Cloudflare ${options.operation} was cancelled`,
    );
  }

  private operationDeadlineError(
    options: ControlOperationFollowOptions,
    input: {
      elapsedMs: number;
      attempts: number;
      lastObservedOperationState: string;
      operationBoundMs: number;
      transportCauseCounts: Readonly<Partial<Record<CloudflareRuntimeTransportCause, number>>>;
      successfulObservationCount: number;
    },
  ): CloudflareRuntimeOperationTimeoutError | CloudflareRuntimeOperationTerminalUnknownError {
    if (
      input.lastObservedOperationState.startsWith("transport_") &&
      Object.keys(input.transportCauseCounts).length > 0
    ) {
      return new CloudflareRuntimeOperationTerminalUnknownError(
        options.operation,
        options.terminalUnknownCode,
        input.elapsedMs,
        input.attempts,
        input.lastObservedOperationState,
        input.operationBoundMs,
        options.operationBoundMs,
        input.transportCauseCounts,
        input.successfulObservationCount,
      );
    }
    return new CloudflareRuntimeOperationTimeoutError(
      options.operation,
      options.timeoutCode,
      input.elapsedMs,
      input.attempts,
      input.lastObservedOperationState,
      input.operationBoundMs,
      options.operationBoundMs,
      input.transportCauseCounts,
    );
  }

  private async sleepWhileFollowingOperation(
    delayMs: number,
    options: ControlOperationFollowOptions,
  ): Promise<void> {
    if (options.signal?.aborted) throw this.operationCancelled(options);
    if (options.signal === undefined) {
      await this.sleepFor(delayMs);
      return;
    }
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = (): void => reject(this.operationCancelled(options));
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (options.signal?.aborted) onAbort();
    });
    try {
      await Promise.race([this.sleepFor(delayMs), cancelled]);
    } finally {
      if (onAbort !== undefined) options.signal.removeEventListener("abort", onAbort);
    }
  }

  private async followOperation<T>(
    input: {
      method: string;
      path: string;
      body: string | Uint8Array;
      contentType?: string;
      idempotencyKey: string;
      parse: { parse(value: unknown): T };
    },
    options: ControlOperationFollowOptions,
  ): Promise<T> {
    const requestedBound = options.operationTimeoutMs ?? options.operationBoundMs;
    const operationBoundMs = Number.isFinite(requestedBound)
      ? Math.max(0, Math.min(requestedBound, options.operationBoundMs))
      : 0;
    const startedAt = this.monotonicNow();
    let attempts = 0;
    let lastObservedOperationState = "not_started";
    let successfulObservationCount = 0;
    const transportCauseCounts: Partial<Record<CloudflareRuntimeTransportCause, number>> = {};

    for (;;) {
      if (options.signal?.aborted) throw this.operationCancelled(options);
      const elapsedMs = Math.max(0, this.monotonicNow() - startedAt);
      const remainingMs = operationBoundMs - elapsedMs;
      const dispatchBudgetMs = Math.floor(Math.min(REQUEST_TIMEOUT_MS, remainingMs));
      if (remainingMs <= 0 || dispatchBudgetMs < CLOUDFLARE_RUNTIME_MIN_TRANSPORT_DISPATCH_MS) {
        throw this.operationDeadlineError(options, {
          elapsedMs,
          attempts,
          lastObservedOperationState,
          operationBoundMs,
          transportCauseCounts,
          successfulObservationCount,
        });
      }
      attempts += 1;
      try {
        return await this.requestEncoded({
          ...input,
          signal: options.signal,
          transportTimeoutMs: dispatchBudgetMs,
          retryDelaysMs: [],
        });
      } catch (error) {
        if (options.signal?.aborted) throw this.operationCancelled(options);
        if (!(error instanceof CloudflareRuntimeControlError)) throw error;
        if (error.code === "control_operation_cancelled") {
          throw this.operationCancelled(options);
        }
        if (error.code === "request_in_progress") {
          successfulObservationCount += 1;
          lastObservedOperationState = "request_in_progress";
        } else if (error.transportCause !== null) {
          transportCauseCounts[error.transportCause] =
            (transportCauseCounts[error.transportCause] ?? 0) + 1;
          lastObservedOperationState = `transport_${error.transportCause}_after_dispatch`;
        } else {
          throw error;
        }
      }

      const elapsedAfterAttemptMs = Math.max(0, this.monotonicNow() - startedAt);
      const followDelayMs = Math.min(
        OPERATION_FOLLOW_DELAY_MS,
        operationBoundMs - elapsedAfterAttemptMs,
      );
      if (followDelayMs <= 0) continue;
      await this.sleepWhileFollowingOperation(followDelayMs, options);
    }
  }

  hasCredentials(): boolean {
    return true;
  }

  async isAvailable(): Promise<boolean> {
    try {
      await this.refreshVersion();
      return true;
    } catch {
      return false;
    }
  }

  async runSelfCheck(): Promise<RuntimeSubsystemStatus> {
    try {
      await this.refreshVersion();
      this.subsystemStatus = "ok";
    } catch (error) {
      logger.warn({ error }, "Cloudflare runtime subsystem self-check failed");
      this.subsystemStatus = "error";
    }
    return this.subsystemStatus;
  }

  getSubsystemStatus(): RuntimeSubsystemStatus | null {
    return this.subsystemStatus;
  }
  async ensureInfrastructure(): Promise<void> {
    await this.refreshVersion();
  }

  async create(
    projectId: number,
    stack?: string | null,
    _environment?: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<RuntimeCreateResult> {
    if (_environment && Object.keys(_environment).length > 0)
      this.unavailable("secret-environment-at-create");
    const locator: RuntimeLocator = { projectId, role: "preview", slot: "primary" };
    const resolvedServicePort = resolveProjectRuntimeManifest({
      stack,
      runtimePort: options?.servicePort,
      legacyProfile: "stack",
    }).servicePort;
    // Cloudflare reserves port 3000 for its Sandbox control service. The
    // legacy Node fallback is therefore not a valid control-plane manifest;
    // sealed Node projects use their fixed 8080 contract instead.
    const servicePort =
      resolvedServicePort === 3000 ? ZERO_SEALED_RUNTIME_PORT : resolvedServicePort;
    const expectedDeploymentVersion = this.deploymentVersion ?? (await this.refreshVersion());
    const runtime = await this.descriptorRequest(
      locator,
      "PUT",
      "",
      {
        locator,
        expectedDeploymentVersion,
        manifest: {
          revision: `project-${projectId}-runtime-v1`,
          runtime: stack ?? "node",
          buildCommand: ["npm", "run", "build"],
          startCommand: commandForStack(stack),
          servicePort,
          healthPath: options?.healthPath ?? "/",
          resourceProfile: "dev",
          public: false,
        },
      },
      this.operationOptions(
        "runtime.ensure",
        RUNTIME_CONTROL_OPERATION_BOUND_MS,
        "runtime_ensure_timeout",
        "runtime_ensure_cancelled",
        options,
      ),
    );
    return toInfo(runtime);
  }

  async start(
    runtimeId: string,
    projectId: number,
    options?: RuntimeStartOptions,
  ): Promise<boolean> {
    const locator = await this.locator(runtimeId, projectId);
    const deployed = this.deployedArtifacts.get(runtimeId);
    if (deployed === undefined) {
      throw new CloudflareRuntimeControlError(
        409,
        "artifact_not_committed",
        false,
        "A committed Cloudflare artifact is required before start",
      );
    }
    await this.requireControlFeature(deployed.feature);
    await this.descriptorRequest(
      locator,
      "POST",
      "/start",
      {
        locator,
        expectedDeploymentVersion: this.deploymentVersion ?? (await this.refreshVersion()),
        artifactRevision: deployed.artifactRevision,
        artifactSha256: deployed.sealedArtifactSha256,
      },
      this.operationOptions(
        "runtime-start",
        RUNTIME_START_OPERATION_BOUND_MS,
        "runtime_start_timeout",
        "runtime_start_cancelled",
        options,
      ),
    );
    return true;
  }

  async stop(
    runtimeId: string,
    projectId: number,
    options?: RuntimeOperationOptions,
  ): Promise<boolean> {
    const locator = await this.locator(runtimeId, projectId);
    await this.descriptorRequest(
      locator,
      "POST",
      "/stop",
      { locator },
      this.operationOptions(
        "runtime.stop",
        RUNTIME_CONTROL_OPERATION_BOUND_MS,
        "runtime_stop_timeout",
        "runtime_stop_cancelled",
        options,
      ),
    );
    return true;
  }

  async destroy(
    runtimeId: string,
    projectId: number,
    options?: RuntimeOperationOptions,
  ): Promise<boolean> {
    const locator = await this.locator(runtimeId, projectId);
    await this.request({
      method: "DELETE",
      path: this.path(locator),
      body: { locator },
      idempotencyKey: crypto.randomUUID(),
      operation: this.operationOptions(
        "runtime.destroy",
        RUNTIME_CONTROL_OPERATION_BOUND_MS,
        "runtime_destroy_timeout",
        "runtime_destroy_cancelled",
        options,
      ),
      parse: { parse: () => true },
    });
    return true;
  }

  async status(runtimeId: string): Promise<RuntimeStatus> {
    const locator = await this.locator(runtimeId);
    return (await this.descriptorRequest(locator, "GET", "")).status;
  }

  async exec(
    runtimeId: string,
    command: string[],
    projectId: number,
    workdir?: string,
    options?: RuntimeOperationOptions,
  ): Promise<RuntimeExecResult> {
    const locator = await this.locator(runtimeId, projectId);
    const result = await this.request({
      method: "POST",
      path: this.path(locator, "/exec"),
      body: { locator, argv: command, cwd: workdir, timeoutMs: 120_000 },
      idempotencyKey: crypto.randomUUID(),
      operation: this.operationOptions(
        "runtime.exec",
        RUNTIME_CONTROL_OPERATION_BOUND_MS,
        "runtime_exec_timeout",
        "runtime_exec_cancelled",
        options,
      ),
      parse: execRuntimeResponseSchema,
    });
    return {
      ...result,
      output: `${result.stdout}${result.stderr}`,
      exitCode: result.exitCode ?? -1,
      runtimeRestarted: false,
    };
  }

  async installDependencies(
    runtimeId: string,
    projectId: number,
    options?: RuntimeInstallOptions,
  ): Promise<{ ok: boolean; output: string }> {
    if (options?.signal?.aborted) throw options.signal.reason;
    const result = await this.exec(runtimeId, ["npm", "install"], projectId, "/workspace", {
      operationTimeoutMs: options?.wallClockCapMs,
      signal: options?.signal,
    });
    return { ok: result.ok, output: result.output };
  }

  async writeFile(
    _runtimeId: string,
    _path: string,
    _content: string,
    _projectId: number,
  ): Promise<boolean> {
    return this.unavailable("file-write");
  }

  async syncFiles(runtimeId: string, projectId: number, files: RuntimeFile[]): Promise<void> {
    const locator = await this.locator(runtimeId, projectId);
    const runtime = await this.descriptorRequest(locator, "GET", "");
    const revision = crypto.randomUUID();
    const artifact = await sealRuntimeArtifact({
      targetRuntimeIdentity: runtimeId,
      manifestRevision: runtime.manifestRevision,
      artifactRevision: `snapshot-${revision}`,
      sourceRevision: revision,
      files,
    });
    await this.deployArtifact(runtimeId, projectId, artifact);
  }

  restoreFiles(runtimeId: string, projectId: number, files: RuntimeFile[]): Promise<void> {
    return this.syncFiles(runtimeId, projectId, files);
  }

  async deployArtifact(
    runtimeId: string,
    projectId: number,
    artifact: RuntimeArtifactDeployment,
    options?: RuntimeOperationOptions,
  ): Promise<RuntimeArtifactDeploymentResult> {
    await this.requireControlFeature("artifact-v1");
    const locator = await this.locator(runtimeId, projectId);
    const envelope = runtimeArtifactEnvelopeSchema.parse(artifact.envelope);
    if (
      envelope.targetRuntimeIdentity !== runtimeId ||
      !(await verifyRuntimeArtifactEnvelope(envelope)) ||
      artifact.chunks.length !== envelope.content.chunks.length
    ) {
      throw new CloudflareRuntimeControlError(
        400,
        "invalid_artifact",
        false,
        "Runtime artifact failed local validation",
      );
    }
    for (let chunkIndex = 0; chunkIndex < artifact.chunks.length; chunkIndex += 1) {
      const chunk = artifact.chunks[chunkIndex];
      const isFinal = chunkIndex === artifact.chunks.length - 1;
      const finalLength =
        envelope.content.payloadBytes % envelope.content.chunkBytes || envelope.content.chunkBytes;
      const expectedLength = isFinal ? finalLength : envelope.content.chunkBytes;
      if (
        chunk.byteLength !== expectedLength ||
        (await sha256Hex(chunk)) !== envelope.content.chunks[chunkIndex]
      ) {
        throw new CloudflareRuntimeControlError(
          400,
          "invalid_artifact",
          false,
          "Runtime artifact chunk failed local validation",
        );
      }
    }
    const expectedDeploymentVersion = this.deploymentVersion ?? (await this.refreshVersion());
    const suffix = `/artifacts/${envelope.sealedArtifactSha256}`;
    await this.request({
      method: "POST",
      path: this.path(locator, `${suffix}/begin`),
      body: { locator, expectedDeploymentVersion, envelope },
      idempotencyKey: `artifact:${envelope.sealedArtifactSha256}:begin`,
      operation: this.operationOptions(
        "artifact.begin",
        RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
        "artifact_transfer_timeout",
        "artifact_transfer_cancelled",
        options,
      ),
      parse: beginRuntimeArtifactResponseSchema,
    });
    for (let chunkIndex = 0; chunkIndex < artifact.chunks.length; chunkIndex += 1) {
      await this.requestBytes({
        method: "PUT",
        path: this.path(locator, `${suffix}/chunks/${chunkIndex}`),
        body: artifact.chunks[chunkIndex],
        idempotencyKey: `artifact:${envelope.sealedArtifactSha256}:chunk:${chunkIndex}`,
        operation: this.operationOptions(
          "artifact.chunk",
          RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
          "artifact_transfer_timeout",
          "artifact_transfer_cancelled",
          options,
        ),
        parse: uploadRuntimeArtifactChunkResponseSchema,
      });
    }
    const result = await this.request({
      method: "POST",
      path: this.path(locator, `${suffix}/commit`),
      body: {
        locator,
        expectedDeploymentVersion,
        sealedArtifactSha256: envelope.sealedArtifactSha256,
      },
      idempotencyKey: `artifact:${envelope.sealedArtifactSha256}:commit`,
      operation: this.operationOptions(
        "artifact.commit",
        RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
        "artifact_commit_timeout",
        "artifact_commit_cancelled",
        options,
      ),
      parse: commitRuntimeArtifactResponseSchema,
    });
    this.deployedArtifacts.set(runtimeId, {
      artifactRevision: envelope.artifactRevision,
      sealedArtifactSha256: envelope.sealedArtifactSha256,
      feature: "artifact-v1",
    });
    return result;
  }

  async deployLayeredArtifact(
    runtimeId: string,
    projectId: number,
    artifact: RuntimeLayeredArtifactDeployment,
    options?: RuntimeOperationOptions,
  ): Promise<RuntimeLayeredArtifactDeploymentResult> {
    await this.requireControlFeature("artifact-layers-v1");
    const locator = await this.locator(runtimeId, projectId);
    const envelope = runtimeLayeredArtifactEnvelopeSchema.parse(artifact.envelope);
    if (
      envelope.targetRuntimeIdentity !== runtimeId ||
      !(await verifyRuntimeLayeredArtifactEnvelope(envelope)) ||
      artifact.appChunks.length !== envelope.content.appArtifact.content.chunks.length ||
      artifact.layers.length !== envelope.content.layers.length
    ) {
      throw invalidLayeredArtifact();
    }
    await validateArtifactChunks(
      artifact.appChunks,
      envelope.content.appArtifact.content.payloadBytes,
      envelope.content.appArtifact.content.chunkBytes,
      envelope.content.appArtifact.content.chunks,
    );
    const providedLayers = new Map(
      artifact.layers.map((layer) => [layer.content.descriptor.contentSha256, layer]),
    );
    for (const content of envelope.content.layers) {
      const provided = providedLayers.get(content.descriptor.contentSha256);
      if (
        provided === undefined ||
        canonicalJson(runtimeArtifactLayerContentSchema.parse(provided.content)) !==
          canonicalJson(content)
      ) {
        throw invalidLayeredArtifact();
      }
      const payload = await validateArtifactChunks(
        provided.chunks,
        content.payloadBytes,
        content.chunkBytes,
        content.chunks,
        true,
      );
      if ((await sha256Hex(payload)) !== content.descriptor.contentSha256) {
        throw invalidLayeredArtifact();
      }
    }

    const expectedDeploymentVersion = this.deploymentVersion ?? (await this.refreshVersion());
    const suffix = `/layered-artifacts/${envelope.sealedArtifactSha256}`;
    const begin = await this.request({
      method: "POST",
      path: this.path(locator, `${suffix}/begin`),
      body: { locator, expectedDeploymentVersion, envelope },
      idempotencyKey: `layered-artifact:${envelope.sealedArtifactSha256}:begin`,
      operation: this.operationOptions(
        "layered-artifact.begin",
        RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
        "artifact_transfer_timeout",
        "artifact_transfer_cancelled",
        options,
      ),
      parse: beginRuntimeLayeredArtifactResponseSchema,
    });
    for (let chunkIndex = 0; chunkIndex < artifact.appChunks.length; chunkIndex += 1) {
      await this.requestBytes({
        method: "PUT",
        path: this.path(locator, `${suffix}/app/chunks/${chunkIndex}`),
        body: artifact.appChunks[chunkIndex],
        idempotencyKey: `layered-artifact:${envelope.sealedArtifactSha256}:app:${chunkIndex}`,
        operation: this.operationOptions(
          "layered-artifact.app-chunk",
          RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
          "artifact_transfer_timeout",
          "artifact_transfer_cancelled",
          options,
        ),
        parse: uploadRuntimeLayeredArtifactChunkResponseSchema,
      });
    }
    for (const layer of artifact.layers) {
      const contentSha256 = layer.content.descriptor.contentSha256;
      if (!begin.layerContentSha256ToUpload.includes(contentSha256)) continue;
      for (let chunkIndex = 0; chunkIndex < layer.chunks.length; chunkIndex += 1) {
        await this.requestBytes({
          method: "PUT",
          path: this.path(locator, `${suffix}/layers/${contentSha256}/chunks/${chunkIndex}`),
          body: layer.chunks[chunkIndex],
          idempotencyKey: `layered-artifact:${envelope.sealedArtifactSha256}:layer:${contentSha256}:${chunkIndex}`,
          operation: this.operationOptions(
            "layered-artifact.layer-chunk",
            RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
            "artifact_transfer_timeout",
            "artifact_transfer_cancelled",
            options,
          ),
          parse: uploadRuntimeLayeredArtifactChunkResponseSchema,
        });
      }
    }
    const result = await this.request({
      method: "POST",
      path: this.path(locator, `${suffix}/commit`),
      body: {
        locator,
        expectedDeploymentVersion,
        sealedArtifactSha256: envelope.sealedArtifactSha256,
      },
      idempotencyKey: `layered-artifact:${envelope.sealedArtifactSha256}:commit`,
      operation: this.operationOptions(
        "layered-artifact.commit",
        RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
        "artifact_commit_timeout",
        "artifact_commit_cancelled",
        options,
      ),
      parse: commitRuntimeLayeredArtifactResponseSchema,
    });
    this.deployedArtifacts.set(runtimeId, {
      artifactRevision: envelope.artifactRevision,
      sealedArtifactSha256: envelope.sealedArtifactSha256,
      feature: "artifact-layers-v1",
    });
    return result;
  }

  async updateRuntimeManifest(
    runtimeId: string,
    projectId: number,
    input: {
      expectedManifestRevision: string;
      manifest: RuntimeManifestContract;
      restart?: "reject-if-running" | "restart";
      sealedArtifactSha256?: string;
      operationTimeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<RuntimeInfo> {
    await this.requireControlFeature("manifest-update-v1");
    const locator = await this.locator(runtimeId, projectId);
    const runtime = await this.descriptorRequest(
      locator,
      "PUT",
      "/manifest",
      {
        locator,
        expectedDeploymentVersion: this.deploymentVersion ?? (await this.refreshVersion()),
        expectedManifestRevision: input.expectedManifestRevision,
        manifest: input.manifest,
        restart: input.restart ?? "reject-if-running",
        ...(input.sealedArtifactSha256 ? { sealedArtifactSha256: input.sealedArtifactSha256 } : {}),
      },
      this.operationOptions(
        "runtime.manifest-update",
        RUNTIME_CONTROL_OPERATION_BOUND_MS,
        "runtime_manifest_update_timeout",
        "runtime_manifest_update_cancelled",
        input,
      ),
    );
    if (input.sealedArtifactSha256 !== undefined) {
      const deployed = this.deployedArtifacts.get(runtimeId);
      if (deployed !== undefined)
        this.deployedArtifacts.set(runtimeId, {
          ...deployed,
          sealedArtifactSha256: input.sealedArtifactSha256,
        });
    }
    return toInfo(runtime);
  }

  async zeroGenerationControlRequest(input: {
    method: "GET" | "POST";
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    operationTimeoutMs?: number;
    signal?: AbortSignal;
  }): Promise<unknown> {
    if (
      !input.path.startsWith(`${CONTROL_API_PREFIX}/pantry/`) &&
      !input.path.startsWith(`${CONTROL_API_PREFIX}/build-plane/`)
    ) {
      throw new CloudflareRuntimeControlError(
        400,
        "invalid_zero_generation_control_path",
        false,
        "Zero generation may address only Pantry and trusted-build control paths",
      );
    }
    const pantry = input.path.startsWith(`${CONTROL_API_PREFIX}/pantry/`);
    const readTransportTimeoutMs =
      input.method === "GET" && input.operationTimeoutMs !== undefined
        ? Math.max(
            0,
            Math.floor(
              (input.operationTimeoutMs -
                CONTROL_RETRY_DELAYS_MS.reduce((total, delay) => total + delay, 0)) /
                (CONTROL_RETRY_DELAYS_MS.length + 1),
            ),
          )
        : undefined;
    return this.request({
      method: input.method,
      path: input.path,
      body: input.body,
      signal: input.signal,
      transportTimeoutMs: readTransportTimeoutMs,
      idempotencyKey:
        input.method === "GET" ? undefined : (input.idempotencyKey ?? crypto.randomUUID()),
      operation:
        input.method === "GET"
          ? undefined
          : this.operationOptions(
              pantry ? "pantry.mutation" : "trusted-build.mutation",
              ZERO_GENERATION_CONTROL_OPERATION_BOUND_MS,
              pantry ? "pantry_operation_timeout" : "trusted_build_operation_timeout",
              pantry ? "pantry_operation_cancelled" : "trusted_build_operation_cancelled",
              input,
            ),
      parse: { parse: (value: unknown) => value },
    });
  }

  async zeroGenerationRuntimeDescriptor(runtimeId: string, projectId: number) {
    const locator = await this.locator(runtimeId, projectId);
    const runtime = await this.descriptorRequest(locator, "GET", "");
    return {
      identity: runtime.identity,
      manifestRevision: runtime.manifestRevision,
      status: runtime.status,
      endpoint: runtime.endpoint,
    };
  }

  async zeroGenerationRuntimeDescriptorForProject(projectId: number) {
    const runtimeId = await deriveRuntimeIdentity({
      namespace: this.config.deploymentNamespace,
      projectId,
      role: "preview",
      slot: "primary",
    });
    try {
      return await this.zeroGenerationRuntimeDescriptor(runtimeId, projectId);
    } catch (error) {
      if (
        error instanceof CloudflareRuntimeControlError &&
        error.status === 404 &&
        error.code === "runtime_not_found"
      ) {
        return null;
      }
      throw error;
    }
  }
  async updateEnvironment(
    _runtimeId: string,
    _projectId: number,
    _environment: Record<string, string>,
    _options?: RuntimeServiceOptions,
  ): Promise<boolean> {
    return this.unavailable("secret-environment");
  }
  async restartWithProjectEnvironment(
    _projectId: number,
    _environment: Record<string, string>,
    _options?: RuntimeServiceOptions,
  ): Promise<void> {
    this.unavailable("secret-environment");
  }
  async ensureAwake(
    runtimeId: string,
    projectId: number,
  ): Promise<{ ok: boolean; message?: string }> {
    return { ok: await this.start(runtimeId, projectId) };
  }
  async provision(
    _projectId: number,
    _files: RuntimeFile[],
    _environment?: Record<string, string>,
    _options?: RuntimeServiceOptions,
  ): Promise<RuntimeInfo | null> {
    return this.unavailable("artifact-provision");
  }
  async hibernate(projectId: number): Promise<void> {
    const id = await deriveRuntimeIdentity({
      namespace: this.config.deploymentNamespace,
      projectId,
      role: "preview",
      slot: "primary",
    });
    await this.stop(id, projectId);
  }
  async ensureProductionDatabaseCapability(
    input: Parameters<
      ProductionDatabaseCapabilityTenantRuntimeProvider["ensureProductionDatabaseCapability"]
    >[0],
  ): ReturnType<
    ProductionDatabaseCapabilityTenantRuntimeProvider["ensureProductionDatabaseCapability"]
  > {
    await this.requireControlFeature("production-database-v1");
    const expectedDeploymentVersion = this.deploymentVersion ?? (await this.refreshVersion());
    const allocationIdentity = await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId: input.projectId,
    });
    const response = await this.request({
      method: "PUT",
      path: `${CONTROL_API_PREFIX}/capabilities/${input.projectId}/neon-postgres/database/production-allocation`,
      body: {
        action: "ensure",
        projectId: input.projectId,
        expectedDeploymentVersion,
        allocationIdentity,
      },
      idempotencyKey: `production-database:${allocationIdentity}:ensure`,
      operation: this.operationOptions(
        "production-database.ensure",
        PRODUCTION_DATABASE_PROVIDER_OPERATION_BOUND_MS,
        "production_database_timeout",
        "production_database_cancelled",
        input,
      ),
      parse: productionDatabaseAllocationResponseSchema,
    });
    return {
      allocationIdentity: response.allocationIdentity,
      revision: response.revision,
      providerProjectId: response.providerProjectId,
      reused: response.reused,
    };
  }
  async releaseProductionDatabaseCapability(
    input: Parameters<
      ProductionDatabaseCapabilityTenantRuntimeProvider["releaseProductionDatabaseCapability"]
    >[0],
  ): ReturnType<
    ProductionDatabaseCapabilityTenantRuntimeProvider["releaseProductionDatabaseCapability"]
  > {
    await this.requireControlFeature("production-database-v1");
    const expectedDeploymentVersion = this.deploymentVersion ?? (await this.refreshVersion());
    const allocationIdentity = await productionDatabaseAllocationIdentity({
      format: "nabuflow.production-database-allocation/v1",
      deploymentNamespace: "production",
      projectId: input.projectId,
    });
    const response = await this.request({
      method: "DELETE",
      path: `${CONTROL_API_PREFIX}/capabilities/${input.projectId}/neon-postgres/database/production-allocation`,
      body: {
        action: "release",
        projectId: input.projectId,
        expectedDeploymentVersion,
        allocationIdentity,
      },
      idempotencyKey: `production-database:${allocationIdentity}:release`,
      operation: this.operationOptions(
        "production-database.release",
        PRODUCTION_DATABASE_PROVIDER_OPERATION_BOUND_MS,
        "production_database_timeout",
        "production_database_cancelled",
        input,
      ),
      parse: productionDatabaseReleaseResponseSchema,
    });
    return {
      allocationIdentity: response.allocationIdentity,
      providerProjectId: response.providerProjectId,
      verifiedGone: response.verifiedGone,
    };
  }
  async promoteProductionArtifact(
    input: Parameters<
      ProductionArtifactPromotingTenantRuntimeProvider["promoteProductionArtifact"]
    >[0],
  ): ReturnType<ProductionArtifactPromotingTenantRuntimeProvider["promoteProductionArtifact"]> {
    await this.requireControlFeature("artifact-promotion-v1");
    const acceptedRelease = acceptedSealedReleaseSchema.parse(input.acceptedRelease);
    const sourceLocator = await this.locator(
      acceptedRelease.sourceRuntimeIdentity,
      input.projectId,
    );
    if (sourceLocator.role !== "preview" || sourceLocator.slot !== "primary") {
      throw new CloudflareRuntimeControlError(
        409,
        "artifact_promotion_source_invalid",
        false,
        "Accepted release does not belong to the project preview runtime",
      );
    }
    const targetLocator: RuntimeLocator = {
      projectId: input.projectId,
      role: "production",
      slot: input.targetSlot,
    };
    const targetRuntimeIdentity = await deriveRuntimeIdentity({
      namespace: this.config.deploymentNamespace,
      ...targetLocator,
    });
    const expectedDeploymentVersion = this.deploymentVersion ?? (await this.refreshVersion());
    const targetManifest: RuntimeManifestContract = {
      ...acceptedRelease.manifest,
      revision: `prod-${input.promotionIdentity.slice(0, 48)}`,
      resourceProfile: "production",
      public: true,
    };
    const options: RuntimeOperationOptions = {
      operationTimeoutMs: input.operationTimeoutMs,
      signal: input.signal,
    };
    const operationKey = `production-publish:${input.promotionIdentity}`;

    await this.descriptorRequest(
      targetLocator,
      "PUT",
      "",
      { locator: targetLocator, expectedDeploymentVersion, manifest: targetManifest },
      this.operationOptions(
        "production-runtime.ensure",
        RUNTIME_CONTROL_OPERATION_BOUND_MS,
        "production_runtime_ensure_timeout",
        "production_runtime_ensure_cancelled",
        options,
      ),
      `${operationKey}:ensure`,
    );

    const promotion = await this.request({
      method: "POST",
      path: this.path(targetLocator, "/promotions/layered"),
      body: {
        sourceLocator,
        targetLocator,
        expectedDeploymentVersion,
        sourceSealedArtifactSha256: acceptedRelease.sealedArtifactSha256,
        targetManifest,
        targetArtifactRevision: `production-${input.promotionIdentity.slice(0, 48)}`,
        promotionIdentity: input.promotionIdentity,
      },
      idempotencyKey: `${operationKey}:promote`,
      operation: this.operationOptions(
        "layered-artifact.promotion",
        RUNTIME_ARTIFACT_OPERATION_BOUND_MS,
        "artifact_promotion_timeout",
        "artifact_promotion_cancelled",
        options,
      ),
      parse: promoteRuntimeLayeredArtifactResponseSchema,
    });
    this.deployedArtifacts.set(targetRuntimeIdentity, {
      artifactRevision: promotion.artifactRevision,
      sealedArtifactSha256: promotion.targetSealedArtifactSha256,
      feature: "artifact-layers-v1",
    });

    const started = await this.descriptorRequest(
      targetLocator,
      "POST",
      "/start",
      {
        locator: targetLocator,
        expectedDeploymentVersion,
        artifactRevision: promotion.artifactRevision,
        artifactSha256: promotion.targetSealedArtifactSha256,
      },
      this.operationOptions(
        "production-runtime.start",
        RUNTIME_START_OPERATION_BOUND_MS,
        "production_runtime_start_timeout",
        "production_runtime_start_cancelled",
        options,
      ),
      `${operationKey}:start`,
    );
    if (started.status !== "running" || started.manifestRevision !== targetManifest.revision) {
      throw new CloudflareRuntimeControlError(
        502,
        "production_runtime_not_ready",
        true,
        "Production candidate did not reach the ready running state",
      );
    }

    await this.request({
      method: "POST",
      path: `${CONTROL_API_PREFIX}/routes/${input.hostname}/activate`,
      body: {
        route: {
          hostname: input.hostname,
          projectId: input.projectId,
          role: "production",
          activeSlot: input.targetSlot,
          manifestRevision: targetManifest.revision,
          servicePort: targetManifest.servicePort,
          sandboxIdentity: targetRuntimeIdentity,
        },
        expectedPreviousManifestRevision: input.expectedPreviousManifestRevision,
      },
      idempotencyKey: `${operationKey}:activate`,
      operation: this.operationOptions(
        "production-route.activate",
        RUNTIME_CONTROL_OPERATION_BOUND_MS,
        "production_route_activation_timeout",
        "production_route_activation_cancelled",
        options,
      ),
      parse: activateRouteResponseSchema,
    });

    const now = new Date().toISOString();
    const release: ProductionArtifactRelease = {
      format: "nabuflow.production-artifact-release/v1",
      state: "active",
      promotionIdentity: input.promotionIdentity,
      sourceVersionId: input.sourceVersionId,
      sourceSealedArtifactSha256: acceptedRelease.sealedArtifactSha256,
      targetSealedArtifactSha256: promotion.targetSealedArtifactSha256,
      targetContentSha256: promotion.targetContentSha256,
      targetRuntimeIdentity,
      targetSlot: input.targetSlot,
      targetManifest,
      hostname: input.hostname,
      promotedAt: now,
      activatedAt: now,
    };
    return { runtime: toInfo(started), release };
  }
  async rollbackProductionArtifactActivation(input: {
    activatedRelease: ProductionArtifactRelease;
    previousRelease: ProductionArtifactRelease | null;
    signal?: AbortSignal;
  }): Promise<void> {
    const options: RuntimeOperationOptions = { signal: input.signal };
    const rollbackKey = `production-publish:${input.activatedRelease.promotionIdentity}:rollback`;
    if (input.previousRelease === null) {
      await this.request({
        method: "DELETE",
        path: `${CONTROL_API_PREFIX}/routes/${input.activatedRelease.hostname}`,
        body: {
          hostname: input.activatedRelease.hostname,
          expectedManifestRevision: input.activatedRelease.targetManifest.revision,
          expectedSandboxIdentity: input.activatedRelease.targetRuntimeIdentity,
        },
        idempotencyKey: rollbackKey,
        operation: this.operationOptions(
          "production-route.rollback",
          RUNTIME_CONTROL_OPERATION_BOUND_MS,
          "production_route_rollback_timeout",
          "production_route_rollback_cancelled",
          options,
        ),
        parse: deactivateRouteResponseSchema,
      });
      return;
    }
    const previousLocator = await this.locator(input.previousRelease.targetRuntimeIdentity);
    await this.request({
      method: "POST",
      path: `${CONTROL_API_PREFIX}/routes/${input.previousRelease.hostname}/activate`,
      body: {
        route: {
          hostname: input.previousRelease.hostname,
          projectId: previousLocator.projectId,
          role: "production",
          activeSlot: input.previousRelease.targetSlot,
          manifestRevision: input.previousRelease.targetManifest.revision,
          servicePort: input.previousRelease.targetManifest.servicePort,
          sandboxIdentity: input.previousRelease.targetRuntimeIdentity,
        },
        expectedPreviousManifestRevision: input.activatedRelease.targetManifest.revision,
      },
      idempotencyKey: rollbackKey,
      operation: this.operationOptions(
        "production-route.rollback",
        RUNTIME_CONTROL_OPERATION_BOUND_MS,
        "production_route_rollback_timeout",
        "production_route_rollback_cancelled",
        options,
      ),
      parse: activateRouteResponseSchema,
    });
  }
  async createProduction(
    _projectId: number,
    _environment: Record<string, string>,
    _runtime?: string | null,
    _options?: RuntimeProductionOptions,
  ): Promise<RuntimeInfo | null> {
    return this.unavailable("production-create");
  }
  async deployProduction(
    _projectId: number,
    _previousRuntimeId: string | null,
    _files: RuntimeFile[],
    _environment: Record<string, string>,
    _options?: RuntimeProductionOptions,
  ): Promise<RuntimeInfo | null> {
    return this.unavailable("production-deploy");
  }
  async configureIdleBehavior(): Promise<void> {
    this.unavailable("idle-behavior");
  }
  async startHealthService(): Promise<void> {
    this.unavailable("health-sidecar");
  }
  async stopHealthService(): Promise<void> {
    this.unavailable("health-sidecar");
  }
  startKeepalive(): () => void {
    return () => undefined;
  }
  async health(endpoint: string, timeoutSeconds: number): Promise<boolean> {
    let target: URL;
    let signal: AbortSignal;
    try {
      const timeoutMs = positiveIntegerTimerMs(timeoutSeconds * 1_000);
      if (timeoutMs === null || timeoutMs < CLOUDFLARE_RUNTIME_MIN_TRANSPORT_DISPATCH_MS) {
        return false;
      }
      target = new URL(endpoint);
      signal = AbortSignal.timeout(timeoutMs);
    } catch {
      return false;
    }
    try {
      const response = await fetch(target, { signal });
      return response.ok;
    } catch {
      return false;
    }
  }
  resolveEndpoint(): string {
    return this.unavailable("derived-public-endpoint");
  }
  getGatewayHostname(): string {
    return new URL(this.config.controlUrl).hostname;
  }
  getGatewayLabel(): string {
    return "Cloudflare runtime gateway";
  }
  isGatewayReachable(): Promise<boolean> {
    return this.isAvailable();
  }
  mapErrorToMessage(raw: string): string {
    return raw;
  }
  async recordLog(projectId: number, level: RuntimeLogLevel, message: string): Promise<void> {
    logger.info({ projectId, level }, message);
  }
  startLogStream(): void {
    this.unavailable("log-tail");
  }
  stopLogStream(): void {}
  async resumeLogStreamsOnBoot(): Promise<void> {}
}
