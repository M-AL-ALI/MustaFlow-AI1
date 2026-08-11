import { DurableObject } from "cloudflare:workers";
import { ACCEPTANCE_JANITOR_BATCH_LIMIT } from "@workspace/tenant-runtime-contracts";
import type {
  AcceptanceEncryptedMaterial,
  AcceptanceLeaseAuditRecord,
  AcceptanceLeaseResource,
  AcceptanceProvisionerBindings,
  AcceptanceVault,
  StoredAcceptanceLease,
} from "./acceptance-provisioner-model";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const LEASE_PREFIX = "lease:";
const AUDIT_PREFIX = "audit:";
const AUDIT_SEQUENCE_KEY = "audit-sequence";
const MAX_AUDIT_RECORDS = 1_000;

function leaseKey(leaseId: string): string {
  return `${LEASE_PREFIX}${leaseId}`;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Acceptance vault material is malformed");
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(value.replace(/-/gu, "+").replace(/_/gu, "/") + padding);
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function readKek(value: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new Error("Acceptance vault KEK must be 32-byte Base64URL without padding");
  }
  const bytes = base64UrlToBytes(value);
  if (bytes.byteLength !== 32) throw new Error("Acceptance vault KEK length is invalid");
  return bytes;
}

function copyBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

function materialAad(lease: StoredAcceptanceLease): Uint8Array<ArrayBuffer> {
  return copyBytes(
    textEncoder.encode(
      `NABUFLOW_ACCEPTANCE_VAULT_V1\n${lease.leaseId}\n${lease.scope.provider}\n${lease.identityHash}`,
    ),
  );
}

async function importKek(value: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const bytes = readKek(value);
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  try {
    copy.set(bytes);
    return await crypto.subtle.importKey("raw", copy, { name: "AES-GCM" }, false, usages);
  } finally {
    bytes.fill(0);
    copy.fill(0);
  }
}

async function encryptMaterial(
  kek: string,
  lease: StoredAcceptanceLease,
  value: string,
): Promise<AcceptanceEncryptedMaterial> {
  const nonce = crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12)));
  const plaintext = copyBytes(textEncoder.encode(value));
  try {
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: materialAad(lease), tagLength: 128 },
      await importKek(kek, ["encrypt"]),
      plaintext,
    );
    return {
      version: 1,
      keyId: "v1",
      nonce: bytesToBase64Url(nonce),
      ciphertext: bytesToBase64Url(new Uint8Array(ciphertext)),
    };
  } finally {
    plaintext.fill(0);
    nonce.fill(0);
  }
}

async function decryptMaterial(kek: string, lease: StoredAcceptanceLease): Promise<string | null> {
  if (lease.material === null || lease.material.version !== 1 || lease.material.keyId !== "v1") {
    return null;
  }
  const nonce = base64UrlToBytes(lease.material.nonce);
  const ciphertext = base64UrlToBytes(lease.material.ciphertext);
  try {
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: materialAad(lease), tagLength: 128 },
        await importKek(kek, ["decrypt"]),
        ciphertext,
      ),
    );
    try {
      return textDecoder.decode(plaintext);
    } finally {
      plaintext.fill(0);
    }
  } finally {
    nonce.fill(0);
    ciphertext.fill(0);
  }
}

