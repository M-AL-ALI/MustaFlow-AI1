/**
 * Domain analytics + status timeline routes.
 *
 *   GET /api/projects/:id/domains/:domainId/analytics?window=24h|7d|30d
 *   GET /api/projects/:id/domains/:domainId/timeline
 */

import { Router, type IRouter } from "express";
import { and, asc, eq, gte, sql } from "drizzle-orm";
import {
  db,
  projectDomainsTable,
  deploymentLogsTable,
  domainServeEventsTable,
} from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { getHostnameAnalytics, type AnalyticsWindow } from "../lib/cf-analytics";

const router: IRouter = Router();

const VALID_WINDOWS: AnalyticsWindow[] = ["24h", "7d", "30d"];

// ── GET /api/projects/:id/domains/:domainId/analytics ────────────────────────
router.get(
  "/projects/:id/domains/:domainId/analytics",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const rawWindow = String(req.query["window"] ?? "24h");
    const window: AnalyticsWindow = VALID_WINDOWS.includes(rawWindow as AnalyticsWindow)
      ? (rawWindow as AnalyticsWindow)
      : "24h";

    const [domain] = await db
      .select()
      .from(projectDomainsTable)
      .where(
        and(
          eq(projectDomainsTable.id, domainId),
          eq(projectDomainsTable.projectId, projectId),
        ),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    // ── Business metrics from our own Postgres ─────────────────────────────
    const windowMs =
      window === "24h" ? 24 * 60 * 60 * 1000 : window === "7d" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
    const since = new Date(Date.now() - windowMs);

    const [serveRow] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(domainServeEventsTable)
      .where(
        and(
          eq(domainServeEventsTable.domainId, domainId),
          gte(domainServeEventsTable.ts, since),
        ),
      );

    const [uniqueDatesRow] = await db
      .select({ uniqueDates: sql<number>`count(distinct date_trunc('day', ts))::int` })
      .from(domainServeEventsTable)
      .where(
        and(
          eq(domainServeEventsTable.domainId, domainId),
          gte(domainServeEventsTable.ts, since),
        ),
      );

    // ── Cloudflare traffic metrics ─────────────────────────────────────────
    const cfMetrics = await getHostnameAnalytics(domain.hostname, window);

    res.json({
      domainId,
      hostname: domain.hostname,
      window,
      domain: { hostname: domain.hostname },
      pg: {
        serveRequests: serveRow?.total ?? 0,
        uniqueDates: uniqueDatesRow?.uniqueDates ?? 0,
      },
      cf: cfMetrics
        ? {
            totalRequests: cfMetrics.requests,
            totalBytes: cfMetrics.bytes,
            errorRate: cfMetrics.errorRate,
            topCountries: cfMetrics.topCountries.map((c) => ({
              code: c.countryCode,
              requests: c.requests,
            })),
            cachedRequests: cfMetrics.cachedRequests,
          }
        : null,
      sslStatus: domain.sslStatus,
      verificationStatus: domain.verificationStatus,
    });
  },
);

