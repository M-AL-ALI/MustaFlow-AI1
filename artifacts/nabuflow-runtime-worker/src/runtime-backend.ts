import { ContainerProxy as SandboxContainerProxy, Sandbox } from "@cloudflare/sandbox";
import { createHash, randomBytes } from "node:crypto";
import {
  CAPABILITY_DOORMAN_HOST,
  RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS,
  RUNTIME_RECONCILIATION_OBSERVATION_TIMEOUT_MS,
  TENANT_RUNTIME_MODE_ENV,
  argvToCommandString,
  compareUtf8,
  sha256Hex,
} from "@workspace/tenant-runtime-contracts";
import type {
  ExecRuntimeRequest,
  RuntimeReconciliationObservation,
  RuntimeReconciliationRepairAction,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import { handleCapabilityIntentFromContainer } from "./capability-endpoint";
import type {
  StoredRuntime,
  StoredRuntimeArtifact,
  StoredRuntimeLayer,
  StoredRuntimeLayeredArtifact,
} from "./model";
import { artifactChunkKey } from "./artifact-storage";
import { dependencyLayerChunkKey, layeredArtifactAppChunkKey } from "./artifact-layer-storage";
import { StagingArtifactCommitOwnerLossError } from "./artifact-commit-recovery";
import {
  RUNTIME_MATERIALIZER_SOURCE,
  RUNTIME_MATERIALIZATION_PREPARER_SOURCE,
  RUNTIME_RELEASE_RETENTION_COUNT,
  RUNTIME_RELEASE_ROOT,
  type RuntimeMaterializationFile,
  type RuntimeMaterializationManifest,
  type RuntimeMaterializationPayload,
  type RuntimeMaterializationRequest,
  runtimeMaterializationPayloadPath,
  runtimeMaterializationLeasePath,
  runtimeMaterializationStageRoot,
  sealRuntimeMaterializationManifest,
  verifyRuntimeMaterializationRequest,
} from "./runtime-materialization";

export const DOORMAN_HOST = CAPABILITY_DOORMAN_HOST;
const TENANT_PROCESS_ID = "tenant-service";
export const RUNTIME_AVAILABILITY_TIMEOUT_MS = RUNTIME_RECONCILIATION_OBSERVATION_TIMEOUT_MS;
export const PUBLISHED_RUNTIME_FORWARD_ORIGIN =
  "https://published-runtime-forward.nabuflow.internal";
export const PUBLISHED_RUNTIME_FORWARD_PORT_HEADER = "x-nabuflow-internal-service-port";
export const PUBLISHED_RUNTIME_FORWARD_TIMEOUT_HEADER = "x-nabuflow-internal-timeout-ms";
const PUBLISHED_RUNTIME_FORWARD_FAILURE_HEADER = "x-nabuflow-internal-forward-failure";
const PUBLISHED_RUNTIME_FORWARD_FAILURE_STAGE_HEADER = "x-nabuflow-internal-forward-stage";
const PUBLISHED_RUNTIME_FORWARD_FAILURE_CAUSE_HEADER = "x-nabuflow-internal-forward-cause";
const PUBLISHED_RUNTIME_FORWARD_FAILURE_CLASS_HEADER = "x-nabuflow-internal-forward-class";

export type PublishedRuntimeForwardFailureCause = "pre_dispatch" | "timeout" | "transport";

export interface PublishedRuntimeForwardFailure {
  stage: "request";
  cause: PublishedRuntimeForwardFailureCause;
  errorClass: "AbortError" | "Error" | "NetworkError" | "TimeoutError" | "TypeError" | "unknown";
}

interface RuntimeContainerFetch {
  containerFetch(request: Request, port: number): Promise<Response>;
}

export interface RuntimeHealthProbeInput {
  servicePort: number;
  healthPath: string;
  timeoutMs: number;
}

export interface RuntimeHealthProbeResult {
  ready: boolean;
  stage: "health";
  cause: "ready" | "health_status" | "health_pre_dispatch" | "health_timeout" | "health_transport";
  status: number | null;
}

function publishedForwardErrorClass(error: unknown): PublishedRuntimeForwardFailure["errorClass"] {
  if (!(error instanceof Error)) return "unknown";
  return ["AbortError", "Error", "NetworkError", "TimeoutError", "TypeError"].includes(error.name)
    ? (error.name as PublishedRuntimeForwardFailure["errorClass"])
    : "Error";
}

function publishedForwardFailureResponse(
  cause: PublishedRuntimeForwardFailureCause,
  errorClass: PublishedRuntimeForwardFailure["errorClass"],
): Response {
  return new Response(null, {
    status: 502,
    headers: {
      [PUBLISHED_RUNTIME_FORWARD_FAILURE_HEADER]: "1",
      [PUBLISHED_RUNTIME_FORWARD_FAILURE_STAGE_HEADER]: "request",
      [PUBLISHED_RUNTIME_FORWARD_FAILURE_CAUSE_HEADER]: cause,
      [PUBLISHED_RUNTIME_FORWARD_FAILURE_CLASS_HEADER]: errorClass,
      "cache-control": "no-store",
    },
  });
}

export function readPublishedRuntimeForwardFailure(
  response: Response,
): PublishedRuntimeForwardFailure | null {
  if (response.headers.get(PUBLISHED_RUNTIME_FORWARD_FAILURE_HEADER) !== "1") return null;
  const stage = response.headers.get(PUBLISHED_RUNTIME_FORWARD_FAILURE_STAGE_HEADER);
  const cause = response.headers.get(PUBLISHED_RUNTIME_FORWARD_FAILURE_CAUSE_HEADER);
  const errorClass = response.headers.get(PUBLISHED_RUNTIME_FORWARD_FAILURE_CLASS_HEADER);
  if (
    stage !== "request" ||
    (cause !== "pre_dispatch" && cause !== "timeout" && cause !== "transport") ||
    (errorClass !== "AbortError" &&
      errorClass !== "Error" &&
      errorClass !== "NetworkError" &&
      errorClass !== "TimeoutError" &&
      errorClass !== "TypeError" &&
      errorClass !== "unknown")
  ) {
    return { stage: "request", cause: "transport", errorClass: "unknown" };
  }
  return { stage, cause, errorClass };
}

export async function forwardPublishedRuntimeRequestInSandbox(
  sandbox: RuntimeContainerFetch,
  request: Request,
): Promise<Response> {
  let signal: AbortSignal;
  let upstream: Request;
  let servicePort: number;
  try {
    const url = new URL(request.url);
    if (url.origin !== PUBLISHED_RUNTIME_FORWARD_ORIGIN) {
      throw new TypeError("Published forwarding origin is invalid");
    }
    servicePort = Number(request.headers.get(PUBLISHED_RUNTIME_FORWARD_PORT_HEADER));
    const timeoutMs = Math.floor(
      Number(request.headers.get(PUBLISHED_RUNTIME_FORWARD_TIMEOUT_HEADER)),
    );
    if (
      !Number.isSafeInteger(servicePort) ||
      servicePort < 1 ||
      servicePort > 65_535 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    ) {
      throw new TypeError("Published forwarding input is invalid");
    }

    const headers = new Headers(request.headers);
    headers.delete(PUBLISHED_RUNTIME_FORWARD_PORT_HEADER);
    headers.delete(PUBLISHED_RUNTIME_FORWARD_TIMEOUT_HEADER);
    signal = AbortSignal.timeout(timeoutMs);
    const body = request.method === "GET" || request.method === "HEAD" ? null : request.body;
    upstream = new Request(
      new URL(`${url.pathname}${url.search}`, "https://tenant.published.invalid"),
      {
        method: request.method,
        headers,
        body,
        redirect: "manual",
        signal,
        ...(body === null ? {} : ({ duplex: "half" } as RequestInit & { duplex: "half" })),
      },
    );
  } catch (error) {
    return publishedForwardFailureResponse("pre_dispatch", publishedForwardErrorClass(error));
  }

  try {
    return await sandbox.containerFetch(upstream, servicePort);
  } catch (error) {
    return publishedForwardFailureResponse(
      signal.aborted ? "timeout" : "transport",
      publishedForwardErrorClass(error),
    );
  }
}

export class ContainerProxy extends SandboxContainerProxy {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).hostname === DOORMAN_HOST) {
      const props = this.ctx.props as { containerId: string };
      return handleCapabilityIntentFromContainer(
        request,
        this.env as unknown as WorkerBindings,
        props.containerId,
      );
    }
    return super.fetch(request);
  }
}

