import {
  ARTIFACT_COMMIT_LEASE_MS,
  ARTIFACT_COMMIT_SERVER_EXECUTION_DEADLINE_MS,
  DURABLE_OPERATION_LEASE_MS,
  DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS,
  sha256Hex,
  signControlRequest,
  type CapabilityDefinition,
  type CapabilityInvocation,
  type ExecRuntimeRequest,
  type RouteRecord,
  type RuntimeReconciliationAuditRecord,
  type RuntimeReconciliationObservation,
  type RuntimeReconciliationTerminal,
  type StripeCapabilityPolicy,
  type ProductionDatabaseAllocationRecord,
} from "@workspace/tenant-runtime-contracts";
import type { WorkerBindings } from "../src/bindings";
import { handleDurableOperationQueue, handleControlRequest } from "../src/worker";
import type {
  CapabilityVault,
  CapabilityVaultInvocationResult,
  ArtifactCommitClaim,
  ArtifactCommitCheckpoint,
  ArtifactCommitDriverClaim,
  ArtifactCommitQueueMessage,
  DurableOperationClaim,
  DurableOperationCheckpoint,
  DurableOperationDriverClaim,
  DurableOperationQueueMessage,
  DurableOperationRegistration,
  ControlAuditRecord,
  ControlCoordinator,
  IdempotencyLookup,
  RuntimeLogEntry,
  StoredHttpResponse,
  StoredRuntime,
  StoredRuntimeArtifact,
  StoredRuntimeLayer,
  StoredRuntimeLayeredArtifact,
  StoredArtifactCommitJob,
  StoredDurableOperationJob,
  StoredRuntimeManifestRestartJob,
  StoredAcceptanceLeaseJob,
  StoredLayeredArtifactPromotionJob,
  StoredProductionDatabaseJob,
  StoredRuntimeStartJob,
  RemovedRuntimeLayeredArtifact,
} from "../src/model";
import type {
  BackendAvailabilityResult,
  BackendReconciliationResult,
  BackendExecResult,
  BackendStartResult,
  BackendStatusResult,
  RuntimeMaterializationTicket,
  RuntimeBackend,
  RuntimeReconciliationObservationSink,
} from "../src/runtime-backend";
import type { ProductionDatabaseAllocator } from "../src/production-database-allocator";

export const TEST_SECRET = "0123456789abcdef0123456789abcdef";
export const TEST_NOW_MS = 1_785_859_200_000;

export class MemoryArtifactCommitQueue {
  readonly messages: DurableOperationQueueMessage[] = [];

  async send(body: DurableOperationQueueMessage): Promise<void> {
    this.messages.push(structuredClone(body));
  }

  async sendBatch(batch: MessageSendRequest<DurableOperationQueueMessage>[]): Promise<void> {
    for (const message of batch) this.messages.push(structuredClone(message.body));
  }
}

export async function drainArtifactCommitQueue(input: {
  env: WorkerBindings;
  coordinator: ControlCoordinator;
  backend: RuntimeBackend;
  nowMs?: number;
  vault?: CapabilityVault;
  productionDatabaseAllocator?: Pick<
    ProductionDatabaseAllocator,
    "ensure" | "release" | "verifyGone"
  >;
}): Promise<number> {
  const queue = input.env.DURABLE_OPERATION_QUEUE as unknown as MemoryArtifactCommitQueue;
  const messages = queue.messages.splice(0);
  if (messages.length === 0) return 0;
  await handleDurableOperationQueue(
    {
      queue: "test-artifact-commit",
      messages: messages.map((body, index) => ({
        id: `test-artifact-commit-${index}`,
        timestamp: new Date(input.nowMs ?? TEST_NOW_MS),
        body,
        attempts: 1,
        ack() {},
        retry() {},
      })),
      ackAll() {},
      retryAll() {},
      metadata: { metrics: {} },
    } as unknown as MessageBatch<DurableOperationQueueMessage>,
    input.env,
    {
      coordinator: input.coordinator,
      backend: input.backend,
      nowMs: input.nowMs ?? TEST_NOW_MS,
      vault: input.vault,
      productionDatabaseAllocator: input.productionDatabaseAllocator,
    },
  );
  return messages.length;
}

export async function commitArtifactAndDrain(input: {
  path: string;
  body: unknown;
  nonce: string;
  idempotencyKey: string;
  env: WorkerBindings;
  coordinator: ControlCoordinator;
  backend: RuntimeBackend;
  nowMs?: number;
}): Promise<Response> {
  return mutationAndDrain(input);
}

export async function mutationAndDrain(input: {
  path: string;
  body: unknown;
  nonce: string;
  idempotencyKey: string;
  env: WorkerBindings;
  coordinator: ControlCoordinator;
  backend: RuntimeBackend;
  nowMs?: number;
  method?: string;
  vault?: CapabilityVault;
  productionDatabaseAllocator?: Pick<
    ProductionDatabaseAllocator,
    "ensure" | "release" | "verifyGone"
  >;
}): Promise<Response> {
  const dependencies = {
    coordinator: input.coordinator,
    backend: input.backend,
    nowMs: input.nowMs ?? TEST_NOW_MS,
    vault: input.vault,
    productionDatabaseAllocator: input.productionDatabaseAllocator,
  };
  const accepted = await handleControlRequest(
    await signedRequest({
      path: input.path,
      method: input.method ?? "POST",
      nonce: input.nonce,
      idempotencyKey: input.idempotencyKey,
      body: input.body,
    }),
    input.env,
    dependencies,
  );
  if (accepted.status !== 409) return accepted;
  const acceptedBody = (await accepted.clone().json()) as { code?: string };
  if (acceptedBody.code !== "request_in_progress") return accepted;
  await drainArtifactCommitQueue({ ...dependencies, env: input.env });
  return handleControlRequest(
    await signedRequest({
      path: input.path,
      method: input.method ?? "POST",
      nonce: `${input.nonce}-replay`,
      idempotencyKey: input.idempotencyKey,
      body: input.body,
    }),
    input.env,
    dependencies,
  );
}

export class MemoryCoordinator implements ControlCoordinator {
  readonly nonces = new Map<string, number>();
  readonly idempotency = new Map<
    string,
    { fingerprint: string; pending: boolean; response?: StoredHttpResponse }
  >();
  readonly audits: ControlAuditRecord[] = [];
  readonly runtimeReconciliations = new Map<string, RuntimeReconciliationAuditRecord>();
  readonly runtimes = new Map<string, StoredRuntime>();
  readonly routes = new Map<string, RouteRecord>();
  readonly containerBindings = new Map<string, string>();
  readonly artifacts = new Map<string, StoredRuntimeArtifact>();
  readonly layeredArtifacts = new Map<string, StoredRuntimeLayeredArtifact>();
  readonly runtimeLayers = new Map<string, StoredRuntimeLayer>();
  readonly artifactCommitJobs = new Map<string, StoredArtifactCommitJob>();
  readonly latestArtifactCommitJobs = new Map<string, string>();
  readonly runtimeLifecycleJobs = new Map<
    string,
    | StoredRuntimeStartJob
    | StoredRuntimeManifestRestartJob
    | StoredAcceptanceLeaseJob
    | StoredLayeredArtifactPromotionJob
    | StoredProductionDatabaseJob
  >();
  readonly latestRuntimeLifecycleJobs = new Map<string, string>();
  layerChunkWrites = 0;

  async consumeOnce(nonce: string, expiresAtMs: number): Promise<boolean> {
    if (this.nonces.has(nonce)) return false;
    this.nonces.set(nonce, expiresAtMs);
    return true;
  }

  async isConsumedOnce(nonce: string, nowMs: number): Promise<boolean> {
    const expiresAtMs = this.nonces.get(nonce);
    return expiresAtMs !== undefined && expiresAtMs > nowMs;
  }

