import { DurableObject } from "cloudflare:workers";
import {
  PRODUCTION_DATABASE_INTENT_STORAGE_KEY,
  ProductionDatabaseIntentError,
  assertProductionDatabaseIntentAuthority,
  beginProductionDatabaseReleaseIntent,
  claimProductionDatabaseDispatchIntent,
  completeProductionDatabaseReleaseIntent,
  completeNeverDispatchedProductionDatabaseReleaseIntent,
  hasVerifiedProductionDatabaseRelease,
  observeProductionDatabaseProjectIntent,
  parseProductionDatabaseIntent,
  productionDatabaseHandoffIntent,
  productionDatabaseIntentReleaseAllocation,
  type ProductionDatabaseIntent,
  type ProductionDatabaseIntentOwner,
  type ProductionDatabaseProviderScope,
} from "./production-database-intent";
import {
  capabilityDefinitionSchema,
  capabilityDatabaseResponseSchema,
  capabilityEchoResponseSchema,
  capabilityStripeResponseSchema,
  parseRuntimeIdentity,
  stripeCapabilityInputSchema,
  stripeCapabilityPolicySchema,
  productionDatabaseAllocationRecordSchema,
  productionDatabaseAllocationIdentity,
  type CapabilityDefinition,
  type CapabilityInvocation,
  type StripeCapabilityPolicy,
  type StripePaymentIntent,
  type ProductionDatabaseAllocationRecord,
  type ProductionDatabaseAdmissionReceipt,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type { CapabilityVault, CapabilityVaultInvocationResult } from "./model";
import { DatabaseBrokerError, executeDatabaseCapability } from "./database-broker";
import {
  cancelStripePaymentIntent,
  createStripePaymentIntent,
  retrieveStripePaymentIntent,
  StripeBrokerError,
} from "./stripe-broker";

const ECHO_PROVIDER = "nabuflow-harness";
const ECHO_NAME = "echo";
const ECHO_STORAGE_KEY = `capability:${ECHO_PROVIDER}:${ECHO_NAME}`;
const DATABASE_PROVIDER = "neon-postgres";
const DATABASE_NAME = "database";
const DATABASE_STORAGE_KEY = `capability:${DATABASE_PROVIDER}:${DATABASE_NAME}`;
const PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY = "allocation:production:neon-postgres";
const STRIPE_PROVIDER = "stripe";
const STRIPE_NAME = "payments";
const STRIPE_STORAGE_KEY = `capability:${STRIPE_PROVIDER}:${STRIPE_NAME}`;
const textEncoder = new TextEncoder();
const credentialDecoder = new TextDecoder("utf-8", { fatal: true });

interface EncryptedCapabilityEnvelope {
  algorithm: "AES-256-GCM";
  keyId: string;
  nonce: string;
  ciphertext: string;
}

interface StoredCapabilityRecord {
  projectId: number;
  revision: string;
  definition: CapabilityDefinition;
  envelope: EncryptedCapabilityEnvelope;
}

interface StoredStripeCapabilityRecord extends StoredCapabilityRecord {
  policy: StripeCapabilityPolicy;
  state: "active" | "revoking";
}

interface StripeIdempotencyRecord {
  projectId: number;
  revision: string;
  fingerprint: string;
  state: "pending" | "completed";
  paymentIntent?: StripePaymentIntent;
}

interface StripeOwnershipRecord {
  projectId: number;
  revision: string;
  paymentIntentId: string;
}

interface EnvelopeContext {
  projectId: number;
  provider: string;
  name: string;
  revision: string;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Vault key encoding is invalid");
  const padded = value
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function copyBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function envelopeAad(context: EnvelopeContext, keyId: string): Uint8Array {
  return textEncoder.encode(
    [
      "nabuflow-capability-envelope-v1",
      `project=${context.projectId}`,
      `provider=${context.provider}`,
      `name=${context.name}`,
      `revision=${context.revision}`,
      `key=${keyId}`,
    ].join("\n"),
  );
}

async function importKek(encodedKey: string): Promise<CryptoKey> {
  const keyBytes = base64UrlToBytes(encodedKey);
  if (keyBytes.byteLength !== 32) throw new Error("Vault KEK must contain exactly 32 bytes");
  return crypto.subtle.importKey("raw", copyBuffer(keyBytes), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function encryptCapabilityMaterial(
  encodedKey: string,
  keyId: string,
  context: EnvelopeContext,
  plaintext: Uint8Array,
): Promise<EncryptedCapabilityEnvelope> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: copyBuffer(nonce),
      additionalData: copyBuffer(envelopeAad(context, keyId)),
    },
    await importKek(encodedKey),
    copyBuffer(plaintext),
  );
  return {
    algorithm: "AES-256-GCM",
    keyId,
    nonce: bytesToBase64Url(nonce),
    ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
  };
}

export async function decryptCapabilityMaterial(
  encodedKey: string,
  context: EnvelopeContext,
  envelope: EncryptedCapabilityEnvelope,
): Promise<Uint8Array> {
  if (envelope.algorithm !== "AES-256-GCM") throw new Error("Vault envelope algorithm is invalid");
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: copyBuffer(base64UrlToBytes(envelope.nonce)),
      additionalData: copyBuffer(envelopeAad(context, envelope.keyId)),
    },
    await importKek(encodedKey),
    copyBuffer(base64UrlToBytes(envelope.ciphertext)),
  );
  return new Uint8Array(plaintext);
}

