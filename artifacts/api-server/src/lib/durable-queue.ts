/**
 * Durable job queue backed by pg-boss (Postgres).
 *
 * Jobs survive process restarts because they are persisted as rows in the
 * `pgboss.*` schema tables managed by pg-boss. Failed jobs are retried with
 * exponential back-off; permanently-failed jobs land in the pg-boss DLQ.
 *
 * Architecture:
 *  - One queue per job kind: "build" and "refine".
 *  - Each job payload is a serialized JobInput (minus the AbortController).
 *  - pg-boss workers pick up jobs and call runJob() with the same semantics
 *    as the legacy in-memory enqueueJob.
 *
 * Graceful degradation:
 *  - When DATABASE_URL is missing or pg-boss fails to start, enqueue falls
 *    back to the in-memory setImmediate path (legacy behaviour preserved).
 *  - DURABLE_QUEUE_ENABLED=false disables pg-boss entirely for local dev.
 */

import { PgBoss, type Job } from "pg-boss";
import { logger } from "./logger";
import { jobQueueDepth, jobsTotal } from "./metrics";

export const QUEUE_BUILD = "mustaflow.build";
export const QUEUE_REFINE = "mustaflow.refine";
export const QUEUE_GDPR_ERASURE = "mustaflow.gdpr-erasure";

const RETRY_LIMIT = 2;
const RETRY_DELAY_SECONDS = 30;

let boss: PgBoss | null = null;
let _ready = false;
let _failed = false;

/**
 * True when the durable queue is initialised and accepting jobs.
 * Falls back to in-memory enqueue when false.
 */
export function isDurableQueueReady(): boolean {
  return _ready && !_failed;
}

/**
 * Start pg-boss and register workers. Called once at server startup.
 * Idempotent — safe to call multiple times.
 */
export async function startDurableQueue(
  onJob: (payload: Record<string, unknown>) => Promise<void>,
): Promise<void> {
  if (process.env.DURABLE_QUEUE_ENABLED === "false") {
    logger.info("Durable queue disabled (DURABLE_QUEUE_ENABLED=false) — using in-memory queue");
    return;
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    logger.warn("DATABASE_URL not set — durable queue unavailable, falling back to in-memory");
    return;
  }

  if (_ready || boss) return;

  try {
    boss = new PgBoss(connectionString);

    boss.on("error", (err: Error) => {
      logger.error({ err }, "pg-boss internal error");
    });

    await boss.start();
    _ready = true;

    for (const queue of [QUEUE_BUILD, QUEUE_REFINE]) {
      await boss.createQueue(queue, {
        retryLimit: RETRY_LIMIT,
        retryDelay: RETRY_DELAY_SECONDS,
        retryBackoff: true,
      });

      // Process one job at a time — single-job handler gives pg-boss
      // per-job ack/fail semantics and prevents a thrown error from
      // retrying jobs that already completed within the same batch.
      await boss.work(
        queue,
        { batchSize: 1, pollingIntervalSeconds: 1 },
        async (jobs: Job<Record<string, unknown>>[]) => {
          const job = jobs[0];
          if (!job) return;
          jobQueueDepth.dec();
          const kind = job.name === QUEUE_BUILD ? "build" : "refine";
          try {
            await onJob(job.data);
            jobsTotal.inc({
              kind,
              status: "success",
              agent_mode: String(job.data.agentMode ?? "unknown"),
              pipeline: "agentic",
            });
          } catch (err) {
            jobsTotal.inc({
              kind,
              status: "error",
              agent_mode: String(job.data.agentMode ?? "unknown"),
              pipeline: "agentic",
            });
            logger.error({ err, jobId: job.id, queue: job.name }, "Durable queue job failed");
            throw err;
          }
        },
      );
    }

    logger.info("Durable job queue (pg-boss) started and workers registered");
  } catch (err) {
    _failed = true;
    logger.error({ err }, "Failed to start durable queue — falling back to in-memory");
  }
}

/**
 * Enqueue a job payload into the durable queue.
 * Returns the pg-boss job ID or null if the queue is unavailable.
 */
export async function durableEnqueue(
  kind: "build" | "refine",
  payload: Record<string, unknown>,
): Promise<string | null> {
  if (!isDurableQueueReady() || !boss) return null;

  const queue = kind === "build" ? QUEUE_BUILD : QUEUE_REFINE;
  try {
    const id = await boss.send(queue, payload, {
      retryLimit: RETRY_LIMIT,
      retryDelay: RETRY_DELAY_SECONDS,
      retryBackoff: true,
    });
    jobQueueDepth.inc();
    logger.info({ queue, jobId: id, taskId: payload.taskId }, "Job enqueued in durable queue");
    return id ?? null;
  } catch (err) {
    logger.error({ err, queue }, "Failed to enqueue job in durable queue — will fall back");
    return null;
  }
}