  async beginIdempotency(
    key: string,
    fingerprint: string,
    _nowMs: number,
  ): Promise<IdempotencyLookup> {
    const existing = this.idempotency.get(key);
    if (existing === undefined) {
      this.idempotency.set(key, { fingerprint, pending: true });
      return { state: "new" };
    }
    if (existing.fingerprint !== fingerprint) return { state: "conflict" };
    if (existing.pending || existing.response === undefined) return { state: "pending" };
    return { state: "replay", response: structuredClone(existing.response) };
  }

  async completeIdempotency(
    key: string,
    fingerprint: string,
    response: StoredHttpResponse,
  ): Promise<void> {
    this.idempotency.set(key, {
      fingerprint,
      pending: false,
      response: structuredClone(response),
    });
  }

  async abandonIdempotency(key: string, fingerprint: string): Promise<void> {
    if (this.idempotency.get(key)?.fingerprint === fingerprint) this.idempotency.delete(key);
  }

  async recordDurableOperationDeploymentObservation(
    jobKey: string,
    deploymentVersion: string,
    nowMs: number,
  ): Promise<"matched" | "deferred" | "not_found" | "terminal"> {
    const job = await this.getDurableOperation(jobKey);
    if (job === null) return "not_found";
    if (job.state !== "active") return "terminal";
    if (job.expectedDeploymentVersion === deploymentVersion) return "matched";
    job.eventSequence += 1;
    job.events.push({
      sequence: job.eventSequence,
      at: new Date(nowMs).toISOString(),
      event: "deployment-version-deferred",
      attempt: job.attempt,
      checkpoint: job.checkpoint,
      deploymentVersion,
    });
    job.updatedAtMs = nowMs;
    return "deferred";
  }

  async registerDurableOperation(
    input: DurableOperationRegistration,
  ): Promise<DurableOperationClaim> {
    if (input.kind === "v1" || input.kind === "layers-v1") {
      return this.registerArtifactCommit(input);
    }
    const lifecycleInput = input as Exclude<
      DurableOperationRegistration,
      { kind: "v1" | "layers-v1" }
    >;
    const idempotency = this.idempotency.get(lifecycleInput.key);
    if (idempotency !== undefined && idempotency.fingerprint !== lifecycleInput.fingerprint) {
      return { state: "conflict" };
    }
    if (idempotency !== undefined && !idempotency.pending && idempotency.response !== undefined) {
      return { state: "replay", response: structuredClone(idempotency.response) };
    }
    const jobKey = `durable-operation-job:${lifecycleInput.kind}:${lifecycleInput.runtimeIdentity}:${lifecycleInput.subjectKey}:${lifecycleInput.key}`;
    const existing = this.runtimeLifecycleJobs.get(jobKey);
    if (existing?.response !== undefined && existing.state !== "active") {
      return { state: "replay", response: structuredClone(existing.response) };
    }
    if (existing !== undefined) {
      this.appendDurableOperationEvent(existing, "request-observed", input.nowMs);
      return { state: "pending", job: structuredClone(existing) };
    }
    const common = {
      jobKey,
      runtimeIdentity: lifecycleInput.runtimeIdentity,
      subjectKey: lifecycleInput.subjectKey,
      expectedDeploymentVersion: lifecycleInput.expectedDeploymentVersion,
      fingerprint: lifecycleInput.fingerprint,
      idempotencyStorageKey: lifecycleInput.key,
      state: "active" as const,
      checkpoint: "initialized" as const,
      ownerId: null,
      attempt: 0,
      eventSequence: 0,
      events: [],
      leaseUntilMs: null,
      abandonAtMs: null,
      deadlineMs: lifecycleInput.nowMs + DURABLE_OPERATION_SERVER_EXECUTION_DEADLINE_MS,
      createdAtMs: lifecycleInput.nowMs,
      updatedAtMs: lifecycleInput.nowMs,
    };
    const job = {
      ...common,
      kind: lifecycleInput.kind,
      subjectKey: lifecycleInput.subjectKey,
      request: structuredClone(lifecycleInput.request),
      ...(lifecycleInput.kind === "runtime-start" &&
      lifecycleInput.publishedRecoveryIdentity !== undefined
        ? { publishedRecoveryIdentity: lifecycleInput.publishedRecoveryIdentity }
        : {}),
      ...(lifecycleInput.kind === "runtime-start" &&
      lifecycleInput.publishedRecoveryGeneration !== undefined
        ? { publishedRecoveryGeneration: lifecycleInput.publishedRecoveryGeneration }
        : {}),
    } as
      | StoredRuntimeStartJob
      | StoredRuntimeManifestRestartJob
      | StoredAcceptanceLeaseJob
      | StoredLayeredArtifactPromotionJob
      | StoredProductionDatabaseJob;
    this.appendDurableOperationEvent(job, "job-created", lifecycleInput.nowMs);
    this.runtimeLifecycleJobs.set(jobKey, job);
    this.latestRuntimeLifecycleJobs.set(
      `${lifecycleInput.kind}:${lifecycleInput.runtimeIdentity}:${lifecycleInput.subjectKey}`,
      jobKey,
    );
    this.idempotency.set(lifecycleInput.key, {
      fingerprint: lifecycleInput.fingerprint,
      pending: true,
    });
    return { state: "new", job: structuredClone(job) };
  }

  async claimDurableOperationDriver(
    jobKey: string,
    ownerId: string,
    nowMs: number,
  ): Promise<DurableOperationDriverClaim> {
    if (this.artifactCommitJobs.has(jobKey)) {
      return this.claimArtifactCommitDriver(jobKey, ownerId, nowMs);
    }
    const job = this.runtimeLifecycleJobs.get(jobKey);
    if (job === undefined) return { state: "not_found" };
    if (job.state !== "active") return { state: "terminal", job: structuredClone(job) };
    if (job.leaseUntilMs !== null && job.leaseUntilMs > nowMs) {
      this.appendDurableOperationEvent(job, "driver-busy", nowMs);
      return { state: "busy", job: structuredClone(job) };
    }
    const adopted = job.attempt > 0;
    if (job.ownerId !== null || job.leaseUntilMs !== null) {
      this.appendDurableOperationEvent(job, "lease-expired", nowMs);
    }
    job.ownerId = ownerId;
    job.attempt += 1;
    job.leaseUntilMs = Math.min(nowMs + DURABLE_OPERATION_LEASE_MS, job.deadlineMs);
    this.appendDurableOperationEvent(job, adopted ? "driver-adopted" : "driver-claimed", nowMs);
    return { state: adopted ? "adopted" : "claimed", job: structuredClone(job) };
  }

  async getDurableOperation(jobKey: string): Promise<StoredDurableOperationJob | null> {
    return structuredClone(
      this.artifactCommitJobs.get(jobKey) ?? this.runtimeLifecycleJobs.get(jobKey) ?? null,
    );
  }

  async getLatestDurableOperation(
    kind: StoredDurableOperationJob["kind"],
    runtimeIdentity: string,
    subjectKey: string,
  ): Promise<StoredDurableOperationJob | null> {
    if (kind !== "v1" && kind !== "layers-v1") {
      const jobKey = this.latestRuntimeLifecycleJobs.get(
        `${kind}:${runtimeIdentity}:${subjectKey}`,
      );
      return jobKey === undefined ? null : this.getDurableOperation(jobKey);
    }
    const jobKey = this.latestArtifactCommitJobs.get(`${runtimeIdentity}:${subjectKey}`);
    const job = jobKey === undefined ? null : await this.getDurableOperation(jobKey);
    return job?.kind === kind ? job : null;
  }