function validateEchoDefinition(definition: CapabilityDefinition): CapabilityDefinition {
  const parsed = capabilityDefinitionSchema.parse(definition);
  const exactPolicy =
    parsed.provider === ECHO_PROVIDER &&
    parsed.name === ECHO_NAME &&
    parsed.allowedMethods.length === 1 &&
    parsed.allowedMethods[0] === "POST" &&
    parsed.allowedPaths.length === 1 &&
    parsed.allowedPaths[0]?.match === "exact" &&
    parsed.allowedPaths[0]?.path === "/v1/echo" &&
    parsed.injection.location === "worker-binding";
  if (!exactPolicy) throw new Error("Echo capability policy is invalid");
  return parsed;
}

function validateDatabaseDefinition(definition: CapabilityDefinition): CapabilityDefinition {
  const parsed = capabilityDefinitionSchema.parse(definition);
  const exactPolicy =
    parsed.provider === DATABASE_PROVIDER &&
    parsed.name === DATABASE_NAME &&
    parsed.allowedMethods.length === 1 &&
    parsed.allowedMethods[0] === "POST" &&
    parsed.allowedPaths.length === 1 &&
    parsed.allowedPaths[0]?.match === "exact" &&
    parsed.allowedPaths[0]?.path === "/v1/query" &&
    parsed.injection.location === "worker-binding";
  if (!exactPolicy) throw new Error("Database capability policy is invalid");
  return parsed;
}

function validateStripeDefinition(definition: CapabilityDefinition): CapabilityDefinition {
  const parsed = capabilityDefinitionSchema.parse(definition);
  const exactPolicy =
    parsed.provider === STRIPE_PROVIDER &&
    parsed.name === STRIPE_NAME &&
    parsed.allowedMethods.length === 1 &&
    parsed.allowedMethods[0] === "POST" &&
    parsed.allowedPaths.length === 1 &&
    parsed.allowedPaths[0]?.match === "exact" &&
    parsed.allowedPaths[0]?.path === "/v1/payment-intents" &&
    parsed.injection.location === "worker-binding";
  if (!exactPolicy) throw new Error("Stripe capability policy is invalid");
  return parsed;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", textEncoder.encode(value)));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function stripeIdempotencyStorageKey(digest: string): string {
  return `stripe-idempotency:${digest}`;
}

function stripeOwnershipStorageKey(paymentIntentId: string): string {
  return `stripe-object:${paymentIntentId}`;
}

function ownsInvocation(
  projectId: number,
  record: StoredCapabilityRecord,
  invocation: CapabilityInvocation,
): boolean {
  try {
    const identity = parseRuntimeIdentity(invocation.caller.runtimeIdentity);
    return identity.projectId === projectId && record.projectId === projectId;
  } catch {
    return false;
  }
}

function readKek(env: WorkerBindings, keyId: string): string {
  if (keyId !== "v1") throw new Error("Vault envelope references an unavailable key version");
  return env.CLOUDFLARE_CAPABILITY_VAULT_KEK_V1;
}