export class NabuflowSandbox extends Sandbox<WorkerBindings> {
  enableInternet = false;
  interceptHttps = true;
  allowedHosts = [DOORMAN_HOST];

  /**
   * Preserve streaming HTTP semantics across the Durable Object's native Fetch
   * boundary while constructing the abort-bearing container request in the
   * Sandbox execution context. Availability remains a separate value-only RPC.
   */
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).origin === PUBLISHED_RUNTIME_FORWARD_ORIGIN) {
      return forwardPublishedRuntimeRequestInSandbox(this, request);
    }
    return super.fetch(request);
  }

  /**
   * Run the bounded tenant health request inside the Sandbox Durable Object.
   *
   * Workers RPC supports Request, Response, and AbortSignal, but the captured
   * production failure occurred on that cross-context request/response path.
   * Keeping all fetch primitives here and returning a small value object removes
   * body-stream and cancellation lifetimes from the outer RPC boundary.
   */
  async probeRuntimeHealth(input: RuntimeHealthProbeInput): Promise<RuntimeHealthProbeResult> {
    let signal: AbortSignal;
    let request: Request;
    try {
      const timeoutMs = Math.floor(input.timeoutMs);
      if (
        !Number.isSafeInteger(input.servicePort) ||
        input.servicePort < 1 ||
        input.servicePort > 65_535 ||
        typeof input.healthPath !== "string" ||
        !input.healthPath.startsWith("/") ||
        !Number.isSafeInteger(timeoutMs) ||
        timeoutMs < 1
      ) {
        throw new TypeError("Runtime health probe input is invalid");
      }
      signal = AbortSignal.timeout(timeoutMs);
      request = new Request(new URL(input.healthPath, `http://localhost:${input.servicePort}`), {
        method: "GET",
        redirect: "manual",
        signal,
      });
    } catch {
      return {
        ready: false,
        stage: "health",
        cause: "health_pre_dispatch",
        status: null,
      };
    }

    try {
      const response = await this.containerFetch(request, input.servicePort);
      const ready = response.status >= 200 && response.status <= 399;
      await response.body?.cancel().catch(() => undefined);
      return {
        ready,
        stage: "health",
        cause: ready ? "ready" : "health_status",
        status: response.status,
      };
    } catch {
      return {
        ready: false,
        stage: "health",
        cause: signal.aborted ? "health_timeout" : "health_transport",
        status: null,
      };
    }
  }

  async prepareRuntimeMaterialization(
    sealedArtifactSha256: string,
    stageLeaseId: string,
  ): Promise<{ ok: true }> {
    const stageRoot = runtimeMaterializationStageRoot(sealedArtifactSha256);
    const scope = new RuntimeMaterializationRpcScope();
    try {
      await consumeRuntimeMaterializationRpcResult(
        scope,
        this.exec(
          argvToCommandString([
            "node",
            "--input-type=module",
            "-e",
            RUNTIME_MATERIALIZATION_PREPARER_SOURCE,
            stageRoot,
            RUNTIME_RELEASE_ROOT,
            stageLeaseId,
          ]),
          { cwd: "/workspace", timeout: 30_000 },
        ),
        (result) => {
          if (!result.success) throw new Error("Runtime materialization staging failed");
        },
      );
      return { ok: true };
    } finally {
      scope.close();
    }
  }

  async materializeRuntimeAggregate(request: RuntimeMaterializationRequest): Promise<{
    ok: true;
    filesWritten: number;
    bytesWritten: number;
    releasesRetained: number;
    releasesRemoved: number;
    leftoversRemoved: number;
  }> {
    const manifest = await verifyRuntimeMaterializationRequest(request);
    if (request.stageLeaseId === undefined) {
      throw new Error("Runtime materialization stage lease is unavailable");
    }
    const stageRoot = runtimeMaterializationStageRoot(manifest.sealedArtifactSha256);
    const releaseRoot = `${RUNTIME_RELEASE_ROOT}/${manifest.sealedArtifactSha256}`;
    const manifestPath = `${stageRoot}/manifest.json`;
    const scriptPath = `${stageRoot}/materialize.mjs`;
    const scope = new RuntimeMaterializationRpcScope();
    const startedAt = Date.now();
    try {
      await consumeRuntimeMaterializationRpcResult(
        scope,
        this.writeFile(manifestPath, request.canonicalManifest),
        (result) => {
          if (!result.success) throw new Error("Runtime materialization manifest write failed");
        },
      );
      await consumeRuntimeMaterializationRpcResult(
        scope,
        this.writeFile(scriptPath, RUNTIME_MATERIALIZER_SOURCE),
        (result) => {
          if (!result.success) throw new Error("Runtime materializer write failed");
        },
      );
      // eslint-disable-next-line no-console -- metadata-only materialization liveness evidence
      console.log(
        JSON.stringify({
          event: "runtime.materialization.started",
          sealedArtifactSha256: manifest.sealedArtifactSha256,
          filesExpected: manifest.files.length,
          payloadsExpected: manifest.payloads.length,
        }),
      );
      const output = await consumeRuntimeMaterializationRpcResult(
        scope,
        this.exec(
          argvToCommandString([
            "node",
            scriptPath,
            manifestPath,
            stageRoot,
            releaseRoot,
            String(request.stagingAbortAfterFiles ?? 0),
            request.rollbackReleaseSha256 ?? "",
            request.stagingAbortReleaseCleanup === true ? "1" : "0",
            request.stagingAbortBeforeReleaseSwap === true ? "1" : "0",
            request.stageLeaseId,
            String(request.stagingHoldLockMs ?? 0),
          ]),
          {
            cwd: "/workspace",
            timeout: 270_000,
          },
        ),
        (result) => {
          if (!result.success) throw new Error("Runtime aggregate materialization failed");
          try {
            return JSON.parse(result.stdout) as unknown;
          } catch {
            throw new Error("Runtime materializer returned malformed evidence");
          }
        },
      );
      if (
        typeof output !== "object" ||
        output === null ||
        (output as { ok?: unknown }).ok !== true ||
        !Number.isSafeInteger((output as { filesWritten?: unknown }).filesWritten) ||
        !Number.isSafeInteger((output as { bytesWritten?: unknown }).bytesWritten) ||
        !Number.isSafeInteger((output as { releasesRetained?: unknown }).releasesRetained) ||
        !Number.isSafeInteger((output as { releasesRemoved?: unknown }).releasesRemoved) ||
        !Number.isSafeInteger((output as { leftoversRemoved?: unknown }).leftoversRemoved) ||
        (output as { filesWritten: number }).filesWritten !== manifest.files.length ||
        (output as { releasesRetained: number }).releasesRetained < 1 ||
        (output as { releasesRetained: number }).releasesRetained >
          RUNTIME_RELEASE_RETENTION_COUNT ||
        (output as { releasesRemoved: number }).releasesRemoved < 0 ||
        (output as { leftoversRemoved: number }).leftoversRemoved < 0
      ) {
        throw new Error("Runtime materializer returned invalid evidence");
      }
      // eslint-disable-next-line no-console -- metadata-only materialization liveness evidence
      console.log(
        JSON.stringify({
          event: "runtime.materialization.complete",
          sealedArtifactSha256: manifest.sealedArtifactSha256,
          filesWritten: manifest.files.length,
          bytesWritten: (output as { bytesWritten: number }).bytesWritten,
          releasesRetained: (output as { releasesRetained: number }).releasesRetained,
          releasesRemoved: (output as { releasesRemoved: number }).releasesRemoved,
          leftoversRemoved: (output as { leftoversRemoved: number }).leftoversRemoved,
          durationMs: Date.now() - startedAt,
        }),
      );
      return {
        ok: true,
        filesWritten: manifest.files.length,
        bytesWritten: (output as { bytesWritten: number }).bytesWritten,
        releasesRetained: (output as { releasesRetained: number }).releasesRetained,
        releasesRemoved: (output as { releasesRemoved: number }).releasesRemoved,
        leftoversRemoved: (output as { leftoversRemoved: number }).leftoversRemoved,
      };
    } finally {
      try {
        await consumeRuntimeMaterializationRpcResult(
          scope,
          this.exec(
            argvToCommandString([
              "rm",
              "-f",
              "--",
              runtimeMaterializationLeasePath(manifest.sealedArtifactSha256, request.stageLeaseId),
            ]),
            {
              cwd: "/workspace",
              timeout: 30_000,
            },
          ),
          () => undefined,
        );
      } catch (error) {
        // eslint-disable-next-line no-console -- cleanup failures must stay visible without replacing the response
        console.error(
          JSON.stringify({
            event: "runtime.materialization.cleanup_failed",
            sealedArtifactSha256: manifest.sealedArtifactSha256,
            error: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      } finally {
        scope.close();
      }
    }
  }
}

// The SDK registry setter only runs on assignment. A static class field looks
// equivalent but bypasses registration in @cloudflare/containers 0.3.7.
NabuflowSandbox.outboundHandlers = {
  capabilityDoorman: (request, env, context) =>
    handleCapabilityIntentFromContainer(request, env as WorkerBindings, context.containerId),
};

export interface BackendStartResult {
  processId: string;
  readyAt: string;
}

export interface BackendExecResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export interface BackendStatusResult {
  running: boolean;
  lastError: string | null;
  cause?: "running" | "process_missing" | "process_not_running" | "process_check_failed";
}

export type RuntimeAvailabilityStage = "process" | "health";
export type RuntimeAvailabilityCause =
  | "ready"
  | "process_missing"
  | "process_not_running"
  | "process_check_failed"
  | "health_status"
  | "health_pre_dispatch"
  | "health_timeout"
  | "health_transport";

export interface BackendAvailabilityResult {
  ready: boolean;
  stage: RuntimeAvailabilityStage;
  cause: RuntimeAvailabilityCause;
  status: number | null;
}

export interface BackendReconciliationResult extends BackendAvailabilityResult {
  attempts: number;
  conclusive: boolean;
  processId: string | null;
  repairAction: RuntimeReconciliationRepairAction;
  trail: RuntimeReconciliationObservation[];
}

export type RuntimeReconciliationObservationSink = (
  observation: RuntimeReconciliationObservation,
) => Promise<void>;

export interface RuntimeMaterializationTicket {
  payloadContentSha256s: string[];
  /** Present on real Sandbox tickets; optional only for legacy in-memory test doubles. */
  stageLeaseId?: string;
}

export interface RuntimeMaterializationOptions {
  /** Staging-only live owner-loss probe; production callers never set it. */
  stagingAbortAfterFiles?: number;
  /** Unit/staging-only post-rename cleanup failure probe. */
  stagingAbortReleaseCleanup?: boolean;
  /** Unit/staging-only same-release swap-boundary failure probe. */
  stagingAbortBeforeReleaseSwap?: boolean;
  /** Unit-only lock contention probe; production callers never set it. */
  stagingHoldLockMs?: number;
}

export interface RuntimeBackend {
  start(runtime: StoredRuntime): Promise<BackendStartResult>;
  stop(runtime: StoredRuntime): Promise<void>;
  destroy(runtime: StoredRuntime): Promise<void>;
  /** Governed route mutations are the only callers allowed to persist this policy. */
  setKeepAlive(identity: string, keepAlive: boolean): Promise<void>;
  status(runtime: StoredRuntime): Promise<BackendStatusResult>;
  availability(runtime: StoredRuntime): Promise<BackendAvailabilityResult>;
  reconcile(
    runtime: StoredRuntime,
    onObservation?: RuntimeReconciliationObservationSink,
  ): Promise<BackendReconciliationResult>;
  exec(runtime: StoredRuntime, request: ExecRuntimeRequest): Promise<BackendExecResult>;
  logs(runtime: StoredRuntime): Promise<{ stdout: string; stderr: string }>;
  materialize(
    runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
  ): Promise<{ filesWritten: number }>;
  materializeLayered(
    runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    layers: StoredRuntimeLayer[],
  ): Promise<{ filesWritten: number; layersMaterialized: number }>;
  stageMaterialization(
    runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
  ): Promise<RuntimeMaterializationTicket>;
  unpackMaterialization(
    runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
    ticket: RuntimeMaterializationTicket,
    options?: RuntimeMaterializationOptions,
  ): Promise<{ filesWritten: number }>;
  stageLayeredMaterialization(
    runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    layers: StoredRuntimeLayer[],
  ): Promise<RuntimeMaterializationTicket>;
  unpackLayeredMaterialization(
    runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    layers: StoredRuntimeLayer[],
    ticket: RuntimeMaterializationTicket,
    options?: RuntimeMaterializationOptions,
  ): Promise<{ filesWritten: number; layersMaterialized: number }>;
}

function reconciliationObservation(
  storedRuntime: StoredRuntime,
  observation: BackendAvailabilityResult,
  attempt: number,
  observedAtMs: number,
  ambiguous: boolean,
  repairAction: RuntimeReconciliationRepairAction,
): RuntimeReconciliationObservation {
  const providerProcess =
    observation.stage === "health"
      ? "running"
      : observation.cause === "process_missing"
        ? "missing"
        : observation.cause === "process_not_running"
          ? "not-running"
          : "unknown";
  const health =
    observation.stage === "process"
      ? "not-probed"
      : observation.ready
        ? "ready"
        : observation.cause === "health_status"
          ? "rejected"
          : "unknown";
  const decision =
    repairAction === "restart-and-rebind"
      ? "repair-required"
      : repairAction === "settle-idle"
        ? "healthy-idle"
        : ambiguous
          ? "ambiguous"
          : observation.ready
            ? "ready"
            : observation.stage === "process" &&
                (observation.cause === "process_missing" ||
                  observation.cause === "process_not_running")
              ? "confirmed-stopped"
              : "confirmed-error";
  const sources: RuntimeReconciliationObservation["sources"] =
    observation.stage === "health"
      ? ["provider-metadata", "process-probe", "health-probe"]
      : observation.cause === "process_missing"
        ? ["provider-metadata"]
        : ["provider-metadata", "process-probe"];
  return {
    attempt,
    observedAt: new Date(observedAtMs).toISOString(),
    stage: observation.stage,
    cause: observation.cause,
    status: observation.status,
    sources,
    decisionInputs: {
      storedStatus: storedRuntime.descriptor.status,
      storedProcessIdentity: storedRuntime.processId === null ? "absent" : "present",
      providerProcess,
      health,
    },
    decision,
    repairAction,
  };
}

function reconciliationRepairAction(
  storedRuntime: StoredRuntime,
  observation: BackendAvailabilityResult,
  atObservationCap: boolean,
): RuntimeReconciliationRepairAction {
  if (observation.ready) {
    return storedRuntime.processId === null ? "reregister-and-rebind" : "none";
  }
  const processDefinitelyAbsent =
    observation.stage === "process" &&
    (observation.cause === "process_missing" || observation.cause === "process_not_running");
  if (
    storedRuntime.descriptor.role === "preview" &&
    storedRuntime.descriptor.status === "stopped" &&
    processDefinitelyAbsent
  ) {
    return "settle-idle";
  }
  const falseTerminalDamage =
    storedRuntime.descriptor.status === "error" &&
    storedRuntime.processId === null &&
    storedRuntime.artifactSha256 !== null;
  if (!falseTerminalDamage) return "none";
  if (processDefinitelyAbsent || observation.cause === "health_status") {
    return "restart-and-rebind";
  }
  if (
    atObservationCap &&
    observation.stage === "health" &&
    (observation.cause === "health_timeout" || observation.cause === "health_transport")
  ) {
    // V3 repairs only the captured false-terminal state after the full observation budget.
    // A truthful running descriptor keeps ambiguous transport non-mutating and retryable.
    return "restart-and-rebind";
  }
  return "none";
}

export class CloudflareSandboxBackend implements RuntimeBackend {
  constructor(
    private readonly env: WorkerBindings,
    private readonly nowMs: () => number = Date.now,
  ) {}

  async start(runtime: StoredRuntime): Promise<BackendStartResult> {
    // A start is a bounded control-plane operation, not proof that the slot owns
    // a published route. The configured activity window keeps a candidate alive
    // through cutover without turning an abandoned candidate into a permanent bill.
    const keepAlive = false;
    const sandbox = await this.configuredSandbox(runtime.descriptor.identity, keepAlive);
    await sandbox.setOutboundByHost(DOORMAN_HOST, "capabilityDoorman");
    await sandbox.killAllProcesses();
    if (runtime.artifactSha256 === null) throw new Error("A committed artifact is required");
    const process = await sandbox.startProcess(argvToCommandString(runtime.manifest.startCommand), {
      cwd: releaseAppRoot(runtime.artifactSha256),
      env: {
        HOST: "0.0.0.0",
        PORT: String(runtime.manifest.servicePort),
        NABUFLOW_RUNTIME_ID: runtime.descriptor.identity,
        // Platform-owned and injected after artifact sealing. Tenant source,
        // requests, and environment APIs cannot select direct credential mode.
        [TENANT_RUNTIME_MODE_ENV]: "cloudflare-capability-v1",
      },
      processId: TENANT_PROCESS_ID,
      autoCleanup: false,
    });
    await process.waitForPort(runtime.manifest.servicePort, {
      path: runtime.manifest.healthPath,
      status: { min: 200, max: 399 },
      timeout: 30_000,
      interval: 250,
    });
    return { processId: process.id, readyAt: new Date().toISOString() };
  }

  async stop(runtime: StoredRuntime): Promise<void> {
    const sandbox = await this.configuredSandbox(runtime.descriptor.identity, false);
    await sandbox.killAllProcesses();
    await sandbox.stop();
  }

  async destroy(runtime: StoredRuntime): Promise<void> {
    const sandbox = await this.configuredSandbox(runtime.descriptor.identity, false);
    await sandbox.destroy();
  }

  async setKeepAlive(identity: string, keepAlive: boolean): Promise<void> {
    const sandbox = await this.configuredSandbox(identity);
    // Policy ownership remains one explicit, awaited mutation. Raw stub acquisition
    // cannot queue an SDK configure call that later resurrects an older value.
    await sandbox.setKeepAlive(keepAlive);
  }

  async status(runtime: StoredRuntime): Promise<BackendStatusResult> {
    if (runtime.processId === null) {
      return { running: false, lastError: null, cause: "process_missing" };
    }
    try {
      const process = await this.sandbox(runtime.descriptor.identity).getProcess(runtime.processId);
      if (process === null) {
        return {
          running: false,
          lastError: "Tenant service is not running",
          cause: "process_missing",
        };
      }
      const status = await process.getStatus();
      const running = status === "running" || status === "starting";
      return {
        running,
        lastError:
          status === "failed" || status === "error"
            ? `Tenant service process ended with status ${status}`
            : null,
        cause: running ? "running" : "process_not_running",
      };
    } catch (error) {
      return {
        running: false,
        lastError: error instanceof Error ? error.message : "Runtime status check failed",
        cause: "process_check_failed",
      };
    }
  }

  async availability(runtime: StoredRuntime): Promise<BackendAvailabilityResult> {
    const processStatus = await this.status(runtime);
    if (!processStatus.running) {
      return {
        ready: false,
        stage: "process",
        cause:
          processStatus.cause === undefined || processStatus.cause === "running"
            ? runtime.processId === null
              ? "process_missing"
              : processStatus.lastError === null
                ? "process_not_running"
                : "process_check_failed"
            : processStatus.cause,
        status: null,
      };
    }

    try {
      return await this.sandbox(runtime.descriptor.identity).probeRuntimeHealth({
        servicePort: runtime.manifest.servicePort,
        healthPath: runtime.manifest.healthPath,
        timeoutMs: RUNTIME_AVAILABILITY_TIMEOUT_MS,
      });
    } catch {
      return {
        ready: false,
        stage: "health",
        cause: "health_transport",
        status: null,
      };
    }
  }

  async reconcile(
    runtime: StoredRuntime,
    onObservation?: RuntimeReconciliationObservationSink,
  ): Promise<BackendReconciliationResult> {
    // Reconciliation is the only path allowed to recover the platform-owned process
    // identity after a stale descriptor lost it. Ordinary metadata reads never probe.
    const candidate = structuredClone(runtime);
    candidate.processId = TENANT_PROCESS_ID;
    const trail: RuntimeReconciliationObservation[] = [];
    for (
      let attempt = 1;
      attempt <= RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS;
      attempt += 1
    ) {
      const observation = await this.availability(candidate);
      const otherwiseAmbiguous =
        observation.cause === "health_timeout" ||
        observation.cause === "health_transport" ||
        observation.cause === "process_check_failed";
      const atObservationCap = attempt === RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS;
      const repairAction = reconciliationRepairAction(runtime, observation, atObservationCap);
      const ambiguous = otherwiseAmbiguous && repairAction === "none";
      const trailEntry = reconciliationObservation(
        runtime,
        observation,
        attempt,
        this.nowMs(),
        ambiguous,
        repairAction,
      );
      trail.push(trailEntry);
      await onObservation?.(structuredClone(trailEntry));
      if (!ambiguous || attempt === RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS) {
        return {
          ...observation,
          attempts: attempt,
          conclusive: !ambiguous,
          processId: observation.ready ? TENANT_PROCESS_ID : null,
          repairAction,
          trail,
        };
      }
    }
    throw new Error("Runtime reconciliation observation budget was not applied");
  }

  async exec(runtime: StoredRuntime, request: ExecRuntimeRequest): Promise<BackendExecResult> {
    try {
      const result = await this.sandbox(runtime.descriptor.identity).exec(
        argvToCommandString(request.argv),
        { cwd: request.cwd, timeout: request.timeoutMs },
      );
      return {
        ok: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        timedOut: false,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : "Command execution failed";
      return {
        ok: false,
        stdout: "",
        stderr: message,
        exitCode: null,
        timedOut: /timed?\s*out/i.test(message),
      };
    }
  }

  async logs(runtime: StoredRuntime): Promise<{ stdout: string; stderr: string }> {
    if (runtime.processId === null) return { stdout: "", stderr: "" };
    try {
      const logs = await this.sandbox(runtime.descriptor.identity).getProcessLogs(
        runtime.processId,
      );
      return { stdout: logs.stdout, stderr: logs.stderr };
    } catch {
      return { stdout: "", stderr: "" };
    }
  }

  async materialize(
    runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
  ): Promise<{ filesWritten: number }> {
    const ticket = await this.stageMaterialization(runtime, artifact);
    return this.unpackMaterialization(runtime, artifact, ticket);
  }

  async materializeLayered(
    runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    layers: StoredRuntimeLayer[],
  ): Promise<{ filesWritten: number; layersMaterialized: number }> {
    const ticket = await this.stageLayeredMaterialization(runtime, artifact, layers);
    return this.unpackLayeredMaterialization(runtime, artifact, layers, ticket);
  }

  async stageMaterialization(
    runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
  ): Promise<RuntimeMaterializationTicket> {
    return this.stageAggregateRelease(
      runtime,
      artifact.envelope.sealedArtifactSha256,
      this.artifactSources(artifact),
    );
  }

  async unpackMaterialization(
    runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
    ticket: RuntimeMaterializationTicket,
    options?: RuntimeMaterializationOptions,
  ): Promise<{ filesWritten: number }> {
    const result = await this.unpackAggregateRelease(
      runtime,
      artifact.envelope.sealedArtifactSha256,
      this.artifactSources(artifact),
      ticket,
      {
        contentSha256: artifact.envelope.contentSha256,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        manifestRevision: artifact.envelope.manifestRevision,
      },
      0,
      options,
    );
    return { filesWritten: result.filesWritten };
  }

  async stageLayeredMaterialization(
    runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    layers: StoredRuntimeLayer[],
  ): Promise<RuntimeMaterializationTicket> {
    return this.stageAggregateRelease(
      runtime,
      artifact.envelope.sealedArtifactSha256,
      this.layeredArtifactSources(artifact, layers),
    );
  }

  async unpackLayeredMaterialization(
    runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    layers: StoredRuntimeLayer[],
    ticket: RuntimeMaterializationTicket,
    options?: RuntimeMaterializationOptions,
  ): Promise<{ filesWritten: number; layersMaterialized: number }> {
    return this.unpackAggregateRelease(
      runtime,
      artifact.envelope.sealedArtifactSha256,
      this.layeredArtifactSources(artifact, layers),
      ticket,
      {
        format: artifact.envelope.content.format,
        contentSha256: artifact.envelope.contentSha256,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        manifestRevision: artifact.envelope.manifestRevision,
        finalMergedReleaseSha256: artifact.envelope.content.finalMergedReleaseSha256,
        layers: artifact.envelope.content.layers.map((layer) => layer.descriptor.contentSha256),
      },
      artifact.envelope.content.layers.length,
      options,
    );
  }

  private artifactSources(artifact: StoredRuntimeArtifact): RuntimeAggregateSource[] {
    return [
      {
        bytes: artifact.envelope.content.payloadBytes,
        chunkBytes: artifact.envelope.content.chunkBytes,
        chunks: artifact.envelope.content.chunks,
        keyForChunk: (chunkIndex) =>
          artifactChunkKey(
            artifact.runtimeIdentity,
            artifact.envelope.sealedArtifactSha256,
            chunkIndex,
          ),
        files: artifact.envelope.content.files,
      },
    ];
  }

  private layeredArtifactSources(
    artifact: StoredRuntimeLayeredArtifact,
    layers: StoredRuntimeLayer[],
  ): RuntimeAggregateSource[] {
    const app = artifact.envelope.content.appArtifact;
    const sources: RuntimeAggregateSource[] = [
      {
        bytes: app.content.payloadBytes,
        chunkBytes: app.content.chunkBytes,
        chunks: app.content.chunks,
        keyForChunk: (chunkIndex) =>
          layeredArtifactAppChunkKey(
            artifact.runtimeIdentity,
            artifact.envelope.sealedArtifactSha256,
            chunkIndex,
          ),
        files: app.content.files,
      },
    ];
    for (const content of artifact.envelope.content.layers) {
      const layer = layers.find(
        (candidate) =>
          candidate.content.descriptor.contentSha256 === content.descriptor.contentSha256,
      );
      if (layer === undefined || layer.state !== "committed") {
        throw new Error("Committed dependency layer is unavailable");
      }
      if (content.descriptor.compression !== "none") {
        throw new Error("Dependency layer compression is unsupported");
      }
      sources.push({
        bytes: content.payloadBytes,
        chunkBytes: content.chunkBytes,
        chunks: content.chunks,
        expectedContentSha256: content.descriptor.contentSha256,
        keyForChunk: (chunkIndex) =>
          dependencyLayerChunkKey(layer.content.descriptor.contentSha256, chunkIndex),
        files: content.files.map((file) => ({
          ...file,
          path: `${content.descriptor.mountPath}/${file.path}`,
        })),
      });
    }
    return sources;
  }

  private async stageAggregateRelease(
    runtime: StoredRuntime,
    sealedArtifactSha256: string,
    sources: RuntimeAggregateSource[],
  ): Promise<RuntimeMaterializationTicket> {
    const scope = new RuntimeMaterializationRpcScope();
    const sandbox = scope.track(await this.configuredSandbox(runtime.descriptor.identity, false));
    const stageLeaseId = randomBytes(16).toString("hex");
    try {
      await consumeRuntimeMaterializationRpcResult(
        scope,
        sandbox.prepareRuntimeMaterialization(sealedArtifactSha256, stageLeaseId),
        () => undefined,
      );
      const payloads: RuntimeMaterializationPayload[] = [];
      for (let index = 0; index < sources.length; index += 1) {
        payloads.push(
          await this.transferAggregatePayload(
            scope,
            sandbox,
            sealedArtifactSha256,
            stageLeaseId,
            index,
            sources[index],
          ),
        );
      }
      return {
        payloadContentSha256s: payloads.map((payload) => payload.contentSha256),
        stageLeaseId,
      };
    } catch (error) {
      await this.cleanupRuntimeMaterializationAttempt(
        scope,
        sandbox,
        sealedArtifactSha256,
        stageLeaseId,
        sources.length,
      );
      throw error;
    } finally {
      scope.close();
    }
  }

  private async unpackAggregateRelease(
    runtime: StoredRuntime,
    sealedArtifactSha256: string,
    sources: RuntimeAggregateSource[],
    ticket: RuntimeMaterializationTicket,
    seal: RuntimeMaterializationManifest["seal"],
    layersMaterialized: number,
    options?: RuntimeMaterializationOptions,
  ): Promise<{ filesWritten: number; layersMaterialized: number }> {
    if (ticket.payloadContentSha256s.length !== sources.length) {
      throw new Error("Runtime materialization ticket does not match its payloads");
    }
    if (ticket.stageLeaseId === undefined || !/^[0-9a-f]{32}$/u.test(ticket.stageLeaseId)) {
      throw new Error("Runtime materialization ticket has no valid stage lease");
    }
    const payloads = sources.map((source, index) => {
      const contentSha256 = ticket.payloadContentSha256s[index];
      if (
        !/^[0-9a-f]{64}$/u.test(contentSha256) ||
        (source.expectedContentSha256 !== undefined &&
          source.expectedContentSha256 !== contentSha256)
      ) {
        throw new Error("Runtime materialization ticket failed integrity verification");
      }
      return { index, contentSha256, size: source.bytes };
    });
    const scope = new RuntimeMaterializationRpcScope();
    const sandbox = scope.track(await this.configuredSandbox(runtime.descriptor.identity, false));
    try {
      const files: RuntimeMaterializationFile[] = sources
        .flatMap((source, payloadIndex) => source.files.map((file) => ({ ...file, payloadIndex })))
        .sort((left, right) => compareUtf8(left.path, right.path));
      const request = await sealRuntimeMaterializationManifest({
        format: "nabu-runtime-materialization/v1",
        sealedArtifactSha256,
        payloads,
        files,
        seal,
      });
      if (options?.stagingAbortAfterFiles !== undefined) {
        request.stagingAbortAfterFiles = options.stagingAbortAfterFiles;
      }
      if (options?.stagingAbortReleaseCleanup !== undefined) {
        request.stagingAbortReleaseCleanup = options.stagingAbortReleaseCleanup;
      }
      if (options?.stagingAbortBeforeReleaseSwap !== undefined) {
        request.stagingAbortBeforeReleaseSwap = options.stagingAbortBeforeReleaseSwap;
      }
      if (options?.stagingHoldLockMs !== undefined) {
        request.stagingHoldLockMs = options.stagingHoldLockMs;
      }
      request.stageLeaseId = ticket.stageLeaseId;
      if (runtime.artifactSha256 !== null) {
        if (!/^[0-9a-f]{64}$/u.test(runtime.artifactSha256)) {
          throw new Error("Runtime rollback release identity is invalid");
        }
        if (runtime.artifactSha256 !== sealedArtifactSha256) {
          request.rollbackReleaseSha256 = runtime.artifactSha256;
        }
      }
      let result: {
        ok: true;
        filesWritten: number;
        bytesWritten: number;
        releasesRetained: number;
        releasesRemoved: number;
        leftoversRemoved: number;
      };
      try {
        result = await consumeRuntimeMaterializationRpcResult(
          scope,
          sandbox.materializeRuntimeAggregate(request),
          (materialized) => materialized,
        );
      } catch (error) {
        if (options?.stagingAbortAfterFiles !== undefined) {
          throw new StagingArtifactCommitOwnerLossError("mid-materialization");
        }
        throw error;
      }
      return { filesWritten: result.filesWritten, layersMaterialized };
    } finally {
      await this.cleanupRuntimeMaterializationAttempt(
        scope,
        sandbox,
        sealedArtifactSha256,
        ticket.stageLeaseId,
        sources.length,
      );
      scope.close();
    }
  }

  private async transferAggregatePayload(
    scope: RuntimeMaterializationRpcScope,
    sandbox: NabuflowSandbox,
    sealedArtifactSha256: string,
    stageLeaseId: string,
    index: number,
    source: RuntimeAggregateSource,
  ): Promise<RuntimeMaterializationPayload> {
    const transfer = verifiedRuntimePayloadStream(this.env.NABUFLOW_RUNTIME_ARTIFACTS, source);
    const stageRoot = runtimeMaterializationStageRoot(sealedArtifactSha256);
    const pendingPath = `${stageRoot}/${String(index).padStart(2, "0")}.${stageLeaseId}.pending`;
    await consumeRuntimeMaterializationRpcResult(
      scope,
      sandbox.writeFile(pendingPath, transfer.stream),
      (result) => {
        if (
          !result.success ||
          !("bytesWritten" in result) ||
          result.bytesWritten !== source.bytes
        ) {
          throw new Error("Runtime aggregate payload transfer is incomplete");
        }
      },
    );
    const contentSha256 = transfer.digest();
    if (
      source.expectedContentSha256 !== undefined &&
      source.expectedContentSha256 !== contentSha256
    ) {
      throw new Error("Runtime aggregate payload failed integrity verification");
    }
    const payload = { index, contentSha256, size: source.bytes };
    await consumeRuntimeMaterializationRpcResult(
      scope,
      sandbox.renameFile(
        pendingPath,
        runtimeMaterializationPayloadPath(sealedArtifactSha256, payload),
      ),
      () => undefined,
    );
    return payload;
  }

  private async cleanupRuntimeMaterializationAttempt(
    scope: RuntimeMaterializationRpcScope,
    sandbox: NabuflowSandbox,
    sealedArtifactSha256: string,
    stageLeaseId: string,
    payloadCount: number,
  ): Promise<void> {
    const stageRoot = runtimeMaterializationStageRoot(sealedArtifactSha256);
    const paths = [
      runtimeMaterializationLeasePath(sealedArtifactSha256, stageLeaseId),
      ...Array.from(
        { length: payloadCount },
        (_, index) => `${stageRoot}/${String(index).padStart(2, "0")}.${stageLeaseId}.pending`,
      ),
    ];
    try {
      await consumeRuntimeMaterializationRpcResult(
        scope,
        sandbox.exec(argvToCommandString(["rm", "-f", "--", ...paths]), {
          cwd: "/workspace",
          timeout: 30_000,
        }),
        () => undefined,
      );
    } catch (error) {
      // eslint-disable-next-line no-console -- an exact-path cleanup failure must remain observable
      console.error(
        JSON.stringify({
          event: "runtime.materialization.attempt_cleanup_failed",
          sealedArtifactSha256,
          error: error instanceof Error ? error.name : "UnknownError",
        }),
      );
    }
  }

  private sandbox(identity: string): NabuflowSandbox {
    return runtimeSandboxStub(this.env, identity);
  }

  private async configuredSandbox(identity: string, keepAlive?: boolean): Promise<NabuflowSandbox> {
    const sandbox = this.sandbox(identity);
    await sandbox.configure(
      runtimeSandboxConfiguration(identity, this.env.NABUFLOW_RUNTIME_SLEEP_AFTER),
    );
    if (keepAlive !== undefined) {
      await sandbox.setKeepAlive(keepAlive);
    }
    return sandbox;
  }
}

interface RuntimeAggregateSource {
  bytes: number;
  chunkBytes: number;
  chunks: string[];
  expectedContentSha256?: string;
  keyForChunk: (chunkIndex: number) => string;
  files: Array<{
    path: string;
    mode: 420 | 493;
    offset: number;
    size: number;
    sha256: string;
  }>;
}

type RuntimeRpcDisposable = { [Symbol.dispose]?: () => void };

export class RuntimeMaterializationRpcScope {
  private readonly resources: RuntimeRpcDisposable[] = [];
  private closed = false;

  track<T>(resource: T): T {
    if (
      typeof resource === "object" &&
      resource !== null &&
      typeof (resource as RuntimeRpcDisposable)[Symbol.dispose] === "function"
    ) {
      this.resources.push(resource as RuntimeRpcDisposable);
    }
    return resource;
  }

  dispose(resource: unknown): void {
    if (typeof resource !== "object" || resource === null) return;
    const disposable = resource as RuntimeRpcDisposable;
    const index = this.resources.lastIndexOf(disposable);
    if (index >= 0) this.resources.splice(index, 1);
    try {
      disposable[Symbol.dispose]?.();
    } catch {
      // Materialization teardown must continue after a best-effort RPC release.
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resource of this.resources.reverse()) {
      try {
        resource[Symbol.dispose]?.();
      } catch {
        // A cancellation must still release every remaining RPC capability.
      }
    }
    this.resources.length = 0;
  }
}

export async function consumeRuntimeMaterializationRpcResult<T, R>(
  scope: RuntimeMaterializationRpcScope,
  pending: Promise<T>,
  consume: (result: T) => R | Promise<R>,
): Promise<R> {
  const result = scope.track(await pending);
  try {
    return await consume(result);
  } finally {
    scope.dispose(result);
  }
}

function verifiedRuntimePayloadStream(
  bucket: R2Bucket,
  source: RuntimeAggregateSource,
): { stream: ReadableStream<Uint8Array>; digest(): string } {
  const aggregateHasher = createHash("sha256");
  let index = 0;
  let bytesRead = 0;
  let contentSha256: string | null = null;
  let failure: Error | null = null;
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        if (index >= source.chunks.length) {
          if (bytesRead !== source.bytes) {
            throw new Error("Runtime aggregate payload length is invalid");
          }
          contentSha256 = aggregateHasher.digest("hex");
          controller.close();
          return;
        }
        const chunkIndex = index;
        const object = await bucket.get(source.keyForChunk(chunkIndex));
        if (object === null) throw new Error("Runtime aggregate payload chunk is unavailable");
        const bytes = new Uint8Array(await object.arrayBuffer());
        const expectedLength = Math.min(
          source.chunkBytes,
          source.bytes - chunkIndex * source.chunkBytes,
        );
        if (
          expectedLength < 0 ||
          bytes.byteLength !== expectedLength ||
          (await sha256Hex(bytes)) !== source.chunks[chunkIndex]
        ) {
          throw new Error("Runtime aggregate payload chunk failed integrity verification");
        }
        aggregateHasher.update(bytes);
        bytesRead += bytes.byteLength;
        index += 1;
        controller.enqueue(bytes);
      } catch (error) {
        failure = error instanceof Error ? error : new Error("Runtime aggregate transfer failed");
        controller.error(failure);
      }
    },
    cancel() {
      canceled = true;
    },
  });
  return {
    stream,
    digest() {
      if (failure !== null) throw failure;
      if (canceled) throw new Error("Runtime aggregate payload transfer was canceled");
      if (contentSha256 === null) {
        throw new Error("Runtime aggregate payload transfer did not complete");
      }
      return contentSha256;
    },
  };
}

