/**
 * Application-facing tenant-runtime facade.
 *
 * The exported compatibility functions preserve existing call signatures and
 * response shapes while every operation is dispatched through the neutral
 * TenantRuntimeProvider contract. Existing persistence fields are intentionally
 * translated here until their separately-scoped schema migration.
 */

import { FlyRuntimeProvider } from "./fly-runtime-provider";
import { CloudflareRuntimeProvider } from "./cloudflare-runtime-provider";
import { parseTenantRuntimeConfig } from "@workspace/tenant-runtime-contracts";
import { PartialConfigRuntimeProvider } from "./partial-config-runtime-provider";
import type {
  RuntimeFile,
  RuntimeInstallOptions,
  RuntimeLogLevel,
  RuntimeProductionOptions,
  RuntimeServiceOptions,
  TenantRuntimeProvider,
} from "./tenant-runtime-provider";

export function createTenantRuntimeProvider(
  environment: Record<string, string | undefined> = process.env,
) {
  const config = parseTenantRuntimeConfig(environment);
  if (config.partialFly) {
    return new PartialConfigRuntimeProvider("fly", config.partialFly.missingBindings);
  }
  if (config.partialCloudflare) {
    return new PartialConfigRuntimeProvider("cloudflare", config.partialCloudflare.missingBindings);
  }
  return config.provider === "cloudflare"
    ? new CloudflareRuntimeProvider(config.cloudflare!)
    : new FlyRuntimeProvider();
}

export const tenantRuntimeProvider = createTenantRuntimeProvider();

export const hasContainerLayerCredentials = (): boolean => tenantRuntimeProvider.hasCredentials();
export const isContainerLayerConfigured = (): Promise<boolean> =>
  tenantRuntimeProvider.isAvailable();
export const runContainerSelfCheck = () => tenantRuntimeProvider.runSelfCheck();
export const getContainerSubsystemStatus = () => tenantRuntimeProvider.getSubsystemStatus();
export const getTenantRuntimeConfigurationStatus = () =>
  tenantRuntimeProvider instanceof PartialConfigRuntimeProvider
    ? {
        status: "partial-config" as const,
        missingBindings: [...tenantRuntimeProvider.missingBindings],
      }
    : { status: "complete" as const, missingBindings: [] };
export const ensureTenantRuntimeInfrastructure = (
  provider: TenantRuntimeProvider,
): Promise<void> =>
  provider instanceof PartialConfigRuntimeProvider
    ? Promise.resolve()
    : provider.ensureInfrastructure();
export const ensureFlyApp = (): Promise<void> =>
  ensureTenantRuntimeInfrastructure(tenantRuntimeProvider);

export async function createContainer(
  projectId: number,
  stack?: string | null,
  environment?: Record<string, string>,
  options?: RuntimeServiceOptions,
) {
  const result = await tenantRuntimeProvider.create(projectId, stack, environment, options);
  if (!result || "error" in result) return result;
  return {
    containerId: result.runtimeId,
    status: result.status,
    containerUrl: result.endpoint,
    servicePort: result.servicePort,
  };
}

export const startContainer = (runtimeId: string, projectId: number) =>
  tenantRuntimeProvider.start(runtimeId, projectId);
export const stopContainer = (runtimeId: string, projectId: number) =>
  tenantRuntimeProvider.stop(runtimeId, projectId);
export const destroyContainer = (runtimeId: string, projectId: number) =>
  tenantRuntimeProvider.destroy(runtimeId, projectId);
export const getContainerStatus = (runtimeId: string) => tenantRuntimeProvider.status(runtimeId);

export async function execInContainer(
  runtimeId: string,
  command: string[],
  projectId: number,
  workdir?: string,
) {
  const result = await tenantRuntimeProvider.exec(runtimeId, command, projectId, workdir);
  return {
    ok: result.ok,
    output: result.output,
    stdout: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    machineWoken: result.runtimeRestarted,
  };
}

export type NpmInstallOptions = Omit<RuntimeInstallOptions, "onRuntimeRestarted"> & {
  onMachineRestarted?: () => Promise<void>;
};

export const npmInstallInBackground = (
  runtimeId: string,
  projectId: number,
  options?: NpmInstallOptions,
) =>
  tenantRuntimeProvider.installDependencies(runtimeId, projectId, {
    maxAttempts: options?.maxAttempts,
    wallClockCapMs: options?.wallClockCapMs,
    signal: options?.signal,
    onRuntimeRestarted: options?.onMachineRestarted,
  });

