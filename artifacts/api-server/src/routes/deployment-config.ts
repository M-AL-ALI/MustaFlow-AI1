// ─────────────────────────────────────────────────────────────────────────────
// Deployment substrate routes (Task #543)
//
//   GET  /api/projects/:id/deployment-config        — current type/region/CDN/health flags
//   PATCH /api/projects/:id/deployment-config       — update any subset
//   GET  /api/projects/:id/uptime                   — last N health checks + uptime %
//   POST /api/projects/:id/uptime/probe             — run a synthetic probe now
//   GET  /api/projects/:id/schedules                — list deployment schedules
//   POST /api/projects/:id/schedules                — create a schedule
//   PATCH /api/projects/:id/schedules/:sid          — enable/disable/edit a schedule
//   DELETE /api/projects/:id/schedules/:sid         — delete a schedule
//
// All routes are auth-gated via requireProjectOwnership.
// Frontend uses raw fetch (canvas-variants / blueprints pattern).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, desc, isNull } from "drizzle-orm";
import {
  db,
  projectsTable,
  deploymentSchedulesTable,
  prodHealthChecksTable,
  DEPLOYMENT_TYPES,
  SCHEDULE_KINDS,
  type DeploymentType,
  type ScheduleKind,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { cdnConfigured, cdnProvider } from "../lib/cdn";
import { computeNextRunAt, runUptimeProbeForProject } from "../lib/deployment-scheduler";
import { parseCron } from "../lib/cron-eval";
import { requireActiveProjectLifecycleSession } from "../lib/project-lifecycle";

const router: IRouter = Router();

const FLY_REGIONS = [
  "iad",
  "lhr",
  "fra",
  "syd",
  "nrt",
  "sin",
  "gru",
  "sjc",
  "ams",
  "ord",
  "yyz",
  "hkg",
  "mad",
];

function isDeploymentType(v: unknown): v is DeploymentType {
  return typeof v === "string" && (DEPLOYMENT_TYPES as readonly string[]).includes(v);
}

function isScheduleKind(v: unknown): v is ScheduleKind {
  return typeof v === "string" && (SCHEDULE_KINDS as readonly string[]).includes(v);
}

// ── GET /api/projects/:id/deployment-config ──────────────────────────────────
router.get(
  "/projects/:id/deployment-config",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const [project] = await db
      .select({
        deploymentType: projectsTable.deploymentType,
        region: projectsTable.region,
        cdnEnabled: projectsTable.cdnEnabled,
        cdnLastPushedAt: projectsTable.cdnLastPushedAt,
        healthCheckPath: projectsTable.healthCheckPath,
        uptimeAlertEmail: projectsTable.uptimeAlertEmail,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json({
      deploymentType: project.deploymentType,
      region: project.region,
      cdnEnabled: project.cdnEnabled,
      cdnLastPushedAt: project.cdnLastPushedAt,
      healthCheckPath: project.healthCheckPath,
      uptimeAlertEmail: project.uptimeAlertEmail,
      cdn: {
        configured: cdnConfigured(),
        provider: cdnProvider(),
      },
      availableTypes: DEPLOYMENT_TYPES,
      availableRegions: FLY_REGIONS,
      pricing: {
        static: {
          label: "Static (CDN)",
          price: "Free for hobby",
          description: "Globally edge-cached snapshot. Best for static sites.",
        },
        autoscale: {
          label: "Autoscale container",
          price: "$0.01/req est.",
          description: "On-demand container, scales to zero when idle.",
        },
        reserved_vm: {
          label: "Reserved VM",
          price: "$5/mo est.",
          description: "Always-on container. Best for background jobs / low latency.",
        },
        scheduled: {
          label: "Scheduled",
          price: "Per execution",
          description: "Runs on a cron schedule. Best for periodic tasks and jobs.",
        },
      },
    });
  },
);

// ── PATCH /api/projects/:id/deployment-config ────────────────────────────────
router.patch(
  "/projects/:id/deployment-config",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const update: Record<string, unknown> = {};
    if (body.deploymentType !== undefined) {
      if (!isDeploymentType(body.deploymentType)) {
        res
          .status(400)
          .json({ error: `deploymentType must be one of ${DEPLOYMENT_TYPES.join(", ")}` });
        return;
      }
      update.deploymentType = body.deploymentType;
    }
    if (body.region !== undefined) {
      if (body.region !== null && (typeof body.region !== "string" || body.region.length > 16)) {
        res.status(400).json({ error: "region must be a short string or null" });
        return;
      }
      update.region = body.region;
    }
    if (body.cdnEnabled !== undefined) {
      update.cdnEnabled = !!body.cdnEnabled;
    }
    if (body.healthCheckPath !== undefined) {
      const p = typeof body.healthCheckPath === "string" ? body.healthCheckPath : "/";
      if (!p.startsWith("/")) {
        res.status(400).json({ error: "healthCheckPath must start with /" });
        return;
      }
      update.healthCheckPath = p.slice(0, 200);
    }
    if (body.uptimeAlertEmail !== undefined) {
      update.uptimeAlertEmail =
        body.uptimeAlertEmail === null ? null : String(body.uptimeAlertEmail).slice(0, 200);
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "no editable fields provided" });
      return;
    }

    update.updatedAt = new Date();
    await db
      .update(projectsTable)
      .set(update)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    res.json({ ok: true, updated: Object.keys(update).filter((k) => k !== "updatedAt") });
  },
);

