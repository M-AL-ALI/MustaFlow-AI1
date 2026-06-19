/**
 * Durable job queue backed by pg-boss (Postgres).
 *
 * Jobs survive process restarts because they are persisted as rows in the
 * `pgboss.*` schema tables managed by pg-boss. Failed jobs are retried with
 * exponential back-off; permanently-failed jobs land in the pg-boss DLQ.
 *
 * Architecture:
 *  - One queue per job kind: "build", "refine", "eas-build", "app-testing",
 *    "cve-autoprotect".
 *  - Each job payload is a serialized input struct (minus any AbortController).
 *  - pg-boss workers pick up jobs and call the registered handler.
 *
 * Graceful degradation:
 *  - When DATABASE_URL is missing or pg-boss fails to start, enqueue falls
 *    back to the in-memory setImmediate path (legacy behaviour preserved).
 *  - DURABLE_QUEUE_ENABLED=false disables pg-boss entirely for local dev.
 */

import { PgBoss, type Job, type ConstructorOptions as PgBossConstructorOptions } from "pg-boss";
import { logger } from "./logger";
import { jobQueueDepth, jobsTotal } from "./metrics";

export const QUEUE_BUILD = "mustaflow.build";
export const QUEUE_REFINE = "mustaflow.refine";
export const QUEUE_EAS_BUILD = "mustaflow.eas-build";
export const QUEUE_APP_TESTING = "mustaflow.app-testing";
export const QUEUE_CVE_AUTOPROTECT = "mustaflow.cve-autoprotect";
export const QUEUE_GDPR_ERASURE = "mustaflow.gdpr-erasure";

const RETRY_LIMIT = 2;
const RETRY_DELAY_SECONDS = 30;

const EAS_RETRY_LIMIT = 1;
const EAS_RETRY_DELAY_SECONDS = 30;

const SECONDARY_RETRY_LIMIT = 2;
const SECONDARY_RETRY_DELAY_SECONDS = 15;

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
 * Start pg-boss and register the build/refine workers. Called once at server startup.
 * Idempotent — safe to call multiple times.
 *
 * After calling this, invoke registerWorker() for each additional job type (EAS,
 * app-testing, CVE) so those queues also get durable workers.
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
    // Pass pool options through to pg-boss's internal pg.Pool so that
    // managed-Postgres idle-connection drops (Neon / PgBouncer NAT timeouts)
    // are detected proactively via TCP keepalive rather than only when the
    // dead socket is next used (which surfaces as "Connection terminated
    // unexpectedly" in prod logs).
    //
    // pg-boss v12 forwards the entire config object to new pg.Pool(config) in
    // its internal Db class. The TypeScript types for ConstructorOptions only
    // declare the pg-boss-specific subset (max, connectionTimeoutMillis), so
    // keepAlive and idleTimeoutMillis must be merged in via a cast — they are
    // valid pg.Pool options that reach the pool at runtime.
    const pgBossOpts: PgBossConstructorOptions = {
      connectionString,
      max: 5,
      connectionTimeoutMillis: 10_000,
    };
    // Assign undeclared-but-forwarded pg.Pool options without TS type error.
    (pgBossOpts as Record<string, unknown>)["keepAlive"] = true;
    (pgBossOpts as Record<string, unknown>)["idleTimeoutMillis"] = 30_000;
    boss = new PgBoss(pgBossOpts);

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
        // Build and refine jobs can legitimately run for 30+ minutes (npm install,
        // tsc checks, AI loops). Set a generous 2-hour expiry so pg-boss does not
        // mark the job as expired/failed while the handler is still running —
        // which would cause the job row to show "failed" even though the handler
        // later writes "completed" to agent_tasks, leaving a split-brain state.
        expireInSeconds: 7200,
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
 * Register a worker for an additional queue (e.g. eas-build, app-testing, cve-autoprotect).
 * Must be called after startDurableQueue resolves. No-ops when the queue is not ready.
 */
