import { describe, expect, it, vi } from "vitest";
import {
  deriveRuntimeIdentity,
  type CapabilityDefinition,
} from "@workspace/tenant-runtime-contracts";
import {
  CapabilityVaultDurableObject,
  decryptCapabilityMaterial,
  encryptCapabilityMaterial,
} from "../src/capability-vault-durable-object";
import { fakeEnv } from "./helpers";

const TEST_KEK = "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY";
const syntheticStripeKey = (kind: "s" | "r", mode: "test" | "live", fill: string) =>
  [`${kind}k`, mode, fill.repeat(32)].join("_");
const context = {
  projectId: 42,
  provider: "nabuflow-harness",
  name: "echo",
  revision: "echo-v1",
};

const definition: CapabilityDefinition = {
  name: "echo",
  provider: "nabuflow-harness",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/echo" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 5_000,
    maxRequestBytes: 32_768,
    maxResponseBytes: 32_768,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

const databaseDefinition: CapabilityDefinition = {
  name: "database",
  provider: "neon-postgres",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/query" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 10_000,
    maxRequestBytes: 65_536,
    maxResponseBytes: 262_144,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

const stripeDefinition: CapabilityDefinition = {
  name: "payments",
  provider: "stripe",
  allowedMethods: ["POST"],
  allowedPaths: [{ match: "exact", path: "/v1/payment-intents" }],
  injection: { location: "worker-binding" },
  limits: {
    timeoutMs: 10_000,
    maxRequestBytes: 8_192,
    maxResponseBytes: 65_536,
    maxRequestsPerMinute: 60,
    maxConcurrent: 4,
  },
};

class MemoryVaultStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string | string[]): Promise<boolean | number> {
    if (Array.isArray(key)) {
      let deleted = 0;
      for (const entry of key) if (this.values.delete(entry)) deleted += 1;
      return deleted;
    }
    return this.values.delete(key);
  }

  async list(options: { prefix: string }): Promise<Map<string, unknown>> {
    return new Map([...this.values.entries()].filter(([key]) => key.startsWith(options.prefix)));
  }

  async transaction<T>(callback: (transaction: MemoryVaultStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  serialized(): string {
    return JSON.stringify([...this.values.entries()]);
  }
}

describe("capability vault envelope", () => {
  it("encrypts with a unique nonce and decrypts only under the bound AAD", async () => {
    const plaintext = new TextEncoder().encode("benign-harness-canary");
    const first = await encryptCapabilityMaterial(TEST_KEK, "v1", context, plaintext);
    const second = await encryptCapabilityMaterial(TEST_KEK, "v1", context, plaintext);

    expect(first.algorithm).toBe("AES-256-GCM");
    expect(first.keyId).toBe("v1");
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.ciphertext).not.toContain("benign-harness-canary");
    expect(
      new TextDecoder().decode(await decryptCapabilityMaterial(TEST_KEK, context, first)),
    ).toBe("benign-harness-canary");

    await expect(
      decryptCapabilityMaterial(TEST_KEK, { ...context, projectId: 43 }, first),
    ).rejects.toThrow();
    await expect(
      decryptCapabilityMaterial(TEST_KEK, { ...context, revision: "echo-v2" }, first),
    ).rejects.toThrow();
  });

  it("rejects malformed and wrong-length KEKs", async () => {
    const plaintext = new Uint8Array([1, 2, 3]);
    await expect(encryptCapabilityMaterial("not+base64", "v1", context, plaintext)).rejects.toThrow(
      "encoding",
    );
    await expect(encryptCapabilityMaterial("c2hvcnQ", "v1", context, plaintext)).rejects.toThrow(
      "32 bytes",
    );
  });

  it("survives a DO restart and independently enforces project ownership", async () => {
    const storage = new MemoryVaultStorage();
    const state = { storage } as unknown as DurableObjectState;
    const first = new CapabilityVaultDurableObject(state, fakeEnv());
    await expect(
      first.provisionEcho({ projectId: 42, revision: "echo-v1", definition }),
    ).resolves.toEqual({ state: "provisioned", keyId: "v1" });
    expect(storage.serialized()).not.toMatch(/benign-harness-canary|credential|secret/i);

    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "production",
      slot: "blue",
    });
    const invocation = {
      v: 1 as const,
      capability: { provider: "nabuflow-harness", name: "echo" },
      action: "invoke",
      requestId: "vault-restart-request-0001",
      input: { message: "after restart" },
      caller: { containerId: "container-platform-id-0001", runtimeIdentity: identity },
    };
    const restarted = new CapabilityVaultDurableObject(state, fakeEnv());
    await expect(restarted.invokeEcho({ projectId: 42, invocation })).resolves.toMatchObject({
      state: "success",
      response: { echo: invocation.input, actedBy: "capability-vault" },
    });
    await expect(restarted.invokeEcho({ projectId: 43, invocation })).resolves.toEqual({
      state: "tenant_mismatch",
    });
    await expect(
      restarted.revokeEcho({ projectId: 42, expectedRevision: "echo-v1" }),
    ).resolves.toBe("revoked");
  });

  it("stores the database connection string only inside an encrypted project-bound envelope", async () => {
    const storage = new MemoryVaultStorage();
    const state = { storage } as unknown as DurableObjectState;
    const vault = new CapabilityVaultDurableObject(state, fakeEnv());
    const credential =
      "postgresql://slice_user:staging-password@ep-db-broker.us-east-2.aws.neon.tech/slice_db";
    await expect(
      vault.provisionDatabase({
        projectId: 42,
        revision: "database-v1",
        definition: databaseDefinition,
        credential: { kind: "neon-connection-string", value: credential },
      }),
    ).resolves.toEqual({ state: "provisioned", keyId: "v1" });
    const serialized = storage.serialized();
    expect(serialized).not.toContain(credential);
    expect(serialized).not.toContain("staging-password");
    expect(serialized).toContain('"algorithm":"AES-256-GCM"');

    const foreignIdentity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 43,
      role: "production",
      slot: "blue",
    });
    await expect(
      vault.invokeDatabase({
        projectId: 42,
        invocation: {
          v: 1,
          capability: { provider: "neon-postgres", name: "database" },
          action: "query",
          requestId: "database-foreign-project",
          input: { kind: "statement", sql: "select 1", params: [] },
          caller: {
            containerId: "container-platform-id-foreign",
            runtimeIdentity: foreignIdentity,
          },
        },
      }),
    ).resolves.toEqual({ state: "tenant_mismatch" });
    await expect(
      vault.revokeDatabase({ projectId: 42, expectedRevision: "database-v1" }),
    ).resolves.toBe("revoked");
  });

  it("atomically couples a durable production allocation to its encrypted capability", async () => {
    const storage = new MemoryVaultStorage();
    const state = { storage } as unknown as DurableObjectState;
    const vault = new CapabilityVaultDurableObject(state, fakeEnv());
    const credential =
      "postgresql://runtime:transient@ep-production-vault.us-east-2.aws.neon.tech/neondb";
    const allocation = {
      format: "nabuflow.production-database-allocation/v1" as const,
      projectId: 42,
      allocationIdentity: "a".repeat(64),
      provider: "neon-postgres" as const,
      providerProjectId: "production-provider-project",
      providerOrganizationId: "org-production",
      regionId: "aws-us-east-2",
      historyRetentionSeconds: 604_800,
      revision: "production-database-a",
      state: "ready" as const,
      createdAt: "2026-08-15T12:00:00.000Z",
      updatedAt: "2026-08-15T12:00:00.000Z",
    };
    await expect(
      vault.provisionProductionDatabase({
        projectId: 42,
        revision: allocation.revision,
        definition: databaseDefinition,
        allocation,
        credential: { kind: "neon-connection-string", value: credential },
      }),
    ).resolves.toEqual({ state: "provisioned", keyId: "v1" });
    expect(storage.serialized()).not.toContain(credential);
    expect(storage.serialized()).toContain('"providerProjectId":"production-provider-project"');

    const restarted = new CapabilityVaultDurableObject(state, fakeEnv());
    await expect(
      restarted.getProductionDatabaseAllocation({
        projectId: 42,
        allocationIdentity: allocation.allocationIdentity,
      }),
    ).resolves.toMatchObject({ state: "ready", historyRetentionSeconds: 604_800 });
    await expect(
      restarted.provisionProductionDatabase({
        projectId: 42,
        revision: allocation.revision,
        definition: databaseDefinition,
        allocation,
        credential: { kind: "neon-connection-string", value: credential },
      }),
    ).resolves.toEqual({ state: "replayed", keyId: "v1" });
    await expect(
      restarted.beginProductionDatabaseRelease({
        projectId: 42,
        allocationIdentity: allocation.allocationIdentity,
      }),
    ).resolves.toMatchObject({ state: "releasing" });
    await expect(
      restarted.completeProductionDatabaseRelease({
        projectId: 42,
        allocationIdentity: allocation.allocationIdentity,
      }),
    ).resolves.toBe("released");
    await expect(
      restarted.getProductionDatabaseAllocation({
        projectId: 42,
        allocationIdentity: allocation.allocationIdentity,
      }),
    ).resolves.toBeNull();
    expect(storage.serialized()).not.toContain("production-provider-project");
  });

  it("encrypts a test-only Stripe key and rejects live keys before storage", async () => {
    const storage = new MemoryVaultStorage();
    const vault = new CapabilityVaultDurableObject(
      { storage } as unknown as DurableObjectState,
      fakeEnv(),
    );
    const testKey = syntheticStripeKey("s", "test", "a");
    await expect(
      vault.provisionStripe({
        projectId: 42,
        revision: "stripe-v1",
        definition: stripeDefinition,
        policy: { allowedCurrencies: ["usd"], maxAmount: 50_000 },
        credential: { kind: "stripe-test-secret-key", value: testKey },
      }),
    ).resolves.toEqual({ state: "provisioned", keyId: "v1" });
    expect(storage.serialized()).not.toContain(testKey);
    expect(storage.serialized()).toContain('"algorithm":"AES-256-GCM"');

    const restrictedTestKey = syntheticStripeKey("r", "test", "r");
    await expect(
      vault.provisionStripe({
        projectId: 42,
        revision: "stripe-restricted-v1",
        definition: stripeDefinition,
        policy: { allowedCurrencies: ["usd"], maxAmount: 50_000 },
        credential: { kind: "stripe-test-secret-key", value: restrictedTestKey },
      }),
    ).resolves.toEqual({ state: "provisioned", keyId: "v1" });
    expect(storage.serialized()).not.toContain(restrictedTestKey);

    const before = storage.serialized();
    await expect(
      vault.provisionStripe({
        projectId: 42,
        revision: "stripe-live-rejected",
        definition: stripeDefinition,
        policy: { allowedCurrencies: ["usd"], maxAmount: 50_000 },
        credential: {
          kind: "stripe-test-secret-key",
          value: syntheticStripeKey("s", "live", "b"),
        },
      }),
    ).rejects.toThrow("credential type");
    await expect(
      vault.provisionStripe({
        projectId: 42,
        revision: "stripe-restricted-live-rejected",
        definition: stripeDefinition,
        policy: { allowedCurrencies: ["usd"], maxAmount: 50_000 },
        credential: {
          kind: "stripe-test-secret-key",
          value: syntheticStripeKey("r", "live", "b"),
        },
      }),
    ).rejects.toThrow("credential type");
    expect(storage.serialized()).toBe(before);
  });

  it("enforces Stripe policy, durable idempotency, revision scope, and object ownership", async () => {
    const storage = new MemoryVaultStorage();
    const vault = new CapabilityVaultDurableObject(
      { storage } as unknown as DurableObjectState,
      fakeEnv(),
    );
    const testKey = syntheticStripeKey("s", "test", "a");
    await vault.provisionStripe({
      projectId: 42,
      revision: "stripe-v1",
      definition: stripeDefinition,
      policy: { allowedCurrencies: ["usd"], maxAmount: 50_000 },
      credential: { kind: "stripe-test-secret-key", value: testKey },
    });
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "production",
      slot: "blue",
    });
    const providerFetch = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      expect(url.origin).toBe("https://api.stripe.com");
      const isCancel = url.pathname.endsWith("/cancel");
      return Response.json({
        id: "pi_test123",
        status: isCancel ? "canceled" : "requires_payment_method",
        amount: 1_099,
        amount_received: 0,
        currency: "usd",
        created: 1_785_859_200,
        livemode: false,
      });
    });
    vi.stubGlobal("fetch", providerFetch);
    const createInvocation = {
      v: 1 as const,
      capability: { provider: "stripe", name: "payments" },
      action: "execute",
      requestId: "stripe-create-request-0001",
      input: {
        kind: "create-payment-intent",
        idempotencyKey: "checkout-order-00000001",
        amount: 1_099,
        currency: "usd",
      },
      caller: { containerId: "container-platform-id-0001", runtimeIdentity: identity },
    };
    try {
      await expect(
        vault.invokeStripe({ projectId: 42, invocation: createInvocation }),
      ).resolves.toMatchObject({
        state: "success",
        response: { idempotentReplay: false, paymentIntent: { id: "pi_test123" } },
      });
      expect(providerFetch).toHaveBeenCalledTimes(1);

      await expect(
        vault.invokeStripe({
          projectId: 42,
          invocation: { ...createInvocation, requestId: "stripe-create-request-0002" },
        }),
      ).resolves.toMatchObject({
        state: "success",
        response: { idempotentReplay: true, paymentIntent: { id: "pi_test123" } },
      });
      expect(providerFetch).toHaveBeenCalledTimes(1);

      await expect(
        vault.invokeStripe({
          projectId: 42,
          invocation: {
            ...createInvocation,
            requestId: "stripe-create-request-conflict",
            input: { ...createInvocation.input, amount: 1_200 },
          },
        }),
      ).resolves.toMatchObject({
        state: "stripe_error",
        status: 409,
        code: "stripe_idempotency_conflict",
      });
      expect(providerFetch).toHaveBeenCalledTimes(1);

      for (const [requestId, input] of [
        [
          "stripe-over-max",
          { ...createInvocation.input, idempotencyKey: "over-max-order-0000001", amount: 50_001 },
        ],
        [
          "stripe-currency-denied",
          { ...createInvocation.input, idempotencyKey: "currency-order-000001", currency: "eur" },
        ],
      ] as const) {
        await expect(
          vault.invokeStripe({
            projectId: 42,
            invocation: { ...createInvocation, requestId, input },
          }),
        ).resolves.toEqual({ state: "policy_rejected" });
      }
      expect(providerFetch).toHaveBeenCalledTimes(1);

      await expect(
        vault.invokeStripe({
          projectId: 42,
          invocation: {
            ...createInvocation,
            requestId: "stripe-retrieve-owned",
            input: { kind: "retrieve-payment-intent", paymentIntentId: "pi_test123" },
          },
        }),
      ).resolves.toMatchObject({
        state: "success",
        response: { paymentIntent: { id: "pi_test123" } },
      });
      expect(providerFetch).toHaveBeenCalledTimes(2);

      await expect(
        vault.invokeStripe({
          projectId: 42,
          invocation: {
            ...createInvocation,
            requestId: "stripe-retrieve-unowned",
            input: { kind: "retrieve-payment-intent", paymentIntentId: "pi_foreign123" },
          },
        }),
      ).resolves.toMatchObject({ state: "stripe_error", code: "stripe_invalid_request" });
      expect(providerFetch).toHaveBeenCalledTimes(2);

      await vault.provisionStripe({
        projectId: 42,
        revision: "stripe-v2",
        definition: stripeDefinition,
        policy: { allowedCurrencies: ["usd"], maxAmount: 50_000 },
        credential: { kind: "stripe-test-secret-key", value: testKey },
      });
      await expect(
        vault.invokeStripe({
          projectId: 42,
          invocation: { ...createInvocation, requestId: "stripe-revision-ambiguous" },
        }),
      ).resolves.toMatchObject({
        state: "stripe_error",
        status: 409,
        code: "stripe_idempotency_conflict",
      });
      expect(providerFetch).toHaveBeenCalledTimes(2);

      const foreignIdentity = await deriveRuntimeIdentity({
        namespace: "staging",
        projectId: 43,
        role: "production",
        slot: "blue",
      });
      await expect(
        vault.invokeStripe({
          projectId: 42,
          invocation: {
            ...createInvocation,
            requestId: "stripe-foreign-runtime",
            caller: { ...createInvocation.caller, runtimeIdentity: foreignIdentity },
          },
        }),
      ).resolves.toEqual({ state: "tenant_mismatch" });

      await expect(
        vault.revokeStripe({ projectId: 42, expectedRevision: "stripe-v2" }),
      ).resolves.toBe("revoked");
      expect(providerFetch).toHaveBeenCalledTimes(4);
      expect((providerFetch.mock.calls[3]?.[0] as Request).url).toBe(
        "https://api.stripe.com/v1/payment_intents/pi_test123/cancel",
      );
      expect(storage.serialized()).not.toMatch(/stripe-idempotency|stripe-object|sk_test/iu);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fails Stripe revocation closed until every owned test object is canceled", async () => {
    const storage = new MemoryVaultStorage();
    const vault = new CapabilityVaultDurableObject(
      { storage } as unknown as DurableObjectState,
      fakeEnv(),
    );
    const testKey = syntheticStripeKey("s", "test", "c");
    await vault.provisionStripe({
      projectId: 42,
      revision: "stripe-cleanup-v1",
      definition: stripeDefinition,
      policy: { allowedCurrencies: ["usd"], maxAmount: 50_000 },
      credential: { kind: "stripe-test-secret-key", value: testKey },
    });
    const identity = await deriveRuntimeIdentity({
      namespace: "staging",
      projectId: 42,
      role: "production",
      slot: "blue",
    });
    let cancellationAvailable = false;
    const providerFetch = vi.fn(async (request: Request) => {
      if (request.url.endsWith("/cancel") && !cancellationAvailable) {
        return Response.json({ error: { type: "api_error" } }, { status: 503 });
      }
      return Response.json({
        id: "pi_cleanup123",
        status: request.url.endsWith("/cancel") ? "canceled" : "requires_payment_method",
        amount: 1_099,
        amount_received: 0,
        currency: "usd",
        created: 1_785_859_200,
        livemode: false,
      });
    });
    vi.stubGlobal("fetch", providerFetch);
    try {
      await expect(
        vault.invokeStripe({
          projectId: 42,
          invocation: {
            v: 1,
            capability: { provider: "stripe", name: "payments" },
            action: "execute",
            requestId: "stripe-cleanup-create-0001",
            input: {
              kind: "create-payment-intent",
              idempotencyKey: "cleanup-order-00000001",
              amount: 1_099,
              currency: "usd",
            },
            caller: { containerId: "container-cleanup-0001", runtimeIdentity: identity },
          },
        }),
      ).resolves.toMatchObject({ state: "success" });

      await expect(
        vault.revokeStripe({ projectId: 42, expectedRevision: "stripe-cleanup-v1" }),
      ).resolves.toBe("cleanup_unavailable");
      expect(storage.serialized()).toMatch(/capability:stripe:payments|stripe-object:/u);

      cancellationAvailable = true;
      await expect(
        vault.revokeStripe({ projectId: 42, expectedRevision: "stripe-cleanup-v1" }),
      ).resolves.toBe("revoked");
      expect(storage.serialized()).not.toMatch(/capability:stripe:payments|stripe-object:/u);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