  async listRecentDurableOperations(input: {
    sinceMs: number;
    untilMs: number;
    limit: number;
    kind?: StoredDurableOperationJob["kind"];
  }): Promise<StoredDurableOperationJob[]> {
    return [...this.artifactCommitJobs.values(), ...this.runtimeLifecycleJobs.values()]
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

  async recordDurableOperationNudge(jobKey: string, nowMs: number) {
    if (this.artifactCommitJobs.has(jobKey)) return this.recordArtifactCommitNudge(jobKey, nowMs);
    const job = this.runtimeLifecycleJobs.get(jobKey);
    if (job === undefined) return "not_found" as const;
    if (job.state !== "active") return "terminal" as const;
    this.appendDurableOperationEvent(job, "queue-nudged", nowMs);
    return "recorded" as const;
  }

  async renewDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    nowMs: number,
  ) {
    if (this.artifactCommitJobs.has(jobKey)) {
      const job = this.artifactCommitJobs.get(jobKey);
      if (job?.attempt !== ownerGeneration) return "not_owner" as const;
      return this.renewArtifactCommit(jobKey, ownerId, nowMs);
    }
    const job = this.runtimeLifecycleJobs.get(jobKey);
    if (job === undefined || job.state !== "active") return "terminal" as const;
    if (job.ownerId !== ownerId || job.attempt !== ownerGeneration) return "not_owner" as const;
    job.leaseUntilMs = Math.min(nowMs + DURABLE_OPERATION_LEASE_MS, job.deadlineMs);
    this.appendDurableOperationEvent(job, "lease-renewed", nowMs);
    return "renewed" as const;
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
    if (this.artifactCommitJobs.has(input.jobKey)) {
      return this.checkpointArtifactCommit({
        ...input,
        checkpoint: input.checkpoint as ArtifactCommitCheckpoint,
      });
    }
    const job = this.runtimeLifecycleJobs.get(input.jobKey);
    if (
      job === undefined ||
      job.ownerId !== input.ownerId ||
      job.attempt !== input.ownerGeneration ||
      job.state !== "active"
    ) {
      throw new Error("Runtime lifecycle checkpoint owner is no longer active");
    }
    job.checkpoint = input.checkpoint as never;
    if (job.kind === "runtime-manifest-restart" && input.runtimeWasRunning !== undefined) {
      job.runtimeWasRunning = input.runtimeWasRunning;
    }
    this.appendDurableOperationEvent(job, "checkpoint-advanced", input.nowMs);
    return structuredClone(job);
  }

