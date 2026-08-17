import { ContainerProxy as SandboxContainerProxy, Sandbox, getSandbox } from "@cloudflare/sandbox";
import { createHash } from "node:crypto";
import {
  CAPABILITY_DOORMAN_HOST,
  RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS,
  RUNTIME_RECONCILIATION_OBSERVATION_TIMEOUT_MS,
  TENANT_RUNTIME_MODE_ENV,
  argvToCommandString,
  compareUtf8,
  sha256Hex,
} from "@workspace/tenant-runtime-contracts";
import type { ExecRuntimeRequest } from "@workspace/tenant-runtime-contracts";
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
  RUNTIME_RELEASE_ROOT,
  type RuntimeMaterializationFile,
  type RuntimeMaterializationManifest,
  type RuntimeMaterializationPayload,
  type RuntimeMaterializationRequest,
  runtimeMaterializationPayloadPath,
  runtimeMaterializationStageRoot,
  sealRuntimeMaterializationManifest,
  verifyRuntimeMaterializationRequest,
} from "./runtime-materialization";

export const DOORMAN_HOST = CAPABILITY_DOORMAN_HOST;
const TENANT_PROCESS_ID = "tenant-service";
export const RUNTIME_AVAILABILITY_TIMEOUT_MS = RUNTIME_RECONCILIATION_OBSERVATION_TIMEOUT_MS;

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

  async prepareRuntimeMaterialization(sealedArtifactSha256: string): Promise<{ ok: true }> {
    const stageRoot = runtimeMaterializationStageRoot(sealedArtifactSha256);
    const scope = new RuntimeMaterializationRpcScope();
    try {
      await consumeRuntimeMaterializationRpcResult(
        scope,
        this.exec(
          argvToCommandString(["sh", "-c", 'rm -rf -- "$1" && mkdir -p -- "$1"', "sh", stageRoot]),
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

  async materializeRuntimeAggregate(
    request: RuntimeMaterializationRequest,
  ): Promise<{ ok: true; filesWritten: number; bytesWritten: number }> {
    const manifest = await verifyRuntimeMaterializationRequest(request);
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
        (output as { filesWritten: number }).filesWritten !== manifest.files.length
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
          durationMs: Date.now() - startedAt,
        }),
      );
      return {
        ok: true,
        filesWritten: manifest.files.length,
        bytesWritten: (output as { bytesWritten: number }).bytesWritten,
      };
    } finally {
      try {
        await consumeRuntimeMaterializationRpcResult(
          scope,
          this.exec(argvToCommandString(["rm", "-rf", "--", stageRoot]), {
            cwd: "/workspace",
            timeout: 30_000,
          }),
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
}

export interface RuntimeMaterializationTicket {
  payloadContentSha256s: string[];
}

export interface RuntimeMaterializationOptions {
  /** Staging-only live owner-loss probe; production callers never set it. */
  stagingAbortAfterFiles?: number;
}

export interface RuntimeBackend {
  start(runtime: StoredRuntime): Promise<BackendStartResult>;
  stop(runtime: StoredRuntime): Promise<void>;
  destroy(runtime: StoredRuntime): Promise<void>;
  status(runtime: StoredRuntime): Promise<BackendStatusResult>;
  availability(runtime: StoredRuntime): Promise<BackendAvailabilityResult>;
  reconcile(runtime: StoredRuntime): Promise<BackendReconciliationResult>;
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

export class CloudflareSandboxBackend implements RuntimeBackend {
  constructor(private readonly env: WorkerBindings) {}

  async start(runtime: StoredRuntime): Promise<BackendStartResult> {
    const sandbox = this.sandbox(runtime.descriptor.identity, true);
    await sandbox.setOutboundByHost(DOORMAN_HOST, "capabilityDoorman");
    await sandbox.setKeepAlive(true);
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
    const sandbox = this.sandbox(runtime.descriptor.identity, false);
    await sandbox.killAllProcesses();
    await sandbox.setKeepAlive(false);
    await sandbox.stop();
  }

  async destroy(runtime: StoredRuntime): Promise<void> {
    await this.sandbox(runtime.descriptor.identity, false).destroy();
  }

  async status(runtime: StoredRuntime): Promise<BackendStatusResult> {
    if (runtime.processId === null) {
      return { running: false, lastError: null, cause: "process_missing" };
    }
    try {
      const process = await this.sandbox(
        runtime.descriptor.identity,
        runtimeReadKeepsContainerAlive(runtime.descriptor.status),
      ).getProcess(runtime.processId);
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

    let signal: AbortSignal;
    let request: Request;
    try {
      signal = AbortSignal.timeout(RUNTIME_AVAILABILITY_TIMEOUT_MS);
      request = new Request(
        new URL(runtime.manifest.healthPath, "https://tenant.runtime.invalid"),
        {
          method: "GET",
          redirect: "manual",
          signal,
        },
      );
    } catch {
      return {
        ready: false,
        stage: "health",
        cause: "health_pre_dispatch",
        status: null,
      };
    }
    try {
      const response = await this.sandbox(runtime.descriptor.identity, true).containerFetch(
        request,
        runtime.manifest.servicePort,
      );
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

  async reconcile(runtime: StoredRuntime): Promise<BackendReconciliationResult> {
    // Reconciliation is the only path allowed to recover the platform-owned process
    // identity after a stale descriptor lost it. Ordinary metadata reads never probe.
    const candidate = structuredClone(runtime);
    candidate.processId = TENANT_PROCESS_ID;
    for (
      let attempt = 1;
      attempt <= RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS;
      attempt += 1
    ) {
      const observation = await this.availability(candidate);
      const ambiguous =
        observation.cause === "health_timeout" ||
        observation.cause === "health_transport" ||
        observation.cause === "process_check_failed";
      if (!ambiguous || attempt === RUNTIME_RECONCILIATION_MAX_AMBIGUOUS_OBSERVATIONS) {
        return {
          ...observation,
          attempts: attempt,
          conclusive: !ambiguous,
          processId: observation.ready ? TENANT_PROCESS_ID : null,
        };
      }
    }
    throw new Error("Runtime reconciliation observation budget was not applied");
  }

  async exec(runtime: StoredRuntime, request: ExecRuntimeRequest): Promise<BackendExecResult> {
    try {
      const result = await this.sandbox(runtime.descriptor.identity, true).exec(
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
      const keepAlive = runtimeReadKeepsContainerAlive(runtime.descriptor.status);
      const logs = await this.sandbox(runtime.descriptor.identity, keepAlive).getProcessLogs(
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
    const sandbox = scope.track(this.sandbox(runtime.descriptor.identity, true));
    try {
      await consumeRuntimeMaterializationRpcResult(
        scope,
        sandbox.killAllProcesses(),
        () => undefined,
      );
      await consumeRuntimeMaterializationRpcResult(
        scope,
        sandbox.prepareRuntimeMaterialization(sealedArtifactSha256),
        () => undefined,
      );
      const payloads: RuntimeMaterializationPayload[] = [];
      for (let index = 0; index < sources.length; index += 1) {
        payloads.push(
          await this.transferAggregatePayload(
            scope,
            sandbox,
            sealedArtifactSha256,
            index,
            sources[index],
          ),
        );
      }
      return { payloadContentSha256s: payloads.map((payload) => payload.contentSha256) };
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
    const sandbox = scope.track(this.sandbox(runtime.descriptor.identity, true));
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
      let result: { ok: true; filesWritten: number; bytesWritten: number };
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
      scope.close();
    }
  }

  private async transferAggregatePayload(
    scope: RuntimeMaterializationRpcScope,
    sandbox: NabuflowSandbox,
    sealedArtifactSha256: string,
    index: number,
    source: RuntimeAggregateSource,
  ): Promise<RuntimeMaterializationPayload> {
    const transfer = verifiedRuntimePayloadStream(this.env.NABUFLOW_RUNTIME_ARTIFACTS, source);
    const stageRoot = runtimeMaterializationStageRoot(sealedArtifactSha256);
    const pendingPath = `${stageRoot}/${String(index).padStart(2, "0")}.pending`;
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

  private sandbox(identity: string, keepAlive: boolean): NabuflowSandbox {
    return getSandbox(
      this.env.NABUFLOW_SANDBOX,
      identity,
      runtimeSandboxOptions(keepAlive, this.env.NABUFLOW_RUNTIME_SLEEP_AFTER),
    ) as NabuflowSandbox;
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

export function runtimeSandboxOptions(keepAlive: boolean, sleepAfter: string) {
  return {
    keepAlive,
    sleepAfter,
    enableDefaultSession: true,
    // Artifact materialization uses streamed writeFile. The Sandbox SDK defaults to HTTP,
    // whose file client rejects streams; RPC is required to carry the stream into the DO.
    transport: "rpc" as const,
  };
}

export function runtimeReadKeepsContainerAlive(
  status: StoredRuntime["descriptor"]["status"],
): boolean {
  return status === "running" || status === "starting";
}

function releaseRootFor(sealedArtifactSha256: string): string {
  return `/workspace/.nabuflow/releases/${sealedArtifactSha256}`;
}

function releaseAppRoot(sealedArtifactSha256: string): string {
  return `${releaseRootFor(sealedArtifactSha256)}/app`;
}
