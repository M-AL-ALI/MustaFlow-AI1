// ─────────────────────────────────────────────────────────────────────────────
// Deployment history routes
//
//   GET /api/projects/:id/deployments          — last 50 deployment log entries
//   GET /api/projects/:id/deployments/domain-status — live domain+SSL status
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, deploymentLogsTable, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

// ── GET /api/projects/:id/deployments ────────────────────────────────────────
router.get(
  "/projects/:id/deployments",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const rows = await db
      .select()
      .from(deploymentLogsTable)
      .where(eq(deploymentLogsTable.projectId, projectId))
      .orderBy(desc(deploymentLogsTable.createdAt))
      .limit(50);

    res.json({ deployments: rows });
  },
);

// ── GET /api/projects/:id/deployments/domain-status ──────────────────────────
// Returns the current domain verification + SSL status for a project.
// Clients poll this at ~15 s intervals after adding a custom domain.
router.get(
  "/projects/:id/deployments/domain-status",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isFinite(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const [project] = await db
      .select({
        domainStatus: projectsTable.domainStatus,
        sslStatus: projectsTable.sslStatus,
        customDomain: projectsTable.customDomain,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // Map internal domain_status values to the verificationStatus field the panel expects
    const verificationStatus =
      project.domainStatus === "active"
        ? "verified"
        : project.domainStatus === "pending_verification"
          ? "pending"
          : project.domainStatus === "unconfigured"
            ? "not_configured"
            : project.domainStatus; // error → pass through

    res.json({
      verificationStatus,
      sslStatus: project.sslStatus,
      customDomain: project.customDomain,
    });
  },
);

export default router;