  async completeDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    response: StoredHttpResponse,
  ): Promise<"completed" | "already_terminal" | "not_owner"> {
    if (this.artifactCommitJobs.has(jobKey)) {
      const job = this.artifactCommitJobs.get(jobKey);
      if (job === undefined) return "not_owner";
      if (job.state !== "active") return "already_terminal";
      if (job.attempt !== ownerGeneration || job.ownerId !== ownerId) return "not_owner";
      await this.completeArtifactCommit(jobKey, ownerId, response);
      return "completed";
    }
    return this.finishRuntimeLifecycle(jobKey, ownerId, ownerGeneration, "succeeded", response);
  }

  async failDurableOperation(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    response: StoredHttpResponse,
  ): Promise<"completed" | "already_terminal" | "not_owner"> {
    if (this.artifactCommitJobs.has(jobKey)) {
      const job = this.artifactCommitJobs.get(jobKey);
      if (job === undefined) return "not_owner";
      if (job.state !== "active") return "already_terminal";
      if (job.attempt !== ownerGeneration || job.ownerId !== ownerId) return "not_owner";
      await this.failArtifactCommit(jobKey, ownerId, response);
      return "completed";
    }
    return this.finishRuntimeLifecycle(jobKey, ownerId, ownerGeneration, "failed", response);
  }

  private async finishRuntimeLifecycle(
    jobKey: string,
    ownerId: string,
    ownerGeneration: number,
    state: "succeeded" | "failed",
    response: StoredHttpResponse,
  ): Promise<"completed" | "already_terminal" | "not_owner"> {
    const job = this.runtimeLifecycleJobs.get(jobKey);
    if (job === undefined) return "not_owner";
    if (job.state !== "active") return "already_terminal";
    if (job.ownerId !== ownerId || job.attempt !== ownerGeneration) return "not_owner";
    job.state = state;
    job.ownerId = null;
    job.leaseUntilMs = null;
    job.response = structuredClone(response);
    this.appendDurableOperationEvent(
      job,
      state === "succeeded" ? "driver-succeeded" : "driver-failed",
      TEST_NOW_MS,
    );
    this.idempotency.set(job.idempotencyStorageKey, {
      fingerprint: job.fingerprint,
      pending: false,
      response: structuredClone(response),
    });
    return "completed";
  }

  private appendDurableOperationEvent(
    job: StoredDurableOperationJob,
    event: StoredDurableOperationJob["events"][number]["event"],
    nowMs: number,
  ): void {
    job.eventSequence += 1;
    job.events.push({
      sequence: job.eventSequence,
      at: new Date(nowMs).toISOString(),
      event,
      attempt: job.attempt,
      checkpoint: job.checkpoint,
    });
    job.updatedAtMs = nowMs;
  }

  async registerArtifactCommit(input: {
    key: string;
    fingerprint: string;
    kind: "v1" | "layers-v1";
    runtimeIdentity: string;
    sealedArtifactSha256: string;
    expectedDeploymentVersion: string;
    nowMs: number;
  }): Promise<ArtifactCommitClaim> {
    const idempotency = this.idempotency.get(input.key);
    if (idempotency !== undefined && idempotency.fingerprint !== input.fingerprint) {
      return { state: "conflict" };
    }
    if (idempotency !== undefined && !idempotency.pending && idempotency.response !== undefined) {
      return { state: "replay", response: structuredClone(idempotency.response) };
    }
    const jobKey = `durable-operation-job:${input.kind}:${input.runtimeIdentity}:${input.sealedArtifactSha256}:${input.key}`;
    const existing = this.artifactCommitJobs.get(jobKey);
    if (existing?.response !== undefined && existing.state !== "active") {
      return { state: "replay", response: structuredClone(existing.response) };
    }
    if (existing !== undefined) {
      this.appendArtifactCommitEvent(existing, "request-observed", input.nowMs);
      return { state: "pending", job: structuredClone(existing) };
    }
    const job: StoredArtifactCommitJob = {
      jobKey,
      kind: input.kind,
      runtimeIdentity: input.runtimeIdentity,
      subjectKey: input.sealedArtifactSha256,
      sealedArtifactSha256: input.sealedArtifactSha256,
      expectedDeploymentVersion: input.expectedDeploymentVersion,
      fingerprint: input.fingerprint,
      idempotencyStorageKey: input.key,
      state: "active",
      checkpoint: "initialized",
      ownerId: null,
      attempt: 0,
      eventSequence: 0,
      events: [],
      leaseUntilMs: null,
      abandonAtMs: null,
      deadlineMs: input.nowMs + ARTIFACT_COMMIT_SERVER_EXECUTION_DEADLINE_MS,
      createdAtMs: input.nowMs,
      updatedAtMs: input.nowMs,
    };
    this.appendArtifactCommitEvent(job, "job-created", input.nowMs);
    this.artifactCommitJobs.set(jobKey, job);
    this.latestArtifactCommitJobs.set(
      `${input.runtimeIdentity}:${input.sealedArtifactSha256}`,
      jobKey,
    );
    this.idempotency.set(input.key, { fingerprint: input.fingerprint, pending: true });
    return { state: "new", job: structuredClone(job) };
  }

  async claimArtifactCommitDriver(
    jobKey: string,
    ownerId: string,
    nowMs: number,
  ): Promise<ArtifactCommitDriverClaim> {
    const job = this.artifactCommitJobs.get(jobKey);
    if (job === undefined) return { state: "not_found" };
    if (job.state !== "active") return { state: "terminal", job: structuredClone(job) };
    if (job.leaseUntilMs !== null && job.leaseUntilMs > nowMs) {
      this.appendArtifactCommitEvent(job, "driver-busy", nowMs);
      return { state: "busy", job: structuredClone(job) };
    }
    const adopted = job.attempt > 0;
    if (job.ownerId !== null || job.leaseUntilMs !== null) {
      this.appendArtifactCommitEvent(job, "lease-expired", nowMs);
    }
    job.ownerId = ownerId;
    job.attempt += 1;
    job.leaseUntilMs = Math.min(nowMs + ARTIFACT_COMMIT_LEASE_MS, job.deadlineMs);
    job.updatedAtMs = nowMs;
    this.appendArtifactCommitEvent(job, adopted ? "driver-adopted" : "driver-claimed", nowMs);
    return { state: adopted ? "adopted" : "claimed", job: structuredClone(job) };
  }

  async getArtifactCommit(jobKey: string): Promise<StoredArtifactCommitJob | null> {
    const job = this.artifactCommitJobs.get(jobKey);
    return job === undefined ? null : structuredClone(job);
  }

  async getLatestArtifactCommit(
    runtimeIdentity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredArtifactCommitJob | null> {
    const jobKey = this.latestArtifactCommitJobs.get(`${runtimeIdentity}:${sealedArtifactSha256}`);
    return jobKey === undefined ? null : this.getArtifactCommit(jobKey);
  }

  async recordArtifactCommitNudge(
    jobKey: string,
    nowMs: number,
  ): Promise<"recorded" | "not_found" | "terminal"> {
    const job = this.artifactCommitJobs.get(jobKey);
    if (job === undefined) return "not_found";
    if (job.state !== "active") return "terminal";
    this.appendArtifactCommitEvent(job, "queue-nudged", nowMs);
    return "recorded";
  }

  private appendArtifactCommitEvent(
    job: StoredArtifactCommitJob,
    event: StoredArtifactCommitJob["events"][number]["event"],
    nowMs: number,
  ): void {
    job.eventSequence += 1;
    job.events.push({
      sequence: job.eventSequence,
      at: new Date(nowMs).toISOString(),
      event,
      attempt: job.attempt,
      checkpoint: job.checkpoint,
    });
    job.updatedAtMs = nowMs;
  }

  async renewArtifactCommit(jobKey: string, ownerId: string, nowMs: number) {
    const job = this.artifactCommitJobs.get(jobKey);
    if (job === undefined || job.state !== "active") return "terminal" as const;
    if (job.ownerId !== ownerId) return "not_owner" as const;
    job.leaseUntilMs = Math.min(nowMs + ARTIFACT_COMMIT_LEASE_MS, job.deadlineMs);
    this.appendArtifactCommitEvent(job, "lease-renewed", nowMs);
    return "renewed" as const;
  }

  async checkpointArtifactCommit(input: {
    jobKey: string;
    ownerId: string;
    checkpoint: ArtifactCommitCheckpoint;
    payloadContentSha256s?: string[];
    nowMs: number;
  }): Promise<StoredArtifactCommitJob> {
    const job = this.artifactCommitJobs.get(input.jobKey);
    if (job === undefined || job.ownerId !== input.ownerId || job.state !== "active") {
      throw new Error("Artifact commit checkpoint owner is no longer active");
    }
    job.checkpoint = input.checkpoint;
    job.updatedAtMs = input.nowMs;
    if (input.payloadContentSha256s !== undefined) {
      job.payloadContentSha256s = [...input.payloadContentSha256s];
    }
    this.appendArtifactCommitEvent(job, "checkpoint-advanced", input.nowMs);
    return structuredClone(job);
  }

  async completeArtifactCommit(
    jobKey: string,
    ownerId: string,
    response: StoredHttpResponse,
  ): Promise<void> {
    await this.finishArtifactCommit(jobKey, ownerId, "succeeded", response);
  }

  async failArtifactCommit(
    jobKey: string,
    ownerId: string,
    response: StoredHttpResponse,
  ): Promise<void> {
    await this.finishArtifactCommit(jobKey, ownerId, "failed", response);
  }

  private async finishArtifactCommit(
    jobKey: string,
    ownerId: string,
    state: "succeeded" | "failed",
    response: StoredHttpResponse,
  ): Promise<void> {
    const job = this.artifactCommitJobs.get(jobKey);
    if (job === undefined || job.ownerId !== ownerId || job.state !== "active") {
      throw new Error("Artifact commit finalization owner is no longer active");
    }
    job.state = state;
    job.ownerId = null;
    job.leaseUntilMs = null;
    job.abandonAtMs = null;
    job.response = structuredClone(response);
    this.appendArtifactCommitEvent(
      job,
      state === "succeeded" ? "driver-succeeded" : "driver-failed",
      job.updatedAtMs,
    );
    const idempotencyKey = job.idempotencyStorageKey;
    this.idempotency.set(idempotencyKey, {
      fingerprint: job.fingerprint,
      pending: false,
      response: structuredClone(response),
    });
  }

  async recordAudit(record: ControlAuditRecord): Promise<void> {
    this.audits.push(structuredClone(record));
  }

  async beginRuntimeReconciliation(record: RuntimeReconciliationAuditRecord): Promise<void> {
    if (this.runtimeReconciliations.has(record.requestId)) {
      throw new Error("Runtime reconciliation request identity already exists");
    }
    this.runtimeReconciliations.set(record.requestId, structuredClone(record));
  }

  async appendRuntimeReconciliationObservation(
    requestId: string,
    observation: RuntimeReconciliationObservation,
  ): Promise<RuntimeReconciliationAuditRecord> {
    const record = this.runtimeReconciliations.get(requestId);
    if (record === undefined) throw new Error("Runtime reconciliation record was not initialized");
    if (record.terminal !== null) throw new Error("Runtime reconciliation is already terminal");
    if (observation.attempt !== record.trail.length + 1) {
      throw new Error("Runtime reconciliation observation sequence is invalid");
    }
    record.trail.push(structuredClone(observation));
    record.updatedAt = observation.observedAt;
    return structuredClone(record);
  }

  async completeRuntimeReconciliation(
    requestId: string,
    terminal: RuntimeReconciliationTerminal,
  ): Promise<RuntimeReconciliationAuditRecord> {
    const record = this.runtimeReconciliations.get(requestId);
    if (record === undefined) throw new Error("Runtime reconciliation record was not initialized");
    if (record.terminal === null) {
      record.terminal = structuredClone(terminal);
      record.updatedAt = terminal.at;
    }
    return structuredClone(record);
  }

  async getRuntimeReconciliation(
    requestId: string,
  ): Promise<RuntimeReconciliationAuditRecord | null> {
    return structuredClone(this.runtimeReconciliations.get(requestId) ?? null);
  }

  async getRuntime(identity: string): Promise<StoredRuntime | null> {
    const runtime = this.runtimes.get(identity);
    return runtime === undefined ? null : structuredClone(runtime);
  }

  async putRuntime(identity: string, runtime: StoredRuntime): Promise<void> {
    this.runtimes.set(identity, structuredClone(runtime));
  }

  async putRuntimeIfManifestRevision(
    identity: string,
    expectedManifestRevision: string,
    runtime: StoredRuntime,
  ): Promise<"updated" | "not_found" | "conflict"> {
    const existing = this.runtimes.get(identity);
    if (existing === undefined) return "not_found";
    if (existing.manifest.revision !== expectedManifestRevision) return "conflict";
    this.runtimes.set(identity, structuredClone(runtime));
    return "updated";
  }

  async deleteRuntime(identity: string): Promise<void> {
    this.runtimes.delete(identity);
  }

  async beginArtifact(record: StoredRuntimeArtifact): Promise<"created" | "exists" | "conflict"> {
    const key = `${record.runtimeIdentity}:${record.envelope.sealedArtifactSha256}`;
    const existing = this.artifacts.get(key);
    if (existing !== undefined) {
      return existing.envelope.contentSha256 === record.envelope.contentSha256 &&
        existing.envelope.manifestRevision === record.envelope.manifestRevision
        ? "exists"
        : "conflict";
    }
    this.artifacts.set(key, structuredClone(record));
    return "created";
  }

  async getArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeArtifact | null> {
    return structuredClone(this.artifacts.get(`${identity}:${sealedArtifactSha256}`) ?? null);
  }

  async recordArtifactChunk(
    identity: string,
    sealedArtifactSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    const key = `${identity}:${sealedArtifactSha256}`;
    const artifact = this.artifacts.get(key);
    if (artifact === undefined || artifact.state !== "pending") return "not_found";
    if (chunkIndex < 0 || chunkIndex >= artifact.receivedChunks.length) return "conflict";
    const current = artifact.receivedChunks[chunkIndex];
    if (current !== null) return current === chunkSha256 ? "replay" : "conflict";
    if (artifact.envelope.content.chunks[chunkIndex] !== chunkSha256) return "conflict";
    artifact.receivedChunks[chunkIndex] = chunkSha256;
    return "recorded";
  }

  async commitArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<"committed" | "incomplete" | "not_found"> {
    const artifact = this.artifacts.get(`${identity}:${sealedArtifactSha256}`);
    if (artifact === undefined) return "not_found";
    if (artifact.receivedChunks.some((chunk) => chunk === null)) return "incomplete";
    artifact.state = "committed";
    artifact.expiresAtMs = null;
    return "committed";
  }

  async removeArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeArtifact | null> {
    const key = `${identity}:${sealedArtifactSha256}`;
    const artifact = this.artifacts.get(key);
    if (artifact === undefined) return null;
    this.artifacts.delete(key);
    return structuredClone(artifact);
  }

  async listArtifacts(identity: string): Promise<StoredRuntimeArtifact[]> {
    const records: StoredRuntimeArtifact[] = [];
    for (const artifact of this.artifacts.values()) {
      if (artifact.runtimeIdentity !== identity) continue;
      records.push(structuredClone(artifact));
    }
    return records;
  }

  async beginLayeredArtifact(
    record: StoredRuntimeLayeredArtifact,
  ): Promise<"created" | "exists" | "conflict"> {
    const key = `${record.runtimeIdentity}:${record.envelope.sealedArtifactSha256}`;
    const existing = this.layeredArtifacts.get(key);
    if (existing !== undefined) {
      return existing.envelope.contentSha256 === record.envelope.contentSha256
        ? "exists"
        : "conflict";
    }
    for (const content of record.envelope.content.layers) {
      const layer = this.runtimeLayers.get(content.descriptor.contentSha256);
      if (
        layer !== undefined &&
        layer.content.descriptor.unpackedManifestSha256 !==
          content.descriptor.unpackedManifestSha256
      ) {
        return "conflict";
      }
    }
    this.layeredArtifacts.set(key, structuredClone(record));
    for (const content of record.envelope.content.layers) {
      const layer = this.runtimeLayers.get(content.descriptor.contentSha256);
      if (layer === undefined) {
        this.runtimeLayers.set(content.descriptor.contentSha256, {
          content: structuredClone(content),
          state: "pending",
          receivedChunks: content.chunks.map(() => null),
          pendingArtifacts: [key],
          artifactReferences: [],
        });
      } else if (!layer.pendingArtifacts.includes(key)) {
        layer.pendingArtifacts.push(key);
      }
    }
    return "created";
  }

  async getLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<StoredRuntimeLayeredArtifact | null> {
    return structuredClone(
      this.layeredArtifacts.get(`${identity}:${sealedArtifactSha256}`) ?? null,
    );
  }

  async getRuntimeLayer(contentSha256: string): Promise<StoredRuntimeLayer | null> {
    return structuredClone(this.runtimeLayers.get(contentSha256) ?? null);
  }

  async recordLayeredArtifactAppChunk(
    identity: string,
    sealedArtifactSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    const artifact = this.layeredArtifacts.get(`${identity}:${sealedArtifactSha256}`);
    if (artifact === undefined || artifact.state !== "pending") return "not_found";
    if (chunkIndex < 0 || chunkIndex >= artifact.receivedAppChunks.length) return "conflict";
    const current = artifact.receivedAppChunks[chunkIndex];
    if (current !== null) return current === chunkSha256 ? "replay" : "conflict";
    if (artifact.envelope.content.appArtifact.content.chunks[chunkIndex] !== chunkSha256)
      return "conflict";
    artifact.receivedAppChunks[chunkIndex] = chunkSha256;
    return "recorded";
  }

  async recordRuntimeLayerChunk(
    identity: string,
    sealedArtifactSha256: string,
    contentSha256: string,
    chunkIndex: number,
    chunkSha256: string,
  ): Promise<"recorded" | "replay" | "not_found" | "conflict"> {
    const reference = `${identity}:${sealedArtifactSha256}`;
    const artifact = this.layeredArtifacts.get(reference);
    const layer = this.runtimeLayers.get(contentSha256);
    if (
      artifact === undefined ||
      artifact.state !== "pending" ||
      layer === undefined ||
      (!layer.pendingArtifacts.includes(reference) && !layer.artifactReferences.includes(reference))
    ) {
      return "not_found";
    }
    if (layer.state === "committed") return "replay";
    if (chunkIndex < 0 || chunkIndex >= layer.receivedChunks.length) return "conflict";
    const current = layer.receivedChunks[chunkIndex];
    if (current !== null) return current === chunkSha256 ? "replay" : "conflict";
    if (layer.content.chunks[chunkIndex] !== chunkSha256) return "conflict";
    layer.receivedChunks[chunkIndex] = chunkSha256;
    this.layerChunkWrites += 1;
    return "recorded";
  }

  async commitLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<"committed" | "incomplete" | "not_found" | "conflict"> {
    const reference = `${identity}:${sealedArtifactSha256}`;
    const artifact = this.layeredArtifacts.get(reference);
    if (artifact === undefined) return "not_found";
    if (artifact.state === "committed") return "committed";
    if (artifact.receivedAppChunks.some((chunk) => chunk === null)) return "incomplete";
    const layers: StoredRuntimeLayer[] = [];
    for (const content of artifact.envelope.content.layers) {
      const layer = this.runtimeLayers.get(content.descriptor.contentSha256);
      if (layer === undefined) return "conflict";
      if (layer.state !== "committed" && layer.receivedChunks.some((chunk) => chunk === null)) {
        return "incomplete";
      }
      layers.push(layer);
    }
    artifact.state = "committed";
    artifact.expiresAtMs = null;
    for (const layer of layers) {
      layer.state = "committed";
      layer.pendingArtifacts = layer.pendingArtifacts.filter(
        (candidate) => candidate !== reference,
      );
      if (!layer.artifactReferences.includes(reference)) layer.artifactReferences.push(reference);
    }
    return "committed";
  }

  async removeLayeredArtifact(
    identity: string,
    sealedArtifactSha256: string,
  ): Promise<RemovedRuntimeLayeredArtifact | null> {
    const reference = `${identity}:${sealedArtifactSha256}`;
    const artifact = this.layeredArtifacts.get(reference);
    if (artifact === undefined) return null;
    const unreferencedLayers: StoredRuntimeLayer[] = [];
    for (const content of artifact.envelope.content.layers) {
      const layer = this.runtimeLayers.get(content.descriptor.contentSha256);
      if (layer === undefined) continue;
      layer.pendingArtifacts = layer.pendingArtifacts.filter(
        (candidate) => candidate !== reference,
      );
      layer.artifactReferences = layer.artifactReferences.filter(
        (candidate) => candidate !== reference,
      );
      if (layer.pendingArtifacts.length === 0 && layer.artifactReferences.length === 0) {
        this.runtimeLayers.delete(content.descriptor.contentSha256);
        unreferencedLayers.push(structuredClone(layer));
      }
    }
    this.layeredArtifacts.delete(reference);
    return { artifact: structuredClone(artifact), unreferencedLayers };
  }

  async listLayeredArtifacts(identity: string): Promise<StoredRuntimeLayeredArtifact[]> {
    return [...this.layeredArtifacts.values()]
      .filter((artifact) => artifact.runtimeIdentity === identity)
      .map((artifact) => structuredClone(artifact));
  }

  async bindContainer(containerId: string, identity: string): Promise<void> {
    this.containerBindings.set(containerId, identity);
  }

  async getContainerBinding(containerId: string): Promise<string | null> {
    return this.containerBindings.get(containerId) ?? null;
  }

  async unbindContainer(containerId: string, expectedIdentity: string): Promise<boolean> {
    if (this.containerBindings.get(containerId) !== expectedIdentity) return false;
    this.containerBindings.delete(containerId);
    return true;
  }

  async getRoute(hostname: string): Promise<RouteRecord | null> {
    const route = this.routes.get(hostname);
    return route === undefined ? null : structuredClone(route);
  }

  async activateRoute(
    route: RouteRecord,
    expectedPreviousManifestRevision: string | null,
  ): Promise<"activated" | "conflict"> {
    const current = this.routes.get(route.hostname);
    if ((current?.manifestRevision ?? null) !== expectedPreviousManifestRevision) return "conflict";
    this.routes.set(route.hostname, structuredClone(route));
    return "activated";
  }

  async deactivateRoute(
    hostname: string,
    expectedManifestRevision: string,
    expectedSandboxIdentity: string,
  ): Promise<"deactivated" | "not_found" | "conflict"> {
    const current = this.routes.get(hostname);
    if (current === undefined) return "not_found";
    if (
      current.manifestRevision !== expectedManifestRevision ||
      current.sandboxIdentity !== expectedSandboxIdentity
    ) {
      return "conflict";
    }
    this.routes.delete(hostname);
    return "deactivated";
  }

  async appendSystemLog(identity: string, message: string): Promise<void> {
    const runtime = this.runtimes.get(identity);
    if (runtime === undefined) return;
    runtime.nextLogSequence += 1;
    runtime.logs.push({
      cursor: `log-${runtime.nextLogSequence.toString().padStart(10, "0")}`,
      timestamp: new Date(TEST_NOW_MS).toISOString(),
      level: "system",
      message,
    });
  }

  async mergeProcessLogs(identity: string, stdout: string, stderr: string): Promise<void> {
    const runtime = this.runtimes.get(identity);
    if (runtime === undefined) return;
    const append = (level: RuntimeLogEntry["level"], message: string) => {
      if (!message) return;
      runtime.nextLogSequence += 1;
      runtime.logs.push({
        cursor: `log-${runtime.nextLogSequence.toString().padStart(10, "0")}`,
        timestamp: new Date(TEST_NOW_MS).toISOString(),
        level,
        message,
      });
    };
    append("stdout", stdout.slice(runtime.stdoutLength));
    append("stderr", stderr.slice(runtime.stderrLength));
    runtime.stdoutLength = stdout.length;
    runtime.stderrLength = stderr.length;
  }

  async listRuntimeLogs(
    identity: string,
    cursor: string | undefined,
    limit: number,
  ): Promise<{ entries: RuntimeLogEntry[]; nextCursor: string | null }> {
    const runtime = this.runtimes.get(identity);
    if (runtime === undefined) return { entries: [], nextCursor: null };
    const after = cursor === undefined ? 0 : Number(cursor.slice(4));
    const entries = runtime.logs
      .filter((entry) => Number(entry.cursor.slice(4)) > after)
      .slice(0, limit);
    return {
      entries: structuredClone(entries),
      nextCursor: entries.at(-1)?.cursor ?? cursor ?? null,
    };
  }
}

