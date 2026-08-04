/** Fly adapter for the provider-neutral tenant runtime contract. */

import { lookup as dnsLookup } from "node:dns/promises";
import * as flyRuntime from "./container";
import * as flyLogs from "./container-logs";
import { logger } from "./logger";
import type {
  RuntimeCreateResult,
  RuntimeExecResult,
  RuntimeFile,
  RuntimeInfo,
  RuntimeInstallOptions,
  RuntimeLogLevel,
  RuntimeProductionOptions,
  RuntimeServiceOptions,
  RuntimeStatus,
  RuntimeSubsystemStatus,
  TenantRuntimeProvider,
} from "./tenant-runtime-provider";

const FLY_APP = process.env.FLY_APP_NAME ?? "mustaflow-containers";
const FLY_PROXY_HOSTNAME = `${FLY_APP}.fly.dev`;
const FLY_PROXY_REACHABILITY_TTL_MS = 30_000;

function toRuntimeInfo(info: flyRuntime.ContainerInfo | flyRuntime.ProdContainerInfo): RuntimeInfo {
  if ("prodContainerId" in info) {
    return {
      runtimeId: info.prodContainerId,
      status: info.status,
      endpoint: info.containerUrl,
      servicePort: info.servicePort,
    };
  }
  return {
    runtimeId: info.containerId,
    status: info.status,
    endpoint: info.containerUrl,
    servicePort: info.servicePort,
  };
}

export class FlyRuntimeProvider implements TenantRuntimeProvider {
  readonly providerId = "fly";

  private gatewayReachabilityCache: { reachable: boolean; checkedAt: number } | null = null;
  private gatewayReachabilityProbe: Promise<boolean> | null = null;

  hasCredentials(): boolean {
    return flyRuntime.hasContainerLayerCredentials();
  }

  isAvailable(): Promise<boolean> {
    return flyRuntime.isContainerLayerConfigured();
  }

  runSelfCheck(): Promise<RuntimeSubsystemStatus> {
    return flyRuntime.runContainerSelfCheck();
  }

  getSubsystemStatus(): RuntimeSubsystemStatus | null {
    return flyRuntime.getContainerSubsystemStatus();
  }

  ensureInfrastructure(): Promise<void> {
    return flyRuntime.ensureFlyApp();
  }

