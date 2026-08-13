import { sha256Hex } from "@workspace/tenant-runtime-contracts";
import type {
  AcceptanceProviderAdapters,
  AcceptanceProviderCreateResult,
  AcceptanceProviderGoneResult,
  AcceptanceProvisionerBindings,
  StoredAcceptanceLease,
} from "./acceptance-provisioner-model";

const NEON_ORIGIN = "https://console.neon.tech";
const STRIPE_ORIGIN = "https://api.stripe.com";
const FLY_ORIGIN = "https://api.machines.dev";
const PROVIDER_TIMEOUT_MS = 20_000;
const MAX_PROVIDER_BODY_BYTES = 128 * 1024;
const PROVIDER_RESOURCE_PREFIX = "nabu-accept-";
const PROVIDER_DISCOVERY_LIMIT = 100;

export type AcceptanceProviderFailureCause =
  | "pre_dispatch"
  | "timeout"
  | "connection_reset"
  | "fetch_exception"
  | "provider_rejected"
  | "malformed_response"
  | "integrity_failure";

export class AcceptanceProviderError extends Error {
  constructor(
    readonly code:
      | "acceptance_live_target_forbidden"
      | "acceptance_scope_mismatch"
      | "acceptance_provider_unavailable"
      | "acceptance_provider_rejected"
      | "acceptance_cleanup_incomplete",
    readonly retryable: boolean,
    readonly causeClass: AcceptanceProviderFailureCause,
  ) {
    super("The disposable acceptance provider operation could not be completed");
  }
}

export interface AcceptanceProviderFetch {
  fetch(request: Request): Promise<Response>;
}

const nativeProviderFetch: AcceptanceProviderFetch = { fetch: (request) => fetch(request) };

function assertProviderScope(
  lease: StoredAcceptanceLease,
  env: AcceptanceProvisionerBindings,
): void {
  if (
    (lease.scope.provider === "neon" &&
      lease.scope.organizationId !== env.ACCEPTANCE_NEON_ORGANIZATION_ID) ||
    (lease.scope.provider === "stripe" &&
      (lease.scope.mode !== "test" ||
        lease.scope.sandboxId !== env.ACCEPTANCE_STRIPE_SANDBOX_ID)) ||
    (lease.scope.provider === "fly" &&
      (!lease.scope.disposable ||
        lease.scope.organizationSlug !== env.ACCEPTANCE_FLY_ORGANIZATION_SLUG))
  ) {
    throw new AcceptanceProviderError("acceptance_scope_mismatch", false, "pre_dispatch");
  }
}

function requiredSecret(value: string | undefined, pattern?: RegExp): string {
  if (value === undefined || value.length < 16 || (pattern !== undefined && !pattern.test(value))) {
    throw new AcceptanceProviderError("acceptance_provider_unavailable", false, "pre_dispatch");
  }
  return value;
}

