import { DurableObject } from "cloudflare:workers";
import { getSandbox } from "@cloudflare/sandbox";
import type { TrustedBuildStage, TrustedBuildState } from "@workspace/tenant-runtime-contracts";
import {
  TRUSTED_BUILD_MAX_ATTEMPTS,
  TRUSTED_BUILD_OPERATION_BOUND_MS,
  TRUSTED_BUILD_QUEUE_WATCHDOG_MS,
} from "./trusted-build-model";
import type {
  StoredTrustedBuild,
  TrustedBuildBegin,
  TrustedBuildClaim,
  TrustedBuildCoordinator,
  TrustedBuildDiagnostics,
  TrustedBuildFailure,
  TrustedBuildWorkerBindings,
} from "./trusted-build-model";

const BUILD_PREFIX = "build:";
const REQUEST_PREFIX = "request:";
const COUNTERS_KEY = "diagnostics";

interface Counters {
  queueDeliveries: number;
  coalescedRequests: number;
}

function buildKey(buildId: string): string {
  return `${BUILD_PREFIX}${buildId}`;
}

function requestKey(requestId: string): string {
  return `${REQUEST_PREFIX}${requestId}`;
}

function isTerminal(state: TrustedBuildState): boolean {
  return state === "succeeded" || state === "failed" || state === "cancelled";
}

function deadlineMs(build: StoredTrustedBuild): number {
  const persisted = (build as StoredTrustedBuild & { deadlineAt?: string }).deadlineAt;
  const parsedPersisted = persisted === undefined ? Number.NaN : Date.parse(persisted);
  if (Number.isFinite(parsedPersisted)) return parsedPersisted;
  const createdAt = Date.parse(build.createdAt);
  return Number.isFinite(createdAt) ? createdAt + TRUSTED_BUILD_OPERATION_BOUND_MS : 0;
}

function persistDeadlineIfMissing(build: StoredTrustedBuild): void {
  if (build.deadlineAt === undefined || !Number.isFinite(Date.parse(build.deadlineAt))) {
    build.deadlineAt = new Date(deadlineMs(build)).toISOString();
  }
}

function terminalizeDeadline(build: StoredTrustedBuild, nowMs: number): boolean {
  persistDeadlineIfMissing(build);
  if (isTerminal(build.state) || nowMs < deadlineMs(build)) return false;
  const failedAt = new Date(nowMs).toISOString();
  const failure: TrustedBuildFailure = {
    code: "build_timeout",
    message: "The trusted build exceeded its absolute operation deadline",
    retryable: true,
    status: 504,
    failedAt,
    negativeCacheUntil: new Date(nowMs + TRUSTED_BUILD_QUEUE_WATCHDOG_MS).toISOString(),
  };
  build.state = "failed";
  build.updatedAt = failedAt;
  build.failure = failure;
  build.leaseUntil = null;
  build.cellId = null;
  const evidence = build.attempts?.find((item) => item.attempt === build.attempt);
  if (evidence !== undefined) {
    evidence.failingStage ??= {
      pass: evidence.lastSuccessfulStage?.pass ?? null,
      stage: evidence.lastSuccessfulStage?.stage ?? "orchestration",
    };
    evidence.error = {
      code: failure.code,
      message: failure.message,
      retryable: failure.retryable,
      status: failure.status,
    };
  }
  return true;
}

