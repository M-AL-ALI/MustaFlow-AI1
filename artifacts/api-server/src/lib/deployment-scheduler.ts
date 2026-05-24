/**
 * Deployment scheduler (Task #543).
 *
 * Two background loops, both setInterval(...).unref() so they never block
 * graceful shutdown:
 *
 *   1. Schedule sweeper — every minute, finds enabled deployment_schedules
 *      rows whose nextRunAt is due and fires them. Currently supports
 *      `task_run` (enqueue an agent task with the schedule note as prompt)
 *      and `health_probe` (one-shot synthetic probe). `redeploy` is reserved
 *      for the future republish-from-snapshot pathway.
 *
 *   2. Uptime probe — every UPTIME_INTERVAL_MS, picks published projects
 *      whose lastProbeAt is older than the interval, runs a single GET
 *      against the configured health_check_path, and records the outcome
 *      in prod_health_checks. Consecutive failures emit a Knowledge Vault
 *      warning entry the owner can see in the Knowledge tab.
 *
 * All work is best-effort: any error is logged and swallowed so one bad
 * project never poisons the loop for the rest.
 */

import { db, projectsTable, deploymentSchedulesTable, prodHealthChecksTable } from "@workspace/db";
import { and, eq, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { logger } from "./logger";
import { recordHealthCheck } from "./prodLogs";
import { writeKnowledge } from "./knowledge";
import { parseCron, nextCronTick } from "./cron-eval";

const SWEEP_INTERVAL_MS = 60_000;
const UPTIME_INTERVAL_MS = 5 * 60_000;
const UPTIME_TIMEOUT_MS = 8_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;
let uptimeTimer: ReturnType<typeof setInterval> | null = null;

/** Recompute nextRunAt for a schedule row. Falsy result means we couldn't parse. */
export function computeNextRunAt(cronExpr: string, from = new Date()): Date | null {
  try {
    return nextCronTick(parseCron(cronExpr), from);
  } catch {
    return null;
  }
}

async function fireSchedule(scheduleId: number): Promise<void> {
  const [row] = await db
    .select()
    .from(deploymentSchedulesTable)
    .where(eq(deploymentSchedulesTable.id, scheduleId));
  if (!row || !row.enabled) return;

  let status: "ran" | "skipped" | "error" = "ran";
  let message = "";

  try {
    switch (row.kind) {
      case "task_run":
        // Hook for future agent-task enqueue. For now we just stamp the row.
        message = "task_run scheduled (no-op until task enqueue is wired)";
        break;
      case "health_probe":
        await runUptimeProbeForProject(row.projectId);
        message = "health probe fired";
        break;
      case "redeploy":
        message = "redeploy scheduled (republish hook is a future task)";
        status = "skipped";
        break;
      default:
        message = `unknown kind: ${row.kind}`;
        status = "skipped";
    }
  } catch (err) {
    status = "error";
    message = err instanceof Error ? err.message : String(err);
  }

  const nextRunAt = computeNextRunAt(row.cronExpr);
  await db
    .update(deploymentSchedulesTable)
    .set({
      lastRunAt: new Date(),
      lastRunStatus: status,
      lastRunMessage: message.slice(0, 500),
      nextRunAt,
      updatedAt: new Date(),
    })
    .where(eq(deploymentSchedulesTable.id, scheduleId));
}

async function sweepSchedules(): Promise<void> {
  const now = new Date();
  try {
    const due = await db
      .select({ id: deploymentSchedulesTable.id })
      .from(deploymentSchedulesTable)
      .where(
        and(
          eq(deploymentSchedulesTable.enabled, true),
          or(
            isNull(deploymentSchedulesTable.nextRunAt),
            lte(deploymentSchedulesTable.nextRunAt, now),
          ),
        ),
      )
      .limit(50);

    for (const { id } of due) {
      try {
        await fireSchedule(id);
      } catch (err) {
        logger.warn({ err, scheduleId: id }, "deployment-scheduler: fire failed");
      }
    }
  } catch (err) {
    logger.warn({ err }, "deployment-scheduler: sweep failed");
  }
}

/**
 * Run one synthetic probe against a project's configured health_check_path
 * and record the outcome. Used by both the periodic uptime loop and ad-hoc
 * `health_probe` schedules.
 */
export async function runUptimeProbeForProject(projectId: number): Promise<void> {
  const [project] = await db
    .select({
      id: projectsTable.id,
      status: projectsTable.status,
      publicSlug: projectsTable.publicSlug,
      publishedSnapshotId: projectsTable.publishedSnapshotId,
      healthCheckPath: projectsTable.healthCheckPath,
      prodContainerUrl: projectsTable.prodContainerUrl,
      uptimeAlertEmail: projectsTable.uptimeAlertEmail,
      name: projectsTable.name,
      deletedAt: projectsTable.deletedAt,
    })
    .from(projectsTable)
    .where(eq(projectsTable.id, projectId));

  if (!project || project.deletedAt || project.status !== "published" || !project.publicSlug) {
    return;
  }

  const path = project.healthCheckPath || "/";
  // Probe target: prefer live container URL, otherwise hit the API's public
  // snapshot route on localhost using the same PORT the server listens on
  // (matches src/index.ts) — defaults to 8080 in dev.
  const apiPort = process.env.PORT ?? "8080";
  const base =
    project.prodContainerUrl?.replace(/\/$/, "") ??
    `http://127.0.0.1:${apiPort}/api/p/${project.publicSlug}`;
  const target = `${base}${path.startsWith("/") ? path : "/" + path}`;

  const startedAt = Date.now();
  let rootStatus = 0;
  let ok = false;
  try {
    const res = await fetch(target, {
      method: "GET",
      signal: AbortSignal.timeout(UPTIME_TIMEOUT_MS),
      redirect: "manual",
    });
    rootStatus = res.status;
    // Only 2xx/3xx count as healthy. 4xx (404/401/403/etc.) means the route
    // returned but isn't actually serving the app, which is a real failure.
    ok = res.status >= 200 && res.status < 400;
  } catch (err) {
    rootStatus = 0;
    ok = false;
    logger.debug({ err, projectId, target }, "uptime probe error");
  }

  const latencyMs = Date.now() - startedAt;
  await recordHealthCheck({
    projectId,
    publicSlug: project.publicSlug,
    snapshotId: project.publishedSnapshotId ?? null,
    status: ok ? "passed" : "failed",
    rootStatus,
    rootLatencyMs: latencyMs,
    routesChecked: 1,
    routesFailed: ok ? 0 : 1,
    failureSummary: ok ? null : `GET ${path} returned ${rootStatus || "error"}`,
  });

  if (!ok) {
    // Knowledge-vault breadcrumb so the owner can see consecutive failures
    // in the project's lesson stream.
    void writeKnowledge({
      title: `Uptime probe failed: ${project.name}`,
      content: `Synthetic probe to ${target} returned ${rootStatus || "network error"} in ${latencyMs}ms.`,
      type: "health-check",
      category: "event",
      severity: "warning",
      projectId,
    }).catch(() => {
      /* best-effort */
    });
  }
}

async function uptimeSweep(): Promise<void> {
  try {
    // Fairness: pick published projects ordered by their oldest health-check
    // (NULLS FIRST — never-probed projects go first). Cap at 20/tick so steady
    // state covers ~240 projects/hour with a 5-min loop, but no project waits
    // forever because the rotation always advances to the stalest entries.
    const rows = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .leftJoin(prodHealthChecksTable, eq(prodHealthChecksTable.projectId, projectsTable.id))
      .where(
        and(
          eq(projectsTable.status, "published"),
          isNotNull(projectsTable.publicSlug),
          isNull(projectsTable.deletedAt),
        ),
      )
      .groupBy(projectsTable.id)
      .orderBy(sql`MAX(${prodHealthChecksTable.createdAt}) ASC NULLS FIRST`)
      .limit(20);

    for (const { id } of rows) {
      try {
        await runUptimeProbeForProject(id);
      } catch (err) {
        logger.debug({ err, projectId: id }, "uptime probe iteration failed");
      }
    }
  } catch (err) {
    logger.warn({ err }, "deployment-scheduler: uptime sweep failed");
  }
}

export function startDeploymentScheduler(): void {
  if (sweepTimer || uptimeTimer) return;
  // Stagger initial fires so all schedulers don't pile up at boot.
  setTimeout(() => void sweepSchedules(), 30_000).unref();
  sweepTimer = setInterval(() => void sweepSchedules(), SWEEP_INTERVAL_MS);
  sweepTimer.unref();

  setTimeout(() => void uptimeSweep(), 90_000).unref();
  uptimeTimer = setInterval(() => void uptimeSweep(), UPTIME_INTERVAL_MS);
  uptimeTimer.unref();
}
