import { describe, expect, it } from "vitest";
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

class MemoryVaultStorage {
  private readonly values = new Map<string, unknown>();

  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }

  async put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
  }

  async delete(key: string): Promise<boolean> {
    return this.values.delete(key);
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
});
