import type {
  RuntimeArtifactEnvelope,
  RuntimeArtifactLayerContent,
  RuntimeLayeredArtifactEnvelope,
  RuntimeManifestContract,
} from "@workspace/tenant-runtime-contracts";

/**
 * Provider-neutral contract for a project's isolated runtime.
 *
 * Provider adapters own substrate vocabulary, credentials, endpoint formats,
 * and lifecycle details. Application code should depend on this contract (or
 * the compatibility facade in tenant-runtime.ts), never a provider SDK/API.
 */

export type RuntimeStatus = "stopped" | "starting" | "running" | "hibernated" | "error";

export type RuntimeSubsystemStatus = "ok" | "unconfigured" | "error";

export interface RuntimeInfo {
  runtimeId: string;
  status: RuntimeStatus;
  endpoint: string | null;
  /** Internal port on which the tenant application listens. */
  servicePort: number;
}

export interface RuntimeCreateFailure {
  error: string;
}

export type RuntimeCreateResult = RuntimeInfo | RuntimeCreateFailure | null;

export interface RuntimeFile {
  path: string;
  content: string;
}

export interface RuntimeExecResult {
  ok: boolean;
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  /** The provider restarted the runtime while servicing this command. */
  runtimeRestarted: boolean;
}

export interface RuntimeInstallOptions {
  maxAttempts?: number;
  wallClockCapMs?: number;
  signal?: AbortSignal;
  /** Called before a retry after the provider restarted the runtime. */
  onRuntimeRestarted?: () => Promise<void>;
}

export interface RuntimeProductionOptions {
  region?: string | null;
  deploymentType?: string | null;
  servicePort?: number | null;
}

export interface RuntimeServiceOptions {
  servicePort?: number | null;
}

export interface RuntimeArtifactDeployment {
  envelope: RuntimeArtifactEnvelope;
  chunks: Uint8Array[];
}

export interface RuntimeArtifactDeploymentResult {
  sealedArtifactSha256: string;
  contentSha256: string;
  filesWritten: number;
  materialized: boolean;
}

export interface RuntimeLayeredArtifactDeployment {
  envelope: RuntimeLayeredArtifactEnvelope;
  appChunks: Uint8Array[];
  layers: Array<{ content: RuntimeArtifactLayerContent; chunks: Uint8Array[] }>;
}

export interface RuntimeLayeredArtifactDeploymentResult extends RuntimeArtifactDeploymentResult {
  layersMaterialized: number;
}

export interface ArtifactDeployingTenantRuntimeProvider extends TenantRuntimeProvider {
  deployArtifact(
    runtimeId: string,
    projectId: number,
    artifact: RuntimeArtifactDeployment,
  ): Promise<RuntimeArtifactDeploymentResult>;
  updateRuntimeManifest(
    runtimeId: string,
    projectId: number,
    input: {
      expectedManifestRevision: string;
      manifest: RuntimeManifestContract;
      restart?: "reject-if-running" | "restart";
      sealedArtifactSha256?: string;
    },
  ): Promise<RuntimeInfo>;
}

export function supportsArtifactDeployment(
  provider: TenantRuntimeProvider,
): provider is ArtifactDeployingTenantRuntimeProvider {
  const candidate = provider as Partial<ArtifactDeployingTenantRuntimeProvider>;
  return (
    typeof candidate.deployArtifact === "function" &&
    typeof candidate.updateRuntimeManifest === "function"
  );
}

export interface LayeredArtifactDeployingTenantRuntimeProvider extends ArtifactDeployingTenantRuntimeProvider {
  deployLayeredArtifact(
    runtimeId: string,
    projectId: number,
    artifact: RuntimeLayeredArtifactDeployment,
  ): Promise<RuntimeLayeredArtifactDeploymentResult>;
}

export function supportsLayeredArtifactDeployment(
  provider: TenantRuntimeProvider,
): provider is LayeredArtifactDeployingTenantRuntimeProvider {
  const candidate = provider as Partial<LayeredArtifactDeployingTenantRuntimeProvider>;
  return (
    supportsArtifactDeployment(provider) && typeof candidate.deployLayeredArtifact === "function"
  );
}

