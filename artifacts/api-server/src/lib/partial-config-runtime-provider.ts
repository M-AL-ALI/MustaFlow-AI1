import type { CloudflareRuntimeBindingName } from "@workspace/tenant-runtime-contracts";
import {
  RuntimeProviderUnavailableError,
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
  type TenantRuntimeProvider,
} from "./tenant-runtime-provider";

/**
 * Fail-closed runtime provider used when Cloudflare configuration is incomplete.
 * It stores binding names only and never retains or inspects a present value.
 */
export class PartialConfigRuntimeProvider implements TenantRuntimeProvider {
  readonly providerId = "cloudflare";
  readonly missingBindings: readonly CloudflareRuntimeBindingName[];

  constructor(missingBindings: readonly CloudflareRuntimeBindingName[]) {
    this.missingBindings = [...missingBindings];
  }

  private unavailable<T>(capability: string): Promise<T> {
    return Promise.reject(new RuntimeProviderUnavailableError(this.providerId, capability));
  }

  private unavailableSync(capability: string): never {
    throw new RuntimeProviderUnavailableError(this.providerId, capability);
  }

  hasCredentials(): boolean {
    return false;
  }

  isAvailable(): Promise<boolean> {
    return Promise.resolve(false);
  }

  runSelfCheck(): Promise<"partial-config"> {
    return Promise.resolve("partial-config");
  }

  getSubsystemStatus(): "partial-config" {
    return "partial-config";
  }

  ensureInfrastructure(): Promise<void> {
    return this.unavailable("infrastructure");
  }

  create(
    _projectId: number,
    _stack?: string | null,
    _environment?: Record<string, string>,
    _options?: RuntimeServiceOptions,
  ): Promise<RuntimeCreateResult> {
    return this.unavailable("runtime-create");
  }

  start(_runtimeId: string, _projectId: number, _options?: RuntimeStartOptions): Promise<boolean> {
    return this.unavailable("runtime-start");
  }

  stop(
    _runtimeId: string,
    _projectId: number,
    _options?: RuntimeOperationOptions,
  ): Promise<boolean> {
    return this.unavailable("runtime-stop");
  }

  destroy(
    _runtimeId: string,
    _projectId: number,
    _options?: RuntimeOperationOptions,
  ): Promise<boolean> {
    return this.unavailable("runtime-destroy");
  }

  status(_runtimeId: string): Promise<RuntimeStatus> {
    return this.unavailable("runtime-status");
  }

  exec(
    _runtimeId: string,
    _command: string[],
    _projectId: number,
    _workdir?: string,
    _options?: RuntimeOperationOptions,
  ): Promise<RuntimeExecResult> {
    return this.unavailable("runtime-exec");
  }

  installDependencies(
    _runtimeId: string,
    _projectId: number,
    _options?: RuntimeInstallOptions,
  ): Promise<{ ok: boolean; output: string }> {
    return this.unavailable("install-dependencies");
  }

  writeFile(
    _runtimeId: string,
    _path: string,
    _content: string,
    _projectId: number,
  ): Promise<boolean> {
    return this.unavailable("file-write");
  }

  syncFiles(
    _runtimeId: string,
    _projectId: number,
    _files: RuntimeFile[],
    _throwIfUnconfigured?: boolean,
  ): Promise<void> {
    return this.unavailable("file-sync");
  }

  restoreFiles(
    _runtimeId: string,
    _projectId: number,
    _files: RuntimeFile[],
    _throwIfUnconfigured?: boolean,
  ): Promise<void> {
    return this.unavailable("file-restore");
  }

  updateEnvironment(
    _runtimeId: string,
    _projectId: number,
    _environment: Record<string, string>,
    _options?: RuntimeServiceOptions,
  ): Promise<boolean> {
    return this.unavailable("secret-environment");
  }

  restartWithProjectEnvironment(
    _projectId: number,
    _environment: Record<string, string>,
    _options?: RuntimeServiceOptions,
  ): Promise<void> {
    return this.unavailable("secret-environment");
  }

  ensureAwake(
    _runtimeId: string,
    _projectId: number,
    _endpoint: string | null,
    _timeoutSeconds?: number,
  ): Promise<{ ok: boolean; message?: string }> {
    return this.unavailable("runtime-awake");
  }

  provision(
    _projectId: number,
    _files: RuntimeFile[],
    _environment?: Record<string, string>,
    _options?: RuntimeServiceOptions,
  ): Promise<RuntimeInfo | null> {
    return this.unavailable("artifact-provision");
  }

  hibernate(_projectId: number): Promise<void> {
    return this.unavailable("runtime-hibernate");
  }

  createProduction(
    _projectId: number,
    _environment: Record<string, string>,
    _runtime?: string | null,
    _options?: RuntimeProductionOptions,
  ): Promise<RuntimeInfo | null> {
    return this.unavailable("production-create");
  }

  deployProduction(
    _projectId: number,
    _previousRuntimeId: string | null,
    _files: RuntimeFile[],
    _environment: Record<string, string>,
    _options?: RuntimeProductionOptions,
  ): Promise<RuntimeInfo | null> {
    return this.unavailable("production-deploy");
  }

  configureIdleBehavior(
    _runtimeId: string,
    _projectId: number,
    _behavior: "stop" | "off",
  ): Promise<void> {
    return this.unavailable("idle-behavior");
  }

  startHealthService(_runtimeId: string, _projectId: number): Promise<void> {
    return this.unavailable("health-sidecar");
  }

  stopHealthService(_runtimeId: string, _projectId: number): Promise<void> {
    return this.unavailable("health-sidecar");
  }

  startKeepalive(_endpoint: string, _projectId: number): () => void {
    return this.unavailableSync("keepalive");
  }

  health(_endpoint: string, _timeoutSeconds: number): Promise<boolean> {
    return this.unavailable("runtime-health");
  }

  resolveEndpoint(_runtimeId: string): string {
    return this.unavailableSync("derived-public-endpoint");
  }

  getGatewayHostname(): string {
    return this.unavailableSync("gateway-hostname");
  }

  getGatewayLabel(): string {
    return this.unavailableSync("gateway-label");
  }

  isGatewayReachable(): Promise<boolean> {
    return this.unavailable("gateway-reachability");
  }

  mapErrorToMessage(_raw: string): string {
    return this.unavailableSync("error-message");
  }

  recordLog(_projectId: number, _level: RuntimeLogLevel, _message: string): Promise<void> {
    return this.unavailable("log-record");
  }

  startLogStream(_projectId: number, _runtimeId: string): void {
    this.unavailableSync("log-tail");
  }

  stopLogStream(_projectId: number): void {
    this.unavailableSync("log-tail");
  }

  resumeLogStreamsOnBoot(): Promise<void> {
    return this.unavailable("log-resume");
  }
}
