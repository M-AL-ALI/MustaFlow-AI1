import { afterEach, describe, expect, it, vi } from "vitest";
import type { AcceptanceLeaseResponse } from "@workspace/tenant-runtime-contracts";
import { AcceptanceVaultDurableObject } from "../src/acceptance-vault-durable-object";
import type {
  AcceptanceProviderAdapters,
  AcceptanceProviderCreateResult,
  AcceptanceProviderGoneResult,
  AcceptanceProvisionerBindings,
  AcceptanceQueueMessage,
  AcceptanceWorkloadIdentity,
  AcceptanceWorkloadVerifier,
  StoredAcceptanceLease,
} from "../src/acceptance-provisioner-model";
import { AcceptanceProviderError } from "../src/acceptance-provider-adapters";
import {
  AcceptanceProvisionerService,
  handleAcceptanceQueue,
  handleAcceptanceScheduled,
} from "../src/acceptance-provisioner-worker";
import { ControlDurableObject } from "../src/control-durable-object";
import type { DurableOperationQueueMessage, StoredDurableOperationJob } from "../src/model";

const NOW_MS = Date.parse("2026-08-11T12:00:00.000Z");
const TEST_KEK = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const RESTRICTED_TEST_KEY = `rk_${"test"}_${"R".repeat(32)}`;
const DATABASE_URL = `postgresql://${"user"}:${"pass"}@fixture.neon.tech/db`;

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let count = 0;
      for (const item of key) if (this.values.delete(item)) count += 1;
      return count;
    }
    return this.values.delete(key);
  }

  async list<T>(options: { prefix?: string; limit?: number } = {}): Promise<Map<string, T>> {
    return new Map(
      [...this.values.entries()]
        .filter(([key]) => key.startsWith(options.prefix ?? ""))
        .slice(0, options.limit)
        .map(([key, value]) => [key, structuredClone(value) as T]),
    );
  }

  async transaction<T>(callback: (transaction: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  async setAlarm(value: number): Promise<void> {
    this.alarm = value;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarm;
  }

  async deleteAlarm(): Promise<void> {
    this.alarm = null;
  }

  serialized(): string {
    return JSON.stringify([...this.values.entries()]);
  }
}

class MemoryQueue {
  readonly messages: AcceptanceQueueMessage[] = [];
  sendAttempts = 0;
  failNextSend = false;

  async send(message: AcceptanceQueueMessage): Promise<void> {
    this.sendAttempts += 1;
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("injected queue send failure");
    }
    this.messages.push(structuredClone(message));
  }
}

class FakeProviders implements AcceptanceProviderAdapters {
  calls = { create: 0, flySecret: 0, destroy: 0, verify: 0, reconcile: 0 };
  failDestroy = false;
  readonly resources = new Map<string, { gone: boolean; configuration: boolean }>();

  async create(lease: StoredAcceptanceLease): Promise<AcceptanceProviderCreateResult> {
    this.calls.create += 1;
    this.resources.set(lease.leaseId, { gone: false, configuration: false });
    return {
      resource: {
        provider: lease.scope.provider,
        ids: [`resource_${lease.leaseId.slice(4, 16)}`],
        createdByLease: true,
        configurationWritten: false,
      },
      material:
        lease.scope.provider === "neon"
          ? { kind: "neon-connection-string", value: DATABASE_URL }
          : null,
      costAmountMinorUnits: 0,
    };
  }

  async writeFlyDatabaseUrl(lease: StoredAcceptanceLease, databaseUrl: string): Promise<void> {
    this.calls.flySecret += 1;
    expect(lease.scope.provider).toBe("fly");
    expect(databaseUrl).toBe(DATABASE_URL);
    const resource = this.resources.get(lease.leaseId);
    if (resource === undefined) throw new Error("missing fake resource");
    resource.configuration = true;
  }

  async destroy(lease: StoredAcceptanceLease): Promise<void> {
    this.calls.destroy += 1;
    if (this.failDestroy) {
      throw new AcceptanceProviderError("acceptance_provider_unavailable", true, "timeout");
    }
    const resource = this.resources.get(lease.leaseId);
    if (resource !== undefined) {
      resource.gone = true;
      resource.configuration = false;
    }
  }

  async verifyGone(lease: StoredAcceptanceLease): Promise<AcceptanceProviderGoneResult> {
    this.calls.verify += 1;
    const resource = this.resources.get(lease.leaseId);
    return {
      resourcesGone: resource === undefined || resource.gone,
      configurationGone: resource === undefined || !resource.configuration,
      costAmountMinorUnits: 0,
    };
  }

  async reconcile(leases: StoredAcceptanceLease[], nowMs: number) {
    this.calls.reconcile += 1;
    let reclaimed = 0;
    for (const lease of leases) {
      if (lease.expiresAtMs > nowMs) continue;
      const resource = this.resources.get(lease.leaseId);
      if (resource !== undefined && !resource.gone) {
        resource.gone = true;
        resource.configuration = false;
        reclaimed += 1;
      }
    }
    return { inspected: leases.length, reclaimed };
  }
}

class FakeCapabilityVault {
  readonly database = new Map<number, { revision: string; credential: string }>();
  readonly stripe = new Map<number, { revision: string; credential: string }>();

