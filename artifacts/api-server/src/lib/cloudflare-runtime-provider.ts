import {
  CONTROL_API_PREFIX,
  controlErrorResponseSchema,
  deriveRuntimeIdentity,
  execRuntimeResponseSchema,
  parseRuntimeIdentityForNamespace,
  runtimeDescriptorSchema,
  sha256Hex,
  signControlRequest,
  versionResponseSchema,
  type RuntimeDescriptor,
  type RuntimeLocator,
  type TenantRuntimeConfig,
} from "@workspace/tenant-runtime-contracts";
import { resolveProjectRuntimeManifest } from "./runtime-manifest";
import { logger } from "./logger";
import {
  RuntimeProviderUnavailableError,
  type RuntimeCreateResult,
  type RuntimeExecResult,
  type RuntimeFile,
  type RuntimeInfo,
  type RuntimeInstallOptions,
  type RuntimeLogLevel,
  type RuntimeProductionOptions,
  type RuntimeServiceOptions,
  type RuntimeStatus,
  type RuntimeSubsystemStatus,
  type TenantRuntimeProvider,
} from "./tenant-runtime-provider";

type CloudflareConfig = NonNullable<TenantRuntimeConfig["cloudflare"]>;

const CLOCK_SKEW_LIMIT_MS = 60_000;
const REQUEST_TIMEOUT_MS = 30_000;
const CONTROL_RETRY_DELAYS_MS = [100, 250, 500] as const;
const MAX_RETRY_AFTER_MS = 1_000;

interface CloudflareRuntimeProviderDependencies {
  sleep?: (delayMs: number) => Promise<void>;
}

