// ─────────────────────────────────────────────────────────────────────────────
// Usage rollup — Task #558
//
// Aggregates domain_serve_events into workspace_usage_daily rows.
// Called once per day (or on-demand from the usage route) to materialise
// per-workspace bandwidth + request counts.
//
// Hostname storage convention:
//   '' (empty string) = platform traffic with no custom domain
//   Non-empty string  = a specific custom hostname
// The workspace_usage_daily.hostname column is NOT NULL DEFAULT '' so the
// unique index on (workspace_id, date, hostname) deduplicates correctly
// (SQL NULLs are not equal, so a nullable column would allow duplicates).
// ─────────────────────────────────────────────────────────────────────────────

import { sql, eq, and, gte, lte, isNull } from "drizzle-orm";
import { db, workspaceUsageDailyTable } from "@workspace/db";
import { logger } from "./logger";

export interface DailyUsageRow {
  workspaceId: number;
  date: string;
  hostname: string;
  requestCount: number;
  bandwidthBytes: number;
}

/**
 * Aggregate domain_serve_events for a given date range into workspace_usage_daily.
 *
 * IDEMPOTENCY: We delete existing rows for each affected (workspace, date, hostname)
 * combination before re-inserting fresh absolute counts. Repeated calls for the
 * same period always produce the same result — no accumulation of stale counts.
 *
 * @param fromDate inclusive start date, ISO YYYY-MM-DD
 * @param toDate   inclusive end date, ISO YYYY-MM-DD (default = today)
 */
export async function rollupUsage(fromDate: string, toDate?: string): Promise<number> {
  const to = toDate ?? new Date().toISOString().slice(0, 10);

  // 1. Compute fresh absolute counts from domain_serve_events.
  //    COALESCE(hostname, '') normalises NULL source hostnames → '' so every
  //    row has a non-empty string key, matching the NOT NULL DB column.
  const rows = await db.execute<{
    workspace_id: number;
    date: string;
    hostname: string;
    request_count: number;
  }>(sql`
    SELECT
      p.workspace_id,
      DATE(e.ts AT TIME ZONE 'UTC')::text        AS date,
      COALESCE(e.hostname, '')                    AS hostname,
      COUNT(*)::bigint                            AS request_count
    FROM domain_serve_events e
    JOIN projects p ON p.id = e.project_id
    WHERE p.workspace_id IS NOT NULL
      AND DATE(e.ts AT TIME ZONE 'UTC') >= ${fromDate}::date
      AND DATE(e.ts AT TIME ZONE 'UTC') <= ${to}::date
    GROUP BY p.workspace_id, DATE(e.ts AT TIME ZONE 'UTC'), COALESCE(e.hostname, '')
  `);

  if (rows.rows.length === 0) {
    logger.info({ fromDate, to, rowsAggregated: 0 }, "Usage rollup — no events in range");
    return 0;
  }

  // 2. Delete existing rows for the affected (workspace, date, hostname) combinations
  //    so the re-insert is a clean replacement, not an accumulation.
  //    We delete per-row (not the whole date range) to avoid wiping rows that
  //    belong to workspaces not present in this batch.
  const deletePromises = rows.rows.map((row) =>
    db.execute(sql`
      DELETE FROM workspace_usage_daily
      WHERE workspace_id = ${Number(row.workspace_id)}
        AND date = ${row.date}::date
        AND hostname = ${row.hostname}
    `),
  );
  await Promise.all(deletePromises);

  // 3. Insert fresh absolute values.
  //    bandwidth_bytes: domain_serve_events has no bytes column yet (requires task #645).
  //    Stored as 0 until that follow-up adds bytes_served to the table.
  const insertValues = rows.rows.map((row) => ({
    workspaceId: Number(row.workspace_id),
    date: row.date,
    hostname: row.hostname, // always a string (never null) — see COALESCE above
    requestCount: Number(row.request_count),
    bandwidthBytes: 0,
  }));

  await db.insert(workspaceUsageDailyTable).values(insertValues);

  logger.info({ fromDate, to, rowsAggregated: rows.rows.length }, "Usage rollup complete");
  return rows.rows.length;
}

/**
 * Query the rolled-up daily usage for a single workspace, optionally for a
 * given month (YYYY-MM format). Returns rows grouped by date and hostname.
 */
