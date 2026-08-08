import { DurableObject } from "cloudflare:workers";
import { sha256Hex } from "@workspace/tenant-runtime-contracts";
import type { RouteRecord } from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type {
  ControlAuditRecord,
  ControlCoordinator,
  IdempotencyLookup,
  RuntimeLogEntry,
  StoredHttpResponse,
  StoredRuntime,
  StoredRuntimeArtifact,
  StoredRuntimeLayer,
  StoredRuntimeLayeredArtifact,
  RemovedRuntimeLayeredArtifact,
} from "./model";
import { deleteArtifactObjects } from "./artifact-storage";
import {
  deleteDependencyLayerObjects,
  deleteLayeredArtifactAppObjects,
} from "./artifact-layer-storage";

const IDEMPOTENCY_PENDING_TTL_MS = 10 * 60 * 1_000;
const IDEMPOTENCY_COMPLETED_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_AUDIT_RECORDS = 1_000;
const MAX_RUNTIME_LOGS = 1_000;
const MAX_LOG_MESSAGE_LENGTH = 100_000;

interface StoredIdempotencyRecord {
  fingerprint: string;
  state: "pending" | "completed";
  expiresAtMs: number;
  response?: StoredHttpResponse;
}

function runtimeKey(identity: string): string {
  return `runtime:${identity}`;
}

function routeKey(hostname: string): string {
  return `route:${hostname}`;
}

function artifactKey(identity: string, sealedArtifactSha256: string): string {
  return `artifact:${identity}:${sealedArtifactSha256}`;
}

function layeredArtifactKey(identity: string, sealedArtifactSha256: string): string {
  return `layered-artifact:${identity}:${sealedArtifactSha256}`;
}

function runtimeLayerKey(contentSha256: string): string {
  return `runtime-layer:${contentSha256}`;
}

function layeredArtifactReference(identity: string, sealedArtifactSha256: string): string {
  return `${identity}:${sealedArtifactSha256}`;
}

async function containerBindingKey(containerId: string): Promise<string> {
  return `container-binding:${await sha256Hex(containerId)}`;
}

function formatCursor(sequence: number): string {
  return `log-${sequence.toString().padStart(10, "0")}`;
}

function parseCursor(cursor: string | undefined): number {
  if (cursor === undefined) return 0;
  const match = /^log-([0-9]{10})$/.exec(cursor);
  if (!match) throw new Error("Malformed log cursor");
  return Number(match[1]);
}

function splitLogDelta(message: string): string[] {
  if (!message) return [];
  const chunks: string[] = [];
  for (let offset = 0; offset < message.length; offset += MAX_LOG_MESSAGE_LENGTH) {
    chunks.push(message.slice(offset, offset + MAX_LOG_MESSAGE_LENGTH));
  }
  return chunks;
}

