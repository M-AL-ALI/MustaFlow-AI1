/**
 * Developer Mode routes
 *
 * GET /projects/:id/developer-mode/runtime-status
 *   Returns metadata only. Reads never wake or otherwise mutate a runtime.
 *
 * POST /projects/:id/developer-mode/runtime-status/wake
 *   Explicitly wakes and probes the runtime behind the project lifecycle fence.
 */

import { Router, type IRouter } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { hasContainerLayerCredentials } from "../lib/tenant-runtime";
import { logger } from "../lib/logger";
import { requireActiveProjectLifecycleSession } from "../lib/project-lifecycle";

const router: IRouter = Router();

async function readDeveloperRuntimeStatus(projectId: number) {
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
  return project ?? null;
}

function presentDeveloperRuntimeStatus(
  project: NonNullable<Awaited<ReturnType<typeof readDeveloperRuntimeStatus>>>,
  preflight: { ok: boolean | null; message: string | null },
) {
  return {
    flyApiTokenPresent: hasContainerLayerCredentials(),
    neonApiKeyPresent: !!process.env.NEON_API_KEY,
    builderMode: project.builderMode,
    containerId: project.containerId ?? null,
    provisioningStatus: project.provisioningStatus,
    provisioningStep: project.provisioningStep ?? null,
    containerStatus: project.containerStatus ?? null,
    preflightOk: preflight.ok,
    preflightMessage: preflight.message,
  };
}

router.get(
  "/projects/:id/developer-mode/runtime-status",
  requireProjectOwnership,
  async (req, res) => {
    const projectId = parseInt(String(req.params.id), 10);
    if (isNaN(projectId)) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }

    const project = await readDeveloperRuntimeStatus(projectId);

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const message = project.containerId
      ? "Runtime metadata loaded. Use the explicit wake action to run a live preflight."
      : project.builderMode === "agentic"
        ? "No container is provisioned for this project."
        : "This project does not use a container.";
    res.json(presentDeveloperRuntimeStatus(project, { ok: null, message }));
  },
);

router.post(
  "/projects/:id/developer-mode/runtime-status/wake",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    if (!Number.isSafeInteger(projectId) || projectId < 1) {
      res.status(400).json({ error: "Invalid project id" });
      return;
    }
    const project = await readDeveloperRuntimeStatus(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    if (!project.containerId) {
      res.json(
        presentDeveloperRuntimeStatus(project, {
          ok: false,
          message:
            project.builderMode === "agentic"
              ? "No container is provisioned for this project."
              : "This project does not use a container.",
        }),
      );
      return;
    }
    try {
      const { ensureContainerAwake } = await import("../lib/tenant-runtime");
      const result = await ensureContainerAwake(
        project.containerId,
        projectId,
        project.containerUrl ?? null,
        10,
      );
      res.json(
        presentDeveloperRuntimeStatus(project, {
          ok: result.ok,
          message: result.message ?? null,
        }),
      );
    } catch (err) {
      logger.warn({ err, projectId }, "developer-mode/runtime-status wake failed");
      res.status(503).json({
        error: "The preview could not be woken yet. Please try again.",
        code: "preview_wake_unavailable",
      });
    }
  },
);

export default router;
