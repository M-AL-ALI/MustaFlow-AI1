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
import { db, projectsTable, projectFilesTable, containerLogsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import {
  provisionContainer,
  hibernateContainer,
  getContainerStatus,
  execInContainer,
  destroyContainer,
  recordContainerLog,
  tenantRuntimeProvider,
} from "../lib/tenant-runtime";
import { subscribeContainerLogs, type ContainerLogPayload } from "../lib/event-bus";
import { getContainerSecretMap } from "../lib/container-secrets";
import { logger } from "../lib/logger";
import { deriveConfiguredPreviewAccess } from "../lib/preview-access";
import {
  resumeAcceptedProjectPreview,
  SealedPreviewResumeError,
} from "../lib/sealed-preview-resume";
import {
  isZeroSealedGenerationTarget,
  resolveZeroGenerationTarget,
} from "../lib/zero-sealed-generation";
import { CloudflareRuntimeControlError } from "../lib/cloudflare-runtime-provider";
import {
  requireActiveProjectLifecycleSession,
  withActiveProjectLifecycle,
} from "../lib/project-lifecycle";

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
 * Load project secrets scoped to development + testing as a plain { KEY: value } map.
 * Only development and testing secrets are injected into the dev container —
 * production and staging secrets must never reach a dev container.
 * Decryption errors for individual secrets are caught and skipped (best-effort).
 *
 * @param previewOnly — when true, only injects secrets where is_preview_safe = true.
 *   Use this for the draft preview container so production secrets are never
 *   automatically exposed in the development preview environment.
 */
async function loadProjectSecretsAsEnv(
  projectId: number,
  _previewOnly = false,
): Promise<Record<string, string>> {
  // Task #767: always restrict to dev+testing environments via getContainerSecretMap.
  // This subsumes the is_preview_safe filter — environment scoping is the authoritative
  // security boundary for the dev container.
  return getContainerSecretMap(projectId);
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

    // Observe the provider without mutating durable project state. Reads never write;
    // reconciliation belongs behind an explicit mutation path.
    let status = project.containerStatus as string;
    if (project.containerId && (status === "running" || status === "starting")) {
      const live = await getContainerStatus(project.containerId);
      status = live;
    }

    res.json({
      containerId: project.containerId ?? null,
      containerStatus: status,
      containerUrl: project.containerUrl ?? null,
      previewAccess: deriveConfiguredPreviewAccess(
        {
          runtimeId: project.containerId,
          runtimeStatus: status,
        },
        tenantRuntimeProvider.providerId,
      ),
    });
  },
);