export class ControlDurableObject
  extends DurableObject<WorkerBindings>
  implements ControlCoordinator
{
  private readonly routeCache = new Map<string, RouteRecord | null>();

  async consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean> {
    const key = `nonce:${await sha256Hex(nonce)}`;
    const consumed = await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<number>(key);
      const nowMs = Date.now();
      if (existing !== undefined && existing > nowMs) return false;
      await transaction.put(key, expiresAtMs);
      return true;
    });
    if (consumed) await this.scheduleCleanup(this.ctx.storage, expiresAtMs);
    return consumed;
  }

  async isConsumedOnce(nonce: string, nowMs: number): Promise<boolean> {
    const expiresAtMs = await this.ctx.storage.get<number>(`nonce:${await sha256Hex(nonce)}`);
    return expiresAtMs !== undefined && expiresAtMs > nowMs;
  }

  async beginIdempotency(
    key: string,
    fingerprint: string,
    nowMs: number,
  ): Promise<IdempotencyLookup> {
    const storageKey = `idempotency:${await sha256Hex(key)}`;
    const result: IdempotencyLookup = await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredIdempotencyRecord>(storageKey);
      if (existing !== undefined && existing.expiresAtMs > nowMs) {
        if (existing.fingerprint !== fingerprint) return { state: "conflict" } as const;
        if (existing.state === "pending") return { state: "pending" } as const;
        if (existing.response === undefined) return { state: "pending" } as const;
        return { state: "replay", response: existing.response } as const;
      }

      const expiresAtMs = nowMs + IDEMPOTENCY_PENDING_TTL_MS;
      await transaction.put(storageKey, {
        fingerprint,
        state: "pending",
        expiresAtMs,
      } satisfies StoredIdempotencyRecord);
      return { state: "new" } as const;
    });
    if (result.state === "new") {
      await this.scheduleCleanup(this.ctx.storage, nowMs + IDEMPOTENCY_PENDING_TTL_MS);
    }
    return result;
  }

  async completeIdempotency(
    key: string,
    fingerprint: string,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<void> {
    const storageKey = `idempotency:${await sha256Hex(key)}`;
    const expiresAtMs = nowMs + IDEMPOTENCY_COMPLETED_TTL_MS;
    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredIdempotencyRecord>(storageKey);
      if (existing === undefined || existing.fingerprint !== fingerprint) {
        throw new Error("Idempotency reservation no longer belongs to this request");
      }
      await transaction.put(storageKey, {
        fingerprint,
        state: "completed",
        expiresAtMs,
        response,
      } satisfies StoredIdempotencyRecord);
    });
    await this.scheduleCleanup(this.ctx.storage, expiresAtMs);
  }

  async abandonIdempotency(key: string, fingerprint: string): Promise<void> {
    const storageKey = `idempotency:${await sha256Hex(key)}`;
    await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredIdempotencyRecord>(storageKey);
      if (existing?.state === "pending" && existing.fingerprint === fingerprint) {
        await transaction.delete(storageKey);
      }
    });
  }

  async recordAudit(record: ControlAuditRecord): Promise<void> {
    const sequence = (await this.ctx.storage.get<number>("audit:sequence")) ?? 0;
    const nextSequence = sequence + 1;
    await this.ctx.storage.put({
      "audit:sequence": nextSequence,
      [`audit:${nextSequence.toString().padStart(12, "0")}`]: record,
    });
    const oldest = nextSequence - MAX_AUDIT_RECORDS;
    if (oldest > 0) {
      await this.ctx.storage.delete(`audit:${oldest.toString().padStart(12, "0")}`);
    }
  }

  async getRuntime(identity: string): Promise<StoredRuntime | null> {
    return (await this.ctx.storage.get<StoredRuntime>(runtimeKey(identity))) ?? null;
  }

  async putRuntime(identity: string, runtime: StoredRuntime): Promise<void> {
    await this.ctx.storage.put(runtimeKey(identity), runtime);
  }

  async putRuntimeIfManifestRevision(
    identity: string,
    expectedManifestRevision: string,
    runtime: StoredRuntime,
  ): Promise<"updated" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = runtimeKey(identity);
      const existing = await transaction.get<StoredRuntime>(key);
      if (existing === undefined) return "not_found" as const;
      if (existing.manifest.revision !== expectedManifestRevision) return "conflict" as const;
      await transaction.put(key, runtime);
      return "updated" as const;
    });
  }

  async deleteRuntime(identity: string): Promise<void> {
    await this.ctx.storage.delete(runtimeKey(identity));
  }

  async beginArtifact(record: StoredRuntimeArtifact): Promise<"created" | "exists" | "conflict"> {
    const key = artifactKey(record.runtimeIdentity, record.envelope.sealedArtifactSha256);
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredRuntimeArtifact>(key);
      if (existing !== undefined) {
        return existing.envelope.contentSha256 === record.envelope.contentSha256 &&
          existing.envelope.manifestRevision === record.envelope.manifestRevision
          ? ("exists" as const)
          : ("conflict" as const);
      }
      await transaction.put(key, record);
      return "created" as const;
    });
    if (result === "created" && record.expiresAtMs !== null) {
      await this.scheduleCleanup(this.ctx.storage, record.expiresAtMs);
    }
    return result;
  }

  async getArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeArtifact | null> {
    return (
      (await this.ctx.storage.get<StoredRuntimeArtifact>(
        artifactKey(identity, sealedArtifactSha256),
      )) ?? null
    );
  }

  async recordArtifactChunk(
    identity: string,
    sealedArtifactSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = artifactKey(identity, sealedArtifactSha256);
      const artifact = await transaction.get<StoredRuntimeArtifact>(key);
      if (artifact === undefined || artifact.state !== "pending") return "not_found" as const;
      if (chunkIndex < 0 || chunkIndex >= artifact.receivedChunks.length)
        return "conflict" as const;
      const current = artifact.receivedChunks[chunkIndex];
      if (current !== null) return current === chunkSha256 ? "replay" : "conflict";
      if (artifact.envelope.content.chunks[chunkIndex] !== chunkSha256) return "conflict" as const;
      artifact.receivedChunks[chunkIndex] = chunkSha256;
      await transaction.put(key, artifact);
      return "recorded" as const;
    });
  }

  async commitArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<"committed" | "incomplete" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = artifactKey(identity, sealedArtifactSha256);
      const artifact = await transaction.get<StoredRuntimeArtifact>(key);
      if (artifact === undefined) return "not_found" as const;
      if (artifact.receivedChunks.some((chunk) => chunk === null)) return "incomplete" as const;
      artifact.state = "committed";
      artifact.expiresAtMs = null;
      await transaction.put(key, artifact);
      return "committed" as const;
    });
  }

  async removeArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeArtifact | null> {
    const key = artifactKey(identity, sealedArtifactSha256);
    return this.ctx.storage.transaction(async (transaction) => {
      const artifact = await transaction.get<StoredRuntimeArtifact>(key);
      if (artifact === undefined) return null;
      await transaction.delete(key);
      return artifact;
    });
  }

  async listArtifacts(identity: string): Promise<StoredRuntimeArtifact[]> {
    const records = await this.ctx.storage.list<StoredRuntimeArtifact>({
      prefix: `artifact:${identity}:`,
    });
    return [...records.values()];
  }

  async beginLayeredArtifact(
    record: StoredRuntimeLayeredArtifact,
  ): Promise<"created" | "exists" | "conflict"> {
    const key = layeredArtifactKey(record.runtimeIdentity, record.envelope.sealedArtifactSha256);
    const reference = layeredArtifactReference(
      record.runtimeIdentity,
      record.envelope.sealedArtifactSha256,
    );
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const existing = await transaction.get<StoredRuntimeLayeredArtifact>(key);
      if (existing !== undefined) {
        return existing.envelope.contentSha256 === record.envelope.contentSha256 &&
          existing.envelope.manifestRevision === record.envelope.manifestRevision
          ? ("exists" as const)
          : ("conflict" as const);
      }
      for (const content of record.envelope.content.layers) {
        const layerKey = runtimeLayerKey(content.descriptor.contentSha256);
        const layer = await transaction.get<StoredRuntimeLayer>(layerKey);
        if (
          layer !== undefined &&
          layer.content.descriptor.unpackedManifestSha256 !==
            content.descriptor.unpackedManifestSha256
        ) {
          return "conflict" as const;
        }
      }
      await transaction.put(key, record);
      for (const content of record.envelope.content.layers) {
        const layerKey = runtimeLayerKey(content.descriptor.contentSha256);
        const existingLayer = await transaction.get<StoredRuntimeLayer>(layerKey);
        if (existingLayer === undefined) {
          await transaction.put(layerKey, {
            content,
            state: "pending",
            receivedChunks: content.chunks.map(() => null),
            pendingArtifacts: [reference],
            artifactReferences: [],
          } satisfies StoredRuntimeLayer);
        } else if (
          !existingLayer.pendingArtifacts.includes(reference) &&
          !existingLayer.artifactReferences.includes(reference)
        ) {
          existingLayer.pendingArtifacts.push(reference);
          await transaction.put(layerKey, existingLayer);
        }
      }
      return "created" as const;
    });
    if (result === "created" && record.expiresAtMs !== null) {
      await this.scheduleCleanup(this.ctx.storage, record.expiresAtMs);
    }
    return result;
  }

  async getLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeLayeredArtifact | null> {
    return (
      (await this.ctx.storage.get<StoredRuntimeLayeredArtifact>(
        layeredArtifactKey(identity, sealedArtifactSha256),
      )) ?? null
    );
  }

  async getRuntimeLayer(contentSha256: string): Promise<StoredRuntimeLayer | null> {
    return (await this.ctx.storage.get<StoredRuntimeLayer>(runtimeLayerKey(contentSha256))) ?? null;
  }

  async recordLayeredArtifactAppChunk(
    identity: string,
    sealedArtifactSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = layeredArtifactKey(identity, sealedArtifactSha256);
      const artifact = await transaction.get<StoredRuntimeLayeredArtifact>(key);
      if (artifact === undefined || artifact.state !== "pending") return "not_found" as const;
      if (chunkIndex < 0 || chunkIndex >= artifact.receivedAppChunks.length)
        return "conflict" as const;
      const current = artifact.receivedAppChunks[chunkIndex];
      if (current !== null) return current === chunkSha256 ? "replay" : "conflict";
      if (artifact.envelope.content.appArtifact.content.chunks[chunkIndex] !== chunkSha256)
        return "conflict" as const;
      artifact.receivedAppChunks[chunkIndex] = chunkSha256;
      await transaction.put(key, artifact);
      return "recorded" as const;
    });
  }

  async recordRuntimeLayerChunk(
    identity: string,
    sealedArtifactSha256: string,
    contentSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    const reference = layeredArtifactReference(identity, sealedArtifactSha256);
    return this.ctx.storage.transaction(async (transaction) => {
      const artifact = await transaction.get<StoredRuntimeLayeredArtifact>(
        layeredArtifactKey(identity, sealedArtifactSha256),
      );
      const layerKey = runtimeLayerKey(contentSha256);
      const layer = await transaction.get<StoredRuntimeLayer>(layerKey);
      if (
        artifact === undefined ||
        artifact.state !== "pending" ||
        layer === undefined ||
        (!layer.pendingArtifacts.includes(reference) &&
          !layer.artifactReferences.includes(reference))
      ) {
        return "not_found" as const;
      }
      if (layer.state === "committed") return "replay" as const;
      if (chunkIndex < 0 || chunkIndex >= layer.receivedChunks.length) return "conflict" as const;
      const current = layer.receivedChunks[chunkIndex];
      if (current !== null) return current === chunkSha256 ? "replay" : "conflict";
      if (layer.content.chunks[chunkIndex] !== chunkSha256) return "conflict" as const;
      layer.receivedChunks[chunkIndex] = chunkSha256;
      await transaction.put(layerKey, layer);
      return "recorded" as const;
    });
  }

  async commitLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<"committed" | "incomplete" | "not_found" | "conflict"> {
    const reference = layeredArtifactReference(identity, sealedArtifactSha256);
    return this.ctx.storage.transaction(async (transaction) => {
      const key = layeredArtifactKey(identity, sealedArtifactSha256);
      const artifact = await transaction.get<StoredRuntimeLayeredArtifact>(key);
      if (artifact === undefined) return "not_found" as const;
      if (artifact.state === "committed") return "committed" as const;
      if (artifact.receivedAppChunks.some((chunk) => chunk === null)) return "incomplete" as const;
      const layers: Array<{ key: string; layer: StoredRuntimeLayer }> = [];
      for (const content of artifact.envelope.content.layers) {
        const layerKey = runtimeLayerKey(content.descriptor.contentSha256);
        const layer = await transaction.get<StoredRuntimeLayer>(layerKey);
        if (
          layer === undefined ||
          layer.content.descriptor.unpackedManifestSha256 !==
            content.descriptor.unpackedManifestSha256
        ) {
          return "conflict" as const;
        }
        if (layer.state !== "committed" && layer.receivedChunks.some((chunk) => chunk === null)) {
          return "incomplete" as const;
        }
        layers.push({ key: layerKey, layer });
      }
      artifact.state = "committed";
      artifact.expiresAtMs = null;
      await transaction.put(key, artifact);
      for (const entry of layers) {
        entry.layer.state = "committed";
        entry.layer.pendingArtifacts = entry.layer.pendingArtifacts.filter(
          (candidate) => candidate !== reference,
        );
        if (!entry.layer.artifactReferences.includes(reference)) {
          entry.layer.artifactReferences.push(reference);
        }
        await transaction.put(entry.key, entry.layer);
      }
      return "committed" as const;
    });
  }

  async removeLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<RemovedRuntimeLayeredArtifact | null> {
    const reference = layeredArtifactReference(identity, sealedArtifactSha256);
    return this.ctx.storage.transaction(async (transaction) => {
      const key = layeredArtifactKey(identity, sealedArtifactSha256);
      const artifact = await transaction.get<StoredRuntimeLayeredArtifact>(key);
      if (artifact === undefined) return null;
      const unreferencedLayers: StoredRuntimeLayer[] = [];
      for (const content of artifact.envelope.content.layers) {
        const layerKey = runtimeLayerKey(content.descriptor.contentSha256);
        const layer = await transaction.get<StoredRuntimeLayer>(layerKey);
        if (layer === undefined) continue;
        layer.pendingArtifacts = layer.pendingArtifacts.filter(
          (candidate) => candidate !== reference,
        );
        layer.artifactReferences = layer.artifactReferences.filter(
          (candidate) => candidate !== reference,
        );
        if (layer.pendingArtifacts.length === 0 && layer.artifactReferences.length === 0) {
          await transaction.delete(layerKey);
          unreferencedLayers.push(layer);
        } else {
          await transaction.put(layerKey, layer);
        }
      }
      await transaction.delete(key);
      return { artifact, unreferencedLayers };
    });
  }

  async listLayeredArtifacts(identity: string): Promise<StoredRuntimeLayeredArtifact[]> {
    const records = await this.ctx.storage.list<StoredRuntimeLayeredArtifact>({
      prefix: `layered-artifact:${identity}:`,
    });
    return [...records.values()];
  }

  async bindContainer(containerId: string, identity: string): Promise<void> {
    await this.ctx.storage.put(await containerBindingKey(containerId), identity);
  }

  async getContainerBinding(containerId: string): Promise<string | null> {
    return (await this.ctx.storage.get<string>(await containerBindingKey(containerId))) ?? null;
  }

  async unbindContainer(containerId: string, expectedIdentity: string): Promise<boolean> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = await containerBindingKey(containerId);
      const current = await transaction.get<string>(key);
      if (current !== expectedIdentity) return false;
      await transaction.delete(key);
      return true;
    });
  }

  async getRoute(hostname: string): Promise<RouteRecord | null> {
    if (this.routeCache.has(hostname)) return structuredClone(this.routeCache.get(hostname)!);
    const route = (await this.ctx.storage.get<RouteRecord>(routeKey(hostname))) ?? null;
    this.routeCache.set(hostname, route);
    return structuredClone(route);
  }

  async activateRoute(
    route: RouteRecord,
    expectedPreviousManifestRevision: string | null,
  ): Promise<"activated" | "conflict"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<RouteRecord>(routeKey(route.hostname));
      if ((current?.manifestRevision ?? null) !== expectedPreviousManifestRevision) {
        return { state: "conflict" as const, current: current ?? null };
      }
      await transaction.put(routeKey(route.hostname), route);
      return { state: "activated" as const, current: route };
    });
    this.routeCache.set(route.hostname, result.current);
    return result.state;
  }

  async deactivateRoute(
    hostname: string,
    expectedManifestRevision: string,
    expectedSandboxIdentity: string,
  ): Promise<"deactivated" | "not_found" | "conflict"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<RouteRecord>(routeKey(hostname));
      if (current === undefined) return { state: "not_found" as const, current: null };
      if (
        current.manifestRevision !== expectedManifestRevision ||
        current.sandboxIdentity !== expectedSandboxIdentity
      ) {
        return { state: "conflict" as const, current };
      }
      await transaction.delete(routeKey(hostname));
      return { state: "deactivated" as const, current: null };
    });
    this.routeCache.set(hostname, result.current);
    return result.state;
  }

  async appendSystemLog(identity: string, message: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = runtimeKey(identity);
      const runtime = await transaction.get<StoredRuntime>(key);
      if (runtime === undefined) return;
      this.appendLogEntries(runtime, "system", splitLogDelta(message));
      await transaction.put(key, runtime);
    });
  }

  async mergeProcessLogs(identity: string, stdout: string, stderr: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const key = runtimeKey(identity);
      const runtime = await transaction.get<StoredRuntime>(key);
      if (runtime === undefined) return;

      const stdoutDelta = stdout.slice(runtime.stdoutLength);
      const stderrDelta = stderr.slice(runtime.stderrLength);
      runtime.stdoutLength = stdout.length;
      runtime.stderrLength = stderr.length;
      this.appendLogEntries(runtime, "stdout", splitLogDelta(stdoutDelta));
      this.appendLogEntries(runtime, "stderr", splitLogDelta(stderrDelta));
      await transaction.put(key, runtime);
    });
  }

  async listRuntimeLogs(
    identity: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: RuntimeLogEntry[]; nextCursor: string | null }> {
    const runtime = await this.getRuntime(identity);
    if (runtime === null) return { entries: [], nextCursor: null };
    const afterSequence = parseCursor(cursor);
    const entries = runtime.logs
      .filter((entry) => Number(entry.cursor.slice(4)) > afterSequence)
      .slice(0, limit);
    const nextCursor = entries.at(-1)?.cursor ?? cursor ?? null;
    return { entries, nextCursor };
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    for (const prefix of ["nonce:", "idempotency:"] as const) {
      const records = await this.ctx.storage.list<number | StoredIdempotencyRecord>({ prefix });
      const expired: string[] = [];
      let nextExpiry: number | null = null;
      for (const [key, value] of records) {
        const expiresAtMs = typeof value === "number" ? value : value.expiresAtMs;
        if (expiresAtMs <= nowMs) expired.push(key);
        else nextExpiry = nextExpiry === null ? expiresAtMs : Math.min(nextExpiry, expiresAtMs);
      }
      if (expired.length > 0) await this.ctx.storage.delete(expired);
      if (nextExpiry !== null) await this.scheduleCleanup(this.ctx.storage, nextExpiry);
    }
    const artifacts = await this.ctx.storage.list<StoredRuntimeArtifact>({ prefix: "artifact:" });
    let nextArtifactExpiry: number | null = null;
    for (const [key, artifact] of artifacts) {
      if (
        artifact.state === "pending" &&
        artifact.expiresAtMs !== null &&
        artifact.expiresAtMs <= nowMs
      ) {
        await deleteArtifactObjects(this.env.NABUFLOW_RUNTIME_ARTIFACTS, artifact);
        await this.ctx.storage.delete(key);
      } else if (artifact.expiresAtMs !== null) {
        nextArtifactExpiry =
          nextArtifactExpiry === null
            ? artifact.expiresAtMs
            : Math.min(nextArtifactExpiry, artifact.expiresAtMs);
      }
    }
    if (nextArtifactExpiry !== null)
      await this.scheduleCleanup(this.ctx.storage, nextArtifactExpiry);

    const layeredArtifacts = await this.ctx.storage.list<StoredRuntimeLayeredArtifact>({
      prefix: "layered-artifact:",
    });
    let nextLayeredArtifactExpiry: number | null = null;
    for (const artifact of layeredArtifacts.values()) {
      if (
        artifact.state === "pending" &&
        artifact.expiresAtMs !== null &&
        artifact.expiresAtMs <= nowMs
      ) {
        const removed = await this.removeLayeredArtifact(
          artifact.runtimeIdentity,
          artifact.envelope.sealedArtifactSha256,
        );
        if (removed !== null) {
          await deleteLayeredArtifactAppObjects(
            this.env.NABUFLOW_RUNTIME_ARTIFACTS,
            removed.artifact,
          );
          for (const layer of removed.unreferencedLayers) {
            await deleteDependencyLayerObjects(this.env.NABUFLOW_RUNTIME_ARTIFACTS, layer);
          }
        }
      } else if (artifact.expiresAtMs !== null) {
        nextLayeredArtifactExpiry =
          nextLayeredArtifactExpiry === null
            ? artifact.expiresAtMs
            : Math.min(nextLayeredArtifactExpiry, artifact.expiresAtMs);
      }
    }
    if (nextLayeredArtifactExpiry !== null) {
      await this.scheduleCleanup(this.ctx.storage, nextLayeredArtifactExpiry);
    }
  }

  private appendLogEntries(
    runtime: StoredRuntime,
    level: RuntimeLogEntry["level"],
    messages: string[],
  ): void {
    for (const message of messages) {
      if (!message) continue;
      runtime.nextLogSequence += 1;
      runtime.logs.push({
        cursor: formatCursor(runtime.nextLogSequence),
        timestamp: new Date().toISOString(),
        level,
        message,
      });
    }
    if (runtime.logs.length > MAX_RUNTIME_LOGS) {
      runtime.logs.splice(0, runtime.logs.length - MAX_RUNTIME_LOGS);
    }
  }

  private async scheduleCleanup(storage: DurableObjectStorage, expiresAtMs: number): Promise<void> {
    const alarm = await storage.getAlarm();
    if (alarm === null || expiresAtMs < alarm) await storage.setAlarm(expiresAtMs);
  }
}
