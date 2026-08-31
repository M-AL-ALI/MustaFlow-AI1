// ─────────────────────────────────────────────────────────────────────────────
// EAS Build routes — mobile app cloud builds via Expo Application Services
//
//   POST /api/projects/:id/builds          — trigger an EAS build (5 credits, deducted at queue time)
//   GET  /api/projects/:id/builds          — list builds (deployment logs with platform=ios|android)
//   GET  /api/projects/:id/builds/:buildLogId — single build status
//   GET  /api/projects/:id/builds/:buildLogId/logs — proxied EAS log chunk
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, and, inArray, desc, isNull } from "drizzle-orm";
import { db, projectsTable, deploymentLogsTable, secretsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { encryptionService } from "../lib/encryption";
import { getOrCreateCredits, deductCreditsAtomic, CREDITS_ENFORCEMENT_ENABLED } from "./credits";
import { isBillingPrivileged } from "../lib/billing-privileges";
import { logger } from "../lib/logger";
import { getEasBuildLogs } from "../lib/eas";
import { enqueueEasJob, EAS_BUILD_CREDIT_COST, extractAppJsonSummary } from "../lib/jobs";
import { requireActiveProjectLifecycleSession } from "../lib/project-lifecycle";

const router: IRouter = Router();

// ── Helper: read a secret value for a project (decrypted) ────────────────────
async function getProjectSecret(projectId: number, name: string): Promise<string | null> {
  const [row] = await db
    .select()
    .from(secretsTable)
    .where(and(eq(secretsTable.projectId, projectId), eq(secretsTable.name, name)));
  if (!row) return null;
  try {
    return encryptionService.decrypt(row.valueEncrypted);
  } catch {
    return null;
  }
}

// ── POST /api/projects/:id/builds ─────────────────────────────────────────────
router.post(
  "/projects/:id/builds",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const { platform } = req.body as { platform?: string };

    if (platform !== "ios" && platform !== "android") {
      res.status(400).json({ error: "platform must be 'ios' or 'android'" });
      return;
    }

    // Load project
    const [project] = await db
      .select()
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Check project is mobile
    const isMobile = ["mobile-ios", "mobile-android", "mobile-cross"].includes(project.kind);
    if (!isMobile) {
      res.status(400).json({ error: "EAS builds are only available for mobile projects." });
      return;
    }

    const userId = req.userId ?? "unknown";

    // Read EAS credentials before touching credits
    const accessToken = await getProjectSecret(projectId, "EAS_ACCESS_TOKEN");
    if (!accessToken) {
      res.status(422).json({
        error:
          "EAS_ACCESS_TOKEN is not configured. Add it to the project Secrets tab to enable EAS builds.",
      });
      return;
    }

    // Credit pre-flight check
    if (project.ownerId) {
      // NabuFlow billing gate (Task #1516): EAS builds are charged builds, so
      // they pass the same plan/card/cap/dunning resolver as the pipeline. EAS
      // runs aren't engine-mode builds, so the mode ladder doesn't apply.
      const { nabuflowGateHttpError, nabuflowChargeActive } =
        await import("../lib/nabuflow-billing");
      const gateErr = await nabuflowGateHttpError(project.ownerId, {
        engineMode: null,
        deepReasoning: false,
        projectedCredits: EAS_BUILD_CREDIT_COST,
        source: "eas",
      });
      if (gateErr) {
        res.status(gateErr.status).json(gateErr.body);
        return;
      }

      const credits = await getOrCreateCredits(project.ownerId);
      const ownerIsBillingPrivileged = await isBillingPrivileged(project.ownerId);
      if (
        CREDITS_ENFORCEMENT_ENABLED &&
        !ownerIsBillingPrivileged &&
        !(await nabuflowChargeActive(project.ownerId)) &&
        credits.balance < EAS_BUILD_CREDIT_COST
      ) {
        res.status(402).json({
          error: `Insufficient credits. An EAS build costs ${EAS_BUILD_CREDIT_COST} credits but your balance is ${credits.balance}. Top up in Billing to continue.`,
        });
        return;
      }
    }

    // Derive app slug / owner from project secrets or project metadata
    const appSlug =
      (await getProjectSecret(projectId, "EXPO_APP_SLUG")) ??
      project.name
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-")
        .replace(/^-+|-+$/g, "");
    const appOwner = (await getProjectSecret(projectId, "EXPO_ACCOUNT_NAME")) ?? userId;

    // Extract app.json summary from project files (for logging / knowledge vault context)
    const appJsonSummary = await extractAppJsonSummary(projectId);

    // Deduct credits immediately (at queue time, not post-success)
    if (project.ownerId) {
      try {
        const debit = await deductCreditsAtomic(userId, EAS_BUILD_CREDIT_COST, {
          type: "build",
          description: `EAS ${platform} build queued — project ${projectId}`,
          projectId,
          source: "eas",
        });
        if ("insufficient" in debit) {
          res.status(402).json({
            error: `Insufficient credits. An EAS build costs ${EAS_BUILD_CREDIT_COST} credits but your balance is ${debit.balance}. Top up in Billing to continue.`,
          });
          return;
        }
      } catch (creditErr) {
        logger.warn({ creditErr }, "Credit deduction failed at queue time");
        res.status(402).json({ error: "Credit deduction failed. Check your balance." });
        return;
      }
    }

    // Create deployment log entry
    const [deployLog] = await db
      .insert(deploymentLogsTable)
      .values({
        projectId,
        userId,
        env: platform,
        status: "queued",
        platform,
        note: `EAS ${platform} build queued`,
      })
      .returning();

    if (!deployLog) {
      res.status(500).json({ error: "Failed to create build record" });
      return;
    }

    // Enqueue the EAS job (background — does not block HTTP response)
    enqueueEasJob({
      deploymentLogId: deployLog.id,
      projectId,
      userId,
      platform: platform as "ios" | "android",
      accessToken,
      appSlug,
      appOwner,
      appJsonSummary,
    });

    logger.info({ projectId, platform, deploymentLogId: deployLog.id }, "EAS build job enqueued");

    res.status(202).json({
      ok: true,
      buildLogId: deployLog.id,
      platform,
      status: "queued",
      note: `EAS ${platform} build queued. Poll GET /api/projects/${projectId}/builds/${deployLog.id} for status.`,
    });
  },
);

