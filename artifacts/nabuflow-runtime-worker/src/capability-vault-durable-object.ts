import { DurableObject } from "cloudflare:workers";
import {
  capabilityDefinitionSchema,
  capabilityDatabaseResponseSchema,
  capabilityEchoResponseSchema,
  parseRuntimeIdentity,
  type CapabilityDefinition,
  type CapabilityInvocation,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type { CapabilityVault, CapabilityVaultInvocationResult } from "./model";
import { DatabaseBrokerError, executeDatabaseCapability } from "./database-broker";

const ECHO_PROVIDER = "nabuflow-harness";
const ECHO_NAME = "echo";
const ECHO_STORAGE_KEY = `capability:${ECHO_PROVIDER}:${ECHO_NAME}`;
const DATABASE_PROVIDER = "neon-postgres";
const DATABASE_NAME = "database";
const DATABASE_STORAGE_KEY = `capability:${DATABASE_PROVIDER}:${DATABASE_NAME}`;
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
      await this.ctx.storage.put(DATABASE_STORAGE_KEY, {
        projectId: input.projectId,
        revision: input.revision,
        definition,
        envelope,
      } satisfies StoredCapabilityRecord);
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
}
