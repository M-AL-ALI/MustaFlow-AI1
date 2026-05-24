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
