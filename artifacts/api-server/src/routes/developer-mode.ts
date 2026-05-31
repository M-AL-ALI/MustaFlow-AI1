/**
 * Developer Mode routes
 *
 * GET /projects/:id/developer-mode/runtime-status
 *   Returns a safe diagnostic status table for a Developer Mode project:
 *   env-var presence (boolean, no values), containerId, provisioningStatus,
 *   builderMode, containerStatus, and the result of a live preflight probe.
 */

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

router.get(
  "/projects/:id/developer-mode/runtime-status",
  requireProjectOwnership,
  async (req, res) => {
    const projectId = parseInt(String(req.params.id), 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const [project] = await db
      .select({
        id: projectsTable.id,
        builderMode: projectsTable.builderMode,
        containerId: projectsTable.containerId,
        containerUrl: projectsTable.containerUrl,
        containerStatus: projectsTable.containerStatus,
        provisioningStatus: projectsTable.provisioningStatus,
        provisioningStep: projectsTable.provisioningStep,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const flyApiTokenPresent = !!process.env.FLY_API_TOKEN;
    const neonApiKeyPresent = !!process.env.NEON_API_KEY;

    let preflightOk = false;
    let preflightMessage: string | null = null;

    if (project.containerId) {
      try {
        const { ensureContainerAwake } = await import("../lib/container");
        const result = await ensureContainerAwake(
          project.containerId,
          projectId,
          project.containerUrl ?? null,
          10,
        );
        preflightOk = result.ok;
        preflightMessage = result.message ?? null;
      } catch (err) {
        preflightOk = false;
        preflightMessage = err instanceof Error ? err.message : "Container wake probe failed";
        logger.warn(
          { err, projectId },
          "developer-mode/runtime-status: container wake probe failed",
        );
      }
    } else {
      preflightMessage =
        project.builderMode === "agentic"
          ? "No container provisioned for this project. Provisioning is required before Developer Mode can run."
          : "Project does not use a container (static-legacy).";
    }

    res.json({
      flyApiTokenPresent,
      neonApiKeyPresent,
      builderMode: project.builderMode,
      containerId: project.containerId ?? null,
      provisioningStatus: project.provisioningStatus,
      provisioningStep: project.provisioningStep ?? null,
      containerStatus: project.containerStatus ?? null,
      preflightOk,
      preflightMessage,
    });
  },
);

export default router;
