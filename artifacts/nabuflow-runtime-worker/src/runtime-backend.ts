import { ContainerProxy as SandboxContainerProxy, Sandbox, getSandbox } from "@cloudflare/sandbox";
import { argvToCommandString, sha256Hex } from "@workspace/tenant-runtime-contracts";
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

export const DOORMAN_HOST = "doorman.staging.nabuflow.internal";
const TENANT_PROCESS_ID = "tenant-service";

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
}

export interface RuntimeBackend {
  start(runtime: StoredRuntime): Promise<BackendStartResult>;
  stop(runtime: StoredRuntime): Promise<void>;
  destroy(runtime: StoredRuntime): Promise<void>;
  status(runtime: StoredRuntime): Promise<BackendStatusResult>;
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
    if (runtime.processId === null) return { running: false, lastError: null };
    try {
      const process = await this.sandbox(runtime.descriptor.identity, false).getProcess(
        runtime.processId,
      );
      if (process === null) return { running: false, lastError: "Tenant service is not running" };
      const status = await process.getStatus();
      return {
        running: status === "running" || status === "starting",
        lastError:
          status === "failed" || status === "error"
            ? `Tenant service process ended with status ${status}`
            : null,
      };
    } catch (error) {
      return {
        running: false,
        lastError: error instanceof Error ? error.message : "Runtime status check failed",
      };
    }
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
      const logs = await this.sandbox(runtime.descriptor.identity, false).getProcessLogs(
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
    const sandbox = this.sandbox(runtime.descriptor.identity, true);
    const releaseRoot = releaseRootFor(artifact.envelope.sealedArtifactSha256);
    const appRoot = `${releaseRoot}/app`;
    await sandbox.killAllProcesses();
    const removed = await sandbox.exec(argvToCommandString(["rm", "-rf", "--", releaseRoot]), {
      cwd: "/workspace",
      timeout: 30_000,
    });
    if (!removed.success) throw new Error("Previous artifact release could not be cleared");
    await sandbox.mkdir(appRoot, { recursive: true });

    for (const file of artifact.envelope.content.files) {
      const bytes = await this.readArtifactRange(artifact, file.offset, file.size);
      if ((await sha256Hex(bytes)) !== file.sha256) {
        throw new Error("Materialized artifact file failed integrity verification");
      }
      const target = `${appRoot}/${file.path}`;
      const parent = target.slice(0, target.lastIndexOf("/"));
      await sandbox.mkdir(parent, { recursive: true });
      await sandbox.writeFile(
        target,
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
      );
      if (file.mode === 0o755) {
        const result = await sandbox.exec(argvToCommandString(["chmod", "755", "--", target]), {
          cwd: appRoot,
          timeout: 30_000,
        });
        if (!result.success) throw new Error("Artifact executable mode could not be applied");
      }
    }
    await sandbox.writeFile(
      `${releaseRoot}/seal.json`,
      JSON.stringify({
        contentSha256: artifact.envelope.contentSha256,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        manifestRevision: artifact.envelope.manifestRevision,
      }),
    );
    return { filesWritten: artifact.envelope.content.files.length };
  }

