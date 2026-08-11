import { DurableObject } from "cloudflare:workers";
import {
  PANTRY_ASSEMBLY_EVENT_TRAIL_LIMIT,
  PANTRY_ASSEMBLY_LEASE_MS,
  PANTRY_ASSEMBLY_QUEUE_WATCHDOG_MS,
  PANTRY_ASSEMBLY_SERVER_EXECUTION_DEADLINE_MS,
  canonicalPantryJson,
  canonicalPantryCatalogStockIdentity,
  pantryCatalogStockIdentityEquals,
  pantryRevisionTransitionIsValid,
  sha256Hex,
  type PantryCatalogObjectReference,
  type PantryCatalogAssemblyDiagnosticsResponse,
  type PantryCatalogAssemblyProgressMetrics,
  type PantryCatalogShelfRecord,
  type PantryCatalogStockIdentity,
  type PantryCatalogStockIdentityStatusResponse,
  type PantryCatalogStockRequest,
  type PantryRevisionState,
} from "@workspace/tenant-runtime-contracts";
import type {
  PantryCatalogCoordinator,
  PantryCatalogDiagnostics,
  PantryAssemblyEventInput,
  PantryIngestClaim,
  PantryIngestFailureRecord,
  PantryGenerationResourceEvidence,
  PantryShelfLookup,
  PantryStockLookup,
  PantryWorkerBindings,
  RemovedPantryShelf,
  StoredPantryAssembly,
} from "./pantry-catalog-model";

function assemblyKey(assemblyId: string): string {
  return `assembly:${assemblyId}`;
}

function generationResourceEvidenceKey(assemblyId: string, generation: number): string {
  return `assembly-resource-evidence:${assemblyId}:${generation.toString().padStart(8, "0")}`;
}

function assemblyDiagnosticsKey(assemblyId: string): string {
  return `assembly-diagnostics:${assemblyId}`;
}

function r2ProbeCheckpointKey(probeId: string, window: number, operation: number): string {
  return `diagnostic-r2-probe:${probeId}:${window.toString().padStart(4, "0")}:${operation
    .toString()
    .padStart(4, "0")}`;
}

const EMPTY_PROGRESS_METRICS: PantryCatalogAssemblyProgressMetrics = {
  resolvedPackages: 0,
  fetchedTarballs: 0,
  verifiedTarballs: 0,
  extractedTarballs: 0,
  dependencyEdges: 0,
  tarballBytes: 0,
  unpackedBytes: 0,
};

function appendAssemblyEvent(
  current: PantryCatalogAssemblyDiagnosticsResponse | undefined,
  assembly: StoredPantryAssembly,
  event: PantryAssemblyEventInput,
): PantryCatalogAssemblyDiagnosticsResponse {
  const previousSequence =
    current?.events.at(-1)?.sequence ?? current?.truncatedBeforeSequence ?? 0;
  const metrics = event.metrics ?? current?.metrics ?? EMPTY_PROGRESS_METRICS;
  const nextEvent = {
    sequence: previousSequence + 1,
    at: event.at,
    kind: event.kind,
    stage: event.stage,
    generation: event.generation ?? assembly.execution.generation,
    attempt: event.attempt ?? assembly.ingest?.attempt ?? 0,
    queueDeliveries: assembly.queueDeliveries,
    stagedObjects: assembly.objects.length,
    metrics,
    failureCode: event.failureCode ?? null,
    failureStage: event.failureStage ?? null,
    failureOperation: event.failureOperation ?? null,
    failureCause: event.failureCause ?? null,
    failureErrorClass: event.failureErrorClass ?? null,
    failureErrorCode: event.failureErrorCode ?? null,
    failureErrorFingerprint: event.failureErrorFingerprint ?? null,
    reclaimedObjects: event.reclaimedObjects ?? 0,
    reclaimedBytes: event.reclaimedBytes ?? 0,
  } as const;
  const events = [...(current?.events ?? []), nextEvent];
  const removed = Math.max(0, events.length - PANTRY_ASSEMBLY_EVENT_TRAIL_LIMIT);
  const retainedEvents = removed === 0 ? events : events.slice(removed);
  const stageTransitions = [...(current?.stageTransitions ?? [])];
  const existingTransition = stageTransitions.find((entry) => entry.stage === event.stage);
  if (existingTransition === undefined) {
    stageTransitions.push({
      stage: event.stage,
      firstAt: event.at,
      lastAt: event.at,
      transitions: 1,
    });
  } else {
    existingTransition.lastAt = event.at;
    existingTransition.transitions += 1;
  }
  return {
    ok: true,
    assemblyId: assembly.assemblyId,
    requestSha256: assembly.request.requestSha256,
    currentStage: event.stage,
    lastTransitionAt: event.at,
    queueEnqueues: (current?.queueEnqueues ?? 0) + (event.kind === "queue-enqueued" ? 1 : 0),
    queueDeliveries: assembly.queueDeliveries,
    generation: event.generation ?? assembly.execution.generation,
    leaseRenewals: (current?.leaseRenewals ?? 0) + (event.kind === "lease-renewed" ? 1 : 0),
    alarmReenqueues: (current?.alarmReenqueues ?? 0) + (event.kind === "alarm-reenqueued" ? 1 : 0),
    ingestAttempts: Math.max(current?.ingestAttempts ?? 0, nextEvent.attempt),
    stagedObjects: assembly.objects.length,
    metrics,
    stageTransitions,
    events: retainedEvents,
    truncatedBeforeSequence:
      removed === 0 ? (current?.truncatedBeforeSequence ?? 0) : events[removed - 1].sequence,
  };
}

function stockKey(requestSha256: string): string {
  return `stock:${requestSha256}`;
}

function shelfKey(rootSha256: string): string {
  return `shelf:${rootSha256}`;
}

