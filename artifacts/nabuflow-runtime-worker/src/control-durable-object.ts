import { DurableObject } from "cloudflare:workers";
import {
  ARTIFACT_COMMIT_EVENT_LIMIT,
  DURABLE_OPERATION_LEASE_MS,
  DURABLE_OPERATION_QUEUE_WATCHDOG_MS,
  DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS,
  sha256Hex,
} from "@workspace/tenant-runtime-contracts";
import type { RouteRecord } from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "./bindings";
import type {
  ControlAuditRecord,
  ControlCoordinator,
  DurableOperationClaim,
  DurableOperationCheckpoint,
  DurableOperationDriverClaim,
  DurableOperationQueueMessage,
  DurableOperationRegistration,
  IdempotencyLookup,
  RuntimeLogEntry,
  StoredHttpResponse,
  StoredRuntime,
  StoredRuntimeArtifact,
  StoredRuntimeLayer,
  StoredRuntimeLayeredArtifact,
  StoredDurableOperationJob,
  StoredArtifactCommitJob,
  ArtifactCommitClaim,
  ArtifactCommitDriverClaim,
  ArtifactCommitCheckpoint,
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
  ownerId?: string;
  leaseUntilMs?: number;
  jobKey?: string;
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

function durableOperationJobKey(
  kind: StoredDurableOperationJob["kind"],
  identity: string,
  subjectKey: string,
  idempotencyStorageKey: string,
): string {
  return `durable-operation-job:${kind}:${identity}:${subjectKey}:${idempotencyStorageKey.slice("idempotency:".length)}`;
}

function durableOperationLatestKey(
  kind: StoredDurableOperationJob["kind"],
  identity: string,
  subjectKey: string,
): string {
  return `durable-operation-latest:${kind}:${identity}:${subjectKey}`;
}

function durableOperationQueueMessage(
  job: StoredDurableOperationJob,
): DurableOperationQueueMessage {
  return {
    schemaVersion: 1,
    jobKey: job.jobKey,
    runtimeIdentity: job.runtimeIdentity,
    subjectKey: job.subjectKey,
    kind: job.kind,
  };
}

function appendDurableOperationEvent(
  job: StoredDurableOperationJob,
  event: StoredDurableOperationJob["events"][number]["event"],
  nowMs: number,
): void {
  // Jobs created by the request-owned predecessor may survive a Worker deployment.
  // Normalize their observability fields before any append so rollout cannot strand them.
  job.eventSequence ??= 0;
  job.events ??= [];
  job.eventSequence += 1;
  job.events.push({
    sequence: job.eventSequence,
    at: new Date(nowMs).toISOString(),
    event,
    attempt: job.attempt,
    checkpoint: job.checkpoint,
  });
  if (job.events.length > ARTIFACT_COMMIT_EVENT_LIMIT) {
    job.events.splice(0, job.events.length - ARTIFACT_COMMIT_EVENT_LIMIT);
  }
  job.updatedAtMs = nowMs;
}

function durableOperationAbandonedResponse(
  kind: StoredDurableOperationJob["kind"],
): StoredHttpResponse {
  if (kind === "runtime-start") {
    return {
      status: 504,
      body: {
        ok: false,
        code: "runtime_start_timeout",
        message: "Runtime start did not complete before the execution deadline",
        retryable: false,
      },
    };
  }
  if (kind === "runtime-manifest-restart") {
    return {
      status: 504,
      body: {
        ok: false,
        code: "runtime_manifest_update_timeout",
        message: "Runtime manifest restart did not complete before the execution deadline",
        retryable: false,
      },
    };
  }
  return {
    status: 503,
    body: {
      ok: false,
      code: "artifact_commit_abandoned",
      message: "The artifact commit owner disappeared before the operation completed",
      retryable: false,
    },
  };
}

const DURABLE_OPERATION_CHECKPOINTS = {
  v1: [
    "initialized",
    "verification-complete",
    "payloads-transferred",
    "unpack-complete",
    "finalized",
  ],
  "layers-v1": [
    "initialized",
    "verification-complete",
    "payloads-transferred",
    "unpack-complete",
    "finalized",
  ],
  "runtime-start": [
    "initialized",
    "artifact-verified",
    "materialized",
    "process-started",
    "finalized",
  ],
  "runtime-manifest-restart": [
    "initialized",
    "runtime-unbound",
    "manifest-persisted",
    "materialized",
    "process-started",
    "finalized",
  ],
} as const satisfies Record<
  StoredDurableOperationJob["kind"],
  readonly DurableOperationCheckpoint[]
>;

function durableOperationSubjectMatches(
  job: StoredDurableOperationJob,
  input: DurableOperationRegistration,
): boolean {
  if (
    job.fingerprint !== input.fingerprint ||
    job.kind !== input.kind ||
    job.runtimeIdentity !== input.runtimeIdentity ||
    job.subjectKey !== input.subjectKey ||
    job.expectedDeploymentVersion !== input.expectedDeploymentVersion
  ) {
    return false;
  }
  if (
    (job.kind === "runtime-start" && input.kind === "runtime-start") ||
    (job.kind === "runtime-manifest-restart" && input.kind === "runtime-manifest-restart")
  ) {
    return JSON.stringify(job.request) === JSON.stringify(input.request);
  }
  return (
    job.kind !== "runtime-start" &&
    job.kind !== "runtime-manifest-restart" &&
    input.kind !== "runtime-start" &&
    input.kind !== "runtime-manifest-restart" &&
    job.sealedArtifactSha256 === input.sealedArtifactSha256
  );
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

  async registerDurableOperation(
    input: DurableOperationRegistration,
  ): Promise<DurableOperationClaim> {
    const idempotencyStorageKey = `idempotency:${await sha256Hex(input.key)}`;
    const jobKey = durableOperationJobKey(
      input.kind,
      input.runtimeIdentity,
      input.subjectKey,
      idempotencyStorageKey,
    );
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const idempotency = await transaction.get<StoredIdempotencyRecord>(idempotencyStorageKey);
      if (idempotency !== undefined && idempotency.expiresAtMs > input.nowMs) {
        if (idempotency.fingerprint !== input.fingerprint) return { state: "conflict" } as const;
        if (idempotency.state === "completed" && idempotency.response !== undefined) {
          return { state: "replay", response: idempotency.response } as const;
        }
      }
      const existing = await transaction.get<StoredDurableOperationJob>(jobKey);
      if (existing !== undefined) {
        existing.eventSequence ??= 0;
        existing.events ??= [];
        existing.expectedDeploymentVersion ??= input.expectedDeploymentVersion;
      }
      if (existing?.response !== undefined && existing.state !== "active") {
        await transaction.put(idempotencyStorageKey, {
          fingerprint: input.fingerprint,
          state: "completed",
          expiresAtMs: input.nowMs + IDEMPOTENCY_COMPLETED_TTL_MS,
          response: existing.response,
          jobKey,
        } satisfies StoredIdempotencyRecord);
        return { state: "replay", response: existing.response } as const;
      }
      if (existing !== undefined) {
        if (!durableOperationSubjectMatches(existing, input)) {
          return { state: "conflict" } as const;
        }
        if (existing.deadlineMs <= input.nowMs) {
          const response = durableOperationAbandonedResponse(existing.kind);
          existing.state = "failed";
          existing.ownerId = null;
          existing.leaseUntilMs = null;
          existing.abandonAtMs = null;
          existing.response = response;
          appendDurableOperationEvent(existing, "deadline-terminal", input.nowMs);
          await transaction.put(jobKey, existing);
          await transaction.put(idempotencyStorageKey, {
            fingerprint: input.fingerprint,
            state: "completed",
            expiresAtMs: input.nowMs + IDEMPOTENCY_COMPLETED_TTL_MS,
            response,
            jobKey,
          } satisfies StoredIdempotencyRecord);
          return { state: "replay", response } as const;
        }
        appendDurableOperationEvent(existing, "request-observed", input.nowMs);
        await transaction.put(jobKey, existing);
        return { state: "pending", job: existing } as const;
      }
      if (
        idempotency?.state === "pending" &&
        idempotency.expiresAtMs > input.nowMs &&
        idempotency.jobKey === undefined
      ) {
        return { state: "pending" } as const;
      }
      const common = {
        jobKey,
        kind: input.kind,
        runtimeIdentity: input.runtimeIdentity,
        subjectKey: input.subjectKey,
        expectedDeploymentVersion: input.expectedDeploymentVersion,
        fingerprint: input.fingerprint,
        idempotencyStorageKey,
        state: "active" as const,
        checkpoint: "initialized" as const,
        ownerId: null,
        attempt: 0,
        eventSequence: 0,
        events: [] as StoredDurableOperationJob["events"],
        leaseUntilMs: null,
        abandonAtMs: null,
        deadlineMs: input.nowMs + DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS,
        createdAtMs: input.nowMs,
        updatedAtMs: input.nowMs,
      };
      const job: StoredDurableOperationJob =
        input.kind === "runtime-start"
          ? { ...common, kind: "runtime-start", request: structuredClone(input.request) }
          : input.kind === "runtime-manifest-restart"
            ? {
                ...common,
                kind: "runtime-manifest-restart",
                request: structuredClone(input.request),
              }
            : {
                ...common,
                kind: input.kind,
                sealedArtifactSha256: input.sealedArtifactSha256,
              };
      appendDurableOperationEvent(job, "job-created", input.nowMs);
      await transaction.put(jobKey, job);
      await transaction.put(
        durableOperationLatestKey(input.kind, input.runtimeIdentity, input.subjectKey),
        jobKey,
      );
      await transaction.put(idempotencyStorageKey, {
        fingerprint: input.fingerprint,
        state: "pending",
        expiresAtMs: input.nowMs + IDEMPOTENCY_PENDING_TTL_MS,
        jobKey,
      } satisfies StoredIdempotencyRecord);
      return { state: "new", job } as const;
    });
    if (result.state === "new") {
      await this.scheduleCleanup(
        this.ctx.storage,
        Math.min(result.job.deadlineMs, input.nowMs + DURABLE_OPERATION_QUEUE_WATCHDOG_MS),
      );
    }
    return result;
  }

  // Compatibility wrappers retain the pre-generalization test and RPC surface while delegating
  // every state transition to the single durable-operation implementation above.
  async registerArtifactCommit(input: {
    key: string;
    fingerprint: string;
    kind: "v1" | "layers-v1";
    runtimeIdentity: string;
    sealedArtifactSha256: string;
    expectedDeploymentVersion: string;
    nowMs: number;
  }): Promise<ArtifactCommitClaim> {
    return this.registerDurableOperation({
      ...input,
      subjectKey: input.sealedArtifactSha256,
    });
  }

  async claimDurableOperationDriver(
    jobKey: string,
    ownerId: string,
    nowMs: number,
  ): Promise<DurableOperationDriverClaim> {
    const leaseUntilMs = nowMs + DURABLE_OPERATION_LEASE_MS;
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const job = await transaction.get<StoredDurableOperationJob>(jobKey);
      if (job === undefined) return { state: "not_found" } as const;
      if (job.state !== "active") return { state: "terminal", job } as const;
      if (job.deadlineMs <= nowMs) {
        const response = durableOperationAbandonedResponse(job.kind);
        job.state = "failed";
        job.ownerId = null;
        job.leaseUntilMs = null;
        job.abandonAtMs = null;
        job.response = response;
        appendDurableOperationEvent(job, "deadline-terminal", nowMs);
        await transaction.put(jobKey, job);
        await transaction.put(job.idempotencyStorageKey, {
          fingerprint: job.fingerprint,
          state: "completed",
          expiresAtMs: nowMs + IDEMPOTENCY_COMPLETED_TTL_MS,
          response,
          jobKey,
        } satisfies StoredIdempotencyRecord);
        return { state: "terminal", job } as const;
      }
      if (job.leaseUntilMs !== null && job.leaseUntilMs > nowMs) {
        appendDurableOperationEvent(job, "driver-busy", nowMs);
        await transaction.put(jobKey, job);
        return { state: "busy", job } as const;
      }
      const adopted = job.attempt > 0;
      if (job.ownerId !== null || job.leaseUntilMs !== null) {
        appendDurableOperationEvent(job, "lease-expired", nowMs);
      }
      job.ownerId = ownerId;
      job.attempt += 1;
      job.leaseUntilMs = Math.min(leaseUntilMs, job.deadlineMs);
      job.abandonAtMs = null;
      appendDurableOperationEvent(job, adopted ? "driver-adopted" : "driver-claimed", nowMs);
      await transaction.put(jobKey, job);
      const idempotency = await transaction.get<StoredIdempotencyRecord>(job.idempotencyStorageKey);
      if (idempotency?.state === "pending") {
        idempotency.ownerId = ownerId;
        idempotency.leaseUntilMs = job.leaseUntilMs;
        await transaction.put(job.idempotencyStorageKey, idempotency);
      }
      return { state: adopted ? "adopted" : "claimed", job } as const;
    });
    if (result.state === "claimed" || result.state === "adopted") {
      await this.scheduleCleanup(this.ctx.storage, result.job.leaseUntilMs!);
    }
    return result;
  }

  async claimArtifactCommitDriver(
    jobKey: string,
    ownerId: string,
    nowMs: number,
  ): Promise<ArtifactCommitDriverClaim> {
    return this.claimDurableOperationDriver(jobKey, ownerId, nowMs);
  }

  async getDurableOperation(jobKey: string): Promise<StoredDurableOperationJob | null> {
    const job = await this.ctx.storage.get<StoredDurableOperationJob>(jobKey);
    if (job === undefined) return null;
    job.eventSequence ??= 0;
    job.events ??= [];
    return job;
  }

  async getArtifactCommit(jobKey: string): Promise<StoredArtifactCommitJob | null> {
    const job = await this.getDurableOperation(jobKey);
    return job === null || job.kind === "runtime-start" || job.kind === "runtime-manifest-restart"
      ? null
      : job;
  }

  async getLatestDurableOperation(
    kind: StoredDurableOperationJob["kind"],
    runtimeIdentity: string,
    subjectKey: string,
  ): Promise<StoredDurableOperationJob | null> {
    const jobKey = await this.ctx.storage.get<string>(
      durableOperationLatestKey(kind, runtimeIdentity, subjectKey),
    );
    return jobKey === undefined ? null : await this.getDurableOperation(jobKey);
  }

  async listRecentDurableOperations(input: {
    sinceMs: number;
    untilMs: number;
    limit: number;
    kind?: StoredDurableOperationJob["kind"];
  }): Promise<StoredDurableOperationJob[]> {
    const records = await this.ctx.storage.list<StoredDurableOperationJob>({
      prefix: "durable-operation-job:",
    });
    return [...records.values()]
      .filter((job) => {
        const createdAtMs =
          job.createdAtMs ?? job.deadlineMs - DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS;
        return (
          createdAtMs >= input.sinceMs &&
          createdAtMs <= input.untilMs &&
          (input.kind === undefined || job.kind === input.kind)
        );
      })
      .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
      .slice(0, input.limit)
      .map((job) => structuredClone(job));
  }

  async getLatestArtifactCommit(
    runtimeIdentity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredArtifactCommitJob | null> {
    const job = await this.getLatestDurableOperation("v1", runtimeIdentity, sealedArtifactSha256);
    if (job !== null && job.kind !== "runtime-start" && job.kind !== "runtime-manifest-restart")
      return job;
    const layeredJob = await this.getLatestDurableOperation(
      "layers-v1",
      runtimeIdentity,
      sealedArtifactSha256,
    );
    return layeredJob !== null &&
      layeredJob.kind !== "runtime-start" &&
      layeredJob.kind !== "runtime-manifest-restart"
      ? layeredJob
      : null;
  }

  async recordDurableOperationNudge(
    jobKey: string,
    nowMs: number,
  ): Promise<"recorded" | "not_found" | "terminal"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const job = await transaction.get<StoredDurableOperationJob>(jobKey);
      if (job === undefined) return "not_found" as const;
      if (job.state !== "active") return "terminal" as const;
      appendDurableOperationEvent(job, "queue-nudged", nowMs);
      await transaction.put(jobKey, job);
      return "recorded" as const;
    });
  }

  async recordArtifactCommitNudge(jobKey: string, nowMs: number) {
    return this.recordDurableOperationNudge(jobKey, nowMs);
  }

  async renewDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    nowMs: number,
  ): Promise<"renewed" | "not_owner" | "terminal"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const job = await transaction.get<StoredDurableOperationJob>(jobKey);
      if (job === undefined || job.state !== "active") return "terminal" as const;
      if (job.ownerId !== ownerId || job.attempt !== ownerGeneration) {
        return "not_owner" as const;
      }
      job.leaseUntilMs = Math.min(nowMs + DURABLE_OPERATION_LEASE_MS, job.deadlineMs);
      appendDurableOperationEvent(job, "lease-renewed", nowMs);
      await transaction.put(jobKey, job);
      const idempotency = await transaction.get<StoredIdempotencyRecord>(job.idempotencyStorageKey);
      if (idempotency?.state === "pending") {
        idempotency.ownerId = ownerId;
        idempotency.leaseUntilMs = job.leaseUntilMs;
        await transaction.put(job.idempotencyStorageKey, idempotency);
      }
      return "renewed" as const;
    });
    if (result === "renewed") {
      const job = await this.getDurableOperation(jobKey);
      if (job?.leaseUntilMs !== null && job?.leaseUntilMs !== undefined) {
        await this.scheduleCleanup(this.ctx.storage, job.leaseUntilMs);
      }
    }
    return result;
  }

  async renewArtifactCommit(jobKey: string, ownerId: string, nowMs: number) {
    const job = await this.getDurableOperation(jobKey);
    return this.renewDurableOperation(jobKey, ownerId, job?.attempt ?? -1, nowMs);
  }

  async checkpointDurableOperation(input: {
    jobKey: string;
    ownerId: string;
    ownerGeneration: number;
    checkpoint: DurableOperationCheckpoint;
    payloadContentSha256s?: string[];
    runtimeWasRunning?: boolean;
    nowMs: number;
  }): Promise<StoredDurableOperationJob> {
    return this.ctx.storage.transaction(async (transaction) => {
      const job = await transaction.get<StoredDurableOperationJob>(input.jobKey);
      if (
        job === undefined ||
        job.state !== "active" ||
        job.ownerId !== input.ownerId ||
        job.attempt !== input.ownerGeneration
      ) {
        throw new Error("Artifact commit checkpoint owner is no longer active");
      }
      const checkpoints = DURABLE_OPERATION_CHECKPOINTS[
        job.kind
      ] as readonly DurableOperationCheckpoint[];
      const current = checkpoints.indexOf(job.checkpoint);
      const next = checkpoints.indexOf(input.checkpoint);
      if (next < current || next > current + 1) {
        throw new Error("Artifact commit checkpoint transition is invalid");
      }
      if (next === current && input.checkpoint !== "payloads-transferred") return job;
      job.checkpoint = input.checkpoint as never;
      if (input.payloadContentSha256s !== undefined) {
        if (input.checkpoint !== "payloads-transferred") {
          throw new Error("Artifact payload hashes require the transfer checkpoint");
        }
        if (job.kind === "runtime-start" || job.kind === "runtime-manifest-restart") {
          throw new Error("Runtime lifecycle checkpoints cannot carry artifact payload hashes");
        }
        job.payloadContentSha256s = [...input.payloadContentSha256s];
      }
      if (input.runtimeWasRunning !== undefined) {
        if (job.kind !== "runtime-manifest-restart" || input.checkpoint !== "runtime-unbound") {
          throw new Error("Runtime running state requires the manifest restart unbound checkpoint");
        }
        job.runtimeWasRunning = input.runtimeWasRunning;
      }
      appendDurableOperationEvent(job, "checkpoint-advanced", input.nowMs);
      await transaction.put(input.jobKey, job);
      return job;
    });
  }

  async checkpointArtifactCommit(input: {
    jobKey: string;
    ownerId: string;
    ownerGeneration?: number;
    checkpoint: ArtifactCommitCheckpoint;
    payloadContentSha256s?: string[];
    nowMs: number;
  }): Promise<StoredArtifactCommitJob> {
    const current = await this.getDurableOperation(input.jobKey);
    const job = await this.checkpointDurableOperation({
      ...input,
      ownerGeneration: input.ownerGeneration ?? current?.attempt ?? -1,
    });
    if (job.kind === "runtime-start" || job.kind === "runtime-manifest-restart") {
      throw new Error("Artifact commit job changed kind");
    }
    return job;
  }

  async completeDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<"completed" | "already_terminal" | "not_owner"> {
    return this.finishDurableOperation(
      jobKey,
      ownerId,
      ownerGeneration,
      "succeeded",
      response,
      nowMs,
    );
  }

  async completeArtifactCommit(
    jobKey: string,
    ownerId: string,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<void> {
    const job = await this.getDurableOperation(jobKey);
    await this.completeDurableOperation(jobKey, ownerId, job?.attempt ?? -1, response, nowMs);
  }

  async failDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<"completed" | "already_terminal" | "not_owner"> {
    return this.finishDurableOperation(jobKey, ownerId, ownerGeneration, "failed", response, nowMs);
  }

  async failArtifactCommit(
    jobKey: string,
    ownerId: string,
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<void> {
    const job = await this.getDurableOperation(jobKey);
    await this.failDurableOperation(jobKey, ownerId, job?.attempt ?? -1, response, nowMs);
  }

  private async finishDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    state: "succeeded" | "failed",
    response: StoredHttpResponse,
    nowMs: number,
  ): Promise<"completed" | "already_terminal" | "not_owner"> {
    const expiresAtMs = nowMs + IDEMPOTENCY_COMPLETED_TTL_MS;
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const job = await transaction.get<StoredDurableOperationJob>(jobKey);
      if (job === undefined) return "not_owner" as const;
      if (job.state !== "active") return "already_terminal" as const;
      if (job.ownerId !== ownerId || job.attempt !== ownerGeneration) {
        return "not_owner" as const;
      }
      if (state === "succeeded" && job.checkpoint !== "finalized") {
        throw new Error("Artifact commit cannot complete before finalization");
      }
      job.state = state;
      job.ownerId = null;
      job.leaseUntilMs = null;
      job.abandonAtMs = null;
      job.response = response;
      appendDurableOperationEvent(
        job,
        state === "succeeded" ? "driver-succeeded" : "driver-failed",
        nowMs,
      );
      await transaction.put(jobKey, job);
      await transaction.put(job.idempotencyStorageKey, {
        fingerprint: job.fingerprint,
        state: "completed",
        expiresAtMs,
        response,
        jobKey,
      } satisfies StoredIdempotencyRecord);
      return "completed" as const;
    });
    if (result === "completed") await this.scheduleCleanup(this.ctx.storage, expiresAtMs);
    return result;
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
    const durableJobs = await this.ctx.storage.list<StoredDurableOperationJob>({
      prefix: "durable-operation-job:",
    });
    let nextDurableJobAlarm: number | null = null;
    for (const [key, snapshot] of durableJobs) {
      if (snapshot.state !== "active") {
        const deleteAt = snapshot.updatedAtMs + IDEMPOTENCY_COMPLETED_TTL_MS;
        if (deleteAt <= nowMs) {
          await this.ctx.storage.delete([
            key,
            durableOperationLatestKey(snapshot.kind, snapshot.runtimeIdentity, snapshot.subjectKey),
          ]);
        } else
          nextDurableJobAlarm =
            nextDurableJobAlarm === null ? deleteAt : Math.min(nextDurableJobAlarm, deleteAt);
        continue;
      }
      const driveAt = Math.min(
        snapshot.leaseUntilMs ?? snapshot.updatedAtMs + DURABLE_OPERATION_QUEUE_WATCHDOG_MS,
        snapshot.deadlineMs,
      );
      if (driveAt > nowMs) {
        nextDurableJobAlarm =
          nextDurableJobAlarm === null ? driveAt : Math.min(nextDurableJobAlarm, driveAt);
        continue;
      }
      const recovery = await this.ctx.storage.transaction(async (transaction) => {
        const job = await transaction.get<StoredDurableOperationJob>(key);
        if (job === undefined || job.state !== "active") return null;
        if (job.deadlineMs <= nowMs) {
          const response = durableOperationAbandonedResponse(job.kind);
          job.state = "failed";
          job.ownerId = null;
          job.leaseUntilMs = null;
          job.abandonAtMs = null;
          job.response = response;
          appendDurableOperationEvent(job, "deadline-terminal", nowMs);
          await transaction.put(key, job);
          await transaction.put(job.idempotencyStorageKey, {
            fingerprint: job.fingerprint,
            state: "completed",
            expiresAtMs: nowMs + IDEMPOTENCY_COMPLETED_TTL_MS,
            response,
            jobKey: key,
          } satisfies StoredIdempotencyRecord);
          return { action: "terminal" as const, job };
        }
        if (job.leaseUntilMs !== null && job.leaseUntilMs > nowMs) {
          return { action: "wait" as const, job };
        }
        if (job.ownerId !== null || job.leaseUntilMs !== null) {
          appendDurableOperationEvent(job, "lease-expired", nowMs);
        }
        job.ownerId = null;
        job.leaseUntilMs = null;
        job.abandonAtMs = null;
        appendDurableOperationEvent(job, "alarm-redelivery", nowMs);
        await transaction.put(key, job);
        return { action: "requeue" as const, job };
      });
      if (recovery === null) continue;
      if (recovery.action === "terminal") {
        const deleteAt = nowMs + IDEMPOTENCY_COMPLETED_TTL_MS;
        nextDurableJobAlarm =
          nextDurableJobAlarm === null ? deleteAt : Math.min(nextDurableJobAlarm, deleteAt);
        continue;
      }
      if (recovery.action === "wait") {
        const next = Math.min(recovery.job.leaseUntilMs!, recovery.job.deadlineMs);
        nextDurableJobAlarm =
          nextDurableJobAlarm === null ? next : Math.min(nextDurableJobAlarm, next);
        continue;
      }
      let enqueued = false;
      try {
        await this.env.DURABLE_OPERATION_QUEUE?.send(durableOperationQueueMessage(recovery.job));
        enqueued = this.env.DURABLE_OPERATION_QUEUE !== undefined;
      } catch {
        // The next watchdog alarm retries; the inner deadline remains authoritative.
      }
      if (!enqueued) {
        await this.ctx.storage.transaction(async (transaction) => {
          const job = await transaction.get<StoredDurableOperationJob>(key);
          if (job === undefined || job.state !== "active") return;
          appendDurableOperationEvent(job, "queue-unavailable", nowMs);
          await transaction.put(key, job);
        });
      }
      const next = Math.min(recovery.job.deadlineMs, nowMs + DURABLE_OPERATION_QUEUE_WATCHDOG_MS);
      nextDurableJobAlarm =
        nextDurableJobAlarm === null ? next : Math.min(nextDurableJobAlarm, next);
    }
    if (nextDurableJobAlarm !== null) {
      await this.scheduleCleanup(this.ctx.storage, nextDurableJobAlarm);
    }
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