export async function getWorkspaceUsage(
  workspaceId: number,
  month?: string,
): Promise<DailyUsageRow[]> {
  const monthStr = month ?? new Date().toISOString().slice(0, 7); // YYYY-MM
  const fromDate = `${monthStr}-01`;
  const toDate = new Date(
    new Date(`${monthStr}-01`).getFullYear(),
    new Date(`${monthStr}-01`).getMonth() + 1,
    0,
  )
    .toISOString()
    .slice(0, 10);

  const rows = await db
    .select()
    .from(workspaceUsageDailyTable)
    .where(
      and(
        eq(workspaceUsageDailyTable.workspaceId, workspaceId),
        gte(workspaceUsageDailyTable.date, fromDate),
        lte(workspaceUsageDailyTable.date, toDate),
      ),
    );

  return rows.map((r) => ({
    workspaceId: r.workspaceId,
    date: String(r.date),
    hostname: r.hostname, // string, never null
    requestCount: Number(r.requestCount),
    bandwidthBytes: Number(r.bandwidthBytes),
  }));
}

/**
 * Report unreported bandwidth overages to Stripe metered billing.
 * Marks rows as reported by setting stripe_meter_reported_at = now().
 * No-op when:
 *   - Stripe is not configured
 *   - STRIPE_BANDWIDTH_OVERAGE_PRICE_ID is not set
 *   - All bandwidth_bytes values are 0 (byte tracking not yet enabled — task #645)
 *   - Stripe SDK predates the meterEvents API
 *
 * Called from GET /workspaces/:id/usage after the monthly rollup so every
 * page view for the current month triggers a lazy reporting pass.
 */
export async function reportBandwidthOverageToStripe(workspaceId: number): Promise<void> {
  try {
    const { getUncachableStripeClient } = await import("./stripeClient");
    const stripe = await getUncachableStripeClient();
    if (!stripe) return;

    const STRIPE_BANDWIDTH_PRICE_ID = process.env.STRIPE_BANDWIDTH_OVERAGE_PRICE_ID;
    if (!STRIPE_BANDWIDTH_PRICE_ID) {
      logger.debug("STRIPE_BANDWIDTH_OVERAGE_PRICE_ID not set — skipping metered billing report");
      return;
    }

    const unreported = await db
      .select()
      .from(workspaceUsageDailyTable)
      .where(
        and(
          eq(workspaceUsageDailyTable.workspaceId, workspaceId),
          isNull(workspaceUsageDailyTable.stripeMeterReportedAt),
        ),
      );

    if (unreported.length === 0) return;

    const totalBytes = unreported.reduce((sum, r) => sum + Number(r.bandwidthBytes), 0);

    // Skip when all bandwidth is zero — byte tracking not yet enabled (task #645).
    // Avoids sending zero-value events to Stripe.
    if (totalBytes <= 0) {
      logger.debug(
        { workspaceId },
        "Bandwidth rollup shows 0 bytes — skipping Stripe report (byte tracking not yet enabled)",
      );
      return;
    }

    // Report as metered usage (quantity = MB rounded up for Stripe meter precision)
    const quantityMb = Math.ceil(totalBytes / (1024 * 1024));

    // stripe.billing.meterEvents.create is the Stripe Billing v2 meters API method.
    // We cast via `as unknown` because the Stripe SDK typings vary by version.
    type MeterEventsApi = {
      create: (params: { event_name: string; payload: Record<string, string> }) => Promise<unknown>;
    };
    const meterApi = (stripe.billing as unknown as { meterEvents?: MeterEventsApi }).meterEvents;
    if (meterApi?.create) {
      await meterApi.create({
        event_name: "bandwidth_gb",
        payload: {
          value: String(quantityMb),
          stripe_customer_id: `workspace_${workspaceId}`,
        },
      });
    } else {
      logger.warn("Stripe billing.meterEvents.create not available in this SDK version — skipping");
    }

    // Mark all reported rows
    for (const row of unreported) {
      await db
        .update(workspaceUsageDailyTable)
        .set({ stripeMeterReportedAt: new Date(), updatedAt: new Date() })
        .where(eq(workspaceUsageDailyTable.id, row.id));
    }

    logger.info(
      { workspaceId, quantityMb, rowsReported: unreported.length },
      "Bandwidth overage reported to Stripe",
    );
  } catch (err) {
    logger.warn({ err, workspaceId }, "Stripe bandwidth reporting failed (non-fatal)");
  }
}