// ── POST /api/projects/:id/container/start ───────────────────────────────────
router.post(
  "/projects/:id/container/start",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    // A Cloudflare sandbox can remain provider-running after its tenant process
    // exits. An explicit wake is a governed mutation, so replay the exact accepted
    // sealed release instead of treating the provider label as app readiness.
    if (isZeroSealedGenerationTarget(resolveZeroGenerationTarget(process.env))) {
      try {
        const runtime = await resumeAcceptedProjectPreview({
          projectId,
          provider: tenantRuntimeProvider,
        });
        await db
          .update(projectsTable)
          .set({
            containerId: runtime.identity,
            containerStatus: runtime.status,
            containerUrl: runtime.endpoint,
          })
          .where(eq(projectsTable.id, projectId));
        res.json({
          containerId: runtime.identity,
          containerStatus: runtime.status,
          containerUrl: runtime.endpoint,
          previewAccess: deriveConfiguredPreviewAccess(
            { runtimeId: runtime.identity, runtimeStatus: runtime.status },
            tenantRuntimeProvider.providerId,
          ),
        });
        return;
      } catch (error) {
        const missingRelease =
          error instanceof SealedPreviewResumeError &&
          error.code === "sealed_preview_release_missing";
        const providerFailure =
          error instanceof CloudflareRuntimeControlError
            ? {
                class: error.name,
                status: error.status,
                code: error.code,
                retryable: error.retryable,
                transportCause: error.transportCause,
              }
            : null;
        req.log.warn(
          {
            projectId,
            code: error instanceof SealedPreviewResumeError ? error.code : "preview_resume_failed",
            providerFailure,
          },
          "Sealed preview resume failed",
        );
        res.status(missingRelease ? 409 : 503).json({
          error: missingRelease
            ? "This preview needs a fresh build before it can be opened."
            : "The preview could not be woken yet. Please try again.",
          code: missingRelease ? "preview_rebuild_required" : "preview_resume_unavailable",
        });
        return;
      }
    }

    if (project.containerStatus === "running" && project.containerId) {
      try {
        const liveStatus = await getContainerStatus(project.containerId);
        if (liveStatus === "running") {
          res.json({
            containerId: project.containerId,
            containerStatus: "running",
            containerUrl: project.containerUrl,
            previewAccess: deriveConfiguredPreviewAccess(
              {
                runtimeId: project.containerId,
                runtimeStatus: "running",
              },
              tenantRuntimeProvider.providerId,
            ),
          });
          return;
        }
      } catch (error) {
        logger.warn({ error, projectId }, "Preview runtime status check failed before wake");
        res.status(503).json({
          error: "We could not check the preview just now. Please try again.",
          code: "preview_status_unavailable",
        });
        return;
      }
    }

    req.log.info({ projectId }, "Provisioning container");

    // Load project files and decrypted secrets in parallel.
    // previewOnly=true: only inject secrets marked is_preview_safe so that production
    // secrets (API keys, payment credentials) are never automatically exposed in the
    // development preview container.
    const [files, envVars] = await Promise.all([
      loadProjectFiles(projectId),
      loadProjectSecretsAsEnv(projectId, true),
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
      previewAccess: "unavailable",
    });

    // Provision asynchronously (don't await — client will poll /status)
    setImmediate(() => {
      void withActiveProjectLifecycle(projectId, async (session) => {
        if (!(await session.assertActive())) return;
        await provisionContainer(projectId, files, envVars);
        if (!(await session.assertActive())) {
          logger.warn({ projectId }, "Container provisioning finished after project retirement");
        }
      }).catch((err: unknown) => {
        logger.error({ err, projectId }, "Container provisioning failed");
      });
    });
  },
);

// ── POST /api/projects/:id/container/stop ────────────────────────────────────
router.post(
  "/projects/:id/container/stop",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    await hibernateContainer(projectId);
    if (project.containerId) {
      const observed = await getContainerStatus(project.containerId);
      if (observed === "running" || observed === "starting") {
        res.status(503).json({
          error: "The preview could not be stopped yet. Please try again.",
          code: "preview_hibernate_unconfirmed",
        });
        return;
      }
    }
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

// ── GET /api/projects/:id/container/logs/stream ──────────────────────────────
// Task #746 — Server-Sent Events stream of live container stdout/stderr.
// Flow mirrors the task-events stream:
//   1. Authorize, then subscribe to the in-process bus to buffer live lines.
//   2. Replay the last N persisted log rows so the client has context.
//   3. Flush any buffered live lines that arrived after the replay snapshot.
//   4. Stream future lines until the client disconnects.
// Observation only: subscribing never starts provider work. Runtime creation
// and boot recovery own log-tailer startup behind their mutation boundaries.
router.get(
  "/projects/:id/container/logs/stream",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders();

    const write = (payload: object): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };

    // Subscribe FIRST so any line arriving during replay is buffered, not
    // dropped on the floor.
    const liveBuffer: ContainerLogPayload[] = [];
    let replayDone = false;
    let streamClosed = false;

    const unsubscribe = subscribeContainerLogs(projectId, (payload) => {
      if (streamClosed) return;
      if (!replayDone) {
        liveBuffer.push(payload);
        return;
      }
      write(payload);
    });

    // Replay the most recent 200 persisted log rows.
    const existing = await db
      .select({
        id: containerLogsTable.id,
        level: containerLogsTable.level,
        message: containerLogsTable.message,
        createdAt: containerLogsTable.createdAt,
      })
      .from(containerLogsTable)
      .where(eq(containerLogsTable.projectId, projectId))
      .orderBy(desc(containerLogsTable.createdAt))
      .limit(200);

    const ordered = existing.reverse();
    let lastReplayedId = 0;
    for (const row of ordered) {
      write({
        id: row.id,
        projectId,
        level: row.level,
        message: row.message,
        createdAt: row.createdAt,
      });
      if (row.id > lastReplayedId) lastReplayedId = row.id;
    }

    replayDone = true;
    for (const payload of liveBuffer) {
      if (payload.id <= lastReplayedId) continue;
      if (streamClosed) break;
      write(payload);
    }

    // If the project has no container yet, surface a system line explaining
    // why so the user isn't staring at an empty pane.
    if (!project.containerId) {
      const msg =
        project.builderMode === "agentic"
          ? "Container is still provisioning — logs will appear once the machine is up."
          : "This project doesn't have a container yet. Logs will appear once one is started.";
      // Don't persist; just hint to the live viewer.
      write({
        id: 0,
        projectId,
        level: "system",
        message: msg,
        createdAt: new Date(),
      });
    }

    // Heartbeat every 25s to keep proxies from closing the idle SSE socket.
    const heartbeat = setInterval(() => {
      if (streamClosed) return;
      try {
        res.write(`: ping\n\n`);
      } catch {
        /* connection already closed */
      }
    }, 25000);

    req.on("close", () => {
      streamClosed = true;
      clearInterval(heartbeat);
      unsubscribe();
    });
  },
);

