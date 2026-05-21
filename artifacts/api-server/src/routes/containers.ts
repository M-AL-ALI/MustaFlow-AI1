/**
 * Container lifecycle routes.
 *
 * POST /api/projects/:id/container/start   — provision or wake the container
 * POST /api/projects/:id/container/stop    — hibernate the container
 * GET  /api/projects/:id/container/status  — get current container status
 * GET  /api/projects/:id/container/logs    — get recent container log lines
 * POST /api/projects/:id/container/exec    — run a command in the container (AI use)
 * DELETE /api/projects/:id/container       — destroy the container permanently
 */

import { Router, type IRouter } from "express";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  db,
  projectsTable,
  projectFilesTable,
  containerLogsTable,
  secretsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import {
  provisionContainer,
  hibernateContainer,
  getContainerStatus,
  execInContainer,
  destroyContainer,
  deployProductionContainer,
} from "../lib/container";
import { encryptionService } from "../lib/encryption";
import { logger } from "../lib/logger";

const router: IRouter = Router();

/** Load the project or return 404. */
async function loadProject(projectId: number, _userId?: string) {
  const [project] = await db
    .select()
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  return project ?? null;
}

/** Load all project files as { path, content } pairs. */
async function loadProjectFiles(projectId: number) {
  const rows = await db
    .select({ path: projectFilesTable.path, content: projectFilesTable.content })
    .from(projectFilesTable)
    .where(eq(projectFilesTable.projectId, projectId));
  return rows;
}

/**
 * Load all project secrets and return them as a plain { KEY: value } map
 * suitable for injecting into a container's environment.
 * Decryption errors for individual secrets are caught and skipped (best-effort).
 */
async function loadProjectSecretsAsEnv(projectId: number): Promise<Record<string, string>> {
  const rows = await db
    .select({ name: secretsTable.name, valueEncrypted: secretsTable.valueEncrypted })
    .from(secretsTable)
    .where(eq(secretsTable.projectId, projectId));

  const env: Record<string, string> = {};
  for (const row of rows) {
    try {
      env[row.name] = encryptionService.decrypt(row.valueEncrypted);
    } catch {
      // skip secrets that can't be decrypted rather than aborting the whole start
    }
  }
  return env;
}

// ── GET /api/projects/:id/container/status ───────────────────────────────────
router.get(
  "/projects/:id/container/status",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // If we have a machine ID, refresh from Fly
    let status = project.containerStatus as string;
    if (project.containerId && (status === "running" || status === "starting")) {
      const live = await getContainerStatus(project.containerId);
      if (live !== status) {
        await db
          .update(projectsTable)
          .set({ containerStatus: live })
          .where(eq(projectsTable.id, projectId));
        status = live;
      }
    }

    res.json({
      containerId: project.containerId ?? null,
      containerStatus: status,
      containerUrl: project.containerUrl ?? null,
    });
  },
);

// ── POST /api/projects/:id/container/start ───────────────────────────────────
router.post(
  "/projects/:id/container/start",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.containerStatus === "running") {
      res.json({
        containerId: project.containerId,
        containerStatus: "running",
        containerUrl: project.containerUrl,
      });
      return;
    }

    req.log.info({ projectId }, "Provisioning container");

    // Load project files and decrypted secrets in parallel
    const [files, envVars] = await Promise.all([
      loadProjectFiles(projectId),
      loadProjectSecretsAsEnv(projectId),
    ]);

    req.log.info(
      { projectId, secretCount: Object.keys(envVars).length },
      "Injecting project secrets into container env",
    );

    // Start container in background — respond immediately with "starting"
    res.json({
      containerId: project.containerId ?? null,
      containerStatus: "starting",
      containerUrl: project.containerUrl ?? null,
    });

    // Provision asynchronously (don't await — client will poll /status)
    setImmediate(() => {
      provisionContainer(projectId, files, envVars).catch((err: unknown) => {
        logger.error({ err, projectId }, "Container provisioning failed");
      });
    });
  },
);

// ── POST /api/projects/:id/container/stop ────────────────────────────────────
router.post(
  "/projects/:id/container/stop",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    await hibernateContainer(projectId);
    res.json({ containerStatus: "hibernated" });
  },
);

