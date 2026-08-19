import { pool } from "@workspace/db";
import type { PoolClient } from "pg";

export interface DualWindowAdmissionResult {
  allowed: boolean;
  blockedWindow: "hour" | "day" | null;
  hourCount: number;
  dayCount: number;
  hourResetAtMs: number;
  dayResetAtMs: number;
  serverNowMs: number;
}

type AdmissionWindow = {
  kind: "hour" | "day";
  start: Date;
  resetAt: Date;
  limit: number;
};

type AdmissionClient = Pick<PoolClient, "query" | "release">;

export type AdmissionConnectionFactory = () => Promise<AdmissionClient>;

const connectAdmissionClient: AdmissionConnectionFactory = () => pool.connect();

function finiteCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("Postgres returned an invalid admission count");
  }
  return count;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`Invalid ${name}`);
  }
  return value;
}

function asDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error("Postgres returned an invalid admission timestamp");
  }
  return date;
}

function sortedWindows(input: {
  key: string;
  hourlyLimit: number;
  dailyLimit: number;
  hourStart: Date;
  hourReset: Date;
  dayStart: Date;
  dayReset: Date;
}): AdmissionWindow[] {
  return [
    {
      kind: "hour" as const,
      start: input.hourStart,
      resetAt: input.hourReset,
      limit: input.hourlyLimit,
    },
    {
      kind: "day" as const,
      start: input.dayStart,
      resetAt: input.dayReset,
      limit: input.dailyLimit,
    },
  ].sort((left, right) => {
    const leftKey = `${input.key}:${left.kind}:${left.start.toISOString()}`;
    const rightKey = `${input.key}:${right.kind}:${right.start.toISOString()}`;
    return leftKey.localeCompare(rightKey);
  });
}

/**
 * Atomically reserve weighted capacity from an hourly and daily ceiling.
 *
 * The two rows are created and locked in one deterministic sorted order. Both
 * counts advance in the same transaction or neither advances. Postgres server
 * time owns bucket boundaries and response timing, so API-host clock drift is
 * irrelevant. Failures are deliberately surfaced to the caller, which must
 * fail closed before any model dispatch.
 */
export async function reserveDualWindowAdmission(
  input: {
    key: string;
    hourlyLimit: number;
    dailyLimit: number;
    weight: number;
  },
  connect: AdmissionConnectionFactory = connectAdmissionClient,
): Promise<DualWindowAdmissionResult> {
  const hourlyLimit = positiveInteger("hourly admission limit", input.hourlyLimit);
  const dailyLimit = positiveInteger("daily admission limit", input.dailyLimit);
  const weight = positiveInteger("admission weight", input.weight);
  const client = await connect();
  let transactionOpen = false;
  try {
    await client.query("BEGIN");
    transactionOpen = true;

    const timeResult = await client.query<{
      server_now: Date;
      hour_start: Date;
      hour_reset: Date;
      day_start: Date;
      day_reset: Date;
    }>(`
      SELECT
        transaction_timestamp() AS server_now,
        date_trunc('hour', transaction_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AS hour_start,
        (date_trunc('hour', transaction_timestamp() AT TIME ZONE 'UTC') + interval '1 hour')
          AT TIME ZONE 'UTC' AS hour_reset,
        date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          AS day_start,
        (date_trunc('day', transaction_timestamp() AT TIME ZONE 'UTC') + interval '1 day')
          AT TIME ZONE 'UTC' AS day_reset
    `);
    const time = timeResult.rows[0];
    if (!time) throw new Error("Postgres returned no admission clock");

    const serverNow = asDate(time.server_now);
    const hourStart = asDate(time.hour_start);
    const hourReset = asDate(time.hour_reset);
    const dayStart = asDate(time.day_start);
    const dayReset = asDate(time.day_reset);
    const windows = sortedWindows({
      key: input.key,
      hourlyLimit,
      dailyLimit,
      hourStart,
      hourReset,
      dayStart,
      dayReset,
    });

    const counts = new Map<"hour" | "day", number>();
    for (const window of windows) {
      await client.query(
        `INSERT INTO brainstorm_admission_counters
           (admission_key, bucket_kind, bucket_start, count, reset_at)
         VALUES ($1, $2, $3, 0, $4)
         ON CONFLICT (admission_key, bucket_kind, bucket_start) DO NOTHING`,
        [input.key, window.kind, window.start, window.resetAt],
      );
      const locked = await client.query<{ count: number | string }>(
        `SELECT count
           FROM brainstorm_admission_counters
          WHERE admission_key = $1
            AND bucket_kind = $2
            AND bucket_start = $3
          FOR UPDATE`,
        [input.key, window.kind, window.start],
      );
      if (locked.rows.length !== 1) {
        throw new Error("Postgres admission counter lock was not established");
      }
      counts.set(window.kind, finiteCount(locked.rows[0]?.count));
    }

    const hourCount = counts.get("hour");
    const dayCount = counts.get("day");
    if (hourCount === undefined || dayCount === undefined) {
      throw new Error("Postgres admission counter set was incomplete");
    }

    const nextHour = hourCount + weight;
    const nextDay = dayCount + weight;
    const blockedWindow = nextHour > hourlyLimit ? "hour" : nextDay > dailyLimit ? "day" : null;

    if (!blockedWindow) {
      for (const window of windows) {
        const updated = await client.query(
          `UPDATE brainstorm_admission_counters
              SET count = count + $4,
                  updated_at = transaction_timestamp()
            WHERE admission_key = $1
              AND bucket_kind = $2
              AND bucket_start = $3`,
          [input.key, window.kind, window.start, weight],
        );
        if (updated.rowCount !== 1) {
          throw new Error("Postgres admission counter update was not persisted");
        }
      }
    }

    // Bounded retention: current rows plus one prior UTC day cover all active
    // hour/day decisions. The reset_at index makes this idempotent cleanup cheap.
    await client.query(
      `DELETE FROM brainstorm_admission_counters
        WHERE reset_at < $1::timestamptz - interval '1 day'`,
      [dayStart],
    );

    await client.query("COMMIT");
    transactionOpen = false;
    return {
      allowed: blockedWindow === null,
      blockedWindow,
      hourCount: blockedWindow ? hourCount : nextHour,
      dayCount: blockedWindow ? dayCount : nextDay,
      hourResetAtMs: hourReset.getTime(),
      dayResetAtMs: dayReset.getTime(),
      serverNowMs: serverNow.getTime(),
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query("ROLLBACK");
      } catch {
        // The original error remains authoritative.
      }
    }
    throw error;
  } finally {
    client.release();
  }
}