export function runtimeSandboxConfiguration(identity: string, sleepAfter: string) {
  return {
    sandboxName: { name: identity },
    sleepAfter,
    // Artifact materialization uses streamed writeFile. The Sandbox SDK defaults to HTTP,
    // whose file client rejects streams; RPC is required to carry the stream into the DO.
    transport: "rpc" as const,
  };
}

/**
 * Acquire the named tenant Sandbox Durable Object without the SDK's implicit configure call.
 * This helper is safe for metadata, probe, fetch, exec, and log reads: idFromName/get are
 * address resolution only and persist no sandbox policy.
 */
export function runtimeSandboxStub(env: WorkerBindings, identity: string): NabuflowSandbox {
  const durableObjectId = env.NABUFLOW_SANDBOX.idFromName(identity);
  return env.NABUFLOW_SANDBOX.get(durableObjectId) as unknown as NabuflowSandbox;
}

/** Preserve the Sandbox SDK's WebSocket port-routing behavior without invoking getSandbox. */
export function runtimeSandboxWebSocketConnect(
  sandbox: Pick<NabuflowSandbox, "fetch">,
  request: Request,
  port: number,
): Promise<Response> {
  if (!Number.isInteger(port) || port < 1024 || port > 65_535 || port === 3_000) {
    throw new Error("The runtime WebSocket port is invalid");
  }
  const headers = new Headers(request.headers);
  headers.set("cf-container-target-port", String(port));
  return sandbox.fetch(new Request(request, { headers }));
}

function releaseRootFor(sealedArtifactSha256: string): string {
  return `/workspace/.nabuflow/releases/${sealedArtifactSha256}`;
}

function releaseAppRoot(sealedArtifactSha256: string): string {
  return `${releaseRootFor(sealedArtifactSha256)}/app`;
}