async function readJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_PROVIDER_BODY_BYTES) {
    throw new AcceptanceProviderError("acceptance_provider_rejected", false, "malformed_response");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  try {
    if (bytes.byteLength > MAX_PROVIDER_BODY_BYTES) {
      throw new AcceptanceProviderError(
        "acceptance_provider_rejected",
        false,
        "malformed_response",
      );
    }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch (error) {
    if (error instanceof AcceptanceProviderError) throw error;
    throw new AcceptanceProviderError("acceptance_provider_rejected", false, "malformed_response");
  } finally {
    bytes.fill(0);
  }
}

async function providerFetch(
  adapter: AcceptanceProviderFetch,
  origin: string,
  path: string,
  init: RequestInit,
): Promise<Response> {
  let request: Request;
  try {
    const url = new URL(path, origin);
    if (url.origin !== origin) throw new Error("Provider origin changed");
    request = new Request(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch {
    throw new AcceptanceProviderError("acceptance_provider_rejected", false, "pre_dispatch");
  }
  try {
    return await adapter.fetch(request);
  } catch (error) {
    if (error instanceof DOMException && error.name === "TimeoutError") {
      throw new AcceptanceProviderError("acceptance_provider_unavailable", true, "timeout");
    }
    const cause = error instanceof TypeError ? "connection_reset" : "fetch_exception";
    throw new AcceptanceProviderError("acceptance_provider_unavailable", true, cause);
  }
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

function objectRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AcceptanceProviderError("acceptance_provider_rejected", false, "malformed_response");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new AcceptanceProviderError("acceptance_provider_rejected", false, "malformed_response");
  }
  return value;
}

async function providerResourceName(lease: StoredAcceptanceLease): Promise<string> {
  return `${PROVIDER_RESOURCE_PREFIX}${(await sha256Hex(lease.leaseId)).slice(0, 24)}`;
}

async function neonProjectId(
  fetchAdapter: AcceptanceProviderFetch,
  env: AcceptanceProvisionerBindings,
  lease: StoredAcceptanceLease,
): Promise<string | null> {
  const token = requiredSecret(env.ACCEPTANCE_NEON_MANAGEMENT_KEY);
  const name = await providerResourceName(lease);
  const response = await providerFetch(
    fetchAdapter,
    NEON_ORIGIN,
    `/api/v2/projects?org_id=${encodeURIComponent(env.ACCEPTANCE_NEON_ORGANIZATION_ID)}&search=${encodeURIComponent(name)}&limit=10&timeout=30000`,
    { method: "GET", headers: bearer(token) },
  );
  if (response.status !== 200) {
    throw new AcceptanceProviderError("acceptance_provider_unavailable", true, "provider_rejected");
  }
  const body = objectRecord(await readJson(response));
  const projects = Array.isArray(body.projects) ? body.projects : [];
  const match = projects
    .map((value) => objectRecord(value))
    .find((project) => project.name === name);
  return match === undefined ? null : requiredString(match.id);
}

async function neonConnectionUrl(
  fetchAdapter: AcceptanceProviderFetch,
  env: AcceptanceProvisionerBindings,
  projectId: string,
): Promise<string> {
  const token = requiredSecret(env.ACCEPTANCE_NEON_MANAGEMENT_KEY);
  const response = await providerFetch(
    fetchAdapter,
    NEON_ORIGIN,
    `/api/v2/projects/${encodeURIComponent(projectId)}/connection_uri?database_name=neondb&role_name=neondb_owner&pooled=true`,
    { method: "GET", headers: bearer(token) },
  );
  if (response.status !== 200) {
    throw new AcceptanceProviderError("acceptance_provider_unavailable", true, "provider_rejected");
  }
  const body = objectRecord(await readJson(response));
  return requiredString(body.uri ?? body.connection_uri);
}

async function stripeIntentId(
  fetchAdapter: AcceptanceProviderFetch,
  env: AcceptanceProvisionerBindings,
  lease: StoredAcceptanceLease,
): Promise<string | null> {
  const token = requiredSecret(
    env.ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY,
    /^r[k]_test_[A-Za-z0-9]+$/u,
  );
  const response = await providerFetch(
    fetchAdapter,
    STRIPE_ORIGIN,
    `/v1/payment_intents?limit=${PROVIDER_DISCOVERY_LIMIT}`,
    { method: "GET", headers: { authorization: `Bearer ${token}` } },
  );
  if (response.status !== 200) {
    throw new AcceptanceProviderError("acceptance_provider_unavailable", true, "provider_rejected");
  }
  const body = objectRecord(await readJson(response));
  if (body.has_more === true) {
    throw new AcceptanceProviderError("acceptance_cleanup_incomplete", true, "provider_rejected");
  }
  const data = Array.isArray(body.data) ? body.data : [];
  for (const value of data) {
    const intent = objectRecord(value);
    if (intent.livemode !== false) continue;
    const metadata = objectRecord(intent.metadata ?? {});
    if (metadata.nabuflow_acceptance_lease === lease.leaseId) return requiredString(intent.id);
  }
  return null;
}

async function flyResource(
  fetchAdapter: AcceptanceProviderFetch,
  env: AcceptanceProvisionerBindings,
  lease: StoredAcceptanceLease,
): Promise<{ appName: string; machineId: string | null }> {
  const token = requiredSecret(env.ACCEPTANCE_FLY_ORG_TOKEN);
  const appName = await providerResourceName(lease);
  const appResponse = await providerFetch(
    fetchAdapter,
    FLY_ORIGIN,
    `/v1/apps/${encodeURIComponent(appName)}`,
    { method: "GET", headers: bearer(token) },
  );
  if (appResponse.status === 404) return { appName, machineId: null };
  if (appResponse.status !== 200) {
    throw new AcceptanceProviderError("acceptance_provider_unavailable", true, "provider_rejected");
  }
  const app = objectRecord(await readJson(appResponse));
  if (app.organization !== undefined && app.organization !== env.ACCEPTANCE_FLY_ORGANIZATION_SLUG) {
    throw new AcceptanceProviderError("acceptance_scope_mismatch", false, "integrity_failure");
  }
  const machinesResponse = await providerFetch(
    fetchAdapter,
    FLY_ORIGIN,
    `/v1/apps/${encodeURIComponent(appName)}/machines?metadata.nabuflow_acceptance_lease=${encodeURIComponent(lease.leaseId)}`,
    { method: "GET", headers: bearer(token) },
  );
  if (machinesResponse.status !== 200) {
    throw new AcceptanceProviderError("acceptance_provider_unavailable", true, "provider_rejected");
  }
  const machinesBody = await readJson(machinesResponse);
  const machines = Array.isArray(machinesBody)
    ? machinesBody
    : Array.isArray((machinesBody as Record<string, unknown>)?.machines)
      ? ((machinesBody as Record<string, unknown>).machines as unknown[])
      : [];
  const machine = machines.map((value) => objectRecord(value))[0];
  return { appName, machineId: machine === undefined ? null : requiredString(machine.id) };
}

async function discoverResource(
  fetchAdapter: AcceptanceProviderFetch,
  env: AcceptanceProvisionerBindings,
  lease: StoredAcceptanceLease,
): Promise<StoredAcceptanceLease["resource"]> {
  if (lease.resource !== null) return lease.resource;
  if (lease.scope.provider === "neon") {
    const projectId = await neonProjectId(fetchAdapter, env, lease);
    return projectId === null
      ? null
      : { provider: "neon", ids: [projectId], createdByLease: true, configurationWritten: false };
  }
  if (lease.scope.provider === "stripe") {
    const intentId = await stripeIntentId(fetchAdapter, env, lease);
    return intentId === null
      ? null
      : { provider: "stripe", ids: [intentId], createdByLease: true, configurationWritten: false };
  }
  const found = await flyResource(fetchAdapter, env, lease);
  return found.machineId === null
    ? null
    : {
        provider: "fly",
        ids: [found.appName, found.machineId],
        createdByLease: true,
        configurationWritten: false,
      };
}

async function neonCreate(
  fetchAdapter: AcceptanceProviderFetch,
  env: AcceptanceProvisionerBindings,
  lease: StoredAcceptanceLease,
): Promise<AcceptanceProviderCreateResult> {
  const token = requiredSecret(env.ACCEPTANCE_NEON_MANAGEMENT_KEY);
  const existingProjectId = await neonProjectId(fetchAdapter, env, lease);
  if (existingProjectId !== null) {
    return {
      resource: {
        provider: "neon",
        ids: [existingProjectId],
        createdByLease: true,
        configurationWritten: false,
      },
      material: {
        kind: "neon-connection-string",
        value: await neonConnectionUrl(fetchAdapter, env, existingProjectId),
      },
      costAmountMinorUnits: 0,
    };
  }
  const name = await providerResourceName(lease);
  const response = await providerFetch(
    fetchAdapter,
    NEON_ORIGIN,
    `/api/v2/projects?org_id=${encodeURIComponent(env.ACCEPTANCE_NEON_ORGANIZATION_ID)}`,
    {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({ project: { name } }),
    },
  );
  if (response.status !== 201) {
    throw new AcceptanceProviderError(
      response.status >= 500 ? "acceptance_provider_unavailable" : "acceptance_provider_rejected",
      response.status >= 500 || response.status === 423,
      "provider_rejected",
    );
  }
  const body = objectRecord(await readJson(response));
  const project = objectRecord(body.project);
  const projectId = requiredString(project.id);
  const connectionUris = Array.isArray(body.connection_uris) ? body.connection_uris : [];
  const firstUri = connectionUris[0];
  const connectionUrl = requiredString(
    typeof firstUri === "object" && firstUri !== null
      ? (firstUri as Record<string, unknown>).connection_uri
      : body.connection_uri,
  );
  let parsed: URL;
  try {
    parsed = new URL(connectionUrl);
  } catch {
    throw new AcceptanceProviderError("acceptance_provider_rejected", false, "malformed_response");
  }
  if (
    !["postgres:", "postgresql:"].includes(parsed.protocol) ||
    !parsed.hostname.endsWith(".neon.tech")
  ) {
    throw new AcceptanceProviderError("acceptance_provider_rejected", false, "integrity_failure");
  }
  return {
    resource: {
      provider: "neon",
      ids: [projectId],
      createdByLease: true,
      configurationWritten: false,
    },
    material: { kind: "neon-connection-string", value: connectionUrl },
    costAmountMinorUnits: 0,
  };
}

async function stripeCreate(
  fetchAdapter: AcceptanceProviderFetch,
  env: AcceptanceProvisionerBindings,
  lease: StoredAcceptanceLease,
): Promise<AcceptanceProviderCreateResult> {
  const token = requiredSecret(
    env.ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY,
    /^r[k]_test_[A-Za-z0-9]+$/u,
  );
  const body = new URLSearchParams({
    amount: "50",
    currency: "usd",
    confirm: "false",
    "metadata[nabuflow_acceptance_lease]": lease.leaseId,
  });
  const response = await providerFetch(fetchAdapter, STRIPE_ORIGIN, "/v1/payment_intents", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/x-www-form-urlencoded",
      "idempotency-key": `nabu-accept-${lease.identityHash}`,
    },
    body,
  });
  if (response.status !== 200) {
    throw new AcceptanceProviderError(
      response.status >= 500 || response.status === 429
        ? "acceptance_provider_unavailable"
        : "acceptance_provider_rejected",
      response.status >= 500 || response.status === 429,
      "provider_rejected",
    );
  }
  const result = objectRecord(await readJson(response));
  if (result.livemode !== false) {
    throw new AcceptanceProviderError(
      "acceptance_live_target_forbidden",
      false,
      "integrity_failure",
    );
  }
  return {
    resource: {
      provider: "stripe",
      ids: [requiredString(result.id)],
      createdByLease: true,
      configurationWritten: false,
    },
    material: null,
    costAmountMinorUnits: 0,
  };
}