// ── GET /api/projects/:id/container/logs ─────────────────────────────────────
router.get(
  "/projects/:id/container/logs",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const limit = Math.min(Number(req.query.limit ?? 200), 500);

    const rows = await db
      .select({
        id: containerLogsTable.id,
        level: containerLogsTable.level,
        message: containerLogsTable.message,
        createdAt: containerLogsTable.createdAt,
      })
      .from(containerLogsTable)
      .where(eq(containerLogsTable.projectId, projectId))
      .orderBy(desc(containerLogsTable.createdAt))
      .limit(limit);

    res.json(rows.reverse());
  },
);

// ── POST /api/projects/:id/container/exec ────────────────────────────────────
// Run a shell command inside the container. Used by the AI build pipeline
// and can be called by power users who know what they're doing.
router.post(
  "/projects/:id/container/exec",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!project.containerId || project.containerStatus !== "running") {
      res.status(409).json({ error: "Container is not running" });
      return;
    }

    const { command, workdir } = req.body as {
      command?: unknown;
      workdir?: unknown;
    };

    if (!Array.isArray(command) || command.length === 0) {
      res.status(400).json({ error: "command must be a non-empty string array" });
      return;
    }

    const cmd = command.map(String);
    const cwd = typeof workdir === "string" ? workdir : "/app";

    const result = await execInContainer(project.containerId, cmd, projectId, cwd);
    res.json(result);
  },
);

// ── POST /api/projects/:id/container/publish ─────────────────────────────────
// Deploy a production container replica for this project.
// This is called automatically by the publish route when a dev container exists.
// It can also be called manually to (re-)deploy the production container without
// going through the full publish flow (useful for ops / debugging).
router.post(
  "/projects/:id/container/publish",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!project.containerId) {
      res.status(409).json({ error: "Project does not have a dev container. Start one first." });
      return;
    }

    req.log.info({ projectId }, "Deploying production container");

    const files = await loadProjectFiles(projectId);

    // Load secrets for env injection
    const secretRows = await db
      .select({ name: secretsTable.name, valueEncrypted: secretsTable.valueEncrypted })
      .from(secretsTable)
      .where(eq(secretsTable.projectId, projectId));

    const envVars: Record<string, string> = {
      PROJECT_ID: String(projectId),
      NODE_ENV: "production",
      PORT: "3000",
    };
    for (const s of secretRows) {
      try {
        envVars[s.name] = encryptionService.decrypt(s.valueEncrypted);
      } catch {
        // skip malformed secrets
      }
    }

    const result = await deployProductionContainer(
      projectId,
      project.prodContainerId ?? null,
      files,
      envVars,
    );

    if (!result) {
      res.status(500).json({
        error: "Production container deploy failed. Check container logs for details.",
      });
      return;
    }

    // Persist new prod container info
    await db
      .update(projectsTable)
      .set({
        prodContainerId: result.prodContainerId,
        prodContainerUrl: result.containerUrl,
        prodContainerStatus: result.status,
      })
      .where(eq(projectsTable.id, projectId));

    res.json({
      ok: true,
      containerId: result.prodContainerId,
      containerUrl: result.containerUrl,
      note: "Production container deployed. Public URL now proxies to this container.",
    });
  },
);

// ── POST /api/projects/:id/container/unpublish ───────────────────────────────
// Stop and destroy the production container for this project.
router.post(
  "/projects/:id/container/unpublish",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.prodContainerId) {
      await destroyContainer(project.prodContainerId, projectId);
      await db
        .update(projectsTable)
        .set({ prodContainerId: null, prodContainerUrl: null, prodContainerStatus: "stopped" })
        .where(eq(projectsTable.id, projectId));
    }
    res.json({ ok: true, note: "Production container stopped and destroyed." });
  },
);

// ── DELETE /api/projects/:id/container ───────────────────────────────────────
// Permanently destroys the container machine. Use with caution.
router.delete(
  "/projects/:id/container",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.containerId) {
      await destroyContainer(project.containerId, projectId);
    }

    await db
      .update(projectsTable)
      .set({ containerId: null, containerStatus: "stopped", containerUrl: null })
      .where(eq(projectsTable.id, projectId));

    res.json({ destroyed: true });
  },
);

export default router;