async function echoProof(canary: Uint8Array, invocation: CapabilityInvocation): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    copyBuffer(canary),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = textEncoder.encode(
    JSON.stringify({
      requestId: invocation.requestId,
      runtimeIdentity: invocation.caller.runtimeIdentity,
      input: invocation.input,
    }),
  );
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class CapabilityVaultDurableObject
  extends DurableObject<WorkerBindings>
  implements CapabilityVault
{
  async provisionEcho(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
  }): Promise<{ state: "provisioned"; keyId: string }> {
    const definition = validateEchoDefinition(input.definition);
    const keyId = this.env.NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID;
    if (keyId !== "v1") throw new Error("The configured vault key version is unsupported");
    const context = {
      projectId: input.projectId,
      provider: definition.provider,
      name: definition.name,
      revision: input.revision,
    };
    const canary = crypto.getRandomValues(new Uint8Array(32));
    const envelope = await encryptCapabilityMaterial(
      readKek(this.env, keyId),
      keyId,
      context,
      canary,
    );
    canary.fill(0);
    await this.ctx.storage.put(ECHO_STORAGE_KEY, {
      projectId: input.projectId,
      revision: input.revision,
      definition,
      envelope,
    } satisfies StoredCapabilityRecord);
    return { state: "provisioned", keyId };
  }

  async revokeEcho(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<StoredCapabilityRecord>(ECHO_STORAGE_KEY);
      if (record === undefined) return "not_found" as const;
      if (record.projectId !== input.projectId || record.revision !== input.expectedRevision) {
        return "conflict" as const;
      }
      await transaction.delete(ECHO_STORAGE_KEY);
      return "revoked" as const;
    });
  }

  async provisionDatabase(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    credential: { kind: "neon-connection-string"; value: string };
  }): Promise<{ state: "provisioned"; keyId: string }> {
    const definition = validateDatabaseDefinition(input.definition);
    if (input.credential.kind !== "neon-connection-string") {
      throw new Error("Database credential type is invalid");
    }
    const keyId = this.env.NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID;
    if (keyId !== "v1") throw new Error("The configured vault key version is unsupported");
    const context = {
      projectId: input.projectId,
      provider: definition.provider,
      name: definition.name,
      revision: input.revision,
    };
    const plaintext = textEncoder.encode(input.credential.value);
    try {
      const envelope = await encryptCapabilityMaterial(
        readKek(this.env, keyId),
        keyId,
        context,
        plaintext,
      );
      const owner = {
        projectId: input.projectId,
        allocationIdentity: await productionDatabaseAllocationIdentity({
          format: "nabuflow.production-database-allocation/v1",
          deploymentNamespace: "production",
          projectId: input.projectId,
        }),
      };
      // Encryption can yield across a completed production release. Compare the
      // current owner-bound history and publish the capability in one transaction.
      await this.ctx.storage.transaction(async (transaction) => {
        const [rawIntent, rawAllocation] = await Promise.all([
          transaction.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY),
          transaction.get(PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY),
        ]);
        // Only an absent key is missing history; a stored null is malformed.
        if (rawIntent === null) {
          throw new ProductionDatabaseIntentError("production_database_intent_conflict");
        }
        const current = parseProductionDatabaseIntent(rawIntent, owner);
        if (current?.state === "releasing" || current?.state === "released") {
          throw new ProductionDatabaseIntentError("production_database_intent_conflict");
        }
        if (rawAllocation !== undefined) {
          const allocation = productionDatabaseAllocationRecordSchema.safeParse(rawAllocation);
          if (
            !allocation.success ||
            allocation.data.projectId !== owner.projectId ||
            allocation.data.allocationIdentity !== owner.allocationIdentity ||
            allocation.data.state === "releasing"
          ) {
            throw new ProductionDatabaseIntentError("production_database_intent_conflict");
          }
          if (
            current !== null &&
            (current.providerProjectId !== allocation.data.providerProjectId ||
              current.scope?.providerOrganizationId !== allocation.data.providerOrganizationId ||
              current.scope?.regionId !== allocation.data.regionId ||
              current.scope?.historyRetentionSeconds !== allocation.data.historyRetentionSeconds)
          ) {
            throw new ProductionDatabaseIntentError("production_database_intent_conflict");
          }
        }
        await transaction.put(DATABASE_STORAGE_KEY, {
          projectId: input.projectId,
          revision: input.revision,
          definition,
          envelope,
        } satisfies StoredCapabilityRecord);
      });
      return { state: "provisioned", keyId };
    } finally {
      plaintext.fill(0);
    }
  }

  async revokeDatabase(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<StoredCapabilityRecord>(DATABASE_STORAGE_KEY);
      if (record === undefined) return "not_found" as const;
      if (record.projectId !== input.projectId || record.revision !== input.expectedRevision) {
        return "conflict" as const;
      }
      await transaction.delete(DATABASE_STORAGE_KEY);
      return "revoked" as const;
    });
  }

  async getProductionDatabaseIntent(
    input: ProductionDatabaseIntentOwner,
  ): Promise<ProductionDatabaseIntent | null> {
    return parseProductionDatabaseIntent(
      await this.ctx.storage.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY),
      input,
    );
  }

  async claimProductionDatabaseDispatch(
    input: ProductionDatabaseIntentOwner & {
      scope: ProductionDatabaseProviderScope;
      expiresAtMs: number;
    },
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const allocation = await transaction.get(PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY);
      const current = parseProductionDatabaseIntent(
        await transaction.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY),
        input,
      );
      assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
      if (allocation !== undefined) throw new Error("production_database_intent_conflict");
      const next = claimProductionDatabaseDispatchIntent(current, input, input.scope, Date.now());
      await transaction.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, next);
      assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
    });
  }

  async recordProductionDatabaseProject(
    input: ProductionDatabaseIntentOwner & {
      scope: ProductionDatabaseProviderScope;
      providerProjectId: string;
      expiresAtMs?: number;
    },
  ): Promise<ProductionDatabaseIntent> {
    return this.ctx.storage.transaction(async (transaction) => {
      assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
      const current = parseProductionDatabaseIntent(
        await transaction.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY),
        input,
      );
      const record = await transaction.get<ProductionDatabaseAllocationRecord>(
        PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY,
      );
      if (record !== undefined) {
        const parsed = productionDatabaseAllocationRecordSchema.parse(record);
        if (
          parsed.projectId !== input.projectId ||
          parsed.allocationIdentity !== input.allocationIdentity ||
          parsed.providerProjectId !== input.providerProjectId
        ) {
          throw new Error("production_database_intent_conflict");
        }
      }
      const next = observeProductionDatabaseProjectIntent(
        current,
        input,
        input.scope,
        input.providerProjectId,
        Date.now(),
      );
      await transaction.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, next);
      assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
      return next;
    });
  }

  async getProductionDatabaseAllocation(input: {
    projectId: number;
    allocationIdentity: string;
  }): Promise<ProductionDatabaseAllocationRecord | null> {
    const record = await this.ctx.storage.get<ProductionDatabaseAllocationRecord>(
      PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY,
    );
    if (record === undefined) return null;
    const parsed = productionDatabaseAllocationRecordSchema.parse(record);
    if (
      parsed.projectId !== input.projectId ||
      parsed.allocationIdentity !== input.allocationIdentity
    ) {
      throw new Error("Production database allocation ownership conflict");
    }
    return parsed;
  }

  async provisionProductionDatabase(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    allocation: ProductionDatabaseAllocationRecord;
    credential: { kind: "neon-connection-string"; value: string };
    expiresAtMs?: number;
  }): Promise<{ state: "provisioned" | "replayed"; keyId: string }> {
    const definition = validateDatabaseDefinition(input.definition);
    const allocation = productionDatabaseAllocationRecordSchema.parse(input.allocation);
    if (
      input.credential.kind !== "neon-connection-string" ||
      allocation.projectId !== input.projectId ||
      allocation.revision !== input.revision ||
      allocation.state !== "ready"
    ) {
      throw new Error("Production database allocation handoff is invalid");
    }
    const keyId = this.env.NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID;
    if (keyId !== "v1") throw new Error("The configured vault key version is unsupported");
    assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
    productionDatabaseHandoffIntent(
      await this.getProductionDatabaseIntent(allocation),
      allocation,
      Date.now(),
    );
    const existingAllocation = await this.ctx.storage.get<ProductionDatabaseAllocationRecord>(
      PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY,
    );
    const existingCapability =
      await this.ctx.storage.get<StoredCapabilityRecord>(DATABASE_STORAGE_KEY);
    if (existingAllocation !== undefined || existingCapability !== undefined) {
      const parsedExisting = productionDatabaseAllocationRecordSchema.safeParse(existingAllocation);
      if (
        parsedExisting.success &&
        existingCapability !== undefined &&
        parsedExisting.data.projectId === allocation.projectId &&
        parsedExisting.data.allocationIdentity === allocation.allocationIdentity &&
        parsedExisting.data.providerProjectId === allocation.providerProjectId &&
        parsedExisting.data.revision === allocation.revision &&
        parsedExisting.data.state === "ready" &&
        existingCapability.projectId === input.projectId &&
        existingCapability.revision === input.revision
      ) {
        return { state: "replayed", keyId: existingCapability.envelope.keyId };
      }
      throw new Error("Production database allocation cannot replace existing ownership");
    }
    const context = {
      projectId: input.projectId,
      provider: definition.provider,
      name: definition.name,
      revision: input.revision,
    };
    const plaintext = textEncoder.encode(input.credential.value);
    try {
      const envelope = await encryptCapabilityMaterial(
        readKek(this.env, keyId),
        keyId,
        context,
        plaintext,
      );
      await this.ctx.storage.transaction(async (transaction) => {
        const [claimedAllocation, claimedCapability] = await Promise.all([
          transaction.get(PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY),
          transaction.get(DATABASE_STORAGE_KEY),
        ]);
        if (claimedAllocation !== undefined || claimedCapability !== undefined) {
          throw new Error("Production database allocation was claimed concurrently");
        }
        const intent = productionDatabaseHandoffIntent(
          parseProductionDatabaseIntent(
            await transaction.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY),
            allocation,
          ),
          allocation,
          Date.now(),
        );
        assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
        await transaction.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, intent);
        await transaction.put(DATABASE_STORAGE_KEY, {
          projectId: input.projectId,
          revision: input.revision,
          definition,
          envelope,
        } satisfies StoredCapabilityRecord);
        await transaction.put(PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY, allocation);
      });
      return { state: "provisioned", keyId };
    } finally {
      plaintext.fill(0);
    }
  }

  async beginProductionDatabaseRelease(input: {
    projectId: number;
    allocationIdentity: string;
    expiresAtMs?: number;
  }): Promise<ProductionDatabaseAllocationRecord | null> {
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<ProductionDatabaseAllocationRecord>(
        PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY,
      );
      const allocation =
        record === undefined ? null : productionDatabaseAllocationRecordSchema.parse(record);
      const current = parseProductionDatabaseIntent(
        await transaction.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY),
        input,
      );
      assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
      const intent = beginProductionDatabaseReleaseIntent(current, input, allocation, Date.now());
      await transaction.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, intent);
      assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
      if (allocation === null) return productionDatabaseIntentReleaseAllocation(intent);
      const releasing = productionDatabaseAllocationRecordSchema.parse({
        ...allocation,
        state: "releasing",
        updatedAt: intent.updatedAt,
      });
      await transaction.put(PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY, releasing);
      assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
      return releasing;
    });
  }

  async completeNeverDispatchedProductionDatabaseRelease(input: {
    projectId: number;
    allocationIdentity: string;
    receipt: ProductionDatabaseAdmissionReceipt;
  }): Promise<"released" | "replayed"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const [rawIntent, allocation, capability] = await Promise.all([
        transaction.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY),
        transaction.get(PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY),
        transaction.get(DATABASE_STORAGE_KEY),
      ]);
      const current = parseProductionDatabaseIntent(rawIntent, input);
      const completed = completeNeverDispatchedProductionDatabaseReleaseIntent(
        current,
        input,
        input.receipt,
        Date.now(),
      );
      // Even a matching replay cannot hide ownership written by another path.
      if (allocation !== undefined || capability !== undefined) {
        throw new ProductionDatabaseIntentError("production_database_intent_conflict");
      }
      if (current !== null) return "replayed" as const;
      await transaction.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, completed);
      return "released" as const;
    });
  }

  async completeProductionDatabaseRelease(input: {
    projectId: number;
    allocationIdentity: string;
    expectedProviderProjectId?: string;
    expiresAtMs?: number;
  }): Promise<"released" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<ProductionDatabaseAllocationRecord>(
        PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY,
      );
      const current = parseProductionDatabaseIntent(
        await transaction.get(PRODUCTION_DATABASE_INTENT_STORAGE_KEY),
        input,
      );
      assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
      if (current?.version === 2) {
        const capability = await transaction.get(DATABASE_STORAGE_KEY);
        assertProductionDatabaseIntentAuthority(input.expiresAtMs, Date.now());
        if (
          record !== undefined ||
          capability !== undefined ||
          input.expectedProviderProjectId !== undefined ||
          !hasVerifiedProductionDatabaseRelease(current)
        ) {
          return "conflict" as const;
        }
        // Negative proof never authorizes deleting an existing capability.
        return "not_found" as const;
      }
      if (record !== undefined) {
        const parsed = productionDatabaseAllocationRecordSchema.parse(record);
        if (
          parsed.projectId !== input.projectId ||
          parsed.allocationIdentity !== input.allocationIdentity ||
          parsed.state !== "releasing" ||
          parsed.providerProjectId !== current?.providerProjectId
        )
          return "conflict" as const;
      }
      const completed = completeProductionDatabaseReleaseIntent(
        current,
        input,
        input.expectedProviderProjectId,
        Date.now(),
      );
      await transaction.put(PRODUCTION_DATABASE_INTENT_STORAGE_KEY, completed);
      await transaction.delete(DATABASE_STORAGE_KEY);
      await transaction.delete(PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY);
      return current?.state === "released" ? ("not_found" as const) : ("released" as const);
    });
  }

  async provisionStripe(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    policy: StripeCapabilityPolicy;
    credential: { kind: "stripe-test-secret-key"; value: string };
  }): Promise<{ state: "provisioned"; keyId: string }> {
    const definition = validateStripeDefinition(input.definition);
    const policy = stripeCapabilityPolicySchema.parse(input.policy);
    if (
      input.credential.kind !== "stripe-test-secret-key" ||
      !/^(?:sk|rk)_test_[A-Za-z0-9]+$/u.test(input.credential.value)
    ) {
      throw new Error("Stripe credential type is invalid");
    }
    const keyId = this.env.NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID;
    if (keyId !== "v1") throw new Error("The configured vault key version is unsupported");
    const context = {
      projectId: input.projectId,
      provider: definition.provider,
      name: definition.name,
      revision: input.revision,
    };
    const plaintext = textEncoder.encode(input.credential.value);
    try {
      const envelope = await encryptCapabilityMaterial(
        readKek(this.env, keyId),
        keyId,
        context,
        plaintext,
      );
      await this.ctx.storage.put(STRIPE_STORAGE_KEY, {
        projectId: input.projectId,
        revision: input.revision,
        definition,
        policy,
        state: "active",
        envelope,
      } satisfies StoredStripeCapabilityRecord);
      return { state: "provisioned", keyId };
    } finally {
      plaintext.fill(0);
    }
  }

  async revokeStripe(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict" | "cleanup_unavailable"> {
    const claim = await this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<StoredStripeCapabilityRecord>(STRIPE_STORAGE_KEY);
      if (record === undefined) return "not_found" as const;
      if (record.projectId !== input.projectId || record.revision !== input.expectedRevision) {
        return "conflict" as const;
      }
      if (record.state !== "revoking") {
        await transaction.put(STRIPE_STORAGE_KEY, { ...record, state: "revoking" });
      }
      return record;
    });
    if (typeof claim === "string") return claim;

    const context = {
      projectId: claim.projectId,
      provider: claim.definition.provider,
      name: claim.definition.name,
      revision: claim.revision,
    };
    let credentialBytes: Uint8Array | null = null;
    try {
      credentialBytes = await decryptCapabilityMaterial(
        readKek(this.env, claim.envelope.keyId),
        context,
        claim.envelope,
      );
      const secretKey = credentialDecoder.decode(credentialBytes);
      const ownershipRecords = await this.ctx.storage.list({ prefix: "stripe-object:" });
      for (const ownership of ownershipRecords.values()) {
        const parsed = ownership as StripeOwnershipRecord;
        // Capability revision changes do not change ownership of already-created
        // test objects. The current project-bound credential must reclaim every
        // object owned by this project's vault before the capability can vanish.
        if (parsed.projectId !== claim.projectId) {
          return "cleanup_unavailable";
        }
        const current = await retrieveStripePaymentIntent(secretKey, parsed.paymentIntentId, {
          timeoutMs: claim.definition.limits.timeoutMs,
        });
        if (current.status !== "canceled") {
          const canceled = await cancelStripePaymentIntent(secretKey, parsed.paymentIntentId, {
            timeoutMs: claim.definition.limits.timeoutMs,
          });
          if (canceled.status !== "canceled") return "cleanup_unavailable";
        }
      }
    } catch {
      return "cleanup_unavailable";
    } finally {
      credentialBytes?.fill(0);
    }

    return this.ctx.storage.transaction(async (transaction) => {
      const record = await transaction.get<StoredStripeCapabilityRecord>(STRIPE_STORAGE_KEY);
      if (record === undefined) return "not_found" as const;
      if (
        record.projectId !== input.projectId ||
        record.revision !== input.expectedRevision ||
        record.state !== "revoking"
      ) {
        return "conflict" as const;
      }
      const idempotencyRecords = await transaction.list({ prefix: "stripe-idempotency:" });
      const ownershipRecords = await transaction.list({ prefix: "stripe-object:" });
      await transaction.delete([
        STRIPE_STORAGE_KEY,
        ...idempotencyRecords.keys(),
        ...ownershipRecords.keys(),
      ]);
      return "revoked" as const;
    });
  }

  async invokeEcho(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = await this.ctx.storage.get<StoredCapabilityRecord>(ECHO_STORAGE_KEY);
    if (record === undefined) return { state: "not_found" };
    if (!ownsInvocation(input.projectId, record, input.invocation)) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "invoke"
    ) {
      return { state: "policy_rejected" };
    }
    const context = {
      projectId: record.projectId,
      provider: record.definition.provider,
      name: record.definition.name,
      revision: record.revision,
    };
    const canary = await decryptCapabilityMaterial(
      readKek(this.env, record.envelope.keyId),
      context,
      record.envelope,
    );
    try {
      const response = capabilityEchoResponseSchema.parse({
        ok: true,
        capability: input.invocation.capability,
        requestId: input.invocation.requestId,
        runtimeIdentity: input.invocation.caller.runtimeIdentity,
        actedBy: "capability-vault",
        proof: await echoProof(canary, input.invocation),
        echo: input.invocation.input,
      });
      return { state: "success", response };
    } finally {
      canary.fill(0);
    }
  }

  async invokeDatabase(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = await this.ctx.storage.get<StoredCapabilityRecord>(DATABASE_STORAGE_KEY);
    if (record === undefined) return { state: "not_found" };
    const managedAllocation = await this.ctx.storage.get<ProductionDatabaseAllocationRecord>(
      PRODUCTION_DATABASE_ALLOCATION_STORAGE_KEY,
    );
    if (managedAllocation?.state === "releasing") {
      return {
        state: "database_error",
        status: 503,
        code: "database_unavailable",
        retryable: true,
        sqlstate: null,
      };
    }
    if (!ownsInvocation(input.projectId, record, input.invocation)) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "query"
    ) {
      return { state: "policy_rejected" };
    }
    const context = {
      projectId: record.projectId,
      provider: record.definition.provider,
      name: record.definition.name,
      revision: record.revision,
    };
    let credentialBytes: Uint8Array | null = null;
    try {
      credentialBytes = await decryptCapabilityMaterial(
        readKek(this.env, record.envelope.keyId),
        context,
        record.envelope,
      );
      const result = await executeDatabaseCapability(
        credentialDecoder.decode(credentialBytes),
        input.invocation.input,
        { timeoutMs: record.definition.limits.timeoutMs },
      );
      return {
        state: "success",
        response: capabilityDatabaseResponseSchema.parse({
          ok: true,
          capability: input.invocation.capability,
          requestId: input.invocation.requestId,
          runtimeIdentity: input.invocation.caller.runtimeIdentity,
          actedBy: "database-broker",
          result,
        }),
      };
    } catch (error) {
      if (error instanceof DatabaseBrokerError) {
        return {
          state: "database_error",
          status: error.status,
          code: error.code,
          retryable: error.retryable,
          sqlstate: error.sqlstate,
        };
      }
      return {
        state: "database_error",
        status: 503,
        code: "database_unavailable",
        retryable: true,
        sqlstate: null,
      };
    } finally {
      credentialBytes?.fill(0);
    }
  }

  async invokeStripe(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = await this.ctx.storage.get<StoredStripeCapabilityRecord>(STRIPE_STORAGE_KEY);
    if (record === undefined) return { state: "not_found" };
    if (record.state === "revoking") {
      return { state: "stripe_error", status: 503, code: "stripe_unavailable", retryable: true };
    }
    if (!ownsInvocation(input.projectId, record, input.invocation)) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "execute"
    ) {
      return { state: "policy_rejected" };
    }
    const parsedInput = stripeCapabilityInputSchema.safeParse(input.invocation.input);
    if (!parsedInput.success) {
      return {
        state: "stripe_error",
        status: 400,
        code: "stripe_invalid_request",
        retryable: false,
      };
    }

    const stripeInput = parsedInput.data;
    if (
      stripeInput.kind === "create-payment-intent" &&
      (stripeInput.amount > record.policy.maxAmount ||
        !record.policy.allowedCurrencies.includes(stripeInput.currency))
    ) {
      return { state: "policy_rejected" };
    }

    let idempotencyDigest: string | null = null;
    let idempotencyFingerprint: string | null = null;
    if (stripeInput.kind === "create-payment-intent") {
      idempotencyDigest = await sha256Hex(
        [
          "nabuflow-stripe-idempotency-v1",
          `project=${record.projectId}`,
          `provider=${STRIPE_PROVIDER}`,
          `name=${STRIPE_NAME}`,
          "operation=create-payment-intent",
          `key=${stripeInput.idempotencyKey}`,
        ].join("\n"),
      );
      idempotencyFingerprint = await sha256Hex(
        JSON.stringify({ amount: stripeInput.amount, currency: stripeInput.currency }),
      );
      const ledgerKey = stripeIdempotencyStorageKey(idempotencyDigest);
      const existing = await this.ctx.storage.get<StripeIdempotencyRecord>(ledgerKey);
      if (
        existing !== undefined &&
        (existing.projectId !== record.projectId ||
          existing.revision !== record.revision ||
          existing.fingerprint !== idempotencyFingerprint)
      ) {
        return {
          state: "stripe_error",
          status: 409,
          code: "stripe_idempotency_conflict",
          retryable: false,
        };
      }
      if (existing?.state === "completed" && existing.paymentIntent !== undefined) {
        return {
          state: "success",
          response: capabilityStripeResponseSchema.parse({
            ok: true,
            capability: input.invocation.capability,
            requestId: input.invocation.requestId,
            runtimeIdentity: input.invocation.caller.runtimeIdentity,
            actedBy: "stripe-broker",
            operation: stripeInput.kind,
            idempotentReplay: true,
            paymentIntent: existing.paymentIntent,
          }),
        };
      }
      if (existing === undefined) {
        await this.ctx.storage.put(ledgerKey, {
          projectId: record.projectId,
          revision: record.revision,
          fingerprint: idempotencyFingerprint,
          state: "pending",
        } satisfies StripeIdempotencyRecord);
      }
    }

    const context = {
      projectId: record.projectId,
      provider: record.definition.provider,
      name: record.definition.name,
      revision: record.revision,
    };
    let credentialBytes: Uint8Array | null = null;
    try {
      credentialBytes = await decryptCapabilityMaterial(
        readKek(this.env, record.envelope.keyId),
        context,
        record.envelope,
      );
      const secretKey = credentialDecoder.decode(credentialBytes);
      let paymentIntent: StripePaymentIntent;
      const idempotentReplay = false;
      if (stripeInput.kind === "create-payment-intent") {
        paymentIntent = await createStripePaymentIntent(
          secretKey,
          { amount: stripeInput.amount, currency: stripeInput.currency },
          `nfg1-${idempotencyDigest!}`,
          { timeoutMs: record.definition.limits.timeoutMs },
        );
        await this.ctx.storage.put(stripeOwnershipStorageKey(paymentIntent.id), {
          projectId: record.projectId,
          revision: record.revision,
          paymentIntentId: paymentIntent.id,
        } satisfies StripeOwnershipRecord);
        await this.ctx.storage.put(stripeIdempotencyStorageKey(idempotencyDigest!), {
          projectId: record.projectId,
          revision: record.revision,
          fingerprint: idempotencyFingerprint!,
          state: "completed",
          paymentIntent,
        } satisfies StripeIdempotencyRecord);
      } else {
        const ownership = await this.ctx.storage.get<StripeOwnershipRecord>(
          stripeOwnershipStorageKey(stripeInput.paymentIntentId),
        );
        if (
          ownership === undefined ||
          ownership.projectId !== record.projectId ||
          ownership.revision !== record.revision
        ) {
          return {
            state: "stripe_error",
            status: 400,
            code: "stripe_invalid_request",
            retryable: false,
          };
        }
        paymentIntent = await retrieveStripePaymentIntent(secretKey, stripeInput.paymentIntentId, {
          timeoutMs: record.definition.limits.timeoutMs,
        });
      }
      return {
        state: "success",
        response: capabilityStripeResponseSchema.parse({
          ok: true,
          capability: input.invocation.capability,
          requestId: input.invocation.requestId,
          runtimeIdentity: input.invocation.caller.runtimeIdentity,
          actedBy: "stripe-broker",
          operation: stripeInput.kind,
          idempotentReplay,
          paymentIntent,
        }),
      };
    } catch (error) {
      if (error instanceof StripeBrokerError) {
        return {
          state: "stripe_error",
          status: error.status,
          code: error.code,
          retryable: error.retryable,
        };
      }
      return {
        state: "stripe_error",
        status: 503,
        code: "stripe_unavailable",
        retryable: true,
      };
    } finally {
      credentialBytes?.fill(0);
    }
  }
}