export class AcceptanceVaultDurableObject
  extends DurableObject<AcceptanceProvisionerBindings>
  implements AcceptanceVault
{
  async createLease(input: {
    leaseId: string;
    identityHash: string;
    ownerSubjectHash: string;
    request: Parameters<AcceptanceVault["createLease"]>[0]["request"];
    nowMs: number;
  }): ReturnType<AcceptanceVault["createLease"]> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const key = leaseKey(input.leaseId);
      const existing = await transaction.get<StoredAcceptanceLease>(key);
      if (existing !== undefined) {
        if (
          existing.identityHash !== input.identityHash ||
          existing.ownerSubjectHash !== input.ownerSubjectHash
        ) {
          return { state: "conflict" } as const;
        }
        return { state: "exists", lease: structuredClone(existing) } as const;
      }
      const lease: StoredAcceptanceLease = {
        schemaVersion: 1,
        leaseId: input.leaseId,
        identityHash: input.identityHash,
        ownerSubjectHash: input.ownerSubjectHash,
        projectId: input.request.projectId,
        scope: structuredClone(input.request.scope),
        state: "pending",
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
        expiresAtMs: input.nowMs + input.request.ttlSeconds * 1_000,
        costCeilingMinorUnits: input.request.costCeilingMinorUnits,
        costAmountMinorUnits: 0,
        resource: null,
        material: null,
        capabilityRevision: null,
        terminalCode: null,
      };
      await transaction.put(key, lease);
      return { state: "created", lease: structuredClone(lease) } as const;
    });
    if (result.state !== "conflict") await this.scheduleNextAlarm();
    return result;
  }

  async getAuthorizedLease(
    leaseId: string,
    ownerSubjectHash: string,
  ): Promise<StoredAcceptanceLease | null> {
    const lease = await this.ctx.storage.get<StoredAcceptanceLease>(leaseKey(leaseId));
    return lease === undefined || lease.ownerSubjectHash !== ownerSubjectHash
      ? null
      : structuredClone(lease);
  }

  async getLeaseForJanitor(leaseId: string): Promise<StoredAcceptanceLease | null> {
    const lease = await this.ctx.storage.get<StoredAcceptanceLease>(leaseKey(leaseId));
    return lease === undefined ? null : structuredClone(lease);
  }

  async listExpired(nowMs: number, limit: number): Promise<StoredAcceptanceLease[]> {
    const leases = await this.ctx.storage.list<StoredAcceptanceLease>({ prefix: LEASE_PREFIX });
    return [...leases.values()]
      .filter(
        (lease) =>
          lease.expiresAtMs <= nowMs && lease.state !== "destroyed" && lease.state !== "destroying",
      )
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs)
      .slice(0, Math.min(limit, ACCEPTANCE_JANITOR_BATCH_LIMIT))
      .map((lease) => structuredClone(lease));
  }

  async listLeases(limit: number): Promise<StoredAcceptanceLease[]> {
    const leases = await this.ctx.storage.list<StoredAcceptanceLease>({
      prefix: LEASE_PREFIX,
      limit: Math.min(limit, ACCEPTANCE_JANITOR_BATCH_LIMIT),
    });
    return [...leases.values()].map((lease) => structuredClone(lease));
  }

  async storeProviderResult(input: {
    leaseId: string;
    ownerSubjectHash: string;
    resource: AcceptanceLeaseResource;
    material: { kind: "neon-connection-string"; value: string } | null;
    costAmountMinorUnits: number;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null> {
    const current = await this.getAuthorizedLease(input.leaseId, input.ownerSubjectHash);
    if (current === null) return null;
    if (input.costAmountMinorUnits > current.costCeilingMinorUnits) {
      throw new Error("Acceptance cost ceiling would be exceeded");
    }
    const material =
      input.material === null
        ? null
        : await encryptMaterial(this.env.ACCEPTANCE_VAULT_KEK, current, input.material.value);
    return this.ctx.storage.transaction(async (transaction) => {
      const lease = await transaction.get<StoredAcceptanceLease>(leaseKey(input.leaseId));
      if (lease === undefined || lease.ownerSubjectHash !== input.ownerSubjectHash) return null;
      lease.resource = structuredClone(input.resource);
      lease.material = material;
      lease.costAmountMinorUnits = input.costAmountMinorUnits;
      lease.state = "active";
      lease.updatedAtMs = input.nowMs;
      await transaction.put(leaseKey(input.leaseId), lease);
      return structuredClone(lease);
    });
  }

  async readMaterial(input: {
    leaseId: string;
    ownerSubjectHash: string;
    kind: "neon-connection-string";
  }): Promise<string | null> {
    const lease = await this.getAuthorizedLease(input.leaseId, input.ownerSubjectHash);
    if (lease === null || lease.scope.provider !== "neon") return null;
    return decryptMaterial(this.env.ACCEPTANCE_VAULT_KEK, lease);
  }

  async markCapabilityProvisioned(input: {
    leaseId: string;
    ownerSubjectHash: string;
    revision: string;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null> {
    return this.ctx.storage.transaction(async (transaction) => {
      const lease = await transaction.get<StoredAcceptanceLease>(leaseKey(input.leaseId));
      if (lease === undefined || lease.ownerSubjectHash !== input.ownerSubjectHash) return null;
      lease.capabilityRevision = input.revision;
      lease.state = "provisioned";
      lease.updatedAtMs = input.nowMs;
      await transaction.put(leaseKey(input.leaseId), lease);
      return structuredClone(lease);
    });
  }

  async markDestroying(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null> {
    return this.mutateTerminal(input, "destroying", null);
  }

  async markDestroyed(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null> {
    return this.mutateTerminal(input, "destroyed", null);
  }

  async markFailed(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    code: string;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null> {
    return this.mutateTerminal(input, "failed", input.code);
  }

  private async mutateTerminal(
    input: { leaseId: string; ownerSubjectHash: string | null; nowMs: number },
    state: "destroying" | "destroyed" | "failed",
    terminalCode: string | null,
  ): Promise<StoredAcceptanceLease | null> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const lease = await transaction.get<StoredAcceptanceLease>(leaseKey(input.leaseId));
      if (
        lease === undefined ||
        (input.ownerSubjectHash !== null && lease.ownerSubjectHash !== input.ownerSubjectHash)
      ) {
        return null;
      }
      lease.state = state;
      lease.updatedAtMs = input.nowMs;
      lease.terminalCode = terminalCode;
      if (state === "destroyed") {
        lease.material = null;
        lease.capabilityRevision = null;
      }
      await transaction.put(leaseKey(input.leaseId), lease);
      return structuredClone(lease);
    });
    await this.scheduleNextAlarm();
    return result;
  }

  async recordAudit(record: Omit<AcceptanceLeaseAuditRecord, "sequence">): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const sequence = (await transaction.get<number>(AUDIT_SEQUENCE_KEY)) ?? 0;
      const next = sequence + 1;
      await transaction.put(AUDIT_SEQUENCE_KEY, next);
      await transaction.put(`${AUDIT_PREFIX}${String(next).padStart(12, "0")}`, {
        ...structuredClone(record),
        sequence: next,
      } satisfies AcceptanceLeaseAuditRecord);
      if (next > MAX_AUDIT_RECORDS) {
        await transaction.delete(
          `${AUDIT_PREFIX}${String(next - MAX_AUDIT_RECORDS).padStart(12, "0")}`,
        );
      }
    });
  }

  async listAudit(): Promise<AcceptanceLeaseAuditRecord[]> {
    const records = await this.ctx.storage.list<AcceptanceLeaseAuditRecord>({
      prefix: AUDIT_PREFIX,
    });
    return [...records.values()].map((record) => structuredClone(record));
  }

  async alarm(): Promise<void> {
    const due = await this.listExpired(Date.now(), ACCEPTANCE_JANITOR_BATCH_LIMIT);
    for (const lease of due) {
      await this.env.ACCEPTANCE_OPERATION_QUEUE.send({
        schemaVersion: 1,
        kind: "acceptance-janitor",
        leaseId: lease.leaseId,
      });
    }
    await this.scheduleNextAlarm();
  }

  private async scheduleNextAlarm(): Promise<void> {
    const leases = await this.ctx.storage.list<StoredAcceptanceLease>({ prefix: LEASE_PREFIX });
    let next: number | null = null;
    for (const lease of leases.values()) {
      if (lease.state === "destroyed" || lease.state === "destroying") continue;
      next = next === null ? lease.expiresAtMs : Math.min(next, lease.expiresAtMs);
    }
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