  async create(
    projectId: number,
    stack?: string | null,
    environment?: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<RuntimeCreateResult> {
    const result = await flyRuntime.createContainer(projectId, stack, environment, options);
    if (!result || "error" in result) return result;
    return toRuntimeInfo(result);
  }

  start(runtimeId: string, projectId: number): Promise<boolean> {
    return flyRuntime.startContainer(runtimeId, projectId);
  }

  stop(runtimeId: string, projectId: number): Promise<boolean> {
    return flyRuntime.stopContainer(runtimeId, projectId);
  }

  destroy(runtimeId: string, projectId: number): Promise<boolean> {
    return flyRuntime.destroyContainer(runtimeId, projectId);
  }

  status(runtimeId: string): Promise<RuntimeStatus> {
    return flyRuntime.getContainerStatus(runtimeId);
  }

  async exec(
    runtimeId: string,
    command: string[],
    projectId: number,
    workdir?: string,
  ): Promise<RuntimeExecResult> {
    const result =
      workdir === undefined
        ? await flyRuntime.execInContainer(runtimeId, command, projectId)
        : await flyRuntime.execInContainer(runtimeId, command, projectId, workdir);
    return {
      ok: result.ok,
      output: result.output,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      runtimeRestarted: result.machineWoken,
    };
  }

  installDependencies(
    runtimeId: string,
    projectId: number,
    options?: RuntimeInstallOptions,
  ): Promise<{ ok: boolean; output: string }> {
    return flyRuntime.npmInstallInBackground(runtimeId, projectId, {
      maxAttempts: options?.maxAttempts,
      wallClockCapMs: options?.wallClockCapMs,
      signal: options?.signal,
      onMachineRestarted: options?.onRuntimeRestarted,
    });
  }

  writeFile(runtimeId: string, path: string, content: string, projectId: number): Promise<boolean> {
    return flyRuntime.writeFileToContainer(runtimeId, path, content, projectId);
  }

  syncFiles(
    runtimeId: string,
    projectId: number,
    files: RuntimeFile[],
    throwIfUnconfigured?: boolean,
  ): Promise<void> {
    return flyRuntime.syncFilesToContainer(runtimeId, projectId, files, throwIfUnconfigured);
  }

  restoreFiles(
    runtimeId: string,
    projectId: number,
    files: RuntimeFile[],
    throwIfUnconfigured?: boolean,
  ): Promise<void> {
    return this.syncFiles(runtimeId, projectId, files, throwIfUnconfigured);
  }

  updateEnvironment(
    runtimeId: string,
    projectId: number,
    environment: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<boolean> {
    return flyRuntime.updateContainerEnv(runtimeId, projectId, environment, options);
  }

  restartWithProjectEnvironment(
    projectId: number,
    environment: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<void> {
    return flyRuntime.restartContainerWithSecrets(projectId, environment, options);
  }

  ensureAwake(
    runtimeId: string,
    projectId: number,
    endpoint: string | null,
    timeoutSeconds?: number,
  ): Promise<{ ok: boolean; message?: string }> {
    return flyRuntime.ensureContainerAwake(runtimeId, projectId, endpoint, timeoutSeconds);
  }

  async provision(
    projectId: number,
    files: RuntimeFile[],
    environment?: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<RuntimeInfo | null> {
    const result = await flyRuntime.provisionContainer(projectId, files, environment, options);
    return result ? toRuntimeInfo(result) : null;
  }

  hibernate(projectId: number): Promise<void> {
    return flyRuntime.hibernateContainer(projectId);
  }

  async createProduction(
    projectId: number,
    environment: Record<string, string>,
    runtime?: string | null,
    options?: RuntimeProductionOptions,
  ): Promise<RuntimeInfo | null> {
    const result = await flyRuntime.createProductionContainer(
      projectId,
      environment,
      runtime,
      options,
    );
    return result ? toRuntimeInfo(result) : null;
  }

  async deployProduction(
    projectId: number,
    previousRuntimeId: string | null,
    files: RuntimeFile[],
    environment: Record<string, string>,
    options?: RuntimeProductionOptions,
  ): Promise<RuntimeInfo | null> {
    const result = await flyRuntime.deployProductionContainer(
      projectId,
      previousRuntimeId,
      files,
      environment,
      options,
    );
    return result ? toRuntimeInfo(result) : null;
  }

  configureIdleBehavior(
    runtimeId: string,
    projectId: number,
    behavior: "stop" | "off",
  ): Promise<void> {
    return flyRuntime.patchMachineAutostop(runtimeId, projectId, behavior);
  }

  startHealthService(runtimeId: string, projectId: number): Promise<void> {
    return flyRuntime.startContainerHealthServer(runtimeId, projectId);
  }

  stopHealthService(runtimeId: string, projectId: number): Promise<void> {
    return flyRuntime.stopContainerHealthServer(runtimeId, projectId);
  }

  startKeepalive(endpoint: string, projectId: number): () => void {
    return flyRuntime.startContainerKeepalive(endpoint, projectId);
  }

  async health(endpoint: string, timeoutSeconds: number): Promise<boolean> {
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(endpoint, { signal: AbortSignal.timeout(5_000) });
        if (response.ok) return true;
      } catch {
        // Preserve the existing production-runtime health polling behavior.
      }
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
    return false;
  }

  resolveEndpoint(runtimeId: string): string {
    return `https://${FLY_PROXY_HOSTNAME}/container/${runtimeId}`;
  }

  getGatewayHostname(): string {
    return FLY_PROXY_HOSTNAME;
  }

  getGatewayLabel(): string {
    return "Fly.io proxy";
  }

  isGatewayReachable(): Promise<boolean> {
    const now = Date.now();
    if (
      this.gatewayReachabilityCache &&
      now - this.gatewayReachabilityCache.checkedAt < FLY_PROXY_REACHABILITY_TTL_MS
    ) {
      return Promise.resolve(this.gatewayReachabilityCache.reachable);
    }
    if (this.gatewayReachabilityProbe) return this.gatewayReachabilityProbe;

    this.gatewayReachabilityProbe = dnsLookup(FLY_PROXY_HOSTNAME)
      .then(() => {
        this.gatewayReachabilityCache = { reachable: true, checkedAt: Date.now() };
        logger.info(
          { hostname: FLY_PROXY_HOSTNAME },
          "Fly proxy hostname resolved - agentic preview proxy enabled",
        );
        return true;
      })
      .catch((error: unknown) => {
        this.gatewayReachabilityCache = { reachable: false, checkedAt: Date.now() };
        logger.info(
          {
            hostname: FLY_PROXY_HOSTNAME,
            code: (error as NodeJS.ErrnoException).code,
          },
          "Fly proxy hostname not reachable - agentic preview proxy disabled in this environment",
        );
        return false;
      })
      .finally(() => {
        this.gatewayReachabilityProbe = null;
      });
    return this.gatewayReachabilityProbe;
  }

  mapErrorToMessage(raw: string): string {
    return flyRuntime.mapFlyErrorToMessage(raw);
  }

  recordLog(projectId: number, level: RuntimeLogLevel, message: string): Promise<void> {
    return flyLogs.recordContainerLog(projectId, level, message);
  }

  startLogStream(projectId: number, runtimeId: string): void {
    flyLogs.ensureContainerLogTailer(projectId, runtimeId);
  }

  stopLogStream(projectId: number): void {
    flyLogs.stopContainerLogTailer(projectId);
  }

  resumeLogStreamsOnBoot(): Promise<void> {
    return flyLogs.resumeContainerLogTailersOnBoot();
  }
}