export async function registerWorker(
  queue: string,
  handler: (payload: Record<string, unknown>) => Promise<void>,
  retryConfig: { retryLimit: number; retryDelay: number; retryBackoff?: boolean } = {
    retryLimit: SECONDARY_RETRY_LIMIT,
    retryDelay: SECONDARY_RETRY_DELAY_SECONDS,
    retryBackoff: true,
  },
): Promise<void> {
  if (!isDurableQueueReady() || !boss) return;

  try {
    await boss.createQueue(queue, {
      retryLimit: retryConfig.retryLimit,
      retryDelay: retryConfig.retryDelay,
      retryBackoff: retryConfig.retryBackoff ?? true,
    });

    await boss.work(
      queue,
      { batchSize: 1, pollingIntervalSeconds: 2 },
      async (jobs: Job<Record<string, unknown>>[]) => {
        const job = jobs[0];
        if (!job) return;
        try {
          await handler(job.data);
          logger.info({ queue, jobId: job.id }, "Durable worker job completed");
        } catch (err) {
          logger.error({ err, jobId: job.id, queue }, "Durable worker job failed");
          throw err;
        }
      },
    );

    logger.info({ queue }, "Durable worker registered");
  } catch (err) {
    logger.error({ err, queue }, "Failed to register durable worker");
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
      expireInSeconds: 7200, // 2 hours — consistent with createQueue setting
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
 * Enqueue a payload into any named queue with an optional idempotency key.
 * Used for EAS builds, app-testing, and CVE auto-protect jobs.
 * Returns the pg-boss job ID or null if the queue is unavailable.
 */
export async function durableEnqueueRaw(
  queue: string,
  payload: Record<string, unknown>,
  key?: string,
  retryConfig: { retryLimit: number; retryDelay: number; retryBackoff?: boolean } = {
    retryLimit: queue === QUEUE_EAS_BUILD ? EAS_RETRY_LIMIT : SECONDARY_RETRY_LIMIT,
    retryDelay: queue === QUEUE_EAS_BUILD ? EAS_RETRY_DELAY_SECONDS : SECONDARY_RETRY_DELAY_SECONDS,
    retryBackoff: true,
  },
): Promise<string | null> {
  if (!isDurableQueueReady() || !boss) return null;

  try {
    const id = await boss.send(queue, payload, {
      retryLimit: retryConfig.retryLimit,
      retryDelay: retryConfig.retryDelay,
      retryBackoff: retryConfig.retryBackoff ?? true,
      ...(key ? { key } : {}),
    });
    logger.info({ queue, jobId: id, key }, "Job enqueued in durable queue (raw)");
    return id ?? null;
  } catch (err) {
    logger.error(
      { err, queue, key },
      "Failed to enqueue job in durable queue (raw) — will fall back",
    );
    return null;
  }
}

export type QueueStat = {
  active: number;
  queued: number;
  failed: number;
  total: number;
};

export type RecentJob = {
  id: string;
  state: string;
  createdon: string;
  completedon: string | null;
  output: unknown;
};

export type QueueDetail = QueueStat & { recent: RecentJob[] };

/**
 * Return pg-boss queue stats (active/queued/failed/total) plus up to `recentLimit`
 * recent pending, active, or failed job entries for all registered queues.
 * Queries the pgboss.job table directly for failed counts and recent entries.
 */
export async function getQueueStats(recentLimit = 5): Promise<{
  build: QueueDetail | null;
  refine: QueueDetail | null;
  easBuild: QueueDetail | null;
  appTesting: QueueDetail | null;
  cveAutoprotect: QueueDetail | null;
}> {
  const empty = {
    build: null,
    refine: null,
    easBuild: null,
    appTesting: null,
    cveAutoprotect: null,
  };
  if (!isDurableQueueReady() || !boss) return empty;

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) return empty;

  // Import pg pool for raw pgboss schema queries (pg-boss doesn't expose failed listing).
  const { Pool } = await import("pg");
  const tmpPool = new Pool({ connectionString, max: 2, connectionTimeoutMillis: 10_000 });
  // Suppress unhandled 'error' events on idle clients — the pool is ended
  // immediately after the queries below, so any dropped idle client between
  // creation and first use must not crash the process.
  tmpPool.on("error", () => undefined);

  async function safeStats(q: string): Promise<QueueDetail | null> {
    try {
      const [pgbossStats, recentRows, failedRow] = await Promise.all([
        boss!.getQueueStats(q),
        tmpPool.query<RecentJob>(
          `SELECT id::text, state, createdon::text, completedon::text, output
             FROM pgboss.job
            WHERE name = $1
              AND state IN ('created','retry','active','failed')
            ORDER BY createdon DESC
            LIMIT $2`,
          [q, recentLimit],
        ),
        tmpPool.query<{ cnt: string }>(
          `SELECT COUNT(*)::int AS cnt FROM pgboss.job WHERE name = $1 AND state = 'failed'`,
          [q],
        ),
      ]);
      return {
        active: pgbossStats.activeCount,
        queued: pgbossStats.queuedCount,
        failed: Number(failedRow.rows[0]?.cnt ?? 0),
        total: pgbossStats.totalCount,
        recent: recentRows.rows,
      };
    } catch {
      return null;
    }
  }

  const [build, refine, easBuild, appTesting, cveAutoprotect] = await Promise.all([
    safeStats(QUEUE_BUILD),
    safeStats(QUEUE_REFINE),
    safeStats(QUEUE_EAS_BUILD),
    safeStats(QUEUE_APP_TESTING),
    safeStats(QUEUE_CVE_AUTOPROTECT),
  ]);

  await tmpPool.end().catch(() => undefined);

  return { build, refine, easBuild, appTesting, cveAutoprotect };
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