function shelfStockKey(rootSha256: string): string {
  return `shelf-stock:${rootSha256}`;
}

function lifecycleKey(rootSha256: string): string {
  return `lifecycle:${rootSha256}`;
}

function revisionKey(revisionId: string): string {
  return `revision:${revisionId}`;
}

function objectReferenceKey(sha256: string): string {
  return `object-reference:${sha256}`;
}

async function externalReferenceKey(rootSha256: string, referenceId: string): Promise<string> {
  return `external-reference:${rootSha256}:${await sha256Hex(referenceId)}`;
}

interface StockIndex {
  state: "assembling" | "committed";
  assemblyId: string;
  revisionRootSha256: string | null;
  identity?: PantryCatalogStockIdentity;
}

function sameObjectReference(
  left: PantryCatalogObjectReference,
  right: PantryCatalogObjectReference,
): boolean {
  return left.kind === right.kind && left.sha256 === right.sha256 && left.bytes === right.bytes;
}

function sameObjectSet(
  left: readonly PantryCatalogObjectReference[],
  right: readonly PantryCatalogObjectReference[],
): boolean {
  return (
    left.length === right.length &&
    left.every((reference, index) => sameObjectReference(reference, right[index]))
  );
}

export class PantryCatalogDurableObject
  extends DurableObject<PantryWorkerBindings>
  implements PantryCatalogCoordinator
{
  async beginStock(request: PantryCatalogStockRequest): Promise<PantryStockLookup> {
    const assemblyId = `passembly_${request.requestSha256}`;
    const identity = canonicalPantryCatalogStockIdentity(request);
    const nowMs = Date.now();
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const index = await transaction.get<StockIndex>(stockKey(request.requestSha256));
      if (
        index?.identity !== undefined &&
        !pantryCatalogStockIdentityEquals(index.identity, identity)
      ) {
        return { state: "conflict", assemblyId: index.assemblyId } as const;
      }
      if (index?.state === "committed" && index.revisionRootSha256 !== null) {
        return {
          state: "committed",
          assemblyId: index.assemblyId,
          revisionRootSha256: index.revisionRootSha256,
        } as const;
      }
      const existing = await transaction.get<StoredPantryAssembly>(assemblyKey(assemblyId));
      if (existing !== undefined) {
        if (!pantryCatalogStockIdentityEquals(existing.request, identity)) {
          return { state: "conflict", assemblyId } as const;
        }
        return { state: "assembling", assembly: existing } as const;
      }
      const assembly: StoredPantryAssembly = {
        assemblyId,
        request,
        state: "assembling",
        objects: [],
        expiresAtMs: Date.parse(request.expiresAt),
        queueDeliveries: 0,
        ingest: {
          state: "queued",
          attempt: 0,
          updatedAt: request.requestedAt,
          leaseUntil: null,
          failure: null,
        },
        execution: {
          generation: 1,
          state: "queued",
          ownerId: null,
          leaseUntilMs: null,
          deadlineMs: nowMs + PANTRY_ASSEMBLY_SERVER_EXECUTION_DEADLINE_MS,
          nextDriveAtMs: nowMs,
          enqueuedGeneration: null,
          checkpoint: "queued",
        },
      };
      await transaction.put({
        [assemblyKey(assemblyId)]: assembly,
        [stockKey(request.requestSha256)]: {
          state: "assembling",
          assemblyId,
          revisionRootSha256: null,
          identity,
        } satisfies StockIndex,
      });
      return { state: "created", assembly } as const;
    });
    if (result.state === "created") {
      await this.recordAssemblyEvent(result.assembly.assemblyId, {
        kind: "assembly-created",
        stage: "queued",
        at: new Date(nowMs).toISOString(),
      });
      await this.scheduleCleanup(nowMs);
    }
    return result;
  }

  async getStockIdentity(
    identitySha256: string,
  ): Promise<PantryCatalogStockIdentityStatusResponse | null> {
    const index = await this.ctx.storage.get<StockIndex>(stockKey(identitySha256));
    if (index === undefined) return null;
    if (index.state === "committed" && index.revisionRootSha256 !== null) {
      return {
        ok: true,
        state: "committed",
        identitySha256,
        assemblyId: index.assemblyId,
        revisionRootSha256: index.revisionRootSha256,
      };
    }
    const assembly = await this.ctx.storage.get<StoredPantryAssembly>(
      assemblyKey(index.assemblyId),
    );
    if (assembly === undefined) return null;
    return {
      ok: true,
      state: "assembling",
      identitySha256,
      assemblyId: index.assemblyId,
      revisionRootSha256: null,
    };
  }

  async claimIngest(
    assemblyId: string,
    generation: number,
    ownerId: string,
    nowMs: number,
  ): Promise<PantryIngestClaim> {
    const now = new Date(nowMs).toISOString();
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const key = assemblyKey(assemblyId);
      const assembly = await transaction.get<StoredPantryAssembly>(key);
      if (assembly === undefined) return { state: "not_found" } as const;
      if (
        assembly.execution.generation !== generation ||
        assembly.execution.enqueuedGeneration !== generation
      ) {
        return { state: "stale", assembly } as const;
      }
      if (assembly.execution.deadlineMs <= nowMs) {
        return { state: "failed", assembly } as const;
      }
      const progress = assembly.ingest;
      if (
        assembly.execution.state === "running" &&
        assembly.execution.leaseUntilMs !== null &&
        assembly.execution.leaseUntilMs > nowMs
      ) {
        return { state: "busy", assembly } as const;
      }
      if (
        progress?.state === "failed" &&
        progress.failure !== null &&
        Date.parse(progress.failure.negativeCacheUntil) > Date.parse(now)
      ) {
        return { state: "failed", assembly } as const;
      }
      const leaseUntilMs = Math.min(
        nowMs + PANTRY_ASSEMBLY_LEASE_MS,
        assembly.execution.deadlineMs,
      );
      assembly.execution = {
        ...assembly.execution,
        state: "running",
        ownerId,
        leaseUntilMs,
        nextDriveAtMs: leaseUntilMs,
        checkpoint: "ingesting",
      };
      assembly.ingest = {
        state: "running",
        attempt: (progress?.attempt ?? 0) + 1,
        updatedAt: now,
        leaseUntil: new Date(leaseUntilMs).toISOString(),
        failure: null,
      };
      await transaction.put(key, assembly);
      return { state: "claimed", assembly } as const;
    });
    if (result.state !== "not_found") {
      await this.recordAssemblyEvent(result.assembly.assemblyId, {
        kind:
          result.state === "claimed"
            ? "generation-claimed"
            : result.state === "busy"
              ? "generation-busy"
              : result.state === "stale"
                ? "generation-busy"
                : "ingest-failed",
        stage:
          result.state === "claimed"
            ? "resolving-metadata"
            : result.state === "failed"
              ? "failed"
              : ((await this.getAssemblyDiagnostics(result.assembly.assemblyId))?.currentStage ??
                "queued"),
        at: now,
        generation: result.assembly.execution.generation,
        attempt: result.assembly.ingest?.attempt ?? 0,
        failureCode: result.assembly.ingest?.failure?.code ?? null,
        failureStage: result.assembly.ingest?.failure?.stage ?? null,
        failureOperation: result.assembly.ingest?.failure?.operation ?? null,
        failureCause: result.assembly.ingest?.failure?.cause ?? null,
        failureErrorClass: result.assembly.ingest?.failure?.errorClass ?? null,
        failureErrorCode: result.assembly.ingest?.failure?.errorCode ?? null,
        failureErrorFingerprint: result.assembly.ingest?.failure?.errorFingerprint ?? null,
      });
    }
    return result;
  }

  async renewIngest(
    assemblyId: string,
    generation: number,
    ownerId: string,
    nowMs: number,
  ): Promise<"renewed" | "not_owner" | "terminal" | "not_found"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const key = assemblyKey(assemblyId);
      const assembly = await transaction.get<StoredPantryAssembly>(key);
      if (assembly === undefined) return { state: "not_found" as const, assembly: null };
      if (assembly.execution.deadlineMs <= nowMs) {
        return { state: "terminal" as const, assembly };
      }
      if (
        assembly.execution.state !== "running" ||
        assembly.execution.generation !== generation ||
        assembly.execution.ownerId !== ownerId
      ) {
        return { state: "not_owner" as const, assembly };
      }
      const leaseUntilMs = Math.min(
        nowMs + PANTRY_ASSEMBLY_LEASE_MS,
        assembly.execution.deadlineMs,
      );
      assembly.execution.leaseUntilMs = leaseUntilMs;
      assembly.execution.nextDriveAtMs = leaseUntilMs;
      if (assembly.ingest?.state === "running") {
        assembly.ingest.leaseUntil = new Date(leaseUntilMs).toISOString();
        assembly.ingest.updatedAt = new Date(nowMs).toISOString();
      }
      await transaction.put(key, assembly);
      return { state: "renewed" as const, assembly };
    });
    if (result.state === "renewed" && result.assembly !== null) {
      await this.recordAssemblyEvent(assemblyId, {
        kind: "lease-renewed",
        stage:
          (await this.getAssemblyDiagnostics(assemblyId))?.currentStage ?? "resolving-metadata",
        at: new Date(nowMs).toISOString(),
        generation,
        attempt: result.assembly.ingest?.attempt ?? 0,
      });
      await this.scheduleCleanup(result.assembly.execution.nextDriveAtMs);
    }
    return result.state;
  }

  async recordIngestFailure(
    assemblyId: string,
    generation: number,
    ownerId: string,
    failure: PantryIngestFailureRecord,
  ): Promise<"recorded" | "not_owner" | "not_found"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const key = assemblyKey(assemblyId);
      const assembly = await transaction.get<StoredPantryAssembly>(key);
      if (assembly === undefined) return "not_found" as const;
      if (
        assembly.execution.generation !== generation ||
        assembly.execution.ownerId !== ownerId ||
        assembly.execution.state !== "running"
      ) {
        return "not_owner" as const;
      }
      assembly.ingest = {
        state: "failed",
        attempt: assembly.ingest?.attempt ?? 1,
        updatedAt: failure.failedAt,
        leaseUntil: null,
        failure,
      };
      assembly.execution.state = "failed";
      assembly.execution.ownerId = null;
      assembly.execution.leaseUntilMs = null;
      assembly.execution.enqueuedGeneration = null;
      assembly.execution.nextDriveAtMs = failure.retryable
        ? Date.parse(failure.negativeCacheUntil)
        : assembly.expiresAtMs;
      await transaction.put(key, assembly);
      return "recorded" as const;
    });
    if (result === "recorded") {
      const assembly = await this.getAssembly(assemblyId);
      await this.recordAssemblyEvent(assemblyId, {
        kind: "ingest-failed",
        stage: "failed",
        at: failure.failedAt,
        generation,
        attempt: assembly?.ingest?.attempt ?? 0,
        failureCode: failure.code,
        failureStage: failure.stage,
        failureOperation: failure.operation,
        failureCause: failure.cause,
        failureErrorClass: failure.errorClass,
        failureErrorCode: failure.errorCode,
        failureErrorFingerprint: failure.errorFingerprint,
      });
      const stored = await this.getAssembly(assemblyId);
      if (stored !== null) await this.scheduleCleanup(stored.execution.nextDriveAtMs);
    }
    return result;
  }

  async allocateRevisionIdentity(
    date: string,
  ): Promise<{ revisionId: string; parentRootSha256: string | null }> {
    return this.ctx.storage.transaction(async (transaction) => {
      const sequenceKey = `revision-sequence:${date}`;
      const sequence = ((await transaction.get<number>(sequenceKey)) ?? 0) + 1;
      const parentRootSha256 = (await transaction.get<string>("shelf:latest-root")) ?? null;
      await transaction.put(sequenceKey, sequence);
      return { revisionId: `pantry-${date}.${sequence}`, parentRootSha256 };
    });
  }

  async markQueueDelivery(assemblyId: string): Promise<"recorded" | "not_found"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const key = assemblyKey(assemblyId);
      const assembly = await transaction.get<StoredPantryAssembly>(key);
      const totalDeliveries = (await transaction.get<number>("queue:deliveries")) ?? 0;
      if (assembly === undefined) {
        await transaction.put("queue:deliveries", totalDeliveries + 1);
        return "not_found" as const;
      }
      assembly.queueDeliveries += 1;
      await transaction.put({
        [key]: assembly,
        "queue:deliveries": totalDeliveries + 1,
      });
      return "recorded" as const;
    });
    if (result === "recorded") {
      const current = await this.getAssemblyDiagnostics(assemblyId);
      await this.recordAssemblyEvent(assemblyId, {
        kind: "queue-delivered",
        stage: current?.currentStage ?? "queued",
        at: new Date().toISOString(),
      });
    }
    return result;
  }

  async getAssembly(assemblyId: string): Promise<StoredPantryAssembly | null> {
    return (await this.ctx.storage.get<StoredPantryAssembly>(assemblyKey(assemblyId))) ?? null;
  }

  async getAssemblyDiagnostics(
    assemblyId: string,
  ): Promise<PantryCatalogAssemblyDiagnosticsResponse | null> {
    return (
      (await this.ctx.storage.get<PantryCatalogAssemblyDiagnosticsResponse>(
        assemblyDiagnosticsKey(assemblyId),
      )) ?? null
    );
  }

  async recordGenerationResourceEvidence(
    evidence: PantryGenerationResourceEvidence,
  ): Promise<void> {
    await this.ctx.storage.put(
      generationResourceEvidenceKey(evidence.assemblyId, evidence.generation),
      structuredClone(evidence),
    );
  }

  async getGenerationResourceEvidence(
    assemblyId: string,
  ): Promise<PantryGenerationResourceEvidence[]> {
    const records = await this.ctx.storage.list<PantryGenerationResourceEvidence>({
      prefix: `assembly-resource-evidence:${assemblyId}:`,
    });
    return [...records.values()].sort((left, right) => left.generation - right.generation);
  }

  async recordR2ProbeCheckpoint(
    probeId: string,
    window: number,
    operation: number,
    checkpoint: { contentSha256: string; bytes: number; completedAt: string },
  ): Promise<void> {
    await this.ctx.storage.put(
      r2ProbeCheckpointKey(probeId, window, operation),
      structuredClone(checkpoint),
    );
  }

  async clearR2ProbeCheckpoints(probeId: string): Promise<number> {
    const records = await this.ctx.storage.list({ prefix: `diagnostic-r2-probe:${probeId}:` });
    if (records.size > 0) await this.ctx.storage.delete([...records.keys()]);
    return records.size;
  }

  async recordAssemblyEvent(
    assemblyId: string,
    event: PantryAssemblyEventInput,
  ): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const assembly = await transaction.get<StoredPantryAssembly>(assemblyKey(assemblyId));
      if (assembly === undefined) return "not_found" as const;
      const current = await transaction.get<PantryCatalogAssemblyDiagnosticsResponse>(
        assemblyDiagnosticsKey(assemblyId),
      );
      await transaction.put(
        assemblyDiagnosticsKey(assemblyId),
        appendAssemblyEvent(current, assembly, event),
      );
      return "recorded" as const;
    });
  }

  async recordStagedObject(
    assemblyId: string,
    reference: PantryCatalogObjectReference,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const key = assemblyKey(assemblyId);
      const assembly = await transaction.get<StoredPantryAssembly>(key);
      if (assembly === undefined) return "not_found" as const;
      const existing = assembly.objects.find((entry) => entry.sha256 === reference.sha256);
      if (existing !== undefined) {
        return sameObjectReference(existing, reference) ? "replay" : "conflict";
      }
      assembly.objects.push(reference);
      assembly.objects.sort((left, right) => {
        const leftKey = `${left.sha256}\0${left.kind}`;
        const rightKey = `${right.sha256}\0${right.kind}`;
        return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
      });
      await transaction.put(key, assembly);
      return "recorded" as const;
    });
    if (result === "recorded" || result === "replay") {
      await this.recordAssemblyEvent(assemblyId, {
        kind: "object-staged",
        stage: "staging-objects",
        at: new Date().toISOString(),
      });
    }
    return result;
  }

  async isObjectReferenced(sha256: string, ignoredAssemblyId?: string): Promise<boolean> {
    if (((await this.ctx.storage.get<number>(objectReferenceKey(sha256))) ?? 0) > 0) return true;
    const assemblies = await this.ctx.storage.list<StoredPantryAssembly>({ prefix: "assembly:" });
    return [...assemblies.values()].some((assembly) =>
      assembly.assemblyId === ignoredAssemblyId
        ? false
        : assembly.objects.some((reference) => reference.sha256 === sha256),
    );
  }

  async reclaimAssemblyObjects(
    assemblyId: string,
  ): Promise<{ state: "reclaimed"; objects: number; bytes: number } | { state: "not_found" }> {
    const assembly = await this.getAssembly(assemblyId);
    if (assembly === null) return { state: "not_found" };
    const references = new Map<string, number>();
    for (const reference of assembly.objects) {
      references.set(reference.sha256, reference.bytes);
      await this.env.PANTRY_CATALOG_OBJECTS.delete(
        `quarantine/${assembly.assemblyId}/objects/${reference.sha256}`,
      );
    }
    let objects = 0;
    let bytes = 0;
    for (const [sha256, objectBytes] of references) {
      if (await this.isObjectReferenced(sha256, assemblyId)) continue;
      const key = `cas/sha256/${sha256}`;
      const existing = await this.env.PANTRY_CATALOG_OBJECTS.head(key);
      if (existing === null) continue;
      await this.env.PANTRY_CATALOG_OBJECTS.delete(key);
      objects += 1;
      bytes += objectBytes;
    }
    await this.recordAssemblyEvent(assemblyId, {
      kind: "objects-reclaimed",
      stage: "failed",
      at: new Date().toISOString(),
      reclaimedObjects: objects,
      reclaimedBytes: bytes,
    });
    return { state: "reclaimed", objects, bytes };
  }

  async commitShelf(
    assemblyId: string,
    shelf: PantryCatalogShelfRecord,
  ): Promise<"committed" | "replay" | "not_found" | "incomplete" | "conflict"> {
    await this.recordAssemblyEvent(assemblyId, {
      kind: "ingest-progress",
      stage: "committing-shelf",
      at: new Date().toISOString(),
    });
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const existingShelf = await transaction.get<PantryCatalogShelfRecord>(
        shelfKey(shelf.revision.rootSha256),
      );
      if (existingShelf !== undefined) {
        return existingShelf.manifestSha256 === shelf.manifestSha256 ? "replay" : "conflict";
      }
      const assembly = await transaction.get<StoredPantryAssembly>(assemblyKey(assemblyId));
      if (assembly === undefined) return "not_found" as const;
      if (!sameObjectSet(assembly.objects, shelf.objectReferences)) return "incomplete" as const;

      const existingRevisionRoot = await transaction.get<string>(
        revisionKey(shelf.revision.content.revisionId),
      );
      if (existingRevisionRoot !== undefined) return "conflict" as const;
      const latestRoot = (await transaction.get<string>("shelf:latest-root")) ?? null;
      if (shelf.revision.content.parentRootSha256 !== latestRoot) return "conflict" as const;

      const puts: Record<string, unknown> = {
        [shelfKey(shelf.revision.rootSha256)]: shelf,
        [lifecycleKey(shelf.revision.rootSha256)]: shelf.state,
        [revisionKey(shelf.revision.content.revisionId)]: shelf.revision.rootSha256,
        "shelf:latest-root": shelf.revision.rootSha256,
        [shelfStockKey(shelf.revision.rootSha256)]: assembly.request.requestSha256,
        [stockKey(assembly.request.requestSha256)]: {
          state: "committed",
          assemblyId,
          revisionRootSha256: shelf.revision.rootSha256,
          identity: canonicalPantryCatalogStockIdentity(assembly.request),
        } satisfies StockIndex,
      };
      for (const reference of shelf.objectReferences) {
        const key = objectReferenceKey(reference.sha256);
        puts[key] = ((await transaction.get<number>(key)) ?? 0) + 1;
      }
      await transaction.put(puts);
      await transaction.delete(assemblyKey(assemblyId));
      return "committed" as const;
    });
    if (result === "committed" || result === "replay") {
      const diagnostics = await this.getAssemblyDiagnostics(assemblyId);
      if (diagnostics !== null) {
        const event = {
          sequence:
            (diagnostics.events.at(-1)?.sequence ?? diagnostics.truncatedBeforeSequence) + 1,
          at: new Date().toISOString(),
          kind: "shelf-committed" as const,
          stage: "committed" as const,
          generation: diagnostics.generation,
          attempt: diagnostics.ingestAttempts,
          queueDeliveries: diagnostics.queueDeliveries,
          stagedObjects: diagnostics.stagedObjects,
          metrics: diagnostics.metrics,
          failureCode: null,
          failureStage: null,
          failureOperation: null,
          failureCause: null,
          failureErrorClass: null,
          failureErrorCode: null,
          failureErrorFingerprint: null,
          reclaimedObjects: 0,
          reclaimedBytes: 0,
        };
        const events = [...diagnostics.events, event];
        const removed = Math.max(0, events.length - PANTRY_ASSEMBLY_EVENT_TRAIL_LIMIT);
        await this.ctx.storage.put(assemblyDiagnosticsKey(assemblyId), {
          ...diagnostics,
          currentStage: "committed",
          lastTransitionAt: event.at,
          stageTransitions: [
            ...diagnostics.stageTransitions,
            {
              stage: "committed" as const,
              firstAt: event.at,
              lastAt: event.at,
              transitions: 1,
            },
          ],
          events: removed === 0 ? events : events.slice(removed),
          truncatedBeforeSequence:
            removed === 0 ? diagnostics.truncatedBeforeSequence : events[removed - 1].sequence,
        } satisfies PantryCatalogAssemblyDiagnosticsResponse);
      }
    }
    return result;
  }

  async commitDerivedShelf(
    parentRootSha256: string,
    shelf: PantryCatalogShelfRecord,
  ): Promise<"committed" | "replay" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const existingShelf = await transaction.get<PantryCatalogShelfRecord>(
        shelfKey(shelf.revision.rootSha256),
      );
      if (existingShelf !== undefined) {
        return existingShelf.manifestSha256 === shelf.manifestSha256 ? "replay" : "conflict";
      }
      const parent = await transaction.get<PantryCatalogShelfRecord>(shelfKey(parentRootSha256));
      const lifecycle = await transaction.get<PantryRevisionState>(lifecycleKey(parentRootSha256));
      if (parent === undefined || lifecycle?.state !== "committed") return "not_found";
      const latestRoot = (await transaction.get<string>("shelf:latest-root")) ?? null;
      const parentResources = parent.revision.content.capturedBuildResources ?? [];
      const nextResources = shelf.revision.content.capturedBuildResources ?? [];
      const parentResourceKeys = new Set(
        parentResources.map((resource) => `${resource.url}\0${resource.contentSha256}`),
      );
      const addedResources = nextResources.filter(
        (resource) => !parentResourceKeys.has(`${resource.url}\0${resource.contentSha256}`),
      );
      const expectedReferences = new Set(
        parent.objectReferences.map((reference) => `${reference.sha256}\0${reference.kind}`),
      );
      for (const resource of addedResources) {
        expectedReferences.add(`${resource.contentSha256}\0captured-build-resource`);
      }
      const actualReferences = new Set(
        shelf.objectReferences.map((reference) => `${reference.sha256}\0${reference.kind}`),
      );
      if (
        latestRoot !== parentRootSha256 ||
        shelf.revision.content.parentRootSha256 !== parentRootSha256 ||
        shelf.revision.content.dependencyClosureSha256 !==
          parent.revision.content.dependencyClosureSha256 ||
        canonicalPantryJson(shelf.revision.content.closure) !==
          canonicalPantryJson(parent.revision.content.closure) ||
        shelf.lockfileSha256 !== parent.lockfileSha256 ||
        shelf.sbomSha256 !== parent.sbomSha256 ||
        shelf.toolchainAttestationSha256 !== parent.toolchainAttestationSha256 ||
        nextResources.length !== parentResources.length + 1 ||
        addedResources.length !== 1 ||
        parentResources.some(
          (resource) =>
            !nextResources.some(
              (next) => next.url === resource.url && next.contentSha256 === resource.contentSha256,
            ),
        ) ||
        expectedReferences.size !== actualReferences.size ||
        [...expectedReferences].some((reference) => !actualReferences.has(reference))
      ) {
        return "conflict";
      }
      const existingRevisionRoot = await transaction.get<string>(
        revisionKey(shelf.revision.content.revisionId),
      );
      if (existingRevisionRoot !== undefined) return "conflict";
      const puts: Record<string, unknown> = {
        [shelfKey(shelf.revision.rootSha256)]: shelf,
        [lifecycleKey(shelf.revision.rootSha256)]: shelf.state,
        [revisionKey(shelf.revision.content.revisionId)]: shelf.revision.rootSha256,
        "shelf:latest-root": shelf.revision.rootSha256,
      };
      for (const reference of shelf.objectReferences) {
        const key = objectReferenceKey(reference.sha256);
        puts[key] = ((await transaction.get<number>(key)) ?? 0) + 1;
      }
      await transaction.put(puts);
      return "committed";
    });
  }

  async getShelfByRoot(rootSha256: string): Promise<PantryShelfLookup | null> {
    const shelf = await this.ctx.storage.get<PantryCatalogShelfRecord>(shelfKey(rootSha256));
    if (shelf === undefined) return null;
    const lifecycle =
      (await this.ctx.storage.get<PantryRevisionState>(lifecycleKey(rootSha256))) ?? shelf.state;
    const externalReferences = await this.countExternalReferences(rootSha256);
    return { shelf, lifecycle, externalReferences };
  }

  async getShelfByRevisionId(revisionId: string): Promise<PantryShelfLookup | null> {
    const root = await this.ctx.storage.get<string>(revisionKey(revisionId));
    return root === undefined ? null : this.getShelfByRoot(root);
  }

  async transitionShelf(
    rootSha256: string,
    expectedStateRevision: number,
    nextState: "quarantined" | "retired",
    updatedAt: string,
  ): Promise<"updated" | "not_found" | "conflict"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = lifecycleKey(rootSha256);
      const current = await transaction.get<PantryRevisionState>(key);
      if (current === undefined) return "not_found" as const;
      if (current.stateRevision !== expectedStateRevision) return "conflict" as const;
      const next: PantryRevisionState = {
        ...current,
        state: nextState,
        stateRevision: current.stateRevision + 1,
        updatedAt,
      };
      if (!pantryRevisionTransitionIsValid(current, next)) return "conflict" as const;
      await transaction.put(key, next);
      return "updated" as const;
    });
  }

  async retainShelf(
    rootSha256: string,
    referenceId: string,
  ): Promise<"retained" | "replay" | "not_found"> {
    const key = await externalReferenceKey(rootSha256, referenceId);
    return this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<PantryCatalogShelfRecord>(shelfKey(rootSha256))) === undefined) {
        return "not_found" as const;
      }
      if ((await transaction.get<string>(key)) !== undefined) return "replay" as const;
      await transaction.put(key, referenceId);
      return "retained" as const;
    });
  }

  async releaseShelf(rootSha256: string, referenceId: string): Promise<"released" | "not_found"> {
    const key = await externalReferenceKey(rootSha256, referenceId);
    return this.ctx.storage.transaction(async (transaction) => {
      if ((await transaction.get<string>(key)) === undefined) return "not_found" as const;
      await transaction.delete(key);
      return "released" as const;
    });
  }

  async cleanupExpiredAssemblies(nowMs: number, maxDeletes: number): Promise<string[]> {
    const assemblies = await this.ctx.storage.list<StoredPantryAssembly>({ prefix: "assembly:" });
    const expired = [...assemblies.values()]
      .filter((assembly) => assembly.expiresAtMs <= nowMs)
      .sort((left, right) => left.expiresAtMs - right.expiresAtMs)
      .slice(0, maxDeletes);
    for (const assembly of expired) await this.deleteAssembly(assembly);
    await this.scheduleNextAssemblyAlarm();
    return expired.map((assembly) => assembly.assemblyId);
  }

  async collectRetiredShelf(
    rootSha256: string,
    retentionNamespace: string,
    nowMs: number,
  ): Promise<RemovedPantryShelf | "not_found" | "conflict"> {
    const externalReferences = await this.countExternalReferences(rootSha256);
    if (externalReferences !== 0) return "conflict";
    return this.ctx.storage.transaction(async (transaction) => {
      const shelf = await transaction.get<PantryCatalogShelfRecord>(shelfKey(rootSha256));
      const lifecycle = await transaction.get<PantryRevisionState>(lifecycleKey(rootSha256));
      if (shelf === undefined || lifecycle === undefined) return "not_found" as const;
      if (
        lifecycle.state !== "retired" ||
        shelf.retention.namespace !== retentionNamespace ||
        Date.parse(shelf.retention.retainUntil) > nowMs
      ) {
        return "conflict" as const;
      }
      const unreferencedObjectSha256: string[] = [];
      const requestSha256 = await transaction.get<string>(shelfStockKey(rootSha256));
      const stockIndex =
        requestSha256 === undefined
          ? undefined
          : await transaction.get<StockIndex>(stockKey(requestSha256));
      const deletes = [
        shelfKey(rootSha256),
        lifecycleKey(rootSha256),
        revisionKey(shelf.revision.content.revisionId),
        shelfStockKey(rootSha256),
      ];
      if (requestSha256 !== undefined) {
        deletes.push(stockKey(requestSha256));
        if (stockIndex !== undefined) {
          deletes.push(assemblyDiagnosticsKey(stockIndex.assemblyId));
        }
      }
      for (const reference of shelf.objectReferences) {
        const key = objectReferenceKey(reference.sha256);
        const next = ((await transaction.get<number>(key)) ?? 1) - 1;
        if (next <= 0) {
          deletes.push(key);
          unreferencedObjectSha256.push(reference.sha256);
        } else {
          await transaction.put(key, next);
        }
      }
      if ((await transaction.get<string>("shelf:latest-root")) === rootSha256) {
        const parentRoot = shelf.revision.content.parentRootSha256;
        if (
          parentRoot !== null &&
          (await transaction.get<PantryCatalogShelfRecord>(shelfKey(parentRoot))) !== undefined
        ) {
          await transaction.put("shelf:latest-root", parentRoot);
        } else {
          deletes.push("shelf:latest-root");
        }
      }
      await transaction.delete(deletes);
      return { shelf, unreferencedObjectSha256 } satisfies RemovedPantryShelf;
    });
  }

  async diagnostics(): Promise<PantryCatalogDiagnostics> {
    const [assemblies, shelves, objects, references, queueDeliveries] = await Promise.all([
      this.ctx.storage.list<StoredPantryAssembly>({ prefix: "assembly:" }),
      this.ctx.storage.list<PantryCatalogShelfRecord>({ prefix: "shelf:" }),
      this.ctx.storage.list<number>({ prefix: "object-reference:" }),
      this.ctx.storage.list<string>({ prefix: "external-reference:" }),
      this.ctx.storage.get<number>("queue:deliveries"),
    ]);
    return {
      assemblies: assemblies.size,
      shelves: [...shelves.keys()].filter((key) => key !== "shelf:latest-root").length,
      committedObjects: objects.size,
      externalReferences: references.size,
      queueDeliveries: queueDeliveries ?? 0,
      failedIngests: [...assemblies.values()].filter(
        (assembly) => assembly.ingest?.state === "failed",
      ).length,
    };
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    await this.driveAssemblyExecutions(nowMs);
    await this.cleanupExpiredAssemblies(nowMs, 1_000);
  }

  private async driveAssemblyExecutions(nowMs: number): Promise<void> {
    const assemblies = await this.ctx.storage.list<StoredPantryAssembly>({ prefix: "assembly:" });
    for (const snapshot of assemblies.values()) {
      const action = await this.ctx.storage.transaction(async (transaction) => {
        const key = assemblyKey(snapshot.assemblyId);
        const assembly = await transaction.get<StoredPantryAssembly>(key);
        if (assembly === undefined) return { state: "gone" as const };
        if (assembly.execution.deadlineMs <= nowMs) {
          const failedAt = new Date(nowMs).toISOString();
          assembly.execution.state = "failed";
          assembly.execution.ownerId = null;
          assembly.execution.leaseUntilMs = null;
          assembly.execution.enqueuedGeneration = null;
          assembly.execution.nextDriveAtMs = assembly.expiresAtMs;
          assembly.ingest = {
            state: "failed",
            attempt: assembly.ingest?.attempt ?? 0,
            updatedAt: failedAt,
            leaseUntil: null,
            failure: {
              code: "ingest_timeout",
              message: "Pantry assembly exceeded its execution deadline",
              retryable: false,
              failedAt,
              negativeCacheUntil: failedAt,
              stage: "assembly-deadline",
              operation: "assembly-deadline",
              cause: "deadline-exceeded",
              errorClass: null,
              errorCode: null,
              errorFingerprint: null,
            },
          };
          await transaction.put(key, assembly);
          return { state: "terminal" as const, assembly };
        }
        if (
          assembly.execution.state === "running" &&
          assembly.execution.leaseUntilMs !== null &&
          assembly.execution.leaseUntilMs > nowMs
        ) {
          return { state: "wait" as const, assembly };
        }
        let adopted = false;
        if (
          assembly.execution.state === "running" ||
          (assembly.execution.state === "failed" &&
            assembly.ingest?.failure?.retryable === true &&
            assembly.execution.nextDriveAtMs <= nowMs) ||
          (assembly.execution.state === "queued" &&
            assembly.execution.enqueuedGeneration === assembly.execution.generation &&
            assembly.execution.nextDriveAtMs <= nowMs)
        ) {
          adopted = true;
          assembly.execution.generation += 1;
          assembly.execution.state = "queued";
          assembly.execution.ownerId = null;
          assembly.execution.leaseUntilMs = null;
          assembly.execution.enqueuedGeneration = null;
          assembly.execution.checkpoint = "queued";
          assembly.ingest = {
            state: "queued",
            attempt: assembly.ingest?.attempt ?? 0,
            updatedAt: new Date(nowMs).toISOString(),
            leaseUntil: null,
            failure: null,
          };
        }
        if (assembly.execution.state !== "queued") {
          return { state: "wait" as const, assembly };
        }
        if (assembly.execution.enqueuedGeneration === assembly.execution.generation) {
          return { state: "wait" as const, assembly };
        }
        assembly.execution.enqueuedGeneration = assembly.execution.generation;
        assembly.execution.nextDriveAtMs = nowMs + PANTRY_ASSEMBLY_QUEUE_WATCHDOG_MS;
        await transaction.put(key, assembly);
        return { state: "enqueue" as const, assembly, adopted };
      });
      if (action.state === "gone") continue;
      if (action.state === "terminal") {
        await this.recordAssemblyEvent(action.assembly.assemblyId, {
          kind: "deadline-terminal",
          stage: "failed",
          at: new Date(nowMs).toISOString(),
          generation: action.assembly.execution.generation,
          attempt: action.assembly.ingest?.attempt ?? 0,
          failureCode: "ingest_timeout",
          failureStage: "assembly-deadline",
          failureOperation: "assembly-deadline",
          failureCause: "deadline-exceeded",
          failureErrorClass: null,
          failureErrorCode: null,
          failureErrorFingerprint: null,
          reclaimedObjects: 0,
          reclaimedBytes: 0,
        });
        continue;
      }
      if (action.state === "wait") continue;
      if (action.adopted) {
        await this.recordAssemblyEvent(action.assembly.assemblyId, {
          kind: "lease-expired",
          stage: "queued",
          at: new Date(nowMs).toISOString(),
          generation: action.assembly.execution.generation,
          attempt: action.assembly.ingest?.attempt ?? 0,
        });
        await this.recordAssemblyEvent(action.assembly.assemblyId, {
          kind: "alarm-reenqueued",
          stage: "queued",
          at: new Date(nowMs).toISOString(),
          generation: action.assembly.execution.generation,
          attempt: action.assembly.ingest?.attempt ?? 0,
        });
      }
      let sent = false;
      try {
        await this.env.PANTRY_INGEST_QUEUE?.send({
          schemaVersion: 1,
          assemblyId: action.assembly.assemblyId,
          requestSha256: action.assembly.request.requestSha256,
          generation: action.assembly.execution.generation,
        });
        sent = this.env.PANTRY_INGEST_QUEUE !== undefined;
      } catch {
        // The alarm owns retry and no request path can enqueue this generation.
      }
      if (sent) {
        await this.recordAssemblyEvent(action.assembly.assemblyId, {
          kind: "queue-enqueued",
          stage: "queued",
          at: new Date(nowMs).toISOString(),
          generation: action.assembly.execution.generation,
          attempt: action.assembly.ingest?.attempt ?? 0,
        });
      } else {
        await this.ctx.storage.transaction(async (transaction) => {
          const key = assemblyKey(action.assembly.assemblyId);
          const assembly = await transaction.get<StoredPantryAssembly>(key);
          if (
            assembly !== undefined &&
            assembly.execution.state === "queued" &&
            assembly.execution.generation === action.assembly.execution.generation
          ) {
            assembly.execution.enqueuedGeneration = null;
            assembly.execution.nextDriveAtMs = nowMs + PANTRY_ASSEMBLY_QUEUE_WATCHDOG_MS;
            await transaction.put(key, assembly);
          }
        });
      }
    }
    await this.scheduleNextAssemblyAlarm();
  }

  private async countExternalReferences(rootSha256: string): Promise<number> {
    return (await this.ctx.storage.list<string>({ prefix: `external-reference:${rootSha256}:` }))
      .size;
  }

  private async deleteAssembly(assembly: StoredPantryAssembly): Promise<void> {
    for (const reference of assembly.objects) {
      await this.env.PANTRY_CATALOG_OBJECTS.delete(
        `quarantine/${assembly.assemblyId}/objects/${reference.sha256}`,
      );
    }
    await this.ctx.storage.transaction(async (transaction) => {
      const index = await transaction.get<StockIndex>(stockKey(assembly.request.requestSha256));
      await transaction.delete([
        assemblyKey(assembly.assemblyId),
        assemblyDiagnosticsKey(assembly.assemblyId),
      ]);
      if (index?.state === "assembling" && index.assemblyId === assembly.assemblyId) {
        await transaction.delete(stockKey(assembly.request.requestSha256));
      }
    });
  }

  private async scheduleCleanup(expiresAtMs: number): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || expiresAtMs < alarm) await this.ctx.storage.setAlarm(expiresAtMs);
  }

  private async scheduleNextAssemblyAlarm(): Promise<void> {
    const assemblies = await this.ctx.storage.list<StoredPantryAssembly>({ prefix: "assembly:" });
    const next = [...assemblies.values()].reduce<number | null>((earliest, assembly) => {
      const executionAt = Math.min(
        assembly.execution.deadlineMs,
        assembly.execution.state === "running" && assembly.execution.leaseUntilMs !== null
          ? assembly.execution.leaseUntilMs
          : assembly.execution.nextDriveAtMs,
      );
      const candidate = Math.min(assembly.expiresAtMs, executionAt);
      return earliest === null || candidate < earliest ? candidate : earliest;
    }, null);
    if (next !== null) await this.ctx.storage.setAlarm(next);
  }
}
