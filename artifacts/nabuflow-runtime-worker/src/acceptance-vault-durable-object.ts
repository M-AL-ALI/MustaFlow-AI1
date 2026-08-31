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
import type { ControlCoordinator, StoredDurableOperationJob } from "./model";
import { registerJanitorDestroy } from "./acceptance-provisioner-worker";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });
const LEASE_PREFIX = "lease:";
const AUDIT_PREFIX = "audit:";
const AUDIT_SEQUENCE_KEY = "audit-sequence";
const MAX_AUDIT_RECORDS = 1_000;
const JANITOR_DISPATCH_ATTEMPT_CAP = 12;
const JANITOR_DISPATCH_RETRY_MS = 5_000;
const JANITOR_DISPATCH_DEADLINE_MS = 15 * 60 * 1_000;
const CLEANUP_CONTROL_TERMINAL_CODES = new Set([
  "acceptance_operation_timeout",
  "acceptance_deployment_version_unavailable",
]);

function leaseKey(leaseId: string): string {
  return `${LEASE_PREFIX}${leaseId}`;
}

function cleanupControlTerminalCode(job: StoredDurableOperationJob | null): string {
  const body = job?.response?.body as { code?: unknown } | undefined;
  return typeof body?.code === "string" && CLEANUP_CONTROL_TERMINAL_CODES.has(body.code)
    ? body.code
    : "acceptance_cleanup_incomplete";
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

export function readAcceptanceVaultKek(value: string): Uint8Array<ArrayBuffer> {
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
  const bytes = readAcceptanceVaultKek(value);
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
    const cleanupOnly = this.env.ACCEPTANCE_STAGING_ENABLED !== "true";
    return [...leases.values()]
      .filter(
        (lease) =>
          (cleanupOnly || lease.expiresAtMs <= nowMs) &&
          lease.state !== "destroyed" &&
          lease.cleanupDispatchState !== "registered" &&
          lease.cleanupDispatchState !== "terminal",
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
    const stored = await this.ctx.storage.transaction(async (transaction) => {
      const lease = await transaction.get<StoredAcceptanceLease>(leaseKey(input.leaseId));
      if (lease === undefined || lease.ownerSubjectHash !== input.ownerSubjectHash) return null;
      lease.resource = structuredClone(input.resource);
      lease.material = material;
      lease.costAmountMinorUnits = input.costAmountMinorUnits;
      lease.updatedAtMs = input.nowMs;
      const cleanupRequired =
        this.env.ACCEPTANCE_STAGING_ENABLED !== "true" ||
        lease.expiresAtMs <= input.nowMs ||
        lease.state === "expired" ||
        lease.state === "destroying" ||
        lease.state === "destroyed" ||
        lease.cleanupDispatchState === "pending" ||
        lease.cleanupDispatchState === "registered" ||
        lease.cleanupDispatchState === "terminal";
      if (cleanupRequired) {
        // A provider create can finish after cleanup policy has won. Persist the locator, but
        // never resurrect the lease: mint a fresh fenced cleanup generation for the new bytes.
        lease.state = "expired";
        lease.terminalCode = null;
        lease.cleanupDispatchGeneration = (lease.cleanupDispatchGeneration ?? 0) + 1;
        lease.cleanupDispatchState = "pending";
        lease.cleanupDispatchAttempts = 0;
        lease.cleanupDispatchNextAttemptAtMs = input.nowMs;
        lease.cleanupDispatchDeadlineMs = input.nowMs + JANITOR_DISPATCH_DEADLINE_MS;
        delete lease.cleanupDispatchJobKey;
      } else {
        lease.state = "active";
      }
      await transaction.put(leaseKey(input.leaseId), lease);
      return structuredClone(lease);
    });
    await this.scheduleNextAlarm();
    return stored;
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
      if (
        lease === undefined ||
        lease.ownerSubjectHash !== input.ownerSubjectHash ||
        lease.state !== "active" ||
        lease.cleanupDispatchState === "pending" ||
        lease.cleanupDispatchState === "registered"
      ) {
        return null;
      }
      lease.capabilityRevision = input.revision;
      lease.state = "provisioned";
      lease.updatedAtMs = input.nowMs;
      await transaction.put(leaseKey(input.leaseId), lease);
      return structuredClone(lease);
    });
  }

  async markFlySecretProvisioned(input: {
    leaseId: string;
    ownerSubjectHash: string;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null> {
    return this.ctx.storage.transaction(async (transaction) => {
      const lease = await transaction.get<StoredAcceptanceLease>(leaseKey(input.leaseId));
      if (
        lease === undefined ||
        lease.ownerSubjectHash !== input.ownerSubjectHash ||
        lease.scope.provider !== "fly" ||
        lease.resource?.provider !== "fly" ||
        lease.resource.configurationWritten !== true ||
        lease.state !== "active" ||
        lease.cleanupDispatchState === "pending" ||
        lease.cleanupDispatchState === "registered"
      ) {
        return null;
      }
      lease.state = "provisioned";
      lease.updatedAtMs = input.nowMs;
      await transaction.put(leaseKey(input.leaseId), lease);
      return structuredClone(lease);
    });
  }

  async markDestroying(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    cleanupGeneration?: number;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null> {
    return this.mutateTerminal(input, "destroying", null);
  }

  async markDestroyed(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    cleanupGeneration?: number;
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

  async markCleanupFailed(input: {
    leaseId: string;
    ownerSubjectHash: string | null;
    cleanupGeneration?: number;
    nowMs: number;
  }): Promise<StoredAcceptanceLease | null> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const lease = await transaction.get<StoredAcceptanceLease>(leaseKey(input.leaseId));
      if (
        lease === undefined ||
        (input.ownerSubjectHash !== null && lease.ownerSubjectHash !== input.ownerSubjectHash) ||
        (input.cleanupGeneration !== undefined &&
          lease.cleanupDispatchGeneration !== input.cleanupGeneration)
      ) {
        return null;
      }
      lease.state = "failed";
      lease.updatedAtMs = input.nowMs;
      lease.terminalCode = "acceptance_cleanup_incomplete";
      lease.cleanupDispatchState = "terminal";
      delete lease.cleanupDispatchJobKey;
      await transaction.put(leaseKey(input.leaseId), lease);
      return structuredClone(lease);
    });
    await this.scheduleNextAlarm();
    return result;
  }

  private async mutateTerminal(
    input: {
      leaseId: string;
      ownerSubjectHash: string | null;
      cleanupGeneration?: number;
      nowMs: number;
    },
    state: "destroying" | "destroyed" | "failed",
    terminalCode: string | null,
  ): Promise<StoredAcceptanceLease | null> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const lease = await transaction.get<StoredAcceptanceLease>(leaseKey(input.leaseId));
      if (
        lease === undefined ||
        (input.ownerSubjectHash !== null && lease.ownerSubjectHash !== input.ownerSubjectHash) ||
        (input.cleanupGeneration !== undefined &&
          lease.cleanupDispatchGeneration !== input.cleanupGeneration)
      ) {
        return null;
      }
      lease.state = state;
      lease.updatedAtMs = input.nowMs;
      lease.terminalCode = terminalCode;
      if (state === "destroyed") {
        lease.material = null;
        lease.capabilityRevision = null;
        lease.cleanupDispatchState = "terminal";
        delete lease.cleanupDispatchJobKey;
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
    await this.runCleanup(Date.now());
  }

  async runCleanup(nowMs: number): Promise<void> {
    await this.reconcileRegisteredCleanup(nowMs);
    const due = await this.stageDueCleanup(nowMs, this.env.ACCEPTANCE_STAGING_ENABLED !== "true");
    for (const lease of due) await this.dispatchCleanup(lease, nowMs);
    await this.scheduleNextAlarm();
  }

  private async reconcileRegisteredCleanup(nowMs: number): Promise<void> {
    const leases = await this.ctx.storage.list<StoredAcceptanceLease>({ prefix: LEASE_PREFIX });
    const control = this.env.ACCEPTANCE_COORDINATOR.get(
      this.env.ACCEPTANCE_COORDINATOR.idFromName("acceptance-coordinator"),
    );
    for (const snapshot of leases.values()) {
      if (
        snapshot.cleanupDispatchState !== "registered" ||
        (snapshot.cleanupDispatchNextAttemptAtMs ?? nowMs) > nowMs
      ) {
        continue;
      }
      let job: StoredDurableOperationJob | null = null;
      let coordinatorReadFailed = false;
      try {
        job =
          snapshot.cleanupDispatchJobKey === undefined
            ? null
            : await (control as unknown as ControlCoordinator).getDurableOperation(
                snapshot.cleanupDispatchJobKey,
              );
      } catch {
        // A transient coordinator read is not evidence that cleanup ended. The same bounded
        // deadline remains authoritative and the alarm will observe it again.
        coordinatorReadFailed = true;
      }
      const jobActive = job?.state === "active";
      const controlCode = cleanupControlTerminalCode(job);
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<StoredAcceptanceLease>(leaseKey(snapshot.leaseId));
        if (
          current?.cleanupDispatchState !== "registered" ||
          current.cleanupDispatchGeneration !== snapshot.cleanupDispatchGeneration ||
          current.cleanupDispatchJobKey !== snapshot.cleanupDispatchJobKey
        ) {
          return;
        }
        if (current.state === "destroyed") {
          current.cleanupDispatchState = "terminal";
          current.updatedAtMs = nowMs;
          delete current.cleanupDispatchJobKey;
          await transaction.put(leaseKey(current.leaseId), current);
          return;
        }
        if (coordinatorReadFailed && nowMs < (current.cleanupDispatchDeadlineMs ?? nowMs)) {
          current.cleanupDispatchNextAttemptAtMs = Math.min(
            current.cleanupDispatchDeadlineMs ?? nowMs + JANITOR_DISPATCH_RETRY_MS,
            nowMs + JANITOR_DISPATCH_RETRY_MS,
          );
          await transaction.put(leaseKey(current.leaseId), current);
          return;
        }
        const attempts = current.cleanupDispatchAttempts ?? 0;
        if (
          nowMs >= (current.cleanupDispatchDeadlineMs ?? nowMs) ||
          attempts >= JANITOR_DISPATCH_ATTEMPT_CAP
        ) {
          current.state = "failed";
          current.updatedAtMs = nowMs;
          current.terminalCode = "acceptance_cleanup_incomplete";
          current.cleanupDispatchState = "terminal";
          delete current.cleanupDispatchJobKey;
          await transaction.put(leaseKey(current.leaseId), current);
          const sequence = (await transaction.get<number>(AUDIT_SEQUENCE_KEY)) ?? 0;
          const next = sequence + 1;
          await transaction.put(AUDIT_SEQUENCE_KEY, next);
          await transaction.put(`${AUDIT_PREFIX}${String(next).padStart(12, "0")}`, {
            sequence: next,
            at: new Date(nowMs).toISOString(),
            leaseId: current.leaseId,
            provider: current.scope.provider,
            operation: "destroy",
            outcome: `failed:${controlCode}`,
            state: current.state,
            resourceCount: current.resource?.ids.length ?? 0,
            costAmountMinorUnits: current.costAmountMinorUnits,
          } satisfies AcceptanceLeaseAuditRecord);
          if (next > MAX_AUDIT_RECORDS) {
            await transaction.delete(
              `${AUDIT_PREFIX}${String(next - MAX_AUDIT_RECORDS).padStart(12, "0")}`,
            );
          }
          return;
        }
        if (jobActive) {
          current.cleanupDispatchNextAttemptAtMs = Math.min(
            current.cleanupDispatchDeadlineMs ?? nowMs + JANITOR_DISPATCH_RETRY_MS,
            nowMs + JANITOR_DISPATCH_RETRY_MS,
          );
          await transaction.put(leaseKey(current.leaseId), current);
          return;
        }
        current.state = "expired";
        current.updatedAtMs = nowMs;
        current.terminalCode = null;
        current.cleanupDispatchGeneration = (current.cleanupDispatchGeneration ?? 0) + 1;
        current.cleanupDispatchState = "pending";
        current.cleanupDispatchNextAttemptAtMs = nowMs;
        delete current.cleanupDispatchJobKey;
        await transaction.put(leaseKey(current.leaseId), current);
        const sequence = (await transaction.get<number>(AUDIT_SEQUENCE_KEY)) ?? 0;
        const next = sequence + 1;
        await transaction.put(AUDIT_SEQUENCE_KEY, next);
        await transaction.put(`${AUDIT_PREFIX}${String(next).padStart(12, "0")}`, {
          sequence: next,
          at: new Date(nowMs).toISOString(),
          leaseId: current.leaseId,
          provider: current.scope.provider,
          operation: "destroy",
          outcome: `retrying:${controlCode}`,
          state: current.state,
          resourceCount: current.resource?.ids.length ?? 0,
          costAmountMinorUnits: current.costAmountMinorUnits,
        } satisfies AcceptanceLeaseAuditRecord);
        if (next > MAX_AUDIT_RECORDS) {
          await transaction.delete(
            `${AUDIT_PREFIX}${String(next - MAX_AUDIT_RECORDS).padStart(12, "0")}`,
          );
        }
      });
    }
  }

  private async stageDueCleanup(
    nowMs: number,
    cleanupOnly: boolean,
  ): Promise<StoredAcceptanceLease[]> {
    return this.ctx.storage.transaction(async (transaction) => {
      const leases = await transaction.list<StoredAcceptanceLease>({ prefix: LEASE_PREFIX });
      const due: StoredAcceptanceLease[] = [];
      for (const lease of [...leases.values()].sort((a, b) => a.expiresAtMs - b.expiresAtMs)) {
        if (due.length >= ACCEPTANCE_JANITOR_BATCH_LIMIT) break;
        // A pre-generation deployment can leave a lease in `destroying` with no durable
        // dispatch identity. Treat it as unfinished cleanup: stage a real generation below and
        // let the same bounded coordinator path prove the resource gone.
        if (lease.state === "destroyed") continue;
        if (
          lease.cleanupDispatchState === "registered" ||
          lease.cleanupDispatchState === "terminal"
        ) {
          continue;
        }
        if (!cleanupOnly && lease.expiresAtMs > nowMs && lease.cleanupDispatchState !== "pending") {
          continue;
        }
        if (
          lease.cleanupDispatchState === "pending" &&
          (lease.cleanupDispatchNextAttemptAtMs ?? lease.expiresAtMs) > nowMs
        ) {
          continue;
        }
        if (lease.cleanupDispatchState !== "pending") {
          lease.state = "expired";
          lease.updatedAtMs = nowMs;
          lease.terminalCode = null;
          lease.cleanupDispatchGeneration = (lease.cleanupDispatchGeneration ?? 0) + 1;
          lease.cleanupDispatchState = "pending";
          lease.cleanupDispatchAttempts = 0;
          lease.cleanupDispatchNextAttemptAtMs = nowMs;
          lease.cleanupDispatchDeadlineMs = nowMs + JANITOR_DISPATCH_DEADLINE_MS;
          delete lease.cleanupDispatchJobKey;
          await transaction.put(leaseKey(lease.leaseId), lease);
        }
        due.push(structuredClone(lease));
      }
      return due;
    });
  }

  private async dispatchCleanup(lease: StoredAcceptanceLease, nowMs: number): Promise<void> {
    const claim = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<StoredAcceptanceLease>(leaseKey(lease.leaseId));
      if (current?.cleanupDispatchState !== "pending") return null;
      const attempts = current.cleanupDispatchAttempts ?? 0;
      if (
        nowMs >= (current.cleanupDispatchDeadlineMs ?? nowMs) ||
        attempts >= JANITOR_DISPATCH_ATTEMPT_CAP
      ) {
        current.state = "failed";
        current.updatedAtMs = nowMs;
        current.terminalCode = "acceptance_cleanup_incomplete";
        current.cleanupDispatchState = "terminal";
        delete current.cleanupDispatchJobKey;
        await transaction.put(leaseKey(current.leaseId), current);
        const sequence = (await transaction.get<number>(AUDIT_SEQUENCE_KEY)) ?? 0;
        const next = sequence + 1;
        await transaction.put(AUDIT_SEQUENCE_KEY, next);
        await transaction.put(`${AUDIT_PREFIX}${String(next).padStart(12, "0")}`, {
          sequence: next,
          at: new Date(nowMs).toISOString(),
          leaseId: current.leaseId,
          provider: current.scope.provider,
          operation: "destroy",
          outcome: "failed:acceptance_cleanup_incomplete",
          state: current.state,
          resourceCount: current.resource?.ids.length ?? 0,
          costAmountMinorUnits: current.costAmountMinorUnits,
        } satisfies AcceptanceLeaseAuditRecord);
        if (next > MAX_AUDIT_RECORDS) {
          await transaction.delete(
            `${AUDIT_PREFIX}${String(next - MAX_AUDIT_RECORDS).padStart(12, "0")}`,
          );
        }
        return { state: "terminal" as const, lease: structuredClone(current) };
      }
      current.cleanupDispatchAttempts = attempts + 1;
      current.cleanupDispatchNextAttemptAtMs = nowMs + JANITOR_DISPATCH_RETRY_MS;
      await transaction.put(leaseKey(current.leaseId), current);
      return { state: "claimed" as const, lease: structuredClone(current) };
    });
    if (claim === null) return;
    if (claim.state === "terminal") return;
    const claimed = claim.lease;
    try {
      const registration = await registerJanitorDestroy(this.env, claimed);
      await this.ctx.storage.transaction(async (transaction) => {
        const current = await transaction.get<StoredAcceptanceLease>(leaseKey(claimed.leaseId));
        if (
          current?.cleanupDispatchState === "pending" &&
          current.cleanupDispatchGeneration === claimed.cleanupDispatchGeneration
        ) {
          current.cleanupDispatchState = "registered";
          current.cleanupDispatchJobKey = registration.jobKey;
          current.cleanupDispatchNextAttemptAtMs = nowMs + JANITOR_DISPATCH_RETRY_MS;
          current.updatedAtMs = nowMs;
          await transaction.put(leaseKey(current.leaseId), current);
        }
      });
    } catch {
      // The persisted pending state and next alarm provide bounded recovery.
    }
  }

  private async scheduleNextAlarm(): Promise<void> {
    const cleanupOnly = this.env.ACCEPTANCE_STAGING_ENABLED !== "true";
    const nowMs = Date.now();
    const leases = await this.ctx.storage.list<StoredAcceptanceLease>({ prefix: LEASE_PREFIX });
    let next: number | null = null;
    for (const lease of leases.values()) {
      if (lease.state === "destroyed" || lease.cleanupDispatchState === "terminal") continue;
      const candidate =
        lease.cleanupDispatchState === "pending" || lease.cleanupDispatchState === "registered"
          ? (lease.cleanupDispatchNextAttemptAtMs ?? lease.expiresAtMs)
          : cleanupOnly
            ? nowMs
            : lease.expiresAtMs;
      next = next === null ? candidate : Math.min(next, candidate);
    }
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(next);
  }
}
