// ─────────────────────────────────────────────────────────────────────────────
// Bandwidth metering routes (Task #624)
//
//   GET  /api/projects/:id/bandwidth          — monthly usage + tier allowances
//   GET  /api/projects/:id/bandwidth/history  — last 12 months
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, gte, desc } from "drizzle-orm";
import { db, projectBandwidthTable, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

// Tier allowances in bytes (monthly)
// These are illustrative values — replace with real billing tier config.
const TIER_ALLOWANCES: Record<string, number> = {
  free: 500 * 1024 * 1024, // 500 MB
  starter: 5 * 1024 * 1024 * 1024, // 5 GB
  pro: 50 * 1024 * 1024 * 1024, // 50 GB
  unlimited: Number.MAX_SAFE_INTEGER,
};

const DEFAULT_TIER_BYTES = TIER_ALLOWANCES.free;

function currentMonth(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

// ── GET /api/projects/:id/bandwidth ──────────────────────────────────────────
router.get("/projects/:id/bandwidth", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const month = currentMonth();

  // Fetch current month row (may not exist yet)
  const [row] = await db
    .select()
    .from(projectBandwidthTable)
    .where(
      and(eq(projectBandwidthTable.projectId, projectId), eq(projectBandwidthTable.month, month)),
    );

  const bytesServed = row?.bytesServed ?? 0;
  const requestCount = row?.requestCount ?? 0;

  // Soft-cap = 80% of tier allowance; hard-cap = 100%
  const tierBytes = DEFAULT_TIER_BYTES;
  const softCapBytes = Math.floor(tierBytes * 0.8);
  const pctUsed = tierBytes > 0 ? (bytesServed / tierBytes) * 100 : 0;
  const atSoftCap = bytesServed >= softCapBytes && bytesServed < tierBytes;
  const atHardCap = bytesServed >= tierBytes;

  res.json({
    month,
    bytesServed,
    requestCount,
    bytesServedFormatted: formatBytes(bytesServed),
    tierBytes,
    tierBytesFormatted: formatBytes(tierBytes),
    pctUsed: Math.min(100, Math.round(pctUsed * 10) / 10),
    atSoftCap,
    atHardCap,
    softCapBytes,
  });
});

// ── GET /api/projects/:id/bandwidth/history ───────────────────────────────────
router.get(
  "/projects/:id/bandwidth/history",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    // Last 12 months
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffMonth = `${cutoff.getUTCFullYear()}-${String(cutoff.getUTCMonth() + 1).padStart(2, "0")}`;

    const rows = await db
      .select()
      .from(projectBandwidthTable)
      .where(
        and(
          eq(projectBandwidthTable.projectId, projectId),
          gte(projectBandwidthTable.month, cutoffMonth),
        ),
      )
      .orderBy(desc(projectBandwidthTable.month))
      .limit(12);

    res.json({
      history: rows.map((r) => ({
        month: r.month,
        bytesServed: r.bytesServed,
        requestCount: r.requestCount,
        bytesServedFormatted: formatBytes(r.bytesServed),
      })),
    });
  },
);

export default router;