export class MockBackend implements RuntimeBackend {
  starts = 0;
  stops = 0;
  destroys = 0;
  execs = 0;
  materializations = 0;
  processLogs = { stdout: "server ready\n", stderr: "" };
  availabilityResult: BackendAvailabilityResult = {
    ready: true,
    stage: "health",
    cause: "ready",
    status: 200,
  };
  readonly availabilityChecks: string[] = [];
  reconciliationResult: BackendReconciliationResult = {
    ready: true,
    stage: "health",
    cause: "ready",
    status: 200,
    attempts: 1,
    conclusive: true,
    processId: "tenant-service",
    trail: [
      {
        attempt: 1,
        observedAt: new Date(TEST_NOW_MS).toISOString(),
        stage: "health",
        cause: "ready",
        status: 200,
        sources: ["provider-metadata", "process-probe", "health-probe"],
        decisionInputs: {
          storedStatus: "error",
          storedProcessIdentity: "absent",
          providerProcess: "running",
          health: "ready",
        },
        decision: "ready",
      },
    ],
  };
  readonly reconciliationChecks: string[] = [];

  async start(_runtime: StoredRuntime): Promise<BackendStartResult> {
    this.starts += 1;
    return { processId: "tenant-service", readyAt: new Date(TEST_NOW_MS).toISOString() };
  }

