// ─────────────────────────────────────────────────────────────────────────────
// Production logs routes (Task #511).
//
//   Authed (project-scoped):
//     GET  /api/projects/:id/prod-logs          — recent raw logs
//     GET  /api/projects/:id/prod-errors        — grouped errors
//     GET  /api/projects/:id/health-checks      — latest synthetic check
//     POST /api/projects/:id/health-checks/run  — run an on-demand check
//
//   Public (mounted before auth wall via publicProdLogRouter):
//     POST /api/p/:slug/log     — browser error beacon (rate-limited per IP+slug)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { and, eq, isNull } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import {
  computeSignature,
  hashIp,
  listErrorGroups,
  listProdLogs,
  recordProdLog,
  latestHealthCheck,
  recordHealthCheck,
  runPostPublishHealthCheck,
  getDeclaredRoutes,
} from "../lib/prodLogs";

const router: IRouter = Router();

// ── Authed: GET /api/projects/:id/prod-logs ─────────────────────────────────
router.get("/projects/:id/prod-logs", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const kind = typeof req.query["kind"] === "string" ? req.query["kind"] : undefined;
  const limit = Number(req.query["limit"] ?? 100);
  const rows = await listProdLogs({ projectId, kind, limit });
  res.json({ logs: rows });
});

// ── Authed: GET /api/projects/:id/prod-errors ───────────────────────────────
router.get(
  "/projects/:id/prod-errors",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const limit = Number(req.query["limit"] ?? 50);
    const groups = await listErrorGroups({ projectId, limit });
    res.json({ groups });
  },
);

// ── Authed: GET /api/projects/:id/health-checks ─────────────────────────────
router.get(
  "/projects/:id/health-checks",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const latest = await latestHealthCheck(projectId);
    res.json({ latest });
  },
);

// ── Authed: POST /api/projects/:id/health-checks/run ────────────────────────
router.post(
  "/projects/:id/health-checks/run",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const [project] = await db
      .select({
        publicSlug: projectsTable.publicSlug,
        publishedSnapshotId: projectsTable.publishedSnapshotId,
        status: projectsTable.status,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    if (!project?.publicSlug || project.status !== "published") {
      res.status(400).json({ error: "Project is not published." });
      return;
    }
    const routes = await getDeclaredRoutes(projectId);
    const result = await runPostPublishHealthCheck({
      projectId,
      publicSlug: project.publicSlug,
      snapshotId: project.publishedSnapshotId,
      routes,
    });
    await recordHealthCheck({
      projectId,
      publicSlug: project.publicSlug,
      snapshotId: project.publishedSnapshotId,
      status: result.status,
      rootStatus: result.rootStatus,
      rootLatencyMs: result.rootLatencyMs,
      routesChecked: result.routesChecked,
      routesFailed: result.routesFailed,
      failureSummary: result.failureSummary,
    });
    res.json(result);
  },
);

export default router;

// ── Public router (mounted before auth wall) ────────────────────────────────
//
// POST /api/p/:slug/log
//   Body: { errors: [{ message, stack?, errorClass?, url? }, ...] }
//   Rate-limited to 30 errors per IP+slug per minute.

const publicProdLogRouter: IRouter = Router();

interface BeaconWindow {
  count: number;
  resetAt: number;
}
const beaconStore = new Map<string, BeaconWindow>();
const BEACON_MAX = 30;
const BEACON_WINDOW_MS = 60_000;

function beaconRateLimit(req: Request, res: Response, next: NextFunction): void {
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";
  const key = `beacon:${req.params["slug"] ?? ""}:${ip}`;
  const now = Date.now();
  let w = beaconStore.get(key);
  if (!w || w.resetAt <= now) {
    w = { count: 0, resetAt: now + BEACON_WINDOW_MS };
    beaconStore.set(key, w);
  }
  w.count += 1;
  if (w.count > BEACON_MAX) {
    res.status(429).json({ error: "rate limit" });
    return;
  }
  next();
}

setInterval(() => {
  const now = Date.now();
  for (const [k, w] of beaconStore.entries()) {
    if (w.resetAt <= now) beaconStore.delete(k);
  }
}, 60_000).unref();

publicProdLogRouter.post("/p/:slug/log", beaconRateLimit, async (req, res): Promise<void> => {
  const slugRaw = req.params["slug"];
  const slug = Array.isArray(slugRaw) ? slugRaw[0] : slugRaw;
  if (!slug) {
    res.status(404).json({ error: "not found" });
    return;
  }
  const [project] = await db
    .select({
      id: projectsTable.id,
      publishedSnapshotId: projectsTable.publishedSnapshotId,
      status: projectsTable.status,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.publicSlug, slug), isNull(projectsTable.deletedAt)));
  if (!project || project.status !== "published") {
    // Ignore beacons for unpublished/missing projects so a leaked slug can't
    // pollute a project's log volume after unpublish.
    res.status(204).end();
    return;
  }
  const body = (req.body ?? {}) as {
    errors?: Array<{
      message?: string;
      stack?: string;
      errorClass?: string;
      url?: string;
    }>;
  };
  const errors = Array.isArray(body.errors) ? body.errors.slice(0, 10) : [];
  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "";
  const ipH = hashIp(ip);
  const ua = String(req.headers["user-agent"] ?? "").slice(0, 200);
  for (const e of errors) {
    const message = String(e.message ?? "").slice(0, 1000);
    if (!message) continue;
    const stack = e.stack ? String(e.stack).slice(0, 4000) : null;
    const errorClass = e.errorClass ? String(e.errorClass).slice(0, 100) : "Error";
    const url = e.url ? String(e.url).slice(0, 500) : null;
    const signature = computeSignature({ message, stack, errorClass });
    recordProdLog({
      projectId: project.id,
      snapshotId: project.publishedSnapshotId,
      kind: "browser",
      path: url,
      ipHash: ipH,
      userAgent: ua,
      errorClass,
      message,
      stack,
      signature,
    });
  }
  res.status(204).end();
});

export { publicProdLogRouter };
