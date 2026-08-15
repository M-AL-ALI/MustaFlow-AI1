import {
  PRODUCTION_DATABASE_ALLOCATION_GATE,
  PRODUCTION_DATABASE_MAX_PROJECTS_BINDING,
  PRODUCTION_DATABASE_NEON_MANAGEMENT_KEY_BINDING,
  PRODUCTION_DATABASE_NEON_HISTORY_RETENTION_SECONDS_BINDING,
  PRODUCTION_DATABASE_NEON_ORGANIZATION_ID_BINDING,
  PRODUCTION_DATABASE_NEON_REGION_ID_BINDING,
  PRODUCTION_DATABASE_PROJECT_PREFIX,
  productionDatabaseAllocationRecordSchema,
  type ProductionDatabaseAllocationRecord,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";

const NEON_ORIGIN = "https://console.neon.tech";
const PROVIDER_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_BODY_BYTES = 128 * 1024;
const MAX_PROVIDER_ATTEMPTS = 3;
const PROVIDER_RETRY_BASE_DELAY_MS = 100;
const MAX_PROJECT_LIMIT = 10_000;

export type ProductionDatabaseFailureCause =
  | "pre_dispatch"
  | "timeout"
  | "connection_reset"
  | "fetch_exception"
  | "provider_rejected"
  | "malformed_response"
  | "integrity_failure";

export class ProductionDatabaseProviderError extends Error {
  constructor(
    readonly status: 409 | 422 | 502 | 503 | 504,
    readonly code:
      | "production_database_inert"
      | "production_database_scope_mismatch"
      | "production_database_cost_limit"
      | "production_database_provider_unavailable"
      | "production_database_provider_rejected"
      | "production_database_integrity_failure"
      | "production_database_cleanup_incomplete",
    readonly retryable: boolean,
    readonly causeClass: ProductionDatabaseFailureCause,
  ) {
    super("The production database operation could not be completed");
    this.name = "ProductionDatabaseProviderError";
  }
}

export interface ProductionDatabaseProviderFetch {
  fetch(request: Request): Promise<Response>;
}

export interface ProductionDatabaseMaterial {
  allocation: ProductionDatabaseAllocationRecord;
  connectionString: string;
  reused: boolean;
}

const nativeProviderFetch: ProductionDatabaseProviderFetch = {
  fetch: (request) => fetch(request),
};

function requiredConfiguration(env: WorkerBindings): {
  managementKey: string;
  organizationId: string;
  regionId: string;
  historyRetentionSeconds: number;
  maxProjects: number;
} {
  const rehearsal =
    env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE === "staging" &&
    env.NABUFLOW_STAGING_PRODUCTION_DATABASE_REHEARSAL === "enabled";
  if (
    env[PRODUCTION_DATABASE_ALLOCATION_GATE] !== "enabled" ||
    (env.CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE !== "production" && !rehearsal)
  ) {
    throw new ProductionDatabaseProviderError(
      503,
      "production_database_inert",
      false,
      "pre_dispatch",
    );
  }
  const managementKey = env[PRODUCTION_DATABASE_NEON_MANAGEMENT_KEY_BINDING];
  const organizationId = env[PRODUCTION_DATABASE_NEON_ORGANIZATION_ID_BINDING];
  const regionId = env[PRODUCTION_DATABASE_NEON_REGION_ID_BINDING];
  const historyRetentionSeconds = Number(
    env[PRODUCTION_DATABASE_NEON_HISTORY_RETENTION_SECONDS_BINDING],
  );
  const maxProjects = Number(env[PRODUCTION_DATABASE_MAX_PROJECTS_BINDING]);
  if (
    typeof managementKey !== "string" ||
    managementKey.length < 20 ||
    typeof organizationId !== "string" ||
    !/^org-[A-Za-z0-9_-]{1,120}$/u.test(organizationId) ||
    typeof regionId !== "string" ||
    !/^[A-Za-z0-9_-]{1,100}$/u.test(regionId) ||
    !Number.isSafeInteger(historyRetentionSeconds) ||
    historyRetentionSeconds < 86_400 ||
    historyRetentionSeconds > 2_592_000 ||
    !Number.isSafeInteger(maxProjects) ||
    maxProjects < 1 ||
    maxProjects > MAX_PROJECT_LIMIT
  ) {
    throw new ProductionDatabaseProviderError(
      503,
      "production_database_inert",
      false,
      "pre_dispatch",
    );
  }
  return { managementKey, organizationId, regionId, historyRetentionSeconds, maxProjects };
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BODY_BYTES) {
    throw new ProductionDatabaseProviderError(
      502,
      "production_database_provider_rejected",
      false,
      "malformed_response",
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    if (bytes.byteLength > MAX_PROVIDER_BODY_BYTES) throw new Error("response too large");
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof ProductionDatabaseProviderError) throw error;
    throw new ProductionDatabaseProviderError(
      502,
      "production_database_provider_rejected",
      false,
      "malformed_response",
    );
  } finally {
    bytes.fill(0);
  }
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProductionDatabaseProviderError(
      502,
      "production_database_provider_rejected",
      false,
      "malformed_response",
    );
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, max = 4_096): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new ProductionDatabaseProviderError(
      502,
      "production_database_provider_rejected",
      false,
      "malformed_response",
    );
  }
  return value;
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