async function flyCreate(
  fetchAdapter: AcceptanceProviderFetch,
  env: AcceptanceProvisionerBindings,
  lease: StoredAcceptanceLease,
): Promise<AcceptanceProviderCreateResult> {
  const token = requiredSecret(env.ACCEPTANCE_FLY_ORG_TOKEN);
  const digest = await sha256Hex(lease.leaseId);
  const found = await flyResource(fetchAdapter, env, lease);
  const appName = found.appName;
  if (found.machineId !== null) {
    return {
      resource: {
        provider: "fly",
        ids: [appName, found.machineId],
        createdByLease: true,
        configurationWritten: false,
      },
      material: null,
      costAmountMinorUnits: 0,
    };
  }
  const appResponse = await providerFetch(fetchAdapter, FLY_ORIGIN, "/v1/apps", {
    method: "POST",
    headers: bearer(token),
    body: JSON.stringify({ app_name: appName, org_slug: env.ACCEPTANCE_FLY_ORGANIZATION_SLUG }),
  });
  if (appResponse.status !== 201 && appResponse.status !== 200 && appResponse.status !== 422) {
    throw new AcceptanceProviderError(
      appResponse.status >= 500
        ? "acceptance_provider_unavailable"
        : "acceptance_provider_rejected",
      appResponse.status >= 500,
      "provider_rejected",
    );
  }
  const machineResponse = await providerFetch(
    fetchAdapter,
    FLY_ORIGIN,
    `/v1/apps/${encodeURIComponent(appName)}/machines`,
    {
      method: "POST",
      headers: bearer(token),
      body: JSON.stringify({
        name: `accept-${digest.slice(0, 12)}`,
        skip_launch: true,
        config: {
          image: env.ACCEPTANCE_FLY_IMAGE_REF,
          env: { NABUFLOW_ACCEPTANCE_LEASE: lease.leaseId },
          metadata: { nabuflow_acceptance_lease: lease.leaseId },
        },
      }),
    },
  );
  if (machineResponse.status !== 200 && machineResponse.status !== 201) {
    throw new AcceptanceProviderError(
      machineResponse.status >= 500
        ? "acceptance_provider_unavailable"
        : "acceptance_provider_rejected",
      machineResponse.status >= 500,
      "provider_rejected",
    );
  }
  const machine = objectRecord(await readJson(machineResponse));
  return {
    resource: {
      provider: "fly",
      ids: [appName, requiredString(machine.id)],
      createdByLease: true,
      configurationWritten: false,
    },
    material: null,
    costAmountMinorUnits: 0,
  };
}