/**
 * Return pg-boss queue stats for the status endpoint.
 */
export async function getQueueStats(): Promise<{
  build: { active: number; queued: number; total: number } | null;
  refine: { active: number; queued: number; total: number } | null;
}> {
  if (!isDurableQueueReady() || !boss) return { build: null, refine: null };
  try {
    const [buildStats, refineStats] = await Promise.all([
      boss.getQueueStats(QUEUE_BUILD),
      boss.getQueueStats(QUEUE_REFINE),
    ]);
    return {
      build: {
        active: buildStats.activeCount,
        queued: buildStats.queuedCount,
        total: buildStats.totalCount,
      },
      refine: {
        active: refineStats.activeCount,
        queued: refineStats.queuedCount,
        total: refineStats.totalCount,
      },
    };
  } catch {
    return { build: null, refine: null };
  }
}

const GDPR_ERASURE_RETRY_LIMIT = 3;
const GDPR_ERASURE_RETRY_DELAY_SECONDS = 300;
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Enqueue a GDPR erasure job for the given userId, scheduled to run 30 days
 * from now. Uses singletonKey so only one pending erasure job exists per user
 * at a time — safe to call multiple times (idempotent).
 *
 * Returns the pg-boss job ID, or null when the queue is unavailable.
 */
export async function enqueueGdprErasure(userId: string): Promise<string | null> {
  if (!isDurableQueueReady() || !boss) return null;
  const startAfter = new Date(Date.now() + THIRTY_DAYS_MS);
  try {
    await boss.createQueue(QUEUE_GDPR_ERASURE, {
      retryLimit: GDPR_ERASURE_RETRY_LIMIT,
      retryDelay: GDPR_ERASURE_RETRY_DELAY_SECONDS,
      retryBackoff: true,
    });
    const id = await boss.send(
      QUEUE_GDPR_ERASURE,
      { userId },
      {
        retryLimit: GDPR_ERASURE_RETRY_LIMIT,
        retryDelay: GDPR_ERASURE_RETRY_DELAY_SECONDS,
        retryBackoff: true,
        startAfter,
        singletonKey: userId,
        singletonNextSlot: true,
      },
    );
    logger.info({ userId, startAfter, jobId: id }, "GDPR erasure job enqueued");
    return id ?? null;
  } catch (err) {
    logger.error({ err, userId }, "Failed to enqueue GDPR erasure job");
    return null;
  }
}

/**
 * Register a worker for the GDPR erasure queue. The handler receives the
 * userId of the account to erase and must be idempotent.
 *
 * Call after startDurableQueue() has completed.
 */
export async function registerGdprErasureWorker(
  handler: (userId: string) => Promise<void>,
): Promise<void> {
  if (!isDurableQueueReady() || !boss) return;
  try {
    await boss.createQueue(QUEUE_GDPR_ERASURE, {
      retryLimit: GDPR_ERASURE_RETRY_LIMIT,
      retryDelay: GDPR_ERASURE_RETRY_DELAY_SECONDS,
      retryBackoff: true,
    });
    await boss.work(
      QUEUE_GDPR_ERASURE,
      { batchSize: 1, pollingIntervalSeconds: 60 },
      async (jobs: Job<Record<string, unknown>>[]) => {
        const job = jobs[0];
        if (!job) return;
        const userId = String(job.data.userId ?? "");
        if (!userId) {
          logger.warn({ jobId: job.id }, "GDPR erasure job missing userId — skipping");
          return;
        }
        try {
          await handler(userId);
          logger.info({ userId, jobId: job.id }, "GDPR erasure job completed");
        } catch (err) {
          logger.error({ err, userId, jobId: job.id }, "GDPR erasure job failed");
          throw err;
        }
      },
    );
    logger.info("GDPR erasure worker registered");
  } catch (err) {
    logger.error({ err }, "Failed to register GDPR erasure worker");
  }
}

/**
 * Stop pg-boss gracefully (drain in-flight jobs first).
 * Call on SIGTERM / SIGINT.
 */
export async function stopDurableQueue(): Promise<void> {
  if (boss && _ready) {
    try {
      await boss.stop({ graceful: true, timeout: 10_000 });
      logger.info("Durable queue stopped");
    } catch (err) {
      logger.warn({ err }, "Error stopping durable queue");
    }
  }
}