// ── POST /api/projects/:id/container/logs/test ───────────────────────────────
// Diagnostic helper — emits a system log line into the project's container
// log stream. Used by the workspace Logs tab "Send test line" button so the
// user can verify the live channel is wired up end-to-end without having to
// trigger real container activity.
router.post(
  "/projects/:id/container/logs/test",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    await recordContainerLog(projectId, "system", "Test log line from workspace.");
    res.json({ ok: true });
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

// ── POST /api/projects/:id/container/publish — RETIRED ───────────────────────
// This route previously allowed manually deploying a production container outside
// the publish gate, bypassing Testing Approval, reading from mutable project_files,
// and injecting all secrets regardless of environment scoping.
//
// It is now retired (410 Gone). Production container deployments must go through
// POST /api/projects/:id/publish, which enforces the full testing + approval gate.
router.post("/projects/:id/container/publish", requireProjectOwnership, (_req, res): void => {
  res.status(410).json({
    error:
      "This endpoint has been retired. Use POST /api/projects/:id/publish to deploy to production. " +
      "Production deployments now require Testing Approval before they can proceed.",
    code: "endpoint_retired",
  });
});

// ── POST /api/projects/:id/container/unpublish ───────────────────────────────
// Stop and destroy the production container for this project.
router.post(
  "/projects/:id/container/unpublish",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.prodContainerId) {
      const destroyed = await destroyContainer(project.prodContainerId, projectId);
      if (!destroyed) {
        res.status(503).json({
          error: "The production container could not be removed yet. Please try again.",
          code: "production_container_destroy_unconfirmed",
        });
        return;
      }
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
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const project = await loadProject(projectId);
    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (project.containerId) {
      const destroyed = await destroyContainer(project.containerId, projectId);
      if (!destroyed) {
        res.status(503).json({
          error: "The preview container could not be removed yet. Please try again.",
          code: "preview_container_destroy_unconfirmed",
        });
        return;
      }
    }

    await db
      .update(projectsTable)
      .set({ containerId: null, containerStatus: "stopped", containerUrl: null })
      .where(eq(projectsTable.id, projectId));

    res.json({ destroyed: true });
  },
);

// ── GET /api/projects/:id/resources ──────────────────────────────────────────
// Reports whether live container resource usage is available. The current
// provider abstraction has no governed metrics source, so this endpoint must
// never invent CPU, memory, or disk observations.
router.get("/projects/:id/resources", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const project = await loadProject(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  res.json({
    metricsAvailable: false,
    reason:
      project.containerId && project.containerStatus === "running"
        ? "provider_metrics_unavailable"
        : "runtime_not_running",
    cpuPercent: null,
    ramMb: null,
    ramLimitMb: null,
    diskMb: null,
    diskLimitMb: null,
    status: project.containerStatus ?? "stopped",
  });
});

export default router;