export class NativeAcceptanceProviderAdapters implements AcceptanceProviderAdapters {
  constructor(
    private readonly env: AcceptanceProvisionerBindings,
    private readonly fetchAdapter: AcceptanceProviderFetch = nativeProviderFetch,
  ) {}

  async create(lease: StoredAcceptanceLease): Promise<AcceptanceProviderCreateResult> {
    assertProviderScope(lease, this.env);
    if (lease.scope.provider === "neon") return neonCreate(this.fetchAdapter, this.env, lease);
    if (lease.scope.provider === "stripe") return stripeCreate(this.fetchAdapter, this.env, lease);
    return flyCreate(this.fetchAdapter, this.env, lease);
  }

  async writeFlyDatabaseUrl(lease: StoredAcceptanceLease, databaseUrl: string): Promise<void> {
    assertProviderScope(lease, this.env);
    if (
      lease.scope.provider !== "fly" ||
      lease.resource?.provider !== "fly" ||
      lease.resource.ids.length !== 2 ||
      !lease.resource.createdByLease
    ) {
      throw new AcceptanceProviderError("acceptance_scope_mismatch", false, "pre_dispatch");
    }
    let parsed: URL;
    try {
      parsed = new URL(databaseUrl);
    } catch {
      throw new AcceptanceProviderError("acceptance_provider_rejected", false, "pre_dispatch");
    }
    if (
      !["postgres:", "postgresql:"].includes(parsed.protocol) ||
      !parsed.hostname.endsWith(".neon.tech")
    ) {
      throw new AcceptanceProviderError("acceptance_provider_rejected", false, "pre_dispatch");
    }
    const token = requiredSecret(this.env.ACCEPTANCE_FLY_ORG_TOKEN);
    const [appName, machineId] = lease.resource.ids;
    const currentResponse = await providerFetch(
      this.fetchAdapter,
      FLY_ORIGIN,
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      { method: "GET", headers: bearer(token) },
    );
    if (currentResponse.status !== 200) {
      throw new AcceptanceProviderError("acceptance_provider_rejected", false, "provider_rejected");
    }
    const machine = objectRecord(await readJson(currentResponse));
    const config = objectRecord(machine.config);
    const metadata = objectRecord(config.metadata ?? {});
    if (metadata.nabuflow_acceptance_lease !== lease.leaseId) {
      throw new AcceptanceProviderError("acceptance_scope_mismatch", false, "integrity_failure");
    }
    const existingEnv = objectRecord(config.env ?? {});
    const patchResponse = await providerFetch(
      this.fetchAdapter,
      FLY_ORIGIN,
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
      {
        method: "POST",
        headers: bearer(token),
        body: JSON.stringify({
          skip_launch: true,
          config: { ...config, env: { ...existingEnv, DATABASE_URL: databaseUrl } },
        }),
      },
    );
    if (patchResponse.status !== 200) {
      throw new AcceptanceProviderError(
        patchResponse.status >= 500
          ? "acceptance_provider_unavailable"
          : "acceptance_provider_rejected",
        patchResponse.status >= 500,
        "provider_rejected",
      );
    }
  }