  async provisionDatabase(input: {
    projectId: number;
    revision: string;
    credential: { value: string };
  }) {
    this.database.set(input.projectId, {
      revision: input.revision,
      credential: input.credential.value,
    });
    return { state: "provisioned" as const, keyId: "v1" };
  }

  async provisionStripe(input: {
    projectId: number;
    revision: string;
    credential: { value: string };
  }) {
    this.stripe.set(input.projectId, {
      revision: input.revision,
      credential: input.credential.value,
    });
    return { state: "provisioned" as const, keyId: "v1" };
  }

  async revokeDatabase(input: { projectId: number; expectedRevision: string }) {
    const current = this.database.get(input.projectId);
    if (current === undefined) return "not_found" as const;
    if (current.revision !== input.expectedRevision) return "conflict" as const;
    this.database.delete(input.projectId);
    return "revoked" as const;
  }

  async revokeStripe(input: { projectId: number; expectedRevision: string }) {
    const current = this.stripe.get(input.projectId);
    if (current === undefined) return "not_found" as const;
    if (current.revision !== input.expectedRevision) return "conflict" as const;
    this.stripe.delete(input.projectId);
    return "revoked" as const;
  }
}

function namespace<T>(value: T): DurableObjectNamespace<never> {
  return {
    idFromName: () => ({}) as DurableObjectId,
    get: () => value,
  } as unknown as DurableObjectNamespace<never>;
}

function identity(subject: string): AcceptanceWorkloadIdentity {
  return {
    subject,
    subjectHash: subject === "runner-a" ? "a".repeat(64) : "b".repeat(64),
    tokenId: `token-${subject}-0000000000`,
    expiresAtMs: NOW_MS + 600_000,
  };
}

function request(
  path: string,
  body: unknown,
  options: { subject?: string; idempotency?: string; method?: string } = {},
): Request {
  return new Request(`https://acceptance.invalid${path}`, {
    method: options.method ?? "POST",
    headers: {
      authorization: `Bearer ${options.subject ?? "runner-a"}`,
      "content-type": "application/json",
      ...(options.idempotency === undefined ? {} : { "idempotency-key": options.idempotency }),
    },
    body: options.method === "GET" ? undefined : JSON.stringify(body),
  });
}

interface Fixture {
  env: AcceptanceProvisionerBindings;
  service: AcceptanceProvisionerService;
  queue: MemoryQueue;
  control: ControlDurableObject;
  vault: AcceptanceVaultDurableObject;
  vaultStorage: MemoryStorage;
  providers: FakeProviders;
  capabilities: FakeCapabilityVault;
}

function fixture(): Fixture {
  const queue = new MemoryQueue();
  const controlStorage = new MemoryStorage();
  const control = new ControlDurableObject(
    { storage: controlStorage } as unknown as DurableObjectState,
    { DURABLE_OPERATION_QUEUE: queue } as never,
  );
  const vaultStorage = new MemoryStorage();
  const capabilities = new FakeCapabilityVault();
  const env = {
    ACCEPTANCE_OPERATION_QUEUE: queue,
    DURABLE_OPERATION_QUEUE: queue,
    CF_VERSION_METADATA: {
      id: "acceptance-worker-test-v1",
      tag: "test",
      timestamp: "2026-08-11T12:00:00.000Z",
    },
    ACCEPTANCE_VAULT_KEK: TEST_KEK,
    ACCEPTANCE_STRIPE_TEST_RESTRICTED_KEY: RESTRICTED_TEST_KEY,
    ACCEPTANCE_WORKLOAD_PUBLIC_KEYS: "{}",
    ACCEPTANCE_WORKLOAD_ISSUER: "https://identity.invalid",
    ACCEPTANCE_WORKLOAD_AUDIENCE: "acceptance-test",
    ACCEPTANCE_WORKLOAD_SUBJECTS: '["runner-a","runner-b"]',
    ACCEPTANCE_NEON_ORGANIZATION_ID: "neon-dedicated",
    ACCEPTANCE_STRIPE_SANDBOX_ID: "stripe-dedicated",
    ACCEPTANCE_FLY_ORGANIZATION_SLUG: "fly-disposable",
    ACCEPTANCE_FLY_IMAGE_REF: "registry.invalid/image@sha256:fixture",
    ACCEPTANCE_PROVIDER_MAX_COST_MINOR_UNITS: "500",
    ACCEPTANCE_STAGING_ENABLED: "true",
  } as unknown as AcceptanceProvisionerBindings;
  const vaultObject = new AcceptanceVaultDurableObject(
    { storage: vaultStorage } as unknown as DurableObjectState,
    env,
  );
  env.ACCEPTANCE_COORDINATOR = namespace(control) as never;
  env.ACCEPTANCE_VAULT = namespace(vaultObject) as never;
  env.CAPABILITY_VAULT = namespace(capabilities) as never;
  const verifier: AcceptanceWorkloadVerifier = {
    async verify(input) {
      const authorization = input.headers.get("authorization");
      if (authorization === null || !authorization.startsWith("Bearer runner-")) return null;
      return identity(authorization.slice("Bearer ".length));
    },
  };
  const providers = new FakeProviders();
  return {
    env,
    service: new AcceptanceProvisionerService(env, verifier, providers),
    queue,
    control,
    vault: vaultObject,
    vaultStorage,
    providers,
    capabilities,
  };
}