async function providerFetch(
  adapter: ProductionDatabaseProviderFetch,
  path: string,
  init: RequestInit,
): Promise<Response> {
  let request: Request;
  try {
    const url = new URL(path, NEON_ORIGIN);
    if (url.origin !== NEON_ORIGIN) throw new Error("provider origin changed");
    request = new Request(url, { ...init, signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS) });
  } catch {
    throw new ProductionDatabaseProviderError(
      502,
      "production_database_provider_rejected",
      false,
      "pre_dispatch",
    );
  }
  try {
    return await adapter.fetch(request);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new ProductionDatabaseProviderError(
        504,
        "production_database_provider_unavailable",
        true,
        "timeout",
      );
    }
    throw new ProductionDatabaseProviderError(
      503,
      "production_database_provider_unavailable",
      true,
      error instanceof TypeError ? "connection_reset" : "fetch_exception",
    );
  }
}

async function exactOperation<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!(error instanceof ProductionDatabaseProviderError) || !error.retryable) throw error;
      if (attempt < MAX_PROVIDER_ATTEMPTS) {
        await new Promise((resolve) => setTimeout(resolve, attempt * PROVIDER_RETRY_BASE_DELAY_MS));
      }
    }
  }
  throw lastError;
}

function projectName(allocationIdentity: string): string {
  return `${PRODUCTION_DATABASE_PROJECT_PREFIX}${allocationIdentity.slice(0, 24)}`;
}

function assertConnectionString(value: unknown): string {
  const connectionString = requiredString(value);
  let parsed: URL;
  try {
    parsed = new URL(connectionString);
  } catch {
    throw new ProductionDatabaseProviderError(
      502,
      "production_database_integrity_failure",
      false,
      "integrity_failure",
    );
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname.endsWith(".neon.tech")
  ) {
    throw new ProductionDatabaseProviderError(
      502,
      "production_database_integrity_failure",
      false,
      "integrity_failure",
    );
  }
  return connectionString;
}

