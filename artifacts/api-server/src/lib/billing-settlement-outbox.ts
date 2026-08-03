import { pool } from "@workspace/db";
import { logger } from "./logger";

export type BillingSettlementKind =
  | "credit_deduction"
  | "overage_invoice_item"
  | "build_token_telemetry";

export interface BillingSettlementRecord {
  id: number;
  kind: BillingSettlementKind;
  dedupe_key: string;
  task_id: number | null;
  owner_id: string | null;
  amount: number | null;
  context: Record<string, unknown>;
  attempts: number;
}

export interface EnqueueBillingSettlementInput {
  kind: BillingSettlementKind;
  dedupeKey: string;
  taskId?: number | null;
  ownerId?: string | null;
  amount?: number | null;
  context: Record<string, unknown>;
  error?: unknown;
}

const SWEEP_INTERVAL_MS = 30_000;
const INITIAL_SWEEP_DELAY_MS = 5_000;
const CLAIM_LIMIT = 10;
const STALE_LOCK_MS = 5 * 60_000;
const MAX_BACKOFF_MS = 6 * 60 * 60_000;
const ENQUEUE_ATTEMPTS = 3;

export function taskCreditSettlementKey(taskId: number, source: string): string {
  return `task-credit:${taskId}:${source}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
}

function retryDelayMs(attempts: number): number {
  return Math.min(30_000 * 2 ** Math.min(attempts, 10), MAX_BACKOFF_MS);
}

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Enqueue idempotently. A bounded retry protects against transient pool/network
 * errors; the stable dedupe key prevents duplicate work records.
 */
export async function enqueueBillingSettlement(
  input: EnqueueBillingSettlementInput,
): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= ENQUEUE_ATTEMPTS; attempt += 1) {
    try {
      await pool.query(
        `INSERT INTO billing_settlement_outbox
           (kind, dedupe_key, task_id, owner_id, amount, context, last_error)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
         ON CONFLICT (dedupe_key) DO UPDATE SET
           context       = EXCLUDED.context,
           last_error    = EXCLUDED.last_error,
           completed_at  = NULL,
           next_retry_at = LEAST(billing_settlement_outbox.next_retry_at, now()),
           updated_at    = now()`,
        [
          input.kind,
          input.dedupeKey,
          input.taskId ?? null,
          input.ownerId ?? null,
          input.amount ?? null,
          JSON.stringify(input.context),
          input.error === undefined ? null : errorMessage(input.error),
        ],
      );
      logger.warn(
        {
          kind: input.kind,
          dedupeKey: input.dedupeKey,
          taskId: input.taskId ?? null,
        },
        "billing settlement deferred to durable outbox",
      );
      return;
    } catch (error) {
      lastError = error;
      if (attempt < ENQUEUE_ATTEMPTS) await wait(25 * attempt);
    }
  }
  logger.error(
    {
      err: lastError,
      kind: input.kind,
      dedupeKey: input.dedupeKey,
      taskId: input.taskId ?? null,
    },
    "billing settlement outbox enqueue exhausted bounded retries",
  );
  throw lastError;
}

export interface SettlementHandlers {
  creditDeduction(record: BillingSettlementRecord): Promise<void>;
  overageInvoiceItem(record: BillingSettlementRecord): Promise<void>;
  buildTokenTelemetry(record: BillingSettlementRecord): Promise<void>;
}

const defaultHandlers: SettlementHandlers = {
  async creditDeduction(record) {
    const { deductCreditsAtomic } = await import("../routes/credits");
    if (!record.owner_id || !record.amount) throw new Error("credit settlement payload incomplete");
    const opts = record.context["opts"] as Parameters<typeof deductCreditsAtomic>[2] | undefined;
    if (!opts) throw new Error("credit settlement options missing");
    const isReservation = record.context["reservation"] === true;
    if (isReservation && record.task_id != null) {
      const taskState = await pool.query<{ status: string }>(
        "SELECT status FROM agent_tasks WHERE id = $1 LIMIT 1",
        [record.task_id],
      );
      const status = taskState.rows[0]?.status;
      if (!status || ["canceled", "failed", "discarded"].includes(status)) {
        logger.info(
          { taskId: record.task_id, status: status ?? "missing", dedupeKey: record.dedupe_key },
          "billing reservation settlement skipped for terminal task",
        );
        return;
      }
    }
    const result = await deductCreditsAtomic(record.owner_id, record.amount, {
      ...opts,
      settlementKey: record.dedupe_key,
    });
    if ("insufficient" in result) {
      throw new Error(`insufficient credits: ${result.balance} < ${record.amount}`);
    }
    if (isReservation && record.task_id != null && result.charged > 0) {
      await pool.query(
        `UPDATE agent_tasks
            SET credits_reserved = $2
          WHERE id = $1
            AND status IN ('queued', 'planning', 'building')`,
        [record.task_id, result.charged],
      );
    }
  },

  async overageInvoiceItem(record) {
    const { reportNabuflowOveragePayload } = await import("./nabuflow-billing");
    await reportNabuflowOveragePayload(
      record.context as unknown as Parameters<typeof reportNabuflowOveragePayload>[0],
    );
  },

  async buildTokenTelemetry(record) {
    const { persistBuildTokenTelemetrySnapshot } = await import("./ai-providers");
    await persistBuildTokenTelemetrySnapshot(
      record.context as unknown as Parameters<typeof persistBuildTokenTelemetrySnapshot>[0],
    );
  },
};

export async function processBillingSettlementRecord(
  record: BillingSettlementRecord,
  handlers: SettlementHandlers = defaultHandlers,
): Promise<void> {
  switch (record.kind) {
    case "credit_deduction":
      return handlers.creditDeduction(record);
    case "overage_invoice_item":
      return handlers.overageInvoiceItem(record);
    case "build_token_telemetry":
      return handlers.buildTokenTelemetry(record);
    default: {
      const exhaustive: never = record.kind;
      throw new Error(`unknown billing settlement kind: ${String(exhaustive)}`);
    }
  }
}

async function claimDueSettlements(): Promise<BillingSettlementRecord[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claimed = await client.query<BillingSettlementRecord>(
      `WITH due AS (
         SELECT id
           FROM billing_settlement_outbox
          WHERE completed_at IS NULL
            AND next_retry_at <= now()
            AND (locked_at IS NULL OR locked_at < $1)
          ORDER BY next_retry_at, id
          FOR UPDATE SKIP LOCKED
          LIMIT $2
       )
       UPDATE billing_settlement_outbox AS outbox
          SET locked_at = now(), updated_at = now()
         FROM due
        WHERE outbox.id = due.id
       RETURNING outbox.id, outbox.kind, outbox.dedupe_key, outbox.task_id,
                 outbox.owner_id, outbox.amount, outbox.context, outbox.attempts`,
      [new Date(Date.now() - STALE_LOCK_MS), CLAIM_LIMIT],
    );
    await client.query("COMMIT");
    return claimed.rows;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function sweepBillingSettlements(
  handlers: SettlementHandlers = defaultHandlers,
): Promise<{ completed: number; deferred: number }> {
  const records = await claimDueSettlements();
  let completed = 0;
  let deferred = 0;
  for (const record of records) {
    try {
      await processBillingSettlementRecord(record, handlers);
      await pool.query(
        `UPDATE billing_settlement_outbox
            SET completed_at = now(), locked_at = NULL, last_error = NULL, updated_at = now()
          WHERE id = $1`,
        [record.id],
      );
      completed += 1;
    } catch (error) {
      const attempts = record.attempts + 1;
      await pool.query(
        `UPDATE billing_settlement_outbox
            SET attempts = $2, next_retry_at = $3, locked_at = NULL,
                last_error = $4, updated_at = now()
          WHERE id = $1`,
        [record.id, attempts, new Date(Date.now() + retryDelayMs(attempts)), errorMessage(error)],
      );
      deferred += 1;
      logger.warn(
        { err: error, outboxId: record.id, kind: record.kind, attempts },
        "billing settlement retry deferred",
      );
    }
  }
  if (records.length > 0) {
    logger.info(
      { claimed: records.length, completed, deferred },
      "billing settlement sweep complete",
    );
  } else {
    logger.debug({ claimed: 0 }, "billing settlement sweep empty");
  }
  return { completed, deferred };
}

let sweepTimer: NodeJS.Timeout | null = null;
let initialTimer: NodeJS.Timeout | null = null;

export function startBillingSettlementSweeper(): void {
  if (sweepTimer || initialTimer) return;
  logger.info(
    { intervalMs: SWEEP_INTERVAL_MS },
    "billing settlement sweeper started, interval 30s",
  );
  const run = () =>
    void sweepBillingSettlements().catch((err) =>
      logger.error({ err }, "billing settlement sweep failed"),
    );
  initialTimer = setTimeout(() => {
    initialTimer = null;
    run();
    sweepTimer = setInterval(run, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }, INITIAL_SWEEP_DELAY_MS);
  initialTimer.unref?.();
}

export function stopBillingSettlementSweeper(): void {
  if (initialTimer) clearTimeout(initialTimer);
  if (sweepTimer) clearInterval(sweepTimer);
  initialTimer = null;
  sweepTimer = null;
}

export async function settleCreditsDurably(input: {
  ownerId: string;
  amount: number;
  taskId: number;
  reservation?: boolean;
  opts: Omit<
    Parameters<typeof import("../routes/credits").deductCreditsAtomic>[2],
    "settlementKey"
  >;
}): Promise<
  Awaited<ReturnType<typeof import("../routes/credits").deductCreditsAtomic>> | { deferred: true }
> {
  const dedupeKey = taskCreditSettlementKey(input.taskId, input.opts.source ?? input.opts.type);
  try {
    const { deductCreditsAtomic } = await import("../routes/credits");
    const result = await deductCreditsAtomic(input.ownerId, input.amount, {
      ...input.opts,
      settlementKey: dedupeKey,
    });
    if ("insufficient" in result) {
      await enqueueBillingSettlement({
        kind: "credit_deduction",
        dedupeKey,
        taskId: input.taskId,
        ownerId: input.ownerId,
        amount: input.amount,
        context: { opts: input.opts, reservation: input.reservation === true },
        error: `insufficient credits: ${result.balance} < ${input.amount}`,
      });
    }
    return result;
  } catch (error) {
    try {
      await enqueueBillingSettlement({
        kind: "credit_deduction",
        dedupeKey,
        taskId: input.taskId,
        ownerId: input.ownerId,
        amount: input.amount,
        context: { opts: input.opts, reservation: input.reservation === true },
        error,
      });
    } catch {
      // Both failures are already logged. The completed build remains successful.
    }
    return { deferred: true };
  }
}