async function drain(fixtureValue: Fixture): Promise<void> {
  while (fixtureValue.queue.messages.length > 0) {
    const message = fixtureValue.queue.messages.shift()!;
    if (message.kind === "acceptance-janitor") {
      await fixtureValue.service.handleJanitorSignal(message.leaseId);
    } else {
      await fixtureValue.service.handleQueue(message);
    }
  }
}

async function createLease(
  fixtureValue: Fixture,
  scope:
    | { provider: "neon"; organizationId: string }
    | { provider: "stripe"; sandboxId: string; mode: "test" }
    | { provider: "fly"; organizationSlug: string; disposable: true },
  idempotency: string,
  projectId = 42,
): Promise<AcceptanceLeaseResponse> {
  const first = await fixtureValue.service.handle(
    request(
      "/_nabuflow/acceptance/v1/leases",
      { schemaVersion: 1, projectId, scope, ttlSeconds: 300, costCeilingMinorUnits: 100 },
      { idempotency },
    ),
  );
  expect(first.status).toBe(202);
  const pending = (await first.json()) as AcceptanceLeaseResponse;
  await drain(fixtureValue);
  const status = await fixtureValue.service.handle(
    request(`/_nabuflow/acceptance/v1/leases/${pending.leaseId}/status`, {}, { method: "GET" }),
  );
  expect(status.status).toBe(200);
  return status.json() as Promise<AcceptanceLeaseResponse>;
}

afterEach(() => vi.useRealTimers());