export class ProductionDatabaseAllocator {
  constructor(
    private readonly env: WorkerBindings,
    private readonly fetchAdapter: ProductionDatabaseProviderFetch = nativeProviderFetch,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async listProjects(configuration: ReturnType<typeof requiredConfiguration>): Promise<{
    projects: Array<Record<string, unknown>>;
  }> {
    const namePrefix = PRODUCTION_DATABASE_PROJECT_PREFIX;
    const response = await exactOperation(async () => {
      const result = await providerFetch(
        this.fetchAdapter,
        `/api/v2/projects?org_id=${encodeURIComponent(configuration.organizationId)}&limit=${configuration.maxProjects + 1}`,
        { method: "GET", headers: bearer(configuration.managementKey) },
      );
      if (result.status !== 200) {
        throw new ProductionDatabaseProviderError(
          result.status >= 500 ? 503 : 422,
          result.status >= 500
            ? "production_database_provider_unavailable"
            : "production_database_provider_rejected",
          result.status >= 500,
          "provider_rejected",
        );
      }
      return result;
    });
    const body = objectRecord(await readJson(response));
    const projects = (Array.isArray(body.projects) ? body.projects : []).map(objectRecord);
    const owned = projects.filter(
      (project) => typeof project.name === "string" && project.name.startsWith(namePrefix),
    );
    if (owned.length > configuration.maxProjects) {
      throw new ProductionDatabaseProviderError(
        409,
        "production_database_cost_limit",
        false,
        "provider_rejected",
      );
    }
    return { projects: owned };
  }

  private async verifyRetention(
    configuration: ReturnType<typeof requiredConfiguration>,
    providerProjectId: string,
  ): Promise<void> {
    const retrieve = async (): Promise<Record<string, unknown>> => {
      const response = await exactOperation(async () => {
        const result = await providerFetch(
          this.fetchAdapter,
          `/api/v2/projects/${encodeURIComponent(providerProjectId)}`,
          { method: "GET", headers: bearer(configuration.managementKey) },
        );
        if (result.status !== 200) {
          throw new ProductionDatabaseProviderError(
            result.status >= 500 ? 503 : 422,
            result.status >= 500
              ? "production_database_provider_unavailable"
              : "production_database_provider_rejected",
            result.status >= 500,
            "provider_rejected",
          );
        }
        return result;
      });
      const body = objectRecord(await readJson(response));
      return objectRecord(body.project ?? body);
    };

    let project = await retrieve();
    if (project.history_retention_seconds !== configuration.historyRetentionSeconds) {
      const response = await exactOperation(async () => {
        const result = await providerFetch(
          this.fetchAdapter,
          `/api/v2/projects/${encodeURIComponent(providerProjectId)}`,
          {
            method: "PATCH",
            headers: bearer(configuration.managementKey),
            body: JSON.stringify({
              project: { history_retention_seconds: configuration.historyRetentionSeconds },
            }),
          },
        );
        if (result.status !== 200) {
          throw new ProductionDatabaseProviderError(
            result.status >= 500 ? 503 : 422,
            result.status >= 500
              ? "production_database_provider_unavailable"
              : "production_database_provider_rejected",
            result.status >= 500 || result.status === 423,
            "provider_rejected",
          );
        }
        return result;
      });
      await readJson(response);
      project = await retrieve();
    }
    if (project.history_retention_seconds !== configuration.historyRetentionSeconds) {
      throw new ProductionDatabaseProviderError(
        502,
        "production_database_integrity_failure",
        false,
        "integrity_failure",
      );
    }
  }

  private async connectionString(
    configuration: ReturnType<typeof requiredConfiguration>,
    providerProjectId: string,
  ): Promise<string> {
    const response = await exactOperation(async () => {
      const result = await providerFetch(
        this.fetchAdapter,
        `/api/v2/projects/${encodeURIComponent(providerProjectId)}/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=true`,
        { method: "GET", headers: bearer(configuration.managementKey) },
      );
      if (result.status !== 200) {
        throw new ProductionDatabaseProviderError(
          result.status >= 500 ? 503 : 422,
          result.status >= 500
            ? "production_database_provider_unavailable"
            : "production_database_provider_rejected",
          result.status >= 500,
          "provider_rejected",
        );
      }
      return result;
    });
    const body = objectRecord(await readJson(response));
    return assertConnectionString(body.uri ?? body.connection_uri);
  }

  async ensure(input: {
    projectId: number;
    allocationIdentity: string;
  }): Promise<ProductionDatabaseMaterial> {
    const configuration = requiredConfiguration(this.env);
    const name = projectName(input.allocationIdentity);
    const listed = await this.listProjects(configuration);
    const matches = listed.projects.filter((project) => project.name === name);
    if (matches.length > 1) {
      throw new ProductionDatabaseProviderError(
        409,
        "production_database_integrity_failure",
        false,
        "integrity_failure",
      );
    }
    if (matches.length === 0 && listed.projects.length >= configuration.maxProjects) {
      throw new ProductionDatabaseProviderError(
        409,
        "production_database_cost_limit",
        false,
        "provider_rejected",
      );
    }
    let providerProjectId: string;
    let reused = true;
    if (matches.length === 1) {
      providerProjectId = requiredString(matches[0]?.id, 128);
      const existingRegion = matches[0]?.region_id ?? matches[0]?.regionId;
      if (existingRegion !== undefined && existingRegion !== configuration.regionId) {
        throw new ProductionDatabaseProviderError(
          409,
          "production_database_scope_mismatch",
          false,
          "integrity_failure",
        );
      }
    } else {
      reused = false;
      let createdProjectId: string | null = null;
      let lastError: unknown;
      for (let attempt = 1; attempt <= MAX_PROVIDER_ATTEMPTS; attempt += 1) {
        try {
          const response = await providerFetch(
            this.fetchAdapter,
            `/api/v2/projects?org_id=${encodeURIComponent(configuration.organizationId)}`,
            {
              method: "POST",
              headers: bearer(configuration.managementKey),
              body: JSON.stringify({
                project: {
                  name,
                  region_id: configuration.regionId,
                  history_retention_seconds: configuration.historyRetentionSeconds,
                },
              }),
            },
          );
          if (response.status === 201) {
            const body = objectRecord(await readJson(response));
            createdProjectId = requiredString(objectRecord(body.project).id, 128);
            break;
          }
          throw new ProductionDatabaseProviderError(
            response.status >= 500 ? 503 : 422,
            response.status >= 500
              ? "production_database_provider_unavailable"
              : "production_database_provider_rejected",
            response.status >= 500 || response.status === 423,
            "provider_rejected",
          );
        } catch (error) {
          lastError = error;
          if (!(error instanceof ProductionDatabaseProviderError) || !error.retryable) throw error;
          const discovery = await this.listProjects(configuration);
          const discovered = discovery.projects.filter((project) => project.name === name);
          if (discovered.length > 1) {
            throw new ProductionDatabaseProviderError(
              409,
              "production_database_integrity_failure",
              false,
              "integrity_failure",
            );
          }
          if (discovered.length === 1) {
            createdProjectId = requiredString(discovered[0]?.id, 128);
            break;
          }
          if (attempt < MAX_PROVIDER_ATTEMPTS) {
            await new Promise((resolve) =>
              setTimeout(resolve, attempt * PROVIDER_RETRY_BASE_DELAY_MS),
            );
          }
        }
      }
      if (createdProjectId === null) throw lastError;
      providerProjectId = createdProjectId;
    }
    await this.verifyRetention(configuration, providerProjectId);
    const connectionString = await this.connectionString(configuration, providerProjectId);
    const timestamp = this.now().toISOString();
    const revision = `production-database-${input.allocationIdentity.slice(0, 48)}`;
    return {
      allocation: productionDatabaseAllocationRecordSchema.parse({
        format: "nabuflow.production-database-allocation/v1",
        projectId: input.projectId,
        allocationIdentity: input.allocationIdentity,
        provider: "neon-postgres",
        providerProjectId,
        providerOrganizationId: configuration.organizationId,
        regionId: configuration.regionId,
        historyRetentionSeconds: configuration.historyRetentionSeconds,
        revision,
        state: "ready",
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      connectionString,
      reused,
    };
  }

  async release(allocation: ProductionDatabaseAllocationRecord): Promise<void> {
    const configuration = requiredConfiguration(this.env);
    if (allocation.providerOrganizationId !== configuration.organizationId) {
      throw new ProductionDatabaseProviderError(
        409,
        "production_database_scope_mismatch",
        false,
        "pre_dispatch",
      );
    }
    await exactOperation(async () => {
      const result = await providerFetch(
        this.fetchAdapter,
        `/api/v2/projects/${encodeURIComponent(allocation.providerProjectId)}`,
        { method: "DELETE", headers: bearer(configuration.managementKey) },
      );
      if (![200, 204, 404].includes(result.status)) {
        throw new ProductionDatabaseProviderError(
          result.status >= 500 ? 503 : 422,
          result.status >= 500
            ? "production_database_provider_unavailable"
            : "production_database_provider_rejected",
          result.status >= 500,
          "provider_rejected",
        );
      }
      return result;
    });
  }

  async verifyGone(allocation: ProductionDatabaseAllocationRecord): Promise<boolean> {
    const configuration = requiredConfiguration(this.env);
    if (allocation.providerOrganizationId !== configuration.organizationId) {
      throw new ProductionDatabaseProviderError(
        409,
        "production_database_scope_mismatch",
        false,
        "pre_dispatch",
      );
    }
    const response = await exactOperation(async () => {
      const result = await providerFetch(
        this.fetchAdapter,
        `/api/v2/projects/${encodeURIComponent(allocation.providerProjectId)}`,
        { method: "GET", headers: bearer(configuration.managementKey) },
      );
      if (![200, 404].includes(result.status)) {
        throw new ProductionDatabaseProviderError(
          result.status >= 500 ? 503 : 422,
          result.status >= 500
            ? "production_database_provider_unavailable"
            : "production_database_provider_rejected",
          result.status >= 500,
          "provider_rejected",
        );
      }
      return result;
    });
    if (response.status === 404) return true;
    if (response.status === 200) return false;
    throw new ProductionDatabaseProviderError(
      422,
      "production_database_provider_rejected",
      false,
      "provider_rejected",
    );
  }
}