  async stop(_runtime: StoredRuntime): Promise<void> {
    this.stops += 1;
  }

  async destroy(_runtime: StoredRuntime): Promise<void> {
    this.destroys += 1;
  }

  async status(_runtime: StoredRuntime): Promise<BackendStatusResult> {
    return { running: true, lastError: null, cause: "running" };
  }

  async availability(runtime: StoredRuntime): Promise<BackendAvailabilityResult> {
    this.availabilityChecks.push(runtime.descriptor.identity);
    return { ...this.availabilityResult };
  }

  async reconcile(
    runtime: StoredRuntime,
    onObservation?: RuntimeReconciliationObservationSink,
  ): Promise<BackendReconciliationResult> {
    this.reconciliationChecks.push(runtime.descriptor.identity);
    for (const observation of this.reconciliationResult.trail) {
      await onObservation?.(structuredClone(observation));
    }
    return { ...this.reconciliationResult };
  }

  async exec(_runtime: StoredRuntime, _request: ExecRuntimeRequest): Promise<BackendExecResult> {
    this.execs += 1;
    return {
      ok: true,
      stdout: "nabuflow-control-plane-ok\n",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    };
  }

  async logs(_runtime: StoredRuntime): Promise<{ stdout: string; stderr: string }> {
    return this.processLogs;
  }

  async materialize(
    _runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
  ): Promise<{ filesWritten: number }> {
    this.materializations += 1;
    return { filesWritten: artifact.envelope.content.files.length };
  }

  async materializeLayered(
    _runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    _layers: StoredRuntimeLayer[],
  ): Promise<{ filesWritten: number; layersMaterialized: number }> {
    this.materializations += 1;
    return {
      filesWritten:
        artifact.envelope.content.appArtifact.content.files.length +
        artifact.envelope.content.layers.reduce((total, layer) => total + layer.files.length, 0),
      layersMaterialized: artifact.envelope.content.layers.length,
    };
  }

  async stageMaterialization(
    _runtime: StoredRuntime,
    _artifact: StoredRuntimeArtifact,
  ): Promise<RuntimeMaterializationTicket> {
    return { payloadContentSha256s: ["a".repeat(64)] };
  }

  async unpackMaterialization(
    _runtime: StoredRuntime,
    artifact: StoredRuntimeArtifact,
    _ticket: RuntimeMaterializationTicket,
  ): Promise<{ filesWritten: number }> {
    this.materializations += 1;
    return { filesWritten: artifact.envelope.content.files.length };
  }

  async stageLayeredMaterialization(
    _runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    _layers: StoredRuntimeLayer[],
  ): Promise<RuntimeMaterializationTicket> {
    return {
      payloadContentSha256s: [
        "a".repeat(64),
        ...artifact.envelope.content.layers.map((layer) => layer.descriptor.contentSha256),
      ],
    };
  }