  async destroy(lease: StoredAcceptanceLease): Promise<void> {
    assertProviderScope(lease, this.env);
    const discovered = await discoverResource(this.fetchAdapter, this.env, lease);
    if (discovered === null) {
      if (lease.scope.provider === "fly") {
        const token = requiredSecret(this.env.ACCEPTANCE_FLY_ORG_TOKEN);
        const appName = await providerResourceName(lease);
        const appDelete = await providerFetch(
          this.fetchAdapter,
          FLY_ORIGIN,
          `/v1/apps/${encodeURIComponent(appName)}?force=true`,
          { method: "DELETE", headers: bearer(token) },
        );
        if (![200, 202, 204, 404].includes(appDelete.status)) {
          throw new AcceptanceProviderError(
            "acceptance_provider_unavailable",
            true,
            "provider_rejected",
          );
        }
      }
      return;
    }
    if (!discovered.createdByLease || discovered.provider !== lease.scope.provider) {
      throw new AcceptanceProviderError("acceptance_scope_mismatch", false, "integrity_failure");
    }
    const resourceLease = { ...lease, resource: discovered };
    if (lease.scope.provider === "neon") {
      const token = requiredSecret(this.env.ACCEPTANCE_NEON_MANAGEMENT_KEY);
      const response = await providerFetch(
        this.fetchAdapter,
        NEON_ORIGIN,
        `/api/v2/projects/${encodeURIComponent(discovered.ids[0])}`,
        { method: "DELETE", headers: bearer(token) },
      );
      if (![200, 204, 404].includes(response.status)) {
        throw new AcceptanceProviderError(
          "acceptance_provider_unavailable",
          true,
          "provider_rejected",
        );
      }
      return;
    }
    if (lease.scope.provider === "stripe") {
      const token = requiredSecret(
        this.env.ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY,
        /^r[k]_test_[A-Za-z0-9]+$/u,
      );
      const response = await providerFetch(
        this.fetchAdapter,
        STRIPE_ORIGIN,
        `/v1/payment_intents/${encodeURIComponent(discovered.ids[0])}/cancel`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/x-www-form-urlencoded",
          },
        },
      );
      if (![200, 400].includes(response.status)) {
        throw new AcceptanceProviderError(
          "acceptance_provider_unavailable",
          true,
          "provider_rejected",
        );
      }
      return;
    }
    const token = requiredSecret(this.env.ACCEPTANCE_FLY_ORG_TOKEN);
    const [appName, machineId] = resourceLease.resource!.ids;
    const machineDelete = await providerFetch(
      this.fetchAdapter,
      FLY_ORIGIN,
      `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}?force=true`,
      { method: "DELETE", headers: bearer(token) },
    );
    if (![200, 204, 404].includes(machineDelete.status)) {
      throw new AcceptanceProviderError(
        "acceptance_provider_unavailable",
        true,
        "provider_rejected",
      );
    }
    const appDelete = await providerFetch(
      this.fetchAdapter,
      FLY_ORIGIN,
      `/v1/apps/${encodeURIComponent(appName)}?force=true`,
      { method: "DELETE", headers: bearer(token) },
    );
    if (![200, 202, 204, 404].includes(appDelete.status)) {
      throw new AcceptanceProviderError(
        "acceptance_provider_unavailable",
        true,
        "provider_rejected",
      );
    }
  }

  async verifyGone(lease: StoredAcceptanceLease): Promise<AcceptanceProviderGoneResult> {
    assertProviderScope(lease, this.env);
    const discovered = await discoverResource(this.fetchAdapter, this.env, lease);
    if (discovered === null) {
      if (lease.scope.provider === "fly") {
        const token = requiredSecret(this.env.ACCEPTANCE_FLY_ORG_TOKEN);
        const appName = await providerResourceName(lease);
        const app = await providerFetch(
          this.fetchAdapter,
          FLY_ORIGIN,
          `/v1/apps/${encodeURIComponent(appName)}`,
          { method: "GET", headers: bearer(token) },
        );
        const gone = app.status === 404;
        return { resourcesGone: gone, configurationGone: gone, costAmountMinorUnits: 0 };
      }
      return { resourcesGone: true, configurationGone: true, costAmountMinorUnits: 0 };
    }
    const resourceLease = { ...lease, resource: discovered };
    if (lease.scope.provider === "neon") {
      const token = requiredSecret(this.env.ACCEPTANCE_NEON_MANAGEMENT_KEY);
      const response = await providerFetch(
        this.fetchAdapter,
        NEON_ORIGIN,
        `/api/v2/projects/${encodeURIComponent(discovered.ids[0])}`,
        { method: "GET", headers: bearer(token) },
      );
      return {
        resourcesGone: response.status === 404,
        configurationGone: response.status === 404,
        costAmountMinorUnits: 0,
      };
    }
    if (lease.scope.provider === "stripe") {
      const token = requiredSecret(
        this.env.ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY,
        /^r[k]_test_[A-Za-z0-9]+$/u,
      );
      const response = await providerFetch(
        this.fetchAdapter,
        STRIPE_ORIGIN,
        `/v1/payment_intents/${encodeURIComponent(discovered.ids[0])}`,
        { method: "GET", headers: { authorization: `Bearer ${token}` } },
      );
      if (response.status !== 200 && response.status !== 404) {
        throw new AcceptanceProviderError(
          "acceptance_provider_unavailable",
          true,
          "provider_rejected",
        );
      }
      if (response.status === 404) {
        return { resourcesGone: true, configurationGone: true, costAmountMinorUnits: 0 };
      }
      const intent = objectRecord(await readJson(response));
      if (intent.livemode !== false) {
        throw new AcceptanceProviderError(
          "acceptance_live_target_forbidden",
          false,
          "integrity_failure",
        );
      }
      const canceled = intent.status === "canceled";
      return { resourcesGone: canceled, configurationGone: canceled, costAmountMinorUnits: 0 };
    }
    const token = requiredSecret(this.env.ACCEPTANCE_FLY_ORG_TOKEN);
    const [appName, machineId] = resourceLease.resource!.ids;
    const [machine, app] = await Promise.all([
      providerFetch(
        this.fetchAdapter,
        FLY_ORIGIN,
        `/v1/apps/${encodeURIComponent(appName)}/machines/${encodeURIComponent(machineId)}`,
        { method: "GET", headers: bearer(token) },
      ),
      providerFetch(this.fetchAdapter, FLY_ORIGIN, `/v1/apps/${encodeURIComponent(appName)}`, {
        method: "GET",
        headers: bearer(token),
      }),
    ]);
    const gone = machine.status === 404 && app.status === 404;
    return { resourcesGone: gone, configurationGone: gone, costAmountMinorUnits: 0 };
  }

  async reconcile(
    leases: StoredAcceptanceLease[],
    nowMs: number,
  ): Promise<{ inspected: number; reclaimed: number }> {
    let reclaimed = 0;
    for (const lease of leases) {
      assertProviderScope(lease, this.env);
      if (
        lease.resource === null ||
        (lease.expiresAtMs > nowMs && lease.state !== "destroyed" && lease.state !== "failed")
      ) {
        continue;
      }
      const before = await this.verifyGone(lease);
      if (before.resourcesGone && before.configurationGone) continue;
      await this.destroy(lease);
      const after = await this.verifyGone(lease);
      if (!after.resourcesGone || !after.configurationGone) {
        throw new AcceptanceProviderError(
          "acceptance_cleanup_incomplete",
          true,
          "provider_rejected",
        );
      }
      reclaimed += 1;
    }
    return { inspected: leases.length, reclaimed };
  }
}