export class TrustedBuildDurableObject
  extends DurableObject<TrustedBuildWorkerBindings>
  implements TrustedBuildCoordinator
{
  constructor(ctx: DurableObjectState, env: TrustedBuildWorkerBindings) {
    super(ctx, env);
  }

  async begin(
    request: Pick<
      StoredTrustedBuild,
      | "buildId"
      | "requestId"
      | "requestSha256"
      | "createdAt"
      | "updatedAt"
      | "requestObjectSha256"
      | "sourceObjectSha256"
      | "sourceBytes"
    >,
    maxActive: number,
  ): Promise<TrustedBuildBegin> {
    const result = await this.ctx.storage.transaction<TrustedBuildBegin>(async (transaction) => {
      const existingBuildId = await transaction.get<string>(requestKey(request.requestId));
      if (existingBuildId !== undefined) {
        const existing = await transaction.get<StoredTrustedBuild>(buildKey(existingBuildId));
        if (existing !== undefined && existing.requestSha256 === request.requestSha256) {
          const counters = (await transaction.get<Counters>(COUNTERS_KEY)) ?? {
            queueDeliveries: 0,
            coalescedRequests: 0,
          };
          counters.coalescedRequests += 1;
          await transaction.put(COUNTERS_KEY, counters);
          return {
            state: existing.state === "succeeded" ? "succeeded" : "coalesced",
            build: existing,
          };
        }
      }
      const builds = await transaction.list<StoredTrustedBuild>({ prefix: BUILD_PREFIX });
      const active = [...builds.values()].filter((build) => !isTerminal(build.state)).length;
      if (active >= maxActive) return { state: "backpressure" };
      const build: StoredTrustedBuild = {
        ...request,
        deadlineAt: new Date(
          Date.parse(request.createdAt) + TRUSTED_BUILD_OPERATION_BOUND_MS,
        ).toISOString(),
        state: "queued",
        attempt: 0,
        queueDeliveries: 0,
        leaseUntil: null,
        cellId: null,
        outputObjectSha256: null,
        failure: null,
        attempts: [],
      };
      await transaction.put({
        [buildKey(build.buildId)]: build,
        [requestKey(build.requestId)]: build.buildId,
      });
      return { state: "created", build };
    });
    if (result.state === "created") {
      await this.scheduleWatchdog(
        Math.min(
          Date.parse(result.build.updatedAt) + TRUSTED_BUILD_QUEUE_WATCHDOG_MS,
          deadlineMs(result.build),
        ),
      );
    }
    return result;
  }

  async recordQueueDelivery(buildId: string): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      const counters = (await transaction.get<Counters>(COUNTERS_KEY)) ?? {
        queueDeliveries: 0,
        coalescedRequests: 0,
      };
      counters.queueDeliveries += 1;
      build.queueDeliveries += 1;
      await transaction.put({ [key]: build, [COUNTERS_KEY]: counters });
      return "recorded";
    });
  }

  async recordStage(
    buildId: string,
    attempt: number,
    pass: 1 | 2 | null,
    stage: TrustedBuildStage,
    outcome: "started" | "succeeded" | "failed",
  ): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      build.attempts ??= [];
      let evidence = build.attempts.find((item) => item.attempt === attempt);
      if (evidence === undefined) {
        evidence = {
          attempt,
          progression: [],
          collectionProgress: [],
          secretScanFindings: [],
          secretScanSummaries: [],
          memoryProgress: [],
          verificationProgress: [],
          lastSuccessfulStage: null,
          failingStage: null,
          error: null,
          diagnostics: null,
        };
        build.attempts.push(evidence);
      }
      evidence.diagnostics ??= null;
      evidence.progression.push({ pass, stage, outcome });
      if (outcome === "succeeded") evidence.lastSuccessfulStage = { pass, stage };
      if (outcome === "failed") evidence.failingStage = { pass, stage };
      await transaction.put(key, build);
      return "recorded";
    });
  }

  async recordCollectionProgress(
    buildId: string,
    attempt: number,
    progress: Parameters<TrustedBuildCoordinator["recordCollectionProgress"]>[2],
  ): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      build.attempts ??= [];
      let evidence = build.attempts.find((item) => item.attempt === attempt);
      if (evidence === undefined) {
        evidence = {
          attempt,
          progression: [],
          collectionProgress: [],
          secretScanFindings: [],
          secretScanSummaries: [],
          memoryProgress: [],
          verificationProgress: [],
          lastSuccessfulStage: null,
          failingStage: null,
          error: null,
          diagnostics: null,
        };
        build.attempts.push(evidence);
      }
      evidence.collectionProgress ??= [];
      evidence.collectionProgress.push(progress);
      if (evidence.collectionProgress.length > 2_000) evidence.collectionProgress.shift();
      await transaction.put(key, build);
      return "recorded";
    });
  }

  async recordSecretScanFindings(
    buildId: string,
    attempt: number,
    findings: Parameters<TrustedBuildCoordinator["recordSecretScanFindings"]>[2],
  ): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      const evidence = build.attempts?.find((item) => item.attempt === attempt);
      if (evidence === undefined) return "not_found";
      evidence.secretScanFindings = [...findings].slice(0, 100);
      await transaction.put(key, build);
      return "recorded";
    });
  }

  async recordSecretScanSummary(
    buildId: string,
    attempt: number,
    summary: Parameters<TrustedBuildCoordinator["recordSecretScanSummary"]>[2],
  ): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      const evidence = build.attempts?.find((item) => item.attempt === attempt);
      if (evidence === undefined) return "not_found";
      evidence.secretScanSummaries ??= [];
      evidence.secretScanSummaries.push(summary);
      if (evidence.secretScanSummaries.length > 10) evidence.secretScanSummaries.shift();
      await transaction.put(key, build);
      return "recorded";
    });
  }

  async recordMemoryProgress(
    buildId: string,
    attempt: number,
    progress: Parameters<TrustedBuildCoordinator["recordMemoryProgress"]>[2],
  ): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      const evidence = build.attempts?.find((item) => item.attempt === attempt);
      if (evidence === undefined) return "not_found";
      evidence.memoryProgress ??= [];
      const existing = evidence.memoryProgress.find(
        (item) => item.pass === progress.pass && item.phase === progress.phase,
      );
      if (existing === undefined) {
        evidence.memoryProgress.push(progress);
      } else {
        existing.controlledPeakBytes = Math.max(
          existing.controlledPeakBytes,
          progress.controlledPeakBytes,
        );
        existing.runtimePeakBytes =
          existing.runtimePeakBytes === null
            ? progress.runtimePeakBytes
            : progress.runtimePeakBytes === null
              ? existing.runtimePeakBytes
              : Math.max(existing.runtimePeakBytes, progress.runtimePeakBytes);
        existing.heapUsedBytes =
          existing.heapUsedBytes === null
            ? progress.heapUsedBytes
            : progress.heapUsedBytes === null
              ? existing.heapUsedBytes
              : Math.max(existing.heapUsedBytes, progress.heapUsedBytes);
        existing.arrayBuffersBytes =
          existing.arrayBuffersBytes === null
            ? progress.arrayBuffersBytes
            : progress.arrayBuffersBytes === null
              ? existing.arrayBuffersBytes
              : Math.max(existing.arrayBuffersBytes, progress.arrayBuffersBytes);
        existing.samples += progress.samples;
        existing.recordedAt = progress.recordedAt;
      }
      await transaction.put(key, build);
      return "recorded";
    });
  }

  async recordVerificationProgress(
    buildId: string,
    attempt: number,
    progress: Parameters<TrustedBuildCoordinator["recordVerificationProgress"]>[2],
  ): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      const evidence = build.attempts?.find((item) => item.attempt === attempt);
      if (evidence === undefined) return "not_found";
      evidence.verificationProgress ??= [];
      evidence.verificationProgress.push(progress);
      if (evidence.verificationProgress.length > 200) evidence.verificationProgress.shift();
      await transaction.put(key, build);
      return "recorded";
    });
  }

  async recordAttemptFailure(
    buildId: string,
    attempt: number,
    pass: 1 | 2 | null,
    stage: TrustedBuildStage,
    failure: Pick<TrustedBuildFailure, "code" | "message" | "retryable" | "status">,
    diagnostics: Parameters<TrustedBuildCoordinator["recordAttemptFailure"]>[5],
  ): Promise<"recorded" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      build.attempts ??= [];
      let evidence = build.attempts.find((item) => item.attempt === attempt);
      if (evidence === undefined) {
        evidence = {
          attempt,
          progression: [],
          collectionProgress: [],
          secretScanFindings: [],
          secretScanSummaries: [],
          memoryProgress: [],
          verificationProgress: [],
          lastSuccessfulStage: null,
          failingStage: null,
          error: null,
          diagnostics: null,
        };
        build.attempts.push(evidence);
      }
      evidence.diagnostics ??= null;
      const lastRecordedFailure = [...evidence.progression]
        .reverse()
        .find((item) => item.outcome === "failed");
      const matchingRecordedFailure = [...evidence.progression]
        .reverse()
        .find((item) => item.outcome === "failed" && item.stage === stage);
      const effectivePass =
        pass ?? matchingRecordedFailure?.pass ?? lastRecordedFailure?.pass ?? null;
      const effectiveStage =
        (stage === "orchestration" || stage === "unknown") && lastRecordedFailure !== undefined
          ? lastRecordedFailure.stage
          : stage;
      if (
        !evidence.progression.some(
          (item) =>
            item.pass === effectivePass &&
            item.stage === effectiveStage &&
            item.outcome === "failed",
        )
      ) {
        evidence.progression.push({
          pass: effectivePass,
          stage: effectiveStage,
          outcome: "failed",
        });
      }
      evidence.failingStage = { pass: effectivePass, stage: effectiveStage };
      evidence.error = {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
        status: failure.status,
      };
      evidence.diagnostics = diagnostics;
      await transaction.put(key, build);
      return "recorded";
    });
  }

  async claim(buildId: string, now: string, leaseUntil: string): Promise<TrustedBuildClaim> {
    const result = await this.ctx.storage.transaction<TrustedBuildClaim>(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return { state: "not_found" };
      if (isTerminal(build.state)) return { state: "terminal", build };
      if (terminalizeDeadline(build, Date.parse(now))) {
        await transaction.put(key, build);
        return { state: "terminal", build };
      }
      if (
        build.state !== "queued" &&
        build.leaseUntil !== null &&
        Date.parse(build.leaseUntil) > Date.parse(now)
      ) {
        return { state: "busy", build };
      }
      if (build.attempt >= TRUSTED_BUILD_MAX_ATTEMPTS) {
        build.state = "failed";
        build.updatedAt = now;
        build.leaseUntil = null;
        build.cellId = null;
        build.failure = {
          code: "build_unavailable",
          message: "The trusted build consumer did not recover",
          retryable: true,
          status: 503,
          failedAt: now,
          negativeCacheUntil: new Date(
            Date.parse(now) + TRUSTED_BUILD_QUEUE_WATCHDOG_MS,
          ).toISOString(),
        };
        await transaction.put(key, build);
        return { state: "terminal", build };
      }
      build.state = "resolving";
      build.attempt += 1;
      build.attempts ??= [];
      if (!build.attempts.some((attempt) => attempt.attempt === build.attempt)) {
        build.attempts.push({
          attempt: build.attempt,
          progression: [],
          collectionProgress: [],
          secretScanFindings: [],
          secretScanSummaries: [],
          memoryProgress: [],
          verificationProgress: [],
          lastSuccessfulStage: null,
          failingStage: null,
          error: null,
          diagnostics: null,
        });
      }
      build.updatedAt = now;
      build.leaseUntil = leaseUntil;
      build.cellId = null;
      await transaction.put(key, build);
      return { state: "claimed", build };
    });
    if (result.state === "claimed") {
      await this.scheduleWatchdog(Math.min(Date.parse(leaseUntil), deadlineMs(result.build)));
    }
    return result;
  }

  async renewLease(
    buildId: string,
    attempt: number,
    now: string,
    leaseUntil: string,
  ): Promise<"updated" | "not_found" | "stale" | "terminal"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found" as const;
      if (isTerminal(build.state)) return "terminal" as const;
      if (terminalizeDeadline(build, Date.parse(now))) {
        await transaction.put(key, build);
        return "terminal" as const;
      }
      if (build.attempt !== attempt) return "stale" as const;
      build.updatedAt = now;
      build.leaseUntil = leaseUntil;
      await transaction.put(key, build);
      return "updated" as const;
    });
    if (result === "updated") {
      const build = await this.get(buildId);
      if (build !== null) {
        await this.scheduleWatchdog(Math.min(Date.parse(leaseUntil), deadlineMs(build)));
      }
    }
    return result;
  }

  async bindCell(
    buildId: string,
    attempt: number,
    cellId: string | null,
  ): Promise<"updated" | "not_found" | "stale" | "terminal"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found" as const;
      if (isTerminal(build.state)) return "terminal" as const;
      if (terminalizeDeadline(build, Date.now())) {
        await transaction.put(key, build);
        return "terminal" as const;
      }
      if (build.attempt !== attempt) return "stale" as const;
      build.cellId = cellId;
      await transaction.put(key, build);
      return "updated" as const;
    });
  }

  async transition(
    buildId: string,
    attempt: number,
    expected: TrustedBuildState,
    next: "resolving" | "building" | "verifying",
    now: string,
  ): Promise<"updated" | "not_found" | "conflict" | "cancelled"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      if (build.state === "cancelled") return "cancelled";
      if (terminalizeDeadline(build, Date.parse(now))) {
        await transaction.put(key, build);
        return "conflict";
      }
      if (build.attempt !== attempt || build.state !== expected) return "conflict";
      build.state = next;
      build.updatedAt = now;
      await transaction.put(key, build);
      return "updated";
    });
  }

  async succeed(
    buildId: string,
    attempt: number,
    outputObjectSha256: string,
    now: string,
  ): Promise<"updated" | "not_found" | "conflict" | "cancelled"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      if (build.state === "cancelled") return "cancelled";
      if (terminalizeDeadline(build, Date.parse(now))) {
        await transaction.put(key, build);
        return "conflict";
      }
      if (build.attempt !== attempt || build.state !== "verifying") return "conflict";
      build.state = "succeeded";
      build.outputObjectSha256 = outputObjectSha256;
      build.updatedAt = now;
      build.leaseUntil = null;
      build.cellId = null;
      await transaction.put(key, build);
      return "updated";
    });
  }

  async fail(
    buildId: string,
    attempt: number,
    failure: TrustedBuildFailure,
  ): Promise<"updated" | "not_found" | "cancelled" | "stale"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      if (build.state === "cancelled") return "cancelled";
      if (terminalizeDeadline(build, Date.parse(failure.failedAt))) {
        await transaction.put(key, build);
        return "stale";
      }
      if (build.attempt !== attempt) return "stale";
      build.state = "failed";
      build.failure = failure;
      build.updatedAt = failure.failedAt;
      build.leaseUntil = null;
      build.cellId = null;
      await transaction.put(key, build);
      return "updated";
    });
  }

  async requeue(
    buildId: string,
    attempt: number,
    expected: TrustedBuildState,
    now: string,
  ): Promise<"updated" | "not_found" | "conflict" | "cancelled"> {
    const result = await this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      if (build.state === "cancelled") return "cancelled";
      if (terminalizeDeadline(build, Date.parse(now))) {
        await transaction.put(key, build);
        return "conflict";
      }
      if (build.attempt !== attempt || build.state !== expected) return "conflict";
      build.state = "queued";
      build.updatedAt = now;
      build.leaseUntil = null;
      build.cellId = null;
      await transaction.put(key, build);
      return "updated";
    });
    if (result === "updated") {
      const build = await this.get(buildId);
      if (build !== null) {
        await this.scheduleWatchdog(
          Math.min(Date.parse(now) + TRUSTED_BUILD_QUEUE_WATCHDOG_MS, deadlineMs(build)),
        );
      }
    }
    return result;
  }

  async cancel(
    buildId: string,
    now: string,
  ): Promise<"cancelled" | "already-terminal" | "not_found"> {
    return this.ctx.storage.transaction(async (transaction) => {
      const key = buildKey(buildId);
      const build = await transaction.get<StoredTrustedBuild>(key);
      if (build === undefined) return "not_found";
      if (isTerminal(build.state)) return "already-terminal";
      if (terminalizeDeadline(build, Date.parse(now))) {
        await transaction.put(key, build);
        return "already-terminal";
      }
      build.state = "cancelled";
      build.updatedAt = now;
      build.leaseUntil = null;
      await transaction.put(key, build);
      return "cancelled";
    });
  }

  async get(buildId: string): Promise<StoredTrustedBuild | null> {
    return (await this.ctx.storage.get<StoredTrustedBuild>(buildKey(buildId))) ?? null;
  }

  async cleanup(
    olderThanMs: number,
    maxDeletes: number,
    includeSucceeded: boolean,
  ): Promise<StoredTrustedBuild[]> {
    return this.ctx.storage.transaction(async (transaction) => {
      const builds = await transaction.list<StoredTrustedBuild>({ prefix: BUILD_PREFIX });
      const removed = [...builds.values()]
        .filter(
          (build) =>
            isTerminal(build.state) &&
            (includeSucceeded || build.state !== "succeeded") &&
            Date.parse(build.updatedAt) < olderThanMs,
        )
        .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))
        .slice(0, maxDeletes);
      for (const build of removed) {
        await transaction.delete([buildKey(build.buildId), requestKey(build.requestId)]);
      }
      return removed;
    });
  }

  async alarm(): Promise<void> {
    const nowMs = Date.now();
    const builds = await this.ctx.storage.list<StoredTrustedBuild>({ prefix: BUILD_PREFIX });
    for (const snapshot of builds.values()) {
      if (isTerminal(snapshot.state)) continue;
      const dueAt = Math.min(
        snapshot.state === "queued" || snapshot.leaseUntil === null
          ? Date.parse(snapshot.updatedAt) + TRUSTED_BUILD_QUEUE_WATCHDOG_MS
          : Date.parse(snapshot.leaseUntil),
        deadlineMs(snapshot),
      );
      if (dueAt > nowMs) continue;
      const recovery = await this.ctx.storage.transaction(async (transaction) => {
        const key = buildKey(snapshot.buildId);
        const build = await transaction.get<StoredTrustedBuild>(key);
        if (build === undefined || isTerminal(build.state)) return null;
        const cellId = build.cellId;
        if (terminalizeDeadline(build, nowMs)) {
          await transaction.put(key, build);
          return { action: "failed" as const, cellId, build };
        }
        const currentDueAt =
          build.state === "queued" || build.leaseUntil === null
            ? Date.parse(build.updatedAt) + TRUSTED_BUILD_QUEUE_WATCHDOG_MS
            : Date.parse(build.leaseUntil);
        if (currentDueAt > nowMs) return null;
        if (build.attempt >= TRUSTED_BUILD_MAX_ATTEMPTS) {
          const failedAt = new Date(nowMs).toISOString();
          const failure: TrustedBuildFailure = {
            code: "build_unavailable",
            message: "The trusted build consumer did not recover",
            retryable: true,
            status: 503,
            failedAt,
            negativeCacheUntil: new Date(nowMs + TRUSTED_BUILD_QUEUE_WATCHDOG_MS).toISOString(),
          };
          build.state = "failed";
          build.updatedAt = failedAt;
          build.failure = failure;
          build.leaseUntil = null;
          build.cellId = null;
          const evidence = build.attempts?.find((item) => item.attempt === build.attempt);
          if (evidence !== undefined) {
            evidence.failingStage ??= {
              pass: evidence.lastSuccessfulStage?.pass ?? null,
              stage: evidence.lastSuccessfulStage?.stage ?? "orchestration",
            };
            evidence.error = {
              code: failure.code,
              message: failure.message,
              retryable: failure.retryable,
              status: failure.status,
            };
          }
          await transaction.put(key, build);
          return { action: "failed" as const, cellId, build };
        }
        build.state = "queued";
        build.updatedAt = new Date(nowMs).toISOString();
        build.leaseUntil = null;
        build.cellId = null;
        await transaction.put(key, build);
        return { action: "requeue" as const, cellId, build };
      });
      if (recovery === null) continue;
      if (recovery.cellId !== null) await this.destroyOrphanedCell(recovery.cellId);
      if (recovery.action === "requeue") {
        let enqueued = false;
        try {
          await this.env.TRUSTED_BUILD_QUEUE?.send({
            schemaVersion: 1,
            buildId: recovery.build.buildId,
            requestId: recovery.build.requestId,
            requestSha256: recovery.build.requestSha256,
          });
          enqueued = this.env.TRUSTED_BUILD_QUEUE !== undefined;
        } catch {
          // The typed terminal fallback below is authoritative.
        }
        if (!enqueued) {
          const failedAt = new Date().toISOString();
          await this.fail(recovery.build.buildId, recovery.build.attempt, {
            code: "build_unavailable",
            message: "Build recovery queue is unavailable",
            retryable: true,
            status: 503,
            failedAt,
            negativeCacheUntil: new Date(
              Date.parse(failedAt) + TRUSTED_BUILD_QUEUE_WATCHDOG_MS,
            ).toISOString(),
          });
        }
      }
    }
    await this.scheduleNextWatchdog();
  }

  async diagnostics(): Promise<TrustedBuildDiagnostics> {
    const [builds, counters] = await Promise.all([
      this.ctx.storage.list<StoredTrustedBuild>({ prefix: BUILD_PREFIX }),
      this.ctx.storage.get<Counters>(COUNTERS_KEY),
    ]);
    const states = [...builds.values()];
    return {
      queued: states.filter((build) => build.state === "queued").length,
      running: states.filter((build) =>
        ["resolving", "building", "verifying"].includes(build.state),
      ).length,
      succeeded: states.filter((build) => build.state === "succeeded").length,
      failed: states.filter((build) => build.state === "failed").length,
      cancelled: states.filter((build) => build.state === "cancelled").length,
      queueDeliveries: counters?.queueDeliveries ?? 0,
      coalescedRequests: counters?.coalescedRequests ?? 0,
    };
  }

  private async destroyOrphanedCell(cellId: string): Promise<void> {
    const sandbox = getSandbox(this.env.TRUSTED_BUILD_SANDBOX, cellId, {
      normalizeId: true,
      keepAlive: true,
      sleepAfter: "10m",
      transport: "rpc",
    });
    try {
      await sandbox.destroy();
    } catch {
      // Recovery is fenced by the attempt number; cell cleanup remains best-effort.
    } finally {
      try {
        (sandbox as unknown as { [Symbol.dispose]?: () => void })[Symbol.dispose]?.();
      } catch {
        // Continue recovery even if the transport has already been disposed.
      }
    }
  }

  private async scheduleWatchdog(atMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || atMs < current) await this.ctx.storage.setAlarm(atMs);
  }

  private async scheduleNextWatchdog(): Promise<void> {
    const builds = await this.ctx.storage.list<StoredTrustedBuild>({ prefix: BUILD_PREFIX });
    let next: number | null = null;
    for (const build of builds.values()) {
      if (isTerminal(build.state)) continue;
      const dueAt = Math.min(
        build.state === "queued" || build.leaseUntil === null
          ? Date.parse(build.updatedAt) + TRUSTED_BUILD_QUEUE_WATCHDOG_MS
          : Date.parse(build.leaseUntil),
        deadlineMs(build),
      );
      next = next === null ? dueAt : Math.min(next, dueAt);
    }
    if (next !== null) await this.ctx.storage.setAlarm(Math.max(Date.now() + 1_000, next));
  }
}
