/**
 * Wave 2B — Ora Monitoring + Admin Visibility
 *
 * GET /api/admin/ora/monitoring
 *
 * Returns a real-time operational snapshot of the Ora public-AI subsystem:
 *   - Kill switch status for every feature
 *   - Live in-memory spend counters (from the spend-cap module)
 *   - DB-backed spend summary for today's UTC date
 *   - Provider circuit-breaker health
 *
 * Access: admin only (requireAdmin middleware).
 * Privacy: returns no raw prompts, user text, file contents, secrets, or
 * stack traces. User IDs are never included — only aggregated counts.
 * No Builder/handoff language appears anywhere in this module.
 */

import { Router, type IRouter } from "express";
import { requireAdmin } from "../lib/adminAuth";
import { logger } from "../lib/logger";
import { isKillSwitchActive, type OraFeature } from "../lib/public-ai/ora-kill-switches";
import {
  getSpendCapSnapshot,
  FEATURE_UNITS,
  type OraFeatureKind,
} from "../lib/public-ai/ora-spend-cap";
import { getOraProviderRoutingSnapshot } from "../lib/public-ai/model-router";
import { pool } from "@workspace/db";

const router: IRouter = Router();

// All routes in this file require admin RBAC.
router.use("/admin/ora/monitoring", requireAdmin);

// ── Kill switch helpers ────────────────────────────────────────────────────────

const ORA_FEATURES: OraFeature[] = [
  "all",
  "streaming",
  "file_upload",
  "file_analysis",
  "dataset_analysis",
  "image_analysis",
  "file_generation",
  "tts",
  "transcribe",
  "web_search",
];

function buildKillSwitchStatus(): Record<OraFeature, boolean> {
  return Object.fromEntries(ORA_FEATURES.map((f) => [f, isKillSwitchActive(f)])) as Record<
    OraFeature,
    boolean
  >;
}

// ── DB spend query ─────────────────────────────────────────────────────────────

interface DbSpendSummary {
  available: boolean;
  dateKey: string;
  globalUnits: number;
  featureBreakdown: Array<{ feature: OraFeatureKind; units: number }>;
  uniqueUserCount: number;
  uniqueIpCount: number;
  error?: string;
}

async function queryDbSpendSummary(dateKey: string): Promise<DbSpendSummary> {
  const client = await pool.connect().catch(() => null);
  if (!client) {
    return {
      available: false,
      dateKey,
      globalUnits: 0,
      featureBreakdown: [],
      uniqueUserCount: 0,
      uniqueIpCount: 0,
      error: "db_connect_failed",
    };
  }

  try {
    const { rows } = await client.query<{ ledger_key: string; units: number }>(
      `SELECT ledger_key, units
         FROM ora_spend_ledger
        WHERE date_key = $1
        ORDER BY units DESC`,
      [dateKey],
    );

    let globalUnits = 0;
    let uniqueUserCount = 0;
    let uniqueIpCount = 0;
    const featureMap = new Map<OraFeatureKind, number>();

    for (const row of rows) {
      const { ledger_key: key, units } = row;
      if (key === "global") {
        globalUnits = units;
      } else if (key.startsWith("user:")) {
        uniqueUserCount++;
      } else if (key.startsWith("ip:")) {
        uniqueIpCount++;
      } else if (key.startsWith("feature:")) {
        const feat = key.slice(8) as OraFeatureKind;
        if (feat in FEATURE_UNITS) {
          featureMap.set(feat, units);
        }
      }
    }

    const featureBreakdown = Array.from(featureMap.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([feature, units]) => ({ feature, units }));

    return {
      available: true,
      dateKey,
      globalUnits,
      featureBreakdown,
      uniqueUserCount,
      uniqueIpCount,
    };
  } catch (err) {
    logger.warn({ err, event: "ora_monitoring_db_query_failed" }, "Ora monitoring DB query failed");
    return {
      available: false,
      dateKey,
      globalUnits: 0,
      featureBreakdown: [],
      uniqueUserCount: 0,
      uniqueIpCount: 0,
      error: "db_query_failed",
    };
  } finally {
    client.release();
  }
}

// ── GET /api/admin/ora/monitoring ──────────────────────────────────────────────

router.get("/admin/ora/monitoring", async (_req, res): Promise<void> => {
  try {
    const asOf = new Date().toISOString();

    // Live in-memory spend snapshot.
    const spendSnapshot = getSpendCapSnapshot();
    const globalPct =
      spendSnapshot.globalCap > 0
        ? Math.round((spendSnapshot.globalUnits / spendSnapshot.globalCap) * 100)
        : 0;

    const spend = {
      dateKey: spendSnapshot.dateKey,
      globalUnits: spendSnapshot.globalUnits,
      globalCap: spendSnapshot.globalCap,
      globalPct,
      userCap: spendSnapshot.userCap,
      anonIpCap: spendSnapshot.anonIpCap,
      byFeature: spendSnapshot.featureUnits,
      ledgerActive: spendSnapshot.ledgerActive,
      periodicSyncActive: spendSnapshot.periodicSyncActive,
    };

    // DB-backed spend summary for today.
    const dbSpend = await queryDbSpendSummary(spendSnapshot.dateKey);

    // Kill switch states.
    const killSwitches = buildKillSwitchStatus();

    // Provider circuit-breaker health.
    const routingSnapshot = getOraProviderRoutingSnapshot();
    const providerHealth = {
      openCircuits: Array.from(routingSnapshot.openCircuits),
      available: routingSnapshot.available,
    };

    res.json({
      ok: true,
      asOf,
      killSwitches,
      spend,
      dbSpend,
      providerHealth,
    });
  } catch (err) {
    logger.error({ err, event: "ora_monitoring_failed" }, "Ora monitoring endpoint error");
    res.status(500).json({ error: "ora_monitoring_failed" });
  }
});

export default router;
