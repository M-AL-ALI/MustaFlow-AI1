import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, cveFindingsTable } from "@workspace/db";
import type { CveSeverity, CveStatus } from "@workspace/db";
import { logger } from "../lib/logger";
import { runCveAudit } from "../lib/checks/cve-scanner";

const router: IRouter = Router();

/**
 * GET /api/security/cve
 * List stored CVE findings. Optionally filter by status.
 */
router.get("/security/cve", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const statusFilter = req.query.status as string | undefined;

  try {
    const rows = await db
      .select()
      .from(cveFindingsTable)
      .where(statusFilter ? eq(cveFindingsTable.status, statusFilter as CveStatus) : undefined)
      .orderBy(cveFindingsTable.detectedAt);

    res.json(rows);
  } catch (err) {
    logger.error({ err }, "Failed to list CVE findings");
    res.status(500).json({ error: "Failed to list CVE findings" });
  }
});

/**
 * POST /api/security/cve/scan
 * Trigger a fresh npm audit scan, upsert results into DB, return findings.
 */
router.post("/security/cve/scan", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  try {
    const advisories = await runCveAudit();

    // Mark all currently open findings as fixed before inserting fresh results
    await db
      .update(cveFindingsTable)
      .set({ status: "fixed" as CveStatus })
      .where(eq(cveFindingsTable.status, "open" as CveStatus));

    if (advisories.length === 0) {
      res.json({ scanned: true, findings: [], total: 0 });
      return;
    }

    const inserted = await db
      .insert(cveFindingsTable)
      .values(
        advisories.map((a) => ({
          severity: a.severity as CveSeverity,
          packageName: a.packageName,
          currentVersion: a.currentVersion ?? null,
          patchedVersion: a.patchedVersion ?? null,
          cveId: a.cveId ?? null,
          title: a.title,
          advisoryUrl: a.advisoryUrl ?? null,
          status: "open" as CveStatus,
        })),
      )
      .returning();

    res.json({ scanned: true, findings: inserted, total: inserted.length });
  } catch (err) {
    logger.error({ err }, "CVE scan failed");
    res.status(500).json({ error: "CVE scan failed" });
  }
});

/**
 * PATCH /api/security/cve/:id/dismiss
 * Dismiss a specific CVE finding.
 */
router.patch("/security/cve/:id/dismiss", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const findingId = Number(req.params.id);
  if (!Number.isFinite(findingId)) {
    res.status(400).json({ error: "Invalid finding id" });
    return;
  }

  try {
    const [updated] = await db
      .update(cveFindingsTable)
      .set({
        status: "dismissed" as CveStatus,
        dismissedAt: new Date(),
        dismissedBy: req.userId,
      })
      .where(eq(cveFindingsTable.id, findingId))
      .returning();

    if (!updated) {
      res.status(404).json({ error: "Finding not found" });
      return;
    }

    res.json(updated);
  } catch (err) {
    logger.error({ err, findingId }, "Failed to dismiss CVE finding");
    res.status(500).json({ error: "Failed to dismiss finding" });
  }
});

export default router;