// ── GET /api/projects/:id/builds ──────────────────────────────────────────────
router.get("/projects/:id/builds", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const rows = await db
    .select()
    .from(deploymentLogsTable)
    .where(
      and(
        eq(deploymentLogsTable.projectId, projectId),
        inArray(deploymentLogsTable.env, ["ios", "android"]),
      ),
    )
    .orderBy(desc(deploymentLogsTable.createdAt))
    .limit(50);

  res.json({ builds: rows });
});

// ── GET /api/projects/:id/builds/:buildLogId ──────────────────────────────────
router.get(
  "/projects/:id/builds/:buildLogId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const buildLogId = Number(req.params.buildLogId);

    if (!Number.isFinite(projectId) || !Number.isFinite(buildLogId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [row] = await db
      .select()
      .from(deploymentLogsTable)
      .where(
        and(eq(deploymentLogsTable.id, buildLogId), eq(deploymentLogsTable.projectId, projectId)),
      );

    if (!row) {
      res.status(404).json({ error: "Build not found" });
      return;
    }

    res.json(row);
  },
);

// ── GET /api/projects/:id/builds/:buildLogId/logs ─────────────────────────────
router.get(
  "/projects/:id/builds/:buildLogId/logs",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const buildLogId = Number(req.params.buildLogId);

    if (!Number.isFinite(projectId) || !Number.isFinite(buildLogId)) {
      res.status(400).json({ error: "Invalid id" });
      return;
    }

    const [row] = await db
      .select()
      .from(deploymentLogsTable)
      .where(
        and(eq(deploymentLogsTable.id, buildLogId), eq(deploymentLogsTable.projectId, projectId)),
      );

    if (!row || !row.buildId) {
      res.json({
        logs: "",
        status: row?.status ?? "unknown",
        note: row?.note ?? null,
      });
      return;
    }

    const accessToken = await getProjectSecret(projectId, "EAS_ACCESS_TOKEN");
    if (!accessToken) {
      res.json({
        logs: "",
        status: row.status,
        note: "EAS_ACCESS_TOKEN not configured — cannot fetch live logs.",
      });
      return;
    }

    const logs = await getEasBuildLogs(accessToken, row.buildId);

    res.json({
      buildId: row.buildId,
      status: row.status,
      platform: row.platform,
      downloadUrl: row.downloadUrl,
      testflightUrl: row.testflightUrl,
      note: row.note,
      logs,
    });
  },
);

export default router;
