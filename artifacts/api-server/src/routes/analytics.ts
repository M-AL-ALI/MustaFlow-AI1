// ─────────────────────────────────────────────────────────────────────────────
// Analytics routes
//
//   GET  /api/projects/:id/analytics       — build analytics (auth-gated)
//   POST /api/p/:slug/analytics/ping       — public, records a page view
//   GET  /api/projects/:id/analytics/summary — auth-gated page view summary
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, eq, isNull, gte, desc, sql } from "drizzle-orm";
import { db, projectsTable, pageViewsTable, buildAnalyticsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { logger } from "../lib/logger";
import * as crypto from "crypto";

const router: IRouter = Router();

// ── GET /api/projects/:id/analytics ──────────────────────────────────────────
// Auth-gated — returns build analytics rows for the project.
router.get("/projects/:id/analytics", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  if (!Number.isFinite(projectId)) {
    res.status(400).json({ error: "Invalid project id" });
    return;
  }

  const rows = await db
    .select()
    .from(buildAnalyticsTable)
    .where(eq(buildAnalyticsTable.projectId, projectId))
    .orderBy(desc(buildAnalyticsTable.createdAt))
    .limit(100);

  const total = rows.length;
  const succeeded = rows.filter((r) => r.outcome === "success").length;
  const successRate = total > 0 ? succeeded / total : null;
  const avgDurationMs =
    total > 0 ? Math.round(rows.reduce((sum, r) => sum + r.durationMs, 0) / total) : null;
  const avgCorrectionPasses =
    total > 0 ? rows.reduce((sum, r) => sum + r.correctionPasses, 0) / total : null;

  const errorCounts = new Map<string, number>();
  for (const r of rows) {
    if (r.primaryErrorCategory) {
      errorCounts.set(r.primaryErrorCategory, (errorCounts.get(r.primaryErrorCategory) ?? 0) + 1);
    }
  }
  let topErrorCategory: string | null = null;
  let topCount = 0;
  for (const [cat, cnt] of errorCounts) {
    if (cnt > topCount) {
      topCount = cnt;
      topErrorCategory = cat;
    }
  }

  res.json({
    rows,
    summary: {
      total,
      successRate,
      avgDurationMs,
      avgCorrectionPasses,
      topErrorCategory,
    },
  });
});

// Session cookie name — stored client-side, persists within a browser session.
const SESSION_COOKIE = "mf_view_session";

// Rate-limit a ping to 1 per session per project per 30 minutes using a simple
// in-memory map. Keys: `${projectId}:${sessionId}`, value: last ping timestamp.
const pingThrottle = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [key, ts] of pingThrottle) {
    if (ts < cutoff) pingThrottle.delete(key);
  }
}, 5 * 60 * 1000).unref();

// ── POST /api/p/:slug/analytics/ping ─────────────────────────────────────────
// Public — no auth. Called by the injected analytics snippet.
router.post("/p/:slug/analytics/ping", async (req, res): Promise<void> => {
  const slug = req.params.slug;
  if (!slug) {
    res.status(400).json({ ok: false });
    return;
  }

  // Resolve project from slug
  const [project] = await db
    .select({ id: projectsTable.id })
    .from(projectsTable)
    .where(and(eq(projectsTable.publicSlug, slug), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ ok: false });
    return;
  }

  // Assign/read session cookie
  let sessionId = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (!sessionId) {
    sessionId = crypto.randomBytes(12).toString("hex");
    res.cookie(SESSION_COOKIE, sessionId, {
      maxAge: 30 * 24 * 60 * 60 * 1000,
      httpOnly: true,
      sameSite: "none",
      secure: true,
    });
  }

  // Throttle: 1 ping per session+page per project per 30 min
  // (pagePath already read from req.body below, but we need it for the key)
  const incomingPath = ((req.body as { path?: string })?.path ?? "/").slice(0, 200);
  const throttleKey = `${project.id}:${sessionId}:${incomingPath}`;
  const now = Date.now();
  const lastPing = pingThrottle.get(throttleKey) ?? 0;
  if (now - lastPing < 30 * 60 * 1000) {
    res.json({ ok: true, throttled: true });
    return;
  }
  pingThrottle.set(throttleKey, now);

  // Hash user agent for uniqueness without storing raw UA
  const ua = req.headers["user-agent"] ?? "";
  const uaHash = crypto.createHash("sha256").update(ua).digest("hex").slice(0, 16);

  const rawReferrer = (req.body as { referrer?: string })?.referrer ?? null;
  const pagePath = incomingPath;

  // Best-effort insert — never fail the client if this errors
  try {
    await db.insert(pageViewsTable).values({
      projectId: project.id,
      publicSlug: slug,
      referrer: rawReferrer ? rawReferrer.slice(0, 500) : null,
      userAgentHash: uaHash,
      sessionId,
      pagePath: pagePath.slice(0, 200),
    });
  } catch (err) {
    logger.warn({ err }, "Failed to record page view");
  }

  res.json({ ok: true });
});

// ── GET /api/projects/:id/analytics/summary ───────────────────────────────────
// Auth-gated — only the project owner may see page view analytics.
router.get(
  "/projects/:id/analytics/summary",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // last 30 days

    const [views] = await db
      .select({ total: sql<number>`count(*)` })
      .from(pageViewsTable)
      .where(and(eq(pageViewsTable.projectId, projectId), gte(pageViewsTable.visitedAt, since)));

    const uniqueSessions = await db
      .selectDistinct({ sessionId: pageViewsTable.sessionId })
      .from(pageViewsTable)
      .where(
        and(
          eq(pageViewsTable.projectId, projectId),
          gte(pageViewsTable.visitedAt, since),
        ),
      );

    // Top referrers — group by referrer domain (exclude nulls/empty)
    const referrerRows = await db
      .select({
        referrer: pageViewsTable.referrer,
        count: sql<number>`count(*)`,
      })
      .from(pageViewsTable)
      .where(
        and(
          eq(pageViewsTable.projectId, projectId),
          gte(pageViewsTable.visitedAt, since),
          sql`${pageViewsTable.referrer} IS NOT NULL AND ${pageViewsTable.referrer} != ''`,
        ),
      )
      .groupBy(pageViewsTable.referrer)
      .orderBy(desc(sql`count(*)`))
      .limit(10);

    // Trend: daily view counts for last 14 days
    const trendRows = await db
      .select({
        day: sql<string>`date_trunc('day', ${pageViewsTable.visitedAt})::date::text`,
        count: sql<number>`count(*)`,
      })
      .from(pageViewsTable)
      .where(
        and(
          eq(pageViewsTable.projectId, projectId),
          gte(pageViewsTable.visitedAt, new Date(Date.now() - 14 * 24 * 60 * 60 * 1000)),
        ),
      )
      .groupBy(sql`date_trunc('day', ${pageViewsTable.visitedAt})`)
      .orderBy(sql`date_trunc('day', ${pageViewsTable.visitedAt})`);

    res.json({
      totalViews: Number(views?.total ?? 0),
      uniqueVisitors: uniqueSessions.length,
      topReferrers: referrerRows.map((r) => ({
        referrer: r.referrer,
        count: Number(r.count),
      })),
      dailyTrend: trendRows.map((r) => ({
        day: r.day,
        count: Number(r.count),
      })),
      windowDays: 30,
    });
  },
);

export default router;