export const writeFileToContainer = (
  runtimeId: string,
  path: string,
  content: string,
  projectId: number,
) => tenantRuntimeProvider.writeFile(runtimeId, path, content, projectId);

export const syncFilesToContainer = (
  runtimeId: string,
  projectId: number,
  files: RuntimeFile[],
  throwIfUnconfigured?: boolean,
) => tenantRuntimeProvider.syncFiles(runtimeId, projectId, files, throwIfUnconfigured);

export const updateContainerEnv = (
  runtimeId: string,
  projectId: number,
  environment: Record<string, string>,
  options?: RuntimeServiceOptions,
) => tenantRuntimeProvider.updateEnvironment(runtimeId, projectId, environment, options);

export const restartContainerWithSecrets = (
  projectId: number,
  environment: Record<string, string>,
  options?: RuntimeServiceOptions,
) => tenantRuntimeProvider.restartWithProjectEnvironment(projectId, environment, options);

export const ensureContainerAwake = (
  runtimeId: string,
  projectId: number,
  endpoint: string | null,
  timeoutSeconds?: number,
) => tenantRuntimeProvider.ensureAwake(runtimeId, projectId, endpoint, timeoutSeconds);

export const mapFlyErrorToMessage = (raw: string): string =>
  tenantRuntimeProvider.mapErrorToMessage(raw);

export async function provisionContainer(
  projectId: number,
  files: RuntimeFile[],
  environment?: Record<string, string>,
  options?: RuntimeServiceOptions,
) {
  const result = await tenantRuntimeProvider.provision(projectId, files, environment, options);
  if (!result) return null;
  return {
    containerId: result.runtimeId,
    status: result.status,
    containerUrl: result.endpoint,
    servicePort: result.servicePort,
  };
}

export const hibernateContainer = (projectId: number) => tenantRuntimeProvider.hibernate(projectId);

export async function createProductionContainer(
  projectId: number,
  environment: Record<string, string>,
  runtime?: string | null,
  options?: RuntimeProductionOptions,
) {
  const result = await tenantRuntimeProvider.createProduction(
    projectId,
    environment,
    runtime,
    options,
  );
  if (!result) return null;
  return {
    prodContainerId: result.runtimeId,
    containerUrl: result.endpoint,
    status: result.status,
    servicePort: result.servicePort,
  };
}

export async function deployProductionContainer(
  projectId: number,
  previousRuntimeId: string | null,
  files: RuntimeFile[],
  environment: Record<string, string>,
  options?: RuntimeProductionOptions,
) {
  const result = await tenantRuntimeProvider.deployProduction(
    projectId,
    previousRuntimeId,
    files,
    environment,
    options,
  );
  if (!result) return null;
  return {
    prodContainerId: result.runtimeId,
    containerUrl: result.endpoint,
    status: result.status,
    servicePort: result.servicePort,
  };
}

export const patchMachineAutostop = (
  runtimeId: string,
  projectId: number,
  behavior: "stop" | "off",
) => tenantRuntimeProvider.configureIdleBehavior(runtimeId, projectId, behavior);

export const startContainerHealthServer = (runtimeId: string, projectId: number) =>
  tenantRuntimeProvider.startHealthService(runtimeId, projectId);
export const stopContainerHealthServer = (runtimeId: string, projectId: number) =>
  tenantRuntimeProvider.stopHealthService(runtimeId, projectId);
export const startContainerKeepalive = (endpoint: string, projectId: number) =>
  tenantRuntimeProvider.startKeepalive(endpoint, projectId);

export const recordContainerLog = (projectId: number, level: RuntimeLogLevel, message: string) =>
  tenantRuntimeProvider.recordLog(projectId, level, message);
export const ensureContainerLogTailer = (projectId: number, runtimeId: string): void =>
  tenantRuntimeProvider.startLogStream(projectId, runtimeId);
export const stopContainerLogTailer = (projectId: number): void =>
  tenantRuntimeProvider.stopLogStream(projectId);
export const resumeTenantRuntimeLogStreamsOnBoot = (
  provider: TenantRuntimeProvider,
): Promise<void> =>
  provider instanceof PartialConfigRuntimeProvider
    ? Promise.resolve()
    : provider.resumeLogStreamsOnBoot();
export const resumeContainerLogTailersOnBoot = (): Promise<void> =>
  resumeTenantRuntimeLogStreamsOnBoot(tenantRuntimeProvider);