describe("staging acceptance provisioner", () => {
  it("defers a durable lease job delivered to the wrong deployment version", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const created = await f.service.handle(
      request(
        "/_nabuflow/acceptance/v1/leases",
        {
          schemaVersion: 1,
          projectId: 42,
          scope: { provider: "neon", organizationId: "neon-dedicated" },
          ttlSeconds: 300,
          costCeilingMinorUnits: 0,
        },
        { idempotency: "deployment-version-deferral-0001" },
      ),
    );
    expect(created.status).toBe(202);
    const firstDelivery = f.queue.messages.shift() as DurableOperationQueueMessage;
    f.env.CF_VERSION_METADATA.id = "acceptance-worker-previous";
    await f.service.handleQueue(firstDelivery);
    expect(f.providers.calls.create).toBe(0);
    expect(f.queue.messages).toHaveLength(0);
    vi.setSystemTime(NOW_MS + 5_000);
    await f.control.alarm();
    expect(f.queue.messages).toHaveLength(1);
    const deferred = await f.control.getDurableOperation(firstDelivery.jobKey);
    expect(deferred).toMatchObject({ state: "active", attempt: 0, deploymentDeferralCount: 1 });
    expect(deferred?.events).toContainEqual(
      expect.objectContaining({
        event: "deployment-version-deferred",
        deploymentVersion: "acceptance-worker-previous",
      }),
    );

    f.env.CF_VERSION_METADATA.id = "acceptance-worker-test-v1";
    await f.service.handleQueue(f.queue.messages.shift() as DurableOperationQueueMessage);
    expect(f.providers.calls.create).toBe(1);
    const lease = (await created.json()) as AcceptanceLeaseResponse;
    const status = await f.service.handle(
      request(`/_nabuflow/acceptance/v1/leases/${lease.leaseId}/status`, {}, { method: "GET" }),
    );
    await expect(status.json()).resolves.toMatchObject({ state: "active", provider: "neon" });
  });

  it("terminalizes a disabled durable acceptance job before ack and prevents alarm redelivery", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const requestBody = {
      schemaVersion: 1,
      projectId: 42,
      scope: { provider: "neon", organizationId: "neon-dedicated" },
      ttlSeconds: 300,
      costCeilingMinorUnits: 0,
    } as const;
    const accepted = await f.service.handle(
      request("/_nabuflow/acceptance/v1/leases", requestBody, {
        idempotency: "disabled-durable-job-0001",
      }),
    );
    expect(accepted.status).toBe(202);
    const delivery = f.queue.messages.shift() as DurableOperationQueueMessage;
    const acks = [vi.fn(), vi.fn()];
    const retries = [vi.fn(), vi.fn()];
    f.env.ACCEPTANCE_STAGING_ENABLED = "false";

    await handleAcceptanceQueue(
      {
        messages: [
          { body: delivery, ack: acks[0], retry: retries[0] },
          {
            body: {
              schemaVersion: 1,
              kind: "acceptance-janitor",
              leaseId: `nal_${"a".repeat(40)}`,
            },
            ack: acks[1],
            retry: retries[1],
          },
        ],
      } as unknown as MessageBatch<AcceptanceQueueMessage>,
      f.env,
    );
    expect(acks[0]).toHaveBeenCalledOnce();
    expect(acks[1]).toHaveBeenCalledOnce();
    expect(retries[0]).not.toHaveBeenCalled();
    expect(retries[1]).not.toHaveBeenCalled();
    const terminal = await f.control.getDurableOperation(delivery.jobKey);
    expect(terminal).toMatchObject({
      state: "failed",
      ownerId: null,
      leaseUntilMs: null,
      abandonAtMs: null,
      response: {
        status: 503,
        body: {
          ok: false,
          code: "acceptance_cleanup_disabled",
          message: "Acceptance cleanup is disabled",
          retryable: false,
        },
      },
    });
    expect(terminal?.events.at(-1)).toMatchObject({ event: "policy-disabled-terminal" });

    vi.setSystemTime(NOW_MS + 60_000);
    await f.control.alarm();
    expect(f.queue.messages).toHaveLength(0);
    expect((await f.control.getDurableOperation(delivery.jobKey))?.events).not.toContainEqual(
      expect.objectContaining({ event: "alarm-redelivery" }),
    );

    f.env.ACCEPTANCE_STAGING_ENABLED = "true";
    const replay = await f.service.handle(
      request("/_nabuflow/acceptance/v1/leases", requestBody, {
        idempotency: "disabled-durable-job-0001",
      }),
    );
    expect(replay.status).toBe(503);
    await expect(replay.json()).resolves.toMatchObject({
      code: "acceptance_cleanup_disabled",
      retryable: false,
    });
  });

  it("creates an opaque idempotent lease with encrypted material and no response leakage", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "neon", organizationId: "neon-dedicated" },
      "create-neon-idempotency-0001",
    );
    expect(lease).toMatchObject({
      provider: "neon",
      state: "active",
      resourceIds: [expect.any(String)],
    });
    expect(f.providers.calls.create).toBe(1);
    expect(f.vaultStorage.serialized()).not.toContain(DATABASE_URL);
    expect(JSON.stringify(lease)).not.toMatch(
      /postgres(?:ql)?:|neon\.tech|r[k]_test_|s[k]_test_/iu,
    );

    const replay = await f.service.handle(
      request(
        "/_nabuflow/acceptance/v1/leases",
        {
          schemaVersion: 1,
          projectId: 42,
          scope: { provider: "neon", organizationId: "neon-dedicated" },
          ttlSeconds: 300,
          costCeilingMinorUnits: 100,
        },
        { idempotency: "create-neon-idempotency-0001" },
      ),
    );
    expect(replay.status).toBe(201);
    expect(f.providers.calls.create).toBe(1);
  });

  it("rejects unauthenticated, cross-lease, cross-org, cross-sandbox, live, and cost targets before providers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const unauthorized = await f.service.handle(
      new Request("https://acceptance.invalid/_nabuflow/acceptance/v1/leases", {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": "unauthorized-00000001" },
        body: JSON.stringify({}),
      }),
    );
    expect(unauthorized.status).toBe(401);

    const lease = await createLease(
      f,
      { provider: "stripe", sandboxId: "stripe-dedicated", mode: "test" },
      "create-stripe-idempotency-0001",
    );
    const crossLease = await f.service.handle(
      request(
        `/_nabuflow/acceptance/v1/leases/${lease.leaseId}/status`,
        {},
        { subject: "runner-b", method: "GET" },
      ),
    );
    const missing = await f.service.handle(
      request(
        `/_nabuflow/acceptance/v1/leases/nal_${"f".repeat(40)}/status`,
        {},
        { subject: "runner-b", method: "GET" },
      ),
    );
    const crossBody = (await crossLease.json()) as Record<string, unknown>;
    const missingBody = (await missing.json()) as Record<string, unknown>;
    delete crossBody.requestId;
    delete missingBody.requestId;
    expect(crossLease.status).toBe(403);
    expect(missing.status).toBe(403);
    expect(crossBody).toEqual(missingBody);

    const antiEnumerationBodies: Array<Record<string, unknown>> = [];
    for (const invalid of [
      { provider: "neon", organizationId: "foreign-org" },
      { provider: "stripe", sandboxId: "foreign-sandbox", mode: "test" },
      { provider: "fly", organizationSlug: "production", disposable: true },
    ]) {
      const response = await f.service.handle(
        request(
          "/_nabuflow/acceptance/v1/leases",
          {
            schemaVersion: 1,
            projectId: 42,
            scope: invalid,
            ttlSeconds: 300,
            costCeilingMinorUnits: 100,
          },
          { idempotency: `invalid-target-${JSON.stringify(invalid).length}-0000` },
        ),
      );
      expect(response.status).toBe(403);
      const responseBody = (await response.json()) as Record<string, unknown>;
      delete responseBody.requestId;
      antiEnumerationBodies.push(responseBody);
    }
    expect(antiEnumerationBodies[1]).toEqual(antiEnumerationBodies[0]);
    expect(antiEnumerationBodies[2]).toEqual(antiEnumerationBodies[0]);
    const liveMode = await f.service.handle(
      request(
        "/_nabuflow/acceptance/v1/leases",
        {
          schemaVersion: 1,
          projectId: 42,
          scope: { provider: "stripe", sandboxId: "stripe-dedicated", mode: "live" },
          ttlSeconds: 300,
          costCeilingMinorUnits: 100,
        },
        { idempotency: "invalid-live-mode-00000001" },
      ),
    );
    expect(liveMode.status).toBe(400);
    const overCost = await f.service.handle(
      request(
        "/_nabuflow/acceptance/v1/leases",
        {
          schemaVersion: 1,
          projectId: 42,
          scope: { provider: "neon", organizationId: "neon-dedicated" },
          ttlSeconds: 300,
          costCeilingMinorUnits: 501,
        },
        { idempotency: "over-cost-idempotency-0001" },
      ),
    );
    expect(overCost.status).toBe(403);
    expect(f.providers.calls.create).toBe(1);
  });

  it("provisions DB, restricted Stripe, and Fly configuration server-to-server without leaking values", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const neon = await createLease(
      f,
      { provider: "neon", organizationId: "neon-dedicated" },
      "create-neon-idempotency-0002",
    );
    const stripe = await createLease(
      f,
      { provider: "stripe", sandboxId: "stripe-dedicated", mode: "test" },
      "create-stripe-idempotency-0002",
    );
    const fly = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "create-fly-idempotency-0002",
    );

    const dbProvision = await f.service.handle(
      request(
        `/_nabuflow/acceptance/v1/leases/${neon.leaseId}/provision-capability`,
        { schemaVersion: 1, revision: "accept-db-v1" },
        { idempotency: "provision-db-idempotency-0001" },
      ),
    );
    expect(dbProvision.status).toBe(202);
    await drain(f);
    expect(f.capabilities.database.get(42)?.credential).toBe(DATABASE_URL);

    const stripeProvision = await f.service.handle(
      request(
        `/_nabuflow/acceptance/v1/leases/${stripe.leaseId}/provision-capability`,
        {
          schemaVersion: 1,
          revision: "accept-stripe-v1",
          stripePolicy: { allowedCurrencies: ["usd"], maxAmount: 50_000 },
        },
        { idempotency: "provision-stripe-idempotency-0001" },
      ),
    );
    expect(stripeProvision.status).toBe(202);
    await drain(f);
    expect(f.capabilities.stripe.get(42)?.credential).toBe(RESTRICTED_TEST_KEY);

    const flyProvision = await f.service.handle(
      request(
        `/_nabuflow/acceptance/v1/leases/${fly.leaseId}/provision-fly-secret`,
        { schemaVersion: 1, databaseLeaseId: neon.leaseId },
        { idempotency: "provision-fly-idempotency-0001" },
      ),
    );
    expect(flyProvision.status).toBe(202);
    await drain(f);
    expect(f.providers.calls.flySecret).toBe(1);
    const flyStatus = await f.service.handle(
      request(`/_nabuflow/acceptance/v1/leases/${fly.leaseId}/status`, {}, { method: "GET" }),
    );
    await expect(flyStatus.json()).resolves.toMatchObject({
      state: "provisioned",
      provider: "fly",
    });

    for (const response of [dbProvision, stripeProvision, flyProvision]) {
      const text = await response.clone().text();
      expect(text).not.toContain(DATABASE_URL);
      expect(text).not.toContain(RESTRICTED_TEST_KEY);
      expect(text).not.toMatch(/neon\.tech|r[k]_test_|postgres(?:ql)?:/iu);
    }
    const audit = await f.vault.listAudit();
    expect(JSON.stringify(audit)).not.toMatch(/neon\.tech|r[k]_test_|postgres(?:ql)?:/iu);
  });

  it("adopts a killed destroy consumer and reaches verified-gone without manual cleanup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "neon", organizationId: "neon-dedicated" },
      "create-neon-idempotency-0003",
    );
    const destroy = await f.service.handle(
      request(
        `/_nabuflow/acceptance/v1/leases/${lease.leaseId}/destroy`,
        { schemaVersion: 1 },
        { idempotency: "destroy-neon-idempotency-0001" },
      ),
    );
    expect(destroy.status).toBe(202);
    const queued = f.queue.messages.shift() as DurableOperationQueueMessage;
    const firstOwner = await f.control.claimDurableOperationDriver(
      queued.jobKey,
      "killed-owner",
      NOW_MS,
    );
    expect(firstOwner.state).toBe("claimed");
    vi.setSystemTime(NOW_MS + 16_001);
    await f.control.alarm();
    await drain(f);
    const status = await f.service.handle(
      request(`/_nabuflow/acceptance/v1/leases/${lease.leaseId}/status`, {}, { method: "GET" }),
    );
    await expect(status.json()).resolves.toMatchObject({ state: "destroyed" });
    expect(f.providers.resources.get(lease.leaseId)).toEqual({ gone: true, configuration: false });
    const jobs = await (
      f.control as unknown as {
        listRecentDurableOperations(input: unknown): Promise<StoredDurableOperationJob[]>;
      }
    ).listRecentDurableOperations({
      sinceMs: NOW_MS,
      untilMs: NOW_MS + 20_000,
      limit: 20,
      kind: "acceptance-lease",
    });
    expect(jobs.some((job) => job.events.some((event) => event.event === "driver-adopted"))).toBe(
      true,
    );
  });

  it("expires leases through the TTL alarm and independently reconciles residual fake resources", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "create-fly-idempotency-0003",
    );
    vi.setSystemTime(NOW_MS + 300_001);
    await f.vault.alarm();
    vi.setSystemTime(NOW_MS + 305_001);
    await f.control.alarm();
    await drain(f);
    expect(f.providers.resources.get(lease.leaseId)?.gone).toBe(true);

    f.providers.resources.get(lease.leaseId)!.gone = false;
    const reconciliation = await f.service.reconcileJanitor(Date.now());
    expect(reconciliation).toMatchObject({ reclaimed: 1 });
    expect(f.providers.resources.get(lease.leaseId)?.gone).toBe(true);
  });

  it("registers one coordinator-owned cleanup successor across repeated vault alarms", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "janitor-one-successor-0001",
    );
    vi.setSystemTime(NOW_MS + 300_001);
    await f.vault.alarm();
    await f.vault.alarm();
    expect(f.queue.messages).toHaveLength(0);
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "expired",
      cleanupDispatchState: "registered",
      cleanupDispatchAttempts: 1,
    });
    vi.setSystemTime(NOW_MS + 305_001);
    await f.control.alarm();
    expect(f.queue.messages).toHaveLength(1);
    await f.control.alarm();
    expect(f.queue.messages).toHaveLength(1);
  });

  it("stages a generation before enabled scheduled cleanup registers its job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "enabled-scheduled-generation-0001",
    );

    vi.setSystemTime(NOW_MS + 300_001);
    await handleAcceptanceScheduled(f.env, f.providers);

    const registered = await f.vault.getLeaseForJanitor(lease.leaseId);
    expect(registered).toMatchObject({
      state: "expired",
      cleanupDispatchGeneration: 1,
      cleanupDispatchState: "registered",
    });
    const job = await f.control.getDurableOperation(registered!.cleanupDispatchJobKey!);
    expect(job).toMatchObject({
      kind: "acceptance-lease",
      request: { operation: "destroy", cleanupGeneration: 1 },
    });
  });

  it("recovers a legacy destroying lease without a generation and proves it quiesced", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "legacy-destroying-recovery-0001",
    );
    const legacy = await f.vault.getLeaseForJanitor(lease.leaseId);
    expect(legacy).not.toBeNull();
    legacy!.state = "destroying";
    delete legacy!.cleanupDispatchGeneration;
    delete legacy!.cleanupDispatchState;
    delete legacy!.cleanupDispatchAttempts;
    delete legacy!.cleanupDispatchNextAttemptAtMs;
    delete legacy!.cleanupDispatchDeadlineMs;
    delete legacy!.cleanupDispatchJobKey;
    await f.vaultStorage.put(`lease:${lease.leaseId}`, legacy!);

    vi.setSystemTime(NOW_MS + 300_001);
    await handleAcceptanceScheduled(f.env, f.providers);
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "expired",
      cleanupDispatchGeneration: 1,
      cleanupDispatchState: "registered",
    });

    vi.setSystemTime(NOW_MS + 305_001);
    await f.control.alarm();
    await drain(f);
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "destroyed",
      cleanupDispatchGeneration: 1,
      cleanupDispatchState: "terminal",
    });
    expect(f.providers.resources.get(lease.leaseId)).toEqual({ gone: true, configuration: false });
  });

  it("fences a provider create that returns after cleanup policy terminalized its job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    let releaseCreate!: () => void;
    let observeCreate!: () => void;
    const createReleased = new Promise<void>((resolve) => {
      releaseCreate = resolve;
    });
    const createObserved = new Promise<void>((resolve) => {
      observeCreate = resolve;
    });
    const nativeCreate = f.providers.create.bind(f.providers);
    vi.spyOn(f.providers, "create").mockImplementationOnce(async (lease) => {
      observeCreate();
      await createReleased;
      return nativeCreate(lease);
    });

    const response = await f.service.handle(
      request(
        "/_nabuflow/acceptance/v1/leases",
        {
          schemaVersion: 1,
          projectId: 42,
          scope: { provider: "neon", organizationId: "neon-dedicated" },
          ttlSeconds: 300,
          costCeilingMinorUnits: 100,
        },
        { idempotency: "late-provider-create-fence-0001" },
      ),
    );
    const pending = (await response.json()) as AcceptanceLeaseResponse;
    const createMessage = f.queue.messages.shift() as DurableOperationQueueMessage;
    const processing = f.service.handleQueue(createMessage);
    await createObserved;

    f.env.ACCEPTANCE_STAGING_ENABLED = "false";
    await f.control.terminalizeDisabledAcceptanceOperation(createMessage.jobKey, Date.now());
    await f.vault.alarm();
    expect(await f.vault.getLeaseForJanitor(pending.leaseId)).toMatchObject({
      state: "expired",
      cleanupDispatchGeneration: 1,
      cleanupDispatchState: "registered",
      resource: null,
    });

    releaseCreate();
    await processing;
    expect(await f.vault.getLeaseForJanitor(pending.leaseId)).toMatchObject({
      state: "failed",
      cleanupDispatchGeneration: 2,
      cleanupDispatchState: "pending",
      resource: { provider: "neon" },
    });
    expect(f.providers.resources.get(pending.leaseId)?.gone).toBe(false);

    await f.vault.alarm();
    vi.setSystemTime(NOW_MS + 5_001);
    await f.control.alarm();
    await drain(f);
    expect(f.providers.resources.get(pending.leaseId)).toEqual({
      gone: true,
      configuration: false,
    });
    expect(await f.vault.getLeaseForJanitor(pending.leaseId)).toMatchObject({
      state: "destroyed",
      cleanupDispatchGeneration: 2,
      cleanupDispatchState: "terminal",
    });
  });

  it("mints a fenced cleanup successor when the coordinator deadline terminalizes a registered job", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "cleanup-control-deadline-0001",
    );
    f.env.ACCEPTANCE_STAGING_ENABLED = "false";
    await handleAcceptanceScheduled(f.env);
    const registered = await f.vault.getLeaseForJanitor(lease.leaseId);
    expect(registered).toMatchObject({
      cleanupDispatchGeneration: 1,
      cleanupDispatchState: "registered",
    });
    const cleanupJob = await f.control.getDurableOperation(registered!.cleanupDispatchJobKey!);
    expect(cleanupJob?.kind).toBe("acceptance-lease");
    const terminalAt = cleanupJob!.deadlineMs + 1;
    await expect(
      f.control.recordDurableOperationDeploymentObservation(
        cleanupJob!.jobKey,
        f.env.CF_VERSION_METADATA.id,
        terminalAt,
        cleanupJob!.deploymentDeferralCount ?? 0,
      ),
    ).resolves.toBe("terminal");

    vi.setSystemTime(terminalAt);
    await f.vault.alarm();
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "expired",
      cleanupDispatchGeneration: 2,
      cleanupDispatchState: "registered",
      cleanupDispatchAttempts: 2,
    });
    expect(await f.vault.listAudit()).toContainEqual(
      expect.objectContaining({
        operation: "destroy",
        outcome: "retrying:acceptance_operation_timeout",
      }),
    );

    vi.setSystemTime(terminalAt + 5_001);
    await f.control.alarm();
    await drain(f);
    expect(f.providers.resources.get(lease.leaseId)?.gone).toBe(true);
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "destroyed",
      cleanupDispatchState: "terminal",
    });
  });

  it("mints a fenced cleanup successor when deployment deferrals reach their cap", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "cleanup-control-deployment-cap-0001",
    );
    f.env.ACCEPTANCE_STAGING_ENABLED = "false";
    await handleAcceptanceScheduled(f.env);
    const registered = await f.vault.getLeaseForJanitor(lease.leaseId);
    let cleanupJob = await f.control.getDurableOperation(registered!.cleanupDispatchJobKey!);
    let disposition: string = "deferred";
    for (let attempt = 0; attempt < 100 && disposition !== "terminal"; attempt += 1) {
      disposition = await f.control.recordDurableOperationDeploymentObservation(
        cleanupJob!.jobKey,
        "wrong-deployment-version",
        NOW_MS + attempt + 1,
        cleanupJob!.deploymentDeferralCount ?? 0,
      );
      cleanupJob = await f.control.getDurableOperation(cleanupJob!.jobKey);
    }
    expect(disposition).toBe("terminal");
    expect(cleanupJob).toMatchObject({
      state: "failed",
      response: { body: { code: "acceptance_deployment_version_unavailable" } },
    });

    vi.setSystemTime(NOW_MS + 5_001);
    await f.vault.alarm();
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      cleanupDispatchGeneration: 2,
      cleanupDispatchState: "registered",
      cleanupDispatchAttempts: 2,
    });
    expect(await f.vault.listAudit()).toContainEqual(
      expect.objectContaining({
        operation: "destroy",
        outcome: "retrying:acceptance_deployment_version_unavailable",
      }),
    );

    vi.setSystemTime(NOW_MS + 10_002);
    await f.control.alarm();
    await drain(f);
    expect(f.providers.resources.get(lease.leaseId)?.gone).toBe(true);
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "destroyed",
      cleanupDispatchState: "terminal",
    });
  });

  it("drains an enabled live resource in cleanup-only mode without permitting a new create", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "janitor-disabled-0001",
    );
    expect(f.providers.resources.get(lease.leaseId)).toEqual({
      gone: false,
      configuration: false,
    });
    expect(f.providers.calls.create).toBe(1);

    f.env.ACCEPTANCE_STAGING_ENABLED = "false";
    const blockedCreate = await f.service.handle(
      request(
        "/_nabuflow/acceptance/v1/leases",
        {
          schemaVersion: 1,
          projectId: 42,
          scope: { provider: "neon", organizationId: "neon-dedicated" },
          ttlSeconds: 300,
          costCeilingMinorUnits: 0,
        },
        { idempotency: "cleanup-only-blocks-create-0001" },
      ),
    );
    expect(blockedCreate.status).toBe(404);
    expect(f.providers.calls.create).toBe(1);

    await handleAcceptanceScheduled(f.env);
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "expired",
      terminalCode: null,
      cleanupDispatchState: "registered",
    });
    vi.setSystemTime(NOW_MS + 5_001);
    await f.control.alarm();
    expect(f.queue.messages).toHaveLength(1);
    const acks = vi.fn();
    const retries = vi.fn();
    await handleAcceptanceQueue(
      {
        messages: [{ body: f.queue.messages.shift()!, ack: acks, retry: retries }],
      } as unknown as MessageBatch<AcceptanceQueueMessage>,
      f.env,
      f.service,
    );

    expect(acks).toHaveBeenCalledOnce();
    expect(retries).not.toHaveBeenCalled();
    expect(f.providers.calls.destroy).toBe(1);
    expect(f.providers.resources.get(lease.leaseId)).toEqual({
      gone: true,
      configuration: false,
    });
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "destroyed",
      terminalCode: null,
      cleanupDispatchState: "terminal",
    });
    expect(f.vaultStorage.alarm).toBeNull();
    expect(await f.vault.listAudit()).toContainEqual(
      expect.objectContaining({
        operation: "destroy",
        outcome: "succeeded",
        state: "destroyed",
      }),
    );
  });

  it("recovers one coordinator successor after an injected queue send failure", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "janitor-send-recovery-0001",
    );
    vi.setSystemTime(NOW_MS + 300_001);
    await f.vault.alarm();
    f.queue.failNextSend = true;
    vi.setSystemTime(NOW_MS + 305_001);
    await f.control.alarm();
    expect(f.queue.messages).toHaveLength(0);
    vi.setSystemTime(NOW_MS + 310_001);
    await f.control.alarm();
    expect(f.queue.messages).toHaveLength(1);
    await f.control.alarm();
    expect(f.queue.messages).toHaveLength(1);
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "expired",
      cleanupDispatchState: "registered",
    });
  });

  it("bounds disabled cleanup provider retries and carries typed terminal evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "cleanup-only-provider-cap-0001",
    );
    f.env.ACCEPTANCE_STAGING_ENABLED = "false";
    f.providers.failDestroy = true;
    await handleAcceptanceScheduled(f.env);
    vi.setSystemTime(NOW_MS + 5_001);
    await f.control.alarm();
    const delivery = f.queue.messages.shift() as DurableOperationQueueMessage;
    const ack = vi.fn();
    const retry = vi.fn();
    const processing = handleAcceptanceQueue(
      {
        messages: [{ body: delivery, ack, retry }],
      } as unknown as MessageBatch<AcceptanceQueueMessage>,
      f.env,
      f.service,
    );
    await vi.advanceTimersByTimeAsync(1_001);
    await processing;

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(f.providers.calls.destroy).toBe(3);
    expect(f.providers.resources.get(lease.leaseId)).toEqual({
      gone: false,
      configuration: false,
    });
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "failed",
      terminalCode: "acceptance_cleanup_incomplete",
      cleanupDispatchState: "terminal",
    });
    expect(await f.control.getDurableOperation(delivery.jobKey)).toMatchObject({
      state: "failed",
      response: {
        status: 503,
        body: {
          code: "acceptance_provider_unavailable",
          retryable: true,
        },
      },
    });
    expect(await f.vault.listAudit()).toContainEqual(
      expect.objectContaining({
        operation: "destroy",
        outcome: "failed:acceptance_provider_unavailable",
        state: "failed",
      }),
    );
    expect(f.vaultStorage.alarm).toBeNull();
  });

  it("bounds coordinator registration failures with typed cleanup evidence", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const lease = await createLease(
      f,
      { provider: "fly", organizationSlug: "fly-disposable", disposable: true },
      "janitor-registration-cap-0001",
    );
    f.env.ACCEPTANCE_COORDINATOR = namespace({
      async registerDurableOperation() {
        throw new Error("injected coordinator failure");
      },
    }) as never;
    f.env.ACCEPTANCE_STAGING_ENABLED = "false";
    for (let attempt = 0; attempt <= 12; attempt += 1) {
      vi.setSystemTime(NOW_MS + attempt * 5_001);
      await f.vault.alarm();
    }
    expect(f.queue.messages).toHaveLength(0);
    expect(await f.vault.getLeaseForJanitor(lease.leaseId)).toMatchObject({
      state: "failed",
      terminalCode: "acceptance_cleanup_incomplete",
      cleanupDispatchState: "terminal",
      cleanupDispatchAttempts: 12,
    });
    expect(f.vaultStorage.alarm).toBeNull();
    expect(await f.vault.listAudit()).toContainEqual(
      expect.objectContaining({
        operation: "destroy",
        outcome: "failed:acceptance_cleanup_incomplete",
        state: "failed",
      }),
    );
  });

  it("reclaims a provider resource lost before its locator reached the vault", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW_MS);
    const f = fixture();
    const requestBody = {
      schemaVersion: 1 as const,
      projectId: 42,
      scope: { provider: "neon" as const, organizationId: "neon-dedicated" },
      ttlSeconds: 300,
      costCeilingMinorUnits: 100,
    };
    const leaseId = `nal_${"9".repeat(40)}`;
    const created = await f.vault.createLease({
      leaseId,
      identityHash: "8".repeat(64),
      ownerSubjectHash: "a".repeat(64),
      request: requestBody,
      nowMs: NOW_MS,
    });
    expect(created.state).toBe("created");
    if (created.state === "conflict") throw new Error("fixture conflict");
    await f.providers.create(created.lease);
    expect((await f.vault.getLeaseForJanitor(leaseId))?.resource).toBeNull();

    vi.setSystemTime(NOW_MS + 300_001);
    await expect(f.service.reconcileJanitor(Date.now())).resolves.toMatchObject({ reclaimed: 1 });
    expect(f.providers.resources.get(leaseId)).toEqual({ gone: true, configuration: false });
  });
});