  async materializeLayered(
    runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    layers: StoredRuntimeLayer[],
  ): Promise<{ filesWritten: number; layersMaterialized: number }> {
    const sandbox = this.sandbox(runtime.descriptor.identity, true);
    const releaseRoot = releaseRootFor(artifact.envelope.sealedArtifactSha256);
    const appRoot = `${releaseRoot}/app`;
    await sandbox.killAllProcesses();
    const removed = await sandbox.exec(argvToCommandString(["rm", "-rf", "--", releaseRoot]), {
      cwd: "/workspace",
      timeout: 30_000,
    });
    if (!removed.success) throw new Error("Previous layered release could not be cleared");
    await sandbox.mkdir(appRoot, { recursive: true });

    const app = artifact.envelope.content.appArtifact;
    for (const file of app.content.files) {
      const bytes = await this.readLayeredAppRange(artifact, file.offset, file.size);
      if ((await sha256Hex(bytes)) !== file.sha256) {
        throw new Error("Materialized layered app file failed integrity verification");
      }
      await this.writeReleaseFile(sandbox, appRoot, file.path, file.mode, bytes);
    }

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
      const payload = await this.readLayerRange(layer, 0, content.payloadBytes);
      if ((await sha256Hex(payload)) !== content.descriptor.contentSha256) {
        throw new Error("Dependency layer content failed integrity verification");
      }
      for (const file of content.files) {
        const bytes = payload.slice(file.offset, file.offset + file.size);
        if ((await sha256Hex(bytes)) !== file.sha256) {
          throw new Error("Materialized dependency file failed integrity verification");
        }
        await this.writeReleaseFile(
          sandbox,
          appRoot,
          `${content.descriptor.mountPath}/${file.path}`,
          file.mode,
          bytes,
        );
      }
    }
    await sandbox.writeFile(
      `${releaseRoot}/seal.json`,
      JSON.stringify({
        format: artifact.envelope.content.format,
        contentSha256: artifact.envelope.contentSha256,
        sealedArtifactSha256: artifact.envelope.sealedArtifactSha256,
        manifestRevision: artifact.envelope.manifestRevision,
        finalMergedReleaseSha256: artifact.envelope.content.finalMergedReleaseSha256,
        layers: artifact.envelope.content.layers.map((layer) => layer.descriptor.contentSha256),
      }),
    );
    return {
      filesWritten:
        app.content.files.length +
        artifact.envelope.content.layers.reduce((total, layer) => total + layer.files.length, 0),
      layersMaterialized: artifact.envelope.content.layers.length,
    };
  }

  private async readArtifactRange(
    artifact: StoredRuntimeArtifact,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const absoluteOffset = offset + written;
      const chunkIndex = Math.floor(absoluteOffset / artifact.envelope.content.chunkBytes);
      const chunkOffset = absoluteOffset % artifact.envelope.content.chunkBytes;
      const readLength = Math.min(
        length - written,
        artifact.envelope.content.chunkBytes - chunkOffset,
      );
      const object = await this.env.NABUFLOW_RUNTIME_ARTIFACTS.get(
        artifactChunkKey(
          artifact.runtimeIdentity,
          artifact.envelope.sealedArtifactSha256,
          chunkIndex,
        ),
        { range: { offset: chunkOffset, length: readLength } },
      );
      if (object === null) throw new Error("Committed artifact chunk is unavailable");
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== readLength) throw new Error("Artifact chunk range is incomplete");
      output.set(bytes, written);
      written += bytes.byteLength;
    }
    return output;
  }

  private async readLayeredAppRange(
    artifact: StoredRuntimeLayeredArtifact,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    const app = artifact.envelope.content.appArtifact.content;
    return this.readR2Range(
      offset,
      length,
      app.chunkBytes,
      (chunkIndex) =>
        layeredArtifactAppChunkKey(
          artifact.runtimeIdentity,
          artifact.envelope.sealedArtifactSha256,
          chunkIndex,
        ),
      "Layered app chunk is unavailable",
    );
  }

  private async readLayerRange(
    layer: StoredRuntimeLayer,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    return this.readR2Range(
      offset,
      length,
      layer.content.chunkBytes,
      (chunkIndex) => dependencyLayerChunkKey(layer.content.descriptor.contentSha256, chunkIndex),
      "Dependency layer chunk is unavailable",
    );
  }

  private async readR2Range(
    offset: number,
    length: number,
    chunkBytes: number,
    keyForChunk: (chunkIndex: number) => string,
    missingMessage: string,
  ): Promise<Uint8Array> {
    const output = new Uint8Array(length);
    let written = 0;
    while (written < length) {
      const absoluteOffset = offset + written;
      const chunkIndex = Math.floor(absoluteOffset / chunkBytes);
      const chunkOffset = absoluteOffset % chunkBytes;
      const readLength = Math.min(length - written, chunkBytes - chunkOffset);
      const object = await this.env.NABUFLOW_RUNTIME_ARTIFACTS.get(keyForChunk(chunkIndex), {
        range: { offset: chunkOffset, length: readLength },
      });
      if (object === null) throw new Error(missingMessage);
      const bytes = new Uint8Array(await object.arrayBuffer());
      if (bytes.byteLength !== readLength) throw new Error("Dependency layer range is incomplete");
      output.set(bytes, written);
      written += bytes.byteLength;
    }
    return output;
  }

  private async writeReleaseFile(
    sandbox: NabuflowSandbox,
    appRoot: string,
    relativePath: string,
    mode: 420 | 493,
    bytes: Uint8Array,
  ): Promise<void> {
    const target = `${appRoot}/${relativePath}`;
    const parent = target.slice(0, target.lastIndexOf("/"));
    await sandbox.mkdir(parent, { recursive: true });
    await sandbox.writeFile(
      target,
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
    if (mode === 0o755) {
      const result = await sandbox.exec(argvToCommandString(["chmod", "755", "--", target]), {
        cwd: appRoot,
        timeout: 30_000,
      });
      if (!result.success) throw new Error("Dependency executable mode could not be applied");
    }
  }

  private sandbox(identity: string, keepAlive: boolean): NabuflowSandbox {
    return getSandbox(
      this.env.NABUFLOW_SANDBOX,
      identity,
      runtimeSandboxOptions(keepAlive, this.env.NABUFLOW_RUNTIME_SLEEP_AFTER),
    ) as NabuflowSandbox;
  }
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

function releaseRootFor(sealedArtifactSha256: string): string {
  return `/workspace/.nabuflow/releases/${sealedArtifactSha256}`;
}

function releaseAppRoot(sealedArtifactSha256: string): string {
  return `${releaseRootFor(sealedArtifactSha256)}/app`;
}