  async unpackLayeredMaterialization(
    _runtime: StoredRuntime,
    artifact: StoredRuntimeLayeredArtifact,
    _layers: StoredRuntimeLayer[],
    _ticket: RuntimeMaterializationTicket,
  ): Promise<{ filesWritten: number; layersMaterialized: number }> {
    this.materializations += 1;
    return {
      filesWritten:
        artifact.envelope.content.appArtifact.content.files.length +
        artifact.envelope.content.layers.reduce((total, layer) => total + layer.files.length, 0),
      layersMaterialized: artifact.envelope.content.layers.length,
    };
  }
}

export class MemoryR2Bucket {
  readonly objects = new Map<string, Uint8Array>();

  async put(
    key: string,
    value: ArrayBuffer | ArrayBufferView | string,
    options?: { onlyIf?: { etagDoesNotMatch?: string } },
  ): Promise<unknown | null> {
    if (options?.onlyIf?.etagDoesNotMatch === "*" && this.objects.has(key)) return null;
    const bytes =
      typeof value === "string"
        ? new TextEncoder().encode(value)
        : value instanceof ArrayBuffer
          ? new Uint8Array(value)
          : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    this.objects.set(key, new Uint8Array(bytes));
    return {};
  }

  async get(
    key: string,
    options?: { range?: { offset: number; length: number } },
  ): Promise<{
    body: ReadableStream<Uint8Array>;
    arrayBuffer(): Promise<ArrayBuffer>;
  } | null> {
    const stored = this.objects.get(key);
    if (stored === undefined) return null;
    const offset = options?.range?.offset ?? 0;
    const length = options?.range?.length ?? stored.byteLength - offset;
    const bytes = stored.slice(offset, offset + length);
    return {
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
      }),
      async arrayBuffer() {
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    };
  }

  async delete(keys: string | string[]): Promise<void> {
    for (const key of typeof keys === "string" ? [keys] : keys) this.objects.delete(key);
  }

  async head(key: string): Promise<{ key: string; size: number; uploaded: Date } | null> {
    const stored = this.objects.get(key);
    return stored === undefined
      ? null
      : { key, size: stored.byteLength, uploaded: new Date("2026-08-10T00:00:00.000Z") };
  }

  async list(options?: { prefix?: string; limit?: number; cursor?: string }): Promise<{
    objects: Array<{ key: string; size: number; uploaded: Date }>;
    truncated: boolean;
    cursor?: string;
  }> {
    const prefix = options?.prefix ?? "";
    const offset = options?.cursor === undefined ? 0 : Number(options.cursor);
    const limit = options?.limit ?? 1_000;
    const matches = [...this.objects.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .sort(([left], [right]) => left.localeCompare(right));
    const page = matches.slice(offset, offset + limit);
    const next = offset + page.length;
    return {
      objects: page.map(([key, bytes]) => ({
        key,
        size: bytes.byteLength,
        uploaded: new Date("2026-08-10T00:00:00.000Z"),
      })),
      truncated: next < matches.length,
      ...(next < matches.length ? { cursor: String(next) } : {}),
    };
  }
}

export class MemoryCapabilityVault implements CapabilityVault {
  readonly records = new Map<number, { revision: string; definition: CapabilityDefinition }>();
  readonly databaseRecords = new Map<
    number,
    { revision: string; definition: CapabilityDefinition; credential: string }
  >();
  readonly productionDatabaseAllocations = new Map<number, ProductionDatabaseAllocationRecord>();
  readonly stripeRecords = new Map<
    number,
    {
      revision: string;
      definition: CapabilityDefinition;
      policy: StripeCapabilityPolicy;
      credential: string;
    }
  >();

  async provisionEcho(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
  }): Promise<{ state: "provisioned"; keyId: string }> {
    this.records.set(input.projectId, {
      revision: input.revision,
      definition: structuredClone(input.definition),
    });
    return { state: "provisioned", keyId: "v1" };
  }

  async revokeEcho(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict"> {
    const record = this.records.get(input.projectId);
    if (record === undefined) return "not_found";
    if (record.revision !== input.expectedRevision) return "conflict";
    this.records.delete(input.projectId);
    return "revoked";
  }

  async invokeEcho(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = this.records.get(input.projectId);
    if (record === undefined) return { state: "not_found" };
    if (
      input.invocation.requestedProjectId !== undefined &&
      input.invocation.requestedProjectId !== input.projectId
    ) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "invoke"
    ) {
      return { state: "policy_rejected" };
    }
    return {
      state: "success",
      response: {
        ok: true,
        capability: input.invocation.capability,
        requestId: input.invocation.requestId,
        runtimeIdentity: input.invocation.caller.runtimeIdentity,
        actedBy: "capability-vault",
        proof: "a".repeat(64),
        echo: input.invocation.input,
      },
    };
  }

  async provisionDatabase(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    credential: { kind: "neon-connection-string"; value: string };
  }): Promise<{ state: "provisioned"; keyId: string }> {
    this.databaseRecords.set(input.projectId, {
      revision: input.revision,
      definition: structuredClone(input.definition),
      credential: input.credential.value,
    });
    return { state: "provisioned", keyId: "v1" };
  }

  async revokeDatabase(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict"> {
    const record = this.databaseRecords.get(input.projectId);
    if (record === undefined) return "not_found";
    if (record.revision !== input.expectedRevision) return "conflict";
    this.databaseRecords.delete(input.projectId);
    return "revoked";
  }

  async getProductionDatabaseAllocation(input: {
    projectId: number;
    allocationIdentity: string;
  }): Promise<ProductionDatabaseAllocationRecord | null> {
    const allocation = this.productionDatabaseAllocations.get(input.projectId);
    if (allocation === undefined) return null;
    if (allocation.allocationIdentity !== input.allocationIdentity) {
      throw new Error("Production database allocation ownership conflict");
    }
    return structuredClone(allocation);
  }

  async provisionProductionDatabase(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    allocation: ProductionDatabaseAllocationRecord;
    credential: { kind: "neon-connection-string"; value: string };
  }): Promise<{ state: "provisioned" | "replayed"; keyId: string }> {
    const existing = this.productionDatabaseAllocations.get(input.projectId);
    if (existing !== undefined) {
      if (
        existing.allocationIdentity !== input.allocation.allocationIdentity ||
        existing.providerProjectId !== input.allocation.providerProjectId ||
        existing.state !== "ready"
      ) {
        throw new Error("Production database allocation ownership conflict");
      }
      return { state: "replayed", keyId: "v1" };
    }
    this.databaseRecords.set(input.projectId, {
      revision: input.revision,
      definition: structuredClone(input.definition),
      credential: input.credential.value,
    });
    this.productionDatabaseAllocations.set(input.projectId, structuredClone(input.allocation));
    return { state: "provisioned", keyId: "v1" };
  }

  async beginProductionDatabaseRelease(input: {
    projectId: number;
    allocationIdentity: string;
  }): Promise<ProductionDatabaseAllocationRecord | null> {
    const allocation = await this.getProductionDatabaseAllocation(input);
    if (allocation === null) return null;
    const releasing = {
      ...allocation,
      state: "releasing" as const,
      updatedAt: new Date(TEST_NOW_MS).toISOString(),
    };
    this.productionDatabaseAllocations.set(input.projectId, releasing);
    return structuredClone(releasing);
  }

  async completeProductionDatabaseRelease(input: {
    projectId: number;
    allocationIdentity: string;
  }): Promise<"released" | "not_found" | "conflict"> {
    const allocation = this.productionDatabaseAllocations.get(input.projectId);
    if (allocation === undefined) return "not_found";
    if (
      allocation.allocationIdentity !== input.allocationIdentity ||
      allocation.state !== "releasing"
    ) {
      return "conflict";
    }
    this.productionDatabaseAllocations.delete(input.projectId);
    this.databaseRecords.delete(input.projectId);
    return "released";
  }

  async invokeDatabase(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = this.databaseRecords.get(input.projectId);
    if (record === undefined) return { state: "not_found" };
    if (
      input.invocation.requestedProjectId !== undefined &&
      input.invocation.requestedProjectId !== input.projectId
    ) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "query"
    ) {
      return { state: "policy_rejected" };
    }
    const statement =
      input.invocation.input.kind === "atomic-batch"
        ? {
            kind: "atomic-batch" as const,
            results: (input.invocation.input.statements as unknown[]).map(() => ({
              command: "SELECT",
              rowCount: 1,
              rows: [{ value: "memory-database" }],
            })),
          }
        : {
            kind: "statement" as const,
            result: {
              command: "SELECT",
              rowCount: 1,
              rows: [{ value: "memory-database" }],
            },
          };
    return {
      state: "success",
      response: {
        ok: true,
        capability: input.invocation.capability,
        requestId: input.invocation.requestId,
        runtimeIdentity: input.invocation.caller.runtimeIdentity,
        actedBy: "database-broker",
        result: statement,
      },
    };
  }

  async provisionStripe(input: {
    projectId: number;
    revision: string;
    definition: CapabilityDefinition;
    policy: StripeCapabilityPolicy;
    credential: { kind: "stripe-test-secret-key"; value: string };
  }): Promise<{ state: "provisioned"; keyId: string }> {
    this.stripeRecords.set(input.projectId, {
      revision: input.revision,
      definition: structuredClone(input.definition),
      policy: structuredClone(input.policy),
      credential: input.credential.value,
    });
    return { state: "provisioned", keyId: "v1" };
  }

  async revokeStripe(input: {
    projectId: number;
    expectedRevision: string;
  }): Promise<"revoked" | "not_found" | "conflict"> {
    const record = this.stripeRecords.get(input.projectId);
    if (record === undefined) return "not_found";
    if (record.revision !== input.expectedRevision) return "conflict";
    this.stripeRecords.delete(input.projectId);
    return "revoked";
  }

  async invokeStripe(input: {
    projectId: number;
    invocation: CapabilityInvocation;
  }): Promise<CapabilityVaultInvocationResult> {
    const record = this.stripeRecords.get(input.projectId);
    if (record === undefined) return { state: "not_found" };
    if (
      input.invocation.requestedProjectId !== undefined &&
      input.invocation.requestedProjectId !== input.projectId
    ) {
      return { state: "tenant_mismatch" };
    }
    if (
      input.invocation.capability.provider !== record.definition.provider ||
      input.invocation.capability.name !== record.definition.name ||
      input.invocation.action !== "execute"
    ) {
      return { state: "policy_rejected" };
    }
    const operation = input.invocation.input.kind;
    if (operation !== "create-payment-intent" && operation !== "retrieve-payment-intent") {
      return {
        state: "stripe_error",
        status: 400,
        code: "stripe_invalid_request",
        retryable: false,
      };
    }
    return {
      state: "success",
      response: {
        ok: true,
        capability: input.invocation.capability,
        requestId: input.invocation.requestId,
        runtimeIdentity: input.invocation.caller.runtimeIdentity,
        actedBy: "stripe-broker",
        operation,
        idempotentReplay: false,
        paymentIntent: {
          id: "pi_memory123",
          status: "requires_payment_method",
          amount: 1_099,
          amountReceived: 0,
          currency: "usd",
          created: 1_785_859_200,
          livemode: false,
        },
      },
    };
  }
}