// ── GET /api/projects/:id/domains/:domainId/timeline ─────────────────────────
router.get(
  "/projects/:id/domains/:domainId/timeline",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);

    const [domain] = await db
      .select()
      .from(projectDomainsTable)
      .where(
        and(
          eq(projectDomainsTable.id, domainId),
          eq(projectDomainsTable.projectId, projectId),
        ),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    // Collect timeline events from deployment_logs (domain audit trail)
    const logs = await db
      .select({
        id: deploymentLogsTable.id,
        note: deploymentLogsTable.note,
        status: deploymentLogsTable.status,
        createdAt: deploymentLogsTable.createdAt,
        env: deploymentLogsTable.env,
      })
      .from(deploymentLogsTable)
      .where(
        and(
          eq(deploymentLogsTable.projectId, projectId),
          eq(deploymentLogsTable.env, "domain"),
        ),
      )
      .orderBy(asc(deploymentLogsTable.createdAt))
      .limit(200);

    // Filter to events relevant to this domain
    const domainLogs = logs.filter((log) => {
      try {
        const note = JSON.parse(log.note ?? "{}") as { hostname?: string };
        return note.hostname === domain.hostname;
      } catch {
        return false;
      }
    });

    // Build synthetic timeline events from domain state
    const timeline: Array<{
      id: string;
      type: string;
      label: string;
      description: string | null;
      ts: string;
      status: "completed" | "pending" | "failed";
    }> = [];

    // Domain attached
    timeline.push({
      id: `domain-created-${domain.id}`,
      type: "domain.attached",
      label: "Domain attached",
      description: `${domain.hostname} added to project`,
      ts: domain.createdAt.toISOString(),
      status: "completed",
    });

    // Audit log events
    for (const log of domainLogs) {
      let note: Record<string, unknown> = {};
      try {
        note = JSON.parse(log.note ?? "{}") as Record<string, unknown>;
      } catch {
        /* skip */
      }
      const action = (note["action"] as string | undefined) ?? log.status;
      let label = action.replace(/_/g, " ");
      let type = action;

      if (action === "domain_verified" || action === "domain_verified_legacy") {
        type = "domain.verified";
        label = "DNS verified";
      } else if (action === "domain_attached") {
        continue; // already added above
      } else if (action === "domain_detached") {
        type = "domain.detached";
        label = "Domain detached";
      } else if (action === "domain_set_primary") {
        type = "domain.primary";
        label = "Set as primary domain";
      }

      timeline.push({
        id: `log-${log.id}`,
        type,
        label,
        description: null,
        ts: log.createdAt.toISOString(),
        status: "completed",
      });
    }

    // SSL events from domain record
    if (domain.verifiedAt) {
      timeline.push({
        id: `ssl-requested-${domain.id}`,
        type: "cert.pending",
        label: "SSL certificate requested",
        description: "Cloudflare is issuing a certificate for this domain",
        ts: domain.verifiedAt.toISOString(),
        status: domain.sslStatus === "active" ? "completed" : "pending",
      });
    }

    if (domain.sslStatus === "active" && domain.sslLastCheckedAt) {
      timeline.push({
        id: `cert-active-${domain.id}`,
        type: "cert.issued",
        label: "SSL certificate active",
        description: domain.sslExpiresAt
          ? `Expires ${new Date(domain.sslExpiresAt).toLocaleDateString()}`
          : null,
        ts: domain.sslLastCheckedAt.toISOString(),
        status: "completed",
      });
    }

    if (domain.sslStatus === "expiring_soon") {
      timeline.push({
        id: `cert-expiring-${domain.id}`,
        type: "cert.expiring",
        label: "SSL certificate expiring soon",
        description: domain.sslExpiresAt
          ? `Expires ${new Date(domain.sslExpiresAt).toLocaleDateString()}`
          : null,
        ts: domain.sslLastCheckedAt?.toISOString() ?? new Date().toISOString(),
        status: "failed",
      });
    }

    // Sort by timestamp
    timeline.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());

    // Future: pending steps
    const pendingSteps: Array<{ type: string; label: string }> = [];
    if (domain.verificationStatus === "pending") {
      pendingSteps.push({ type: "domain.verified", label: "Awaiting DNS verification" });
      pendingSteps.push({ type: "cert.issued", label: "SSL certificate pending" });
    } else if (domain.sslStatus === "pending" || domain.sslStatus === "provisioning") {
      pendingSteps.push({ type: "cert.issued", label: "SSL certificate pending" });
    }

    res.json({
      domainId,
      hostname: domain.hostname,
      timeline,
      pendingSteps,
      currentStatus: {
        verificationStatus: domain.verificationStatus,
        sslStatus: domain.sslStatus,
        sslExpiresAt: domain.sslExpiresAt,
      },
    });
  },
);

export default router;