export type RuntimeLogLevel = "stdout" | "stderr" | "system";

export class RuntimeProviderUnavailableError extends Error {
  readonly code = "runtime_provider_capability_unavailable";

  constructor(
    readonly providerId: string,
    readonly capability: string,
    message = `Runtime capability ${capability} is unavailable from provider ${providerId}`,
  ) {
    super(message);
    this.name = "RuntimeProviderUnavailableError";
  }
}

export interface TenantRuntimeProvider {
  /** Stable provider identifier for diagnostics only. */
  readonly providerId: string;

  hasCredentials(): boolean;
  isAvailable(): Promise<boolean>;
  runSelfCheck(): Promise<RuntimeSubsystemStatus>;
  getSubsystemStatus(): RuntimeSubsystemStatus | null;
  ensureInfrastructure(): Promise<void>;

  create(
    projectId: number,
    stack?: string | null,
    environment?: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<RuntimeCreateResult>;
  start(runtimeId: string, projectId: number): Promise<boolean>;
  stop(runtimeId: string, projectId: number): Promise<boolean>;
  destroy(runtimeId: string, projectId: number): Promise<boolean>;
  status(runtimeId: string): Promise<RuntimeStatus>;
  exec(
    runtimeId: string,
    command: string[],
    projectId: number,
    workdir?: string,
  ): Promise<RuntimeExecResult>;

  installDependencies(
    runtimeId: string,
    projectId: number,
    options?: RuntimeInstallOptions,
  ): Promise<{ ok: boolean; output: string }>;
  writeFile(runtimeId: string, path: string, content: string, projectId: number): Promise<boolean>;
  syncFiles(
    runtimeId: string,
    projectId: number,
    files: RuntimeFile[],
    throwIfUnconfigured?: boolean,
  ): Promise<void>;
  restoreFiles(
    runtimeId: string,
    projectId: number,
    files: RuntimeFile[],
    throwIfUnconfigured?: boolean,
  ): Promise<void>;
  updateEnvironment(
    runtimeId: string,
    projectId: number,
    environment: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<boolean>;
  restartWithProjectEnvironment(
    projectId: number,
    environment: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<void>;

  ensureAwake(
    runtimeId: string,
    projectId: number,
    endpoint: string | null,
    timeoutSeconds?: number,
  ): Promise<{ ok: boolean; message?: string }>;
  provision(
    projectId: number,
    files: RuntimeFile[],
    environment?: Record<string, string>,
    options?: RuntimeServiceOptions,
  ): Promise<RuntimeInfo | null>;
  hibernate(projectId: number): Promise<void>;
  createProduction(
    projectId: number,
    environment: Record<string, string>,
    runtime?: string | null,
    options?: RuntimeProductionOptions,
  ): Promise<RuntimeInfo | null>;
  deployProduction(
    projectId: number,
    previousRuntimeId: string | null,
    files: RuntimeFile[],
    environment: Record<string, string>,
    options?: RuntimeProductionOptions,
  ): Promise<RuntimeInfo | null>;

  configureIdleBehavior(
    runtimeId: string,
    projectId: number,
    behavior: "stop" | "off",
  ): Promise<void>;
  startHealthService(runtimeId: string, projectId: number): Promise<void>;
  stopHealthService(runtimeId: string, projectId: number): Promise<void>;
  startKeepalive(endpoint: string, projectId: number): () => void;
  health(endpoint: string, timeoutSeconds: number): Promise<boolean>;

  resolveEndpoint(runtimeId: string): string;
  getGatewayHostname(): string;
  getGatewayLabel(): string;
  isGatewayReachable(): Promise<boolean>;
  mapErrorToMessage(raw: string): string;

  recordLog(projectId: number, level: RuntimeLogLevel, message: string): Promise<void>;
  startLogStream(projectId: number, runtimeId: string): void;
  stopLogStream(projectId: number): void;
  resumeLogStreamsOnBoot(): Promise<void>;
}