// ── GET /api/projects/:id/uptime ─────────────────────────────────────────────
router.get("/projects/:id/uptime", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const rows = await db
    .select()
    .from(prodHealthChecksTable)
    .where(eq(prodHealthChecksTable.projectId, projectId))
    .orderBy(desc(prodHealthChecksTable.createdAt))
    .limit(50);

  const total = rows.length;
  const passed = rows.filter((r) => r.status === "passed").length;
  const uptimePct = total === 0 ? null : Math.round((passed / total) * 1000) / 10;

  res.json({
    projectId,
    uptimePct,
    sampleSize: total,
    lastCheck: rows[0] ?? null,
    checks: rows,
  });
});

// ── POST /api/projects/:id/uptime/probe ──────────────────────────────────────
router.post(
  "/projects/:id/uptime/probe",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    try {
      await runUptimeProbeForProject(projectId);
      res.json({ ok: true });
    } catch (err) {
      req.log.warn({ err, projectId }, "manual uptime probe failed");
      res.status(500).json({ error: "probe failed" });
    }
  },
);

// ── GET /api/projects/:id/schedules ──────────────────────────────────────────
router.get("/projects/:id/schedules", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const rows = await db
    .select()
    .from(deploymentSchedulesTable)
    .where(eq(deploymentSchedulesTable.projectId, projectId))
    .orderBy(desc(deploymentSchedulesTable.createdAt));
  res.json({ schedules: rows });
});

// ── POST /api/projects/:id/schedules ─────────────────────────────────────────
router.post(
  "/projects/:id/schedules",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const cronExpr = typeof body.cronExpr === "string" ? body.cronExpr.trim() : "";
    if (!cronExpr) {
      res.status(400).json({ error: "cronExpr is required" });
      return;
    }
    try {
      parseCron(cronExpr);
    } catch (err) {
      res.status(400).json({
        error: `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    const kind: ScheduleKind = isScheduleKind(body.kind) ? body.kind : "task_run";
    const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
    const enabled = body.enabled === undefined ? true : !!body.enabled;
    const nextRunAt = computeNextRunAt(cronExpr);

    const [row] = await db
      .insert(deploymentSchedulesTable)
      .values({
        projectId,
        kind,
        cronExpr,
        enabled,
        note,
        nextRunAt,
        createdBy: req.userId ?? null,
      })
      .returning();

    res.status(201).json({ schedule: row });
  },
);

// ── PATCH /api/projects/:id/schedules/:sid ───────────────────────────────────
router.patch(
  "/projects/:id/schedules/:sid",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const sid = Number(req.params.sid);
    const body = (req.body ?? {}) as Record<string, unknown>;

    const [existing] = await db
      .select()
      .from(deploymentSchedulesTable)
      .where(
        and(
          eq(deploymentSchedulesTable.id, sid),
          eq(deploymentSchedulesTable.projectId, projectId),
        ),
      );
    if (!existing) {
      res.status(404).json({ error: "schedule not found" });
      return;
    }

    const update: Record<string, unknown> = {};
    if (body.enabled !== undefined) update.enabled = !!body.enabled;
    if (body.note !== undefined) {
      update.note = body.note === null ? null : String(body.note).slice(0, 500);
    }
    if (body.cronExpr !== undefined) {
      const newExpr = String(body.cronExpr).trim();
      try {
        parseCron(newExpr);
      } catch (err) {
        res.status(400).json({
          error: `invalid cron expression: ${err instanceof Error ? err.message : String(err)}`,
        });
        return;
      }
      update.cronExpr = newExpr;
      update.nextRunAt = computeNextRunAt(newExpr);
    }
    if (body.kind !== undefined) {
      if (!isScheduleKind(body.kind)) {
        res.status(400).json({ error: `kind must be one of ${SCHEDULE_KINDS.join(", ")}` });
        return;
      }
      update.kind = body.kind;
    }

    if (Object.keys(update).length === 0) {
      res.status(400).json({ error: "no editable fields provided" });
      return;
    }
    update.updatedAt = new Date();

    const [row] = await db
      .update(deploymentSchedulesTable)
      .set(update)
      .where(eq(deploymentSchedulesTable.id, sid))
      .returning();
    res.json({ schedule: row });
  },
);

// ── DELETE /api/projects/:id/schedules/:sid ──────────────────────────────────
router.delete(
  "/projects/:id/schedules/:sid",
  requireProjectOwnership,
  requireActiveProjectLifecycleSession,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const sid = Number(req.params.sid);
    await db
      .delete(deploymentSchedulesTable)
      .where(
        and(
          eq(deploymentSchedulesTable.id, sid),
          eq(deploymentSchedulesTable.projectId, projectId),
        ),
      );
    res.json({ ok: true });
  },
);

export default router;