export function fakeEnv(): WorkerBindings {
  const artifactBucket = new MemoryR2Bucket();
  const artifactCommitQueue = new MemoryArtifactCommitQueue();
  return {
    CF_VERSION_METADATA: {
      id: "worker-version-test-1",
      tag: "",
      timestamp: new Date(TEST_NOW_MS).toISOString(),
    },
    CLOUDFLARE_RUNTIME_CONTROL_TOKEN: TEST_SECRET,
    CLOUDFLARE_CAPABILITY_VAULT_KEK_V1: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY",
    CLOUDFLARE_RUNTIME_DEPLOYMENT_NAMESPACE: "staging",
    CLOUDFLARE_RUNTIME_PREVIEW_PUBLIC_KEY: "test-public-key",
    NABUFLOW_RUNTIME_SLEEP_AFTER: "10m",
    NABUFLOW_RUNTIME_LAYER_PLATFORM:
      '{"runtime":"node","runtimeVersion":"22.18.0","nodeAbi":"127","os":"linux","cpu":"x64","libc":"glibc","toolchainImageDigest":"sha256:e83bb4d6d9748b93a4b876ce0852b5e93d8e0893da10c59d425770aef0d73738"}',
    NABUFLOW_CAPABILITY_VAULT_ACTIVE_KEY_ID: "v1",
    NABUFLOW_RUNTIME_ARTIFACTS: artifactBucket as unknown as R2Bucket,
    DURABLE_OPERATION_QUEUE: artifactCommitQueue as unknown as Queue<DurableOperationQueueMessage>,
    ARTIFACT_COMMIT_QUEUE: artifactCommitQueue as unknown as Queue<ArtifactCommitQueueMessage>,
    NABUFLOW_SANDBOX: {
      idFromName(identity: string) {
        return { toString: () => `container:${identity}` };
      },
    },
  } as WorkerBindings;
}

export async function signedRequest(input: {
  path: string;
  method?: string;
  body?: unknown;
  timestamp?: number;
  nonce: string;
  idempotencyKey?: string;
  secret?: string;
}): Promise<Request> {
  const method = input.method ?? "GET";
  const body = input.body === undefined ? "" : JSON.stringify(input.body);
  const timestamp = String(input.timestamp ?? TEST_NOW_MS);
  const bodySha256 = await sha256Hex(body);
  const idempotencyKey = input.idempotencyKey ?? "";
  const fields = {
    method,
    pathAndQuery: input.path,
    timestamp,
    nonce: input.nonce,
    bodySha256,
    idempotencyKey,
  };
  const signature = await signControlRequest(input.secret ?? TEST_SECRET, fields);
  return new Request(`https://runtime.example${input.path}`, {
    method,
    body: body || undefined,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      "x-nabuflow-timestamp": timestamp,
      "x-nabuflow-nonce": input.nonce,
      "x-nabuflow-body-sha256": bodySha256,
      "x-nabuflow-signature": signature,
      ...(idempotencyKey ? { "idempotency-key": idempotencyKey } : {}),
    },
  });
}

export async function signedRawRequest(input: {
  path: string;
  method: string;
  body: Uint8Array;
  timestamp?: number;
  nonce: string;
  idempotencyKey: string;
  secret?: string;
}): Promise<Request> {
  const timestamp = String(input.timestamp ?? TEST_NOW_MS);
  const bodySha256 = await sha256Hex(input.body);
  const signature = await signControlRequest(input.secret ?? TEST_SECRET, {
    method: input.method,
    pathAndQuery: input.path,
    timestamp,
    nonce: input.nonce,
    bodySha256,
    idempotencyKey: input.idempotencyKey,
  });
  return new Request(`https://runtime.example${input.path}`, {
    method: input.method,
    body: input.body.slice().buffer as ArrayBuffer,
    headers: {
      "content-type": "application/octet-stream",
      "x-nabuflow-timestamp": timestamp,
      "x-nabuflow-nonce": input.nonce,
      "x-nabuflow-body-sha256": bodySha256,
      "x-nabuflow-signature": signature,
      "idempotency-key": input.idempotencyKey,
    },
  });
}

export function ensureBody() {
  return {
    locator: { projectId: 42, role: "preview" as const, slot: "primary" as const },
    expectedDeploymentVersion: "worker-version-test-1",
    manifest: {
      revision: "manifest-1",
      runtime: "node",
      buildCommand: ["node", "--version"],
      startCommand: ["node", "server.mjs"],
      servicePort: 8080,
      healthPath: "/health",
      resourceProfile: "dev",
      public: false,
    },
  };
}