export class CloudflareRuntimeControlError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable: boolean,
    message: string,
  ) {
    super(message);
    this.name = "CloudflareRuntimeControlError";
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

export class CloudflareRuntimeProvider implements TenantRuntimeProvider {
  readonly providerId = "cloudflare";
  private subsystemStatus: RuntimeSubsystemStatus | null = null;
  private deploymentVersion: string | null = null;
  private clockOffsetMs = 0;

  private readonly sleep: (delayMs: number) => Promise<void>;

  constructor(
    private readonly config: CloudflareConfig,
    dependencies: CloudflareRuntimeProviderDependencies = {},
  ) {
    this.sleep =
      dependencies.sleep ?? ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
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
      let response: Response;
      try {
        response = await fetch(`${this.config.controlUrl}${CONTROL_API_PREFIX}/version`, {
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (error) {
        if (attempt < CONTROL_RETRY_DELAYS_MS.length) {
          await this.sleep(CONTROL_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new CloudflareRuntimeControlError(
          503,
          "control_plane_unreachable",
          true,
          error instanceof Error
            ? `Cloudflare control clock probe failed: ${error.name}`
            : "Cloudflare control clock probe failed",
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
          await this.sleep(retryAfterMs(response, CONTROL_RETRY_DELAYS_MS[attempt]));
          continue;
        }
        throw error;
      }

      const workerDate = response.headers.get("date");
      const workerTime = workerDate === null ? Number.NaN : Date.parse(workerDate);
      if (!Number.isFinite(workerTime)) throw new Error("Cloudflare control response omitted Date");
      const offset = workerTime - Date.now();
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
    return version.deploymentVersion;
  }

  private async request<T>(input: {
    method?: string;
    path: string;
    body?: unknown;
    idempotencyKey?: string;
    parse: { parse(value: unknown): T };
  }): Promise<T> {
    const method = input.method ?? "GET";
    const body = input.body === undefined ? "" : JSON.stringify(input.body);
    const bodySha256 = await sha256Hex(body);
    const idempotencyKey = input.idempotencyKey ?? "";
    for (let attempt = 0; ; attempt += 1) {
      const timestamp = String(Date.now() + this.clockOffsetMs);
      const nonce = crypto.randomUUID();
      const signature = await signControlRequest(this.config.controlToken, {
        method,
        pathAndQuery: input.path,
        timestamp,
        nonce,
        bodySha256,
        idempotencyKey,
      });
      let response: Response;
      try {
        response = await fetch(`${this.config.controlUrl}${input.path}`, {
          method,
          body: body || undefined,
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
          headers: {
            ...(body ? { "content-type": "application/json" } : {}),
            "x-nabuflow-timestamp": timestamp,
            "x-nabuflow-nonce": nonce,
            "x-nabuflow-body-sha256": bodySha256,
            "x-nabuflow-signature": signature,
            ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
          },
        });
      } catch (error) {
        if (attempt < CONTROL_RETRY_DELAYS_MS.length) {
          await this.sleep(CONTROL_RETRY_DELAYS_MS[attempt]);
          continue;
        }
        throw new CloudflareRuntimeControlError(
          503,
          "control_plane_unreachable",
          true,
          error instanceof Error
            ? `Cloudflare runtime control request failed: ${error.name}`
            : "Cloudflare runtime control request failed",
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
      if (
        attempt < CONTROL_RETRY_DELAYS_MS.length &&
        (error.retryable || transientInvalidSignature)
      ) {
        await this.sleep(retryAfterMs(response, CONTROL_RETRY_DELAYS_MS[attempt]));
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
  ): Promise<RuntimeDescriptor> {
    const result = await this.request({
      method,
      path: this.path(locator, suffix),
      body,
      idempotencyKey: method === "GET" ? undefined : crypto.randomUUID(),
      parse: {
        parse: (value: unknown) =>
          runtimeDescriptorSchema.parse((value as { runtime: unknown }).runtime),
      },
    });
    return result;
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
    const servicePort = resolveProjectRuntimeManifest({
      stack,
      runtimePort: options?.servicePort,
      legacyProfile: "stack",
    }).servicePort;
    const expectedDeploymentVersion = this.deploymentVersion ?? (await this.refreshVersion());
    const runtime = await this.descriptorRequest(locator, "PUT", "", {
      locator,
      expectedDeploymentVersion,
      manifest: {
        revision: `project-${projectId}-runtime-v1`,
        runtime: stack ?? "node",
        buildCommand: ["npm", "run", "build"],
        startCommand: commandForStack(stack),
        servicePort,
        healthPath: "/",
        resourceProfile: "dev",
        public: false,
      },
    });
    return toInfo(runtime);
  }

  async start(runtimeId: string, projectId: number): Promise<boolean> {
    const locator = await this.locator(runtimeId, projectId);
    const revision = `start-${Date.now()}`;
    await this.descriptorRequest(locator, "POST", "/start", {
      locator,
      expectedDeploymentVersion: this.deploymentVersion ?? (await this.refreshVersion()),
      artifactRevision: revision,
      artifactSha256: await sha256Hex(revision),
    });
    return true;
  }

  async stop(runtimeId: string, projectId: number): Promise<boolean> {
    const locator = await this.locator(runtimeId, projectId);
    await this.descriptorRequest(locator, "POST", "/stop", { locator });
    return true;
  }

  async destroy(runtimeId: string, projectId: number): Promise<boolean> {
    const locator = await this.locator(runtimeId, projectId);
    await this.request({
      method: "DELETE",
      path: this.path(locator),
      body: { locator },
      idempotencyKey: crypto.randomUUID(),
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
  ): Promise<RuntimeExecResult> {
    const locator = await this.locator(runtimeId, projectId);
    const result = await this.request({
      method: "POST",
      path: this.path(locator, "/exec"),
      body: { locator, argv: command, cwd: workdir, timeoutMs: 120_000 },
      idempotencyKey: crypto.randomUUID(),
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
    const result = await this.exec(runtimeId, ["npm", "install"], projectId, "/workspace");
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

  async syncFiles(_runtimeId: string, _projectId: number, _files: RuntimeFile[]): Promise<void> {
    this.unavailable("file-sync");
  }

  restoreFiles(_runtimeId: string, _projectId: number, _files: RuntimeFile[]): Promise<void> {
    return this.unavailable("file-restore");
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
    try {
      const response = await fetch(endpoint, {
        signal: AbortSignal.timeout(timeoutSeconds * 1000),
      });
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
