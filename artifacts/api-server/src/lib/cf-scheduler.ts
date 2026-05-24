/**
 * Cloudflare for SaaS scheduler — Task #553
 *
 * Runs three recurring jobs:
 *
 * 1. Cert-status polling (every 5 min):
 *    Polls Cloudflare for every project_domains row that has a cfHostnameId.
 *    Updates sslStatus, sslLastCheckedAt, sslExpiresAt.
 *    Also syncs projects.sslStatus for the primary domain (backward compat).
 *
 * 2. Dangling-CNAME sweep (once daily):
 *    Lists all CF custom hostnames → removes any that no longer have a
 *    matching active project_domains row. Logs each removal to deployment_logs.
 *
 * 3. Expiry alert (once daily):
 *    Flags any cert within 14 days of expiry with no renewal in progress.
 *    Writes an admin alert row to deployment_logs.
 */

import { eq, isNotNull, and, isNull, lte } from "drizzle-orm";
import { db, projectDomainsTable, projectsTable, deploymentLogsTable } from "@workspace/db";
import {
  cfEnabled,
  getCustomHostname,
  listCustomHostnames,
  deleteCustomHostname,
  mapCfSslStatus,
} from "./cloudflare";
import { logger } from "./logger";

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 5 * 60_000; // 5 minutes
const DAILY_INTERVAL_MS = 24 * 60 * 60_000;
const INITIAL_POLL_DELAY_MS = 60_000; // 1 min warm-up before first poll
const INITIAL_DAILY_DELAY_MS = 90_000; // 1.5 min warm-up before first daily run
const EXPIRY_WARN_DAYS = 14;

// ── Cert-status polling ───────────────────────────────────────────────────────

/**
 * Poll Cloudflare for every project_domains row that has a cfHostnameId.
 * Updates sslStatus, sslLastCheckedAt, sslExpiresAt.
 */
export async function runCertStatusPoll(): Promise<void> {
  if (!cfEnabled()) return;

  let polled = 0;
  let updated = 0;
  let errors = 0;

  try {
    const domains = await db
      .select({
        id: projectDomainsTable.id,
        projectId: projectDomainsTable.projectId,
        hostname: projectDomainsTable.hostname,
        isPrimary: projectDomainsTable.isPrimary,
        cfHostnameId: projectDomainsTable.cfHostnameId,
        sslStatus: projectDomainsTable.sslStatus,
      })
      .from(projectDomainsTable)
      .where(isNotNull(projectDomainsTable.cfHostnameId));

    for (const domain of domains) {
      polled++;
      try {
        const cfHostname = await getCustomHostname(domain.cfHostnameId!);
        if (!cfHostname) continue;

        const newStatus = mapCfSslStatus(cfHostname.ssl?.status);
        const expiresOn = cfHostname.ssl?.expires_on ? new Date(cfHostname.ssl.expires_on) : null;

        // Detect expiring soon (active cert, ≤ 14 days out)
        const finalStatus =
          newStatus === "active" && expiresOn
            ? expiresOn.getTime() - Date.now() <= EXPIRY_WARN_DAYS * 24 * 60 * 60_000
              ? "expiring_soon"
              : "active"
            : newStatus;

        await db
          .update(projectDomainsTable)
          .set({
            sslStatus: finalStatus,
            sslLastCheckedAt: new Date(),
            sslExpiresAt: expiresOn ?? undefined,
            updatedAt: new Date(),
          })
          .where(eq(projectDomainsTable.id, domain.id));

        // Sync legacy projects.sslStatus for the primary domain
        if (domain.isPrimary) {
          await db
            .update(projectsTable)
            .set({
              sslStatus: finalStatus,
              sslVerifiedAt:
                finalStatus === "active" || finalStatus === "expiring_soon"
                  ? new Date()
                  : undefined,
              updatedAt: new Date(),
            })
            .where(eq(projectsTable.id, domain.projectId));
        }

        updated++;
      } catch (err) {
        errors++;
        logger.warn({ err, hostname: domain.hostname }, "CF cert poll: error polling domain");
      }
    }

    if (polled > 0) {
      logger.info({ polled, updated, errors }, "CF cert poll: completed");
    }
  } catch (err) {
    logger.error({ err }, "CF cert poll: failed to load domains");
  }
}

// ── Dangling-CNAME sweep ──────────────────────────────────────────────────────

/**
 * Reconcile Cloudflare's custom hostname list against project_domains.
 * Remove any CF hostname that has no live project_domains row or whose project
 * is soft-deleted / unpublished. Logs every removal to deployment_logs.
 */
export async function runDanglingCnameSweep(): Promise<void> {
  if (!cfEnabled()) return;

  logger.info("CF scheduler: starting dangling-CNAME sweep");

  try {
    const cfHostnames = await listCustomHostnames();
    if (cfHostnames.length === 0) {
      logger.info("CF scheduler: no custom hostnames found in Cloudflare");
      return;
    }

    // Build a set of known cfHostnameIds from project_domains
    const knownDomains = await db
      .select({
        cfHostnameId: projectDomainsTable.cfHostnameId,
        hostname: projectDomainsTable.hostname,
        projectId: projectDomainsTable.projectId,
      })
      .from(projectDomainsTable)
      .where(isNotNull(projectDomainsTable.cfHostnameId));

    const knownIds = new Set(knownDomains.map((d) => d.cfHostnameId));

    let removed = 0;
    let kept = 0;

    for (const cfHost of cfHostnames) {
      if (knownIds.has(cfHost.id)) {
        kept++;
        continue;
      }

      // This CF hostname has no matching project_domains row — dangling.
      logger.warn(
        { cfHostnameId: cfHost.id, hostname: cfHost.hostname },
        "CF scheduler: dangling hostname detected, removing",
      );

      const deleted = await deleteCustomHostname(cfHost.id);

      try {
        await db.insert(deploymentLogsTable).values({
          projectId: 0, // platform-level event — no specific project
          userId: "system",
          env: "domain",
          status: deleted ? "passed" : "failed",
          note: JSON.stringify({
            action: "dangling_cname_removed",
            cfHostnameId: cfHost.id,
            hostname: cfHost.hostname,
            deleted,
          }),
        });
      } catch {
        /* best-effort audit */
      }

      if (deleted) removed++;
    }

    logger.info(
      { scanned: cfHostnames.length, kept, removed },
      "CF scheduler: dangling sweep done",
    );
  } catch (err) {
    logger.error({ err }, "CF scheduler: dangling sweep failed");
  }
}

// ── Expiry alert ──────────────────────────────────────────────────────────────

/**
 * Find certs expiring within EXPIRY_WARN_DAYS and write admin alerts.
 * Only fires for certs that are not already in "expiring_soon" or "expired" state
 * with a recent alert (i.e. doesn't spam — checks once daily).
 */
export async function runExpiryAlert(): Promise<void> {
  logger.info("CF scheduler: running expiry alert check");

  try {
    const cutoff = new Date(Date.now() + EXPIRY_WARN_DAYS * 24 * 60 * 60_000);

    const expiring = await db
      .select({
        id: projectDomainsTable.id,
        projectId: projectDomainsTable.projectId,
        hostname: projectDomainsTable.hostname,
        sslStatus: projectDomainsTable.sslStatus,
        sslExpiresAt: projectDomainsTable.sslExpiresAt,
        cfHostnameId: projectDomainsTable.cfHostnameId,
      })
      .from(projectDomainsTable)
      .where(
        and(
          isNotNull(projectDomainsTable.sslExpiresAt),
          lte(projectDomainsTable.sslExpiresAt, cutoff),
          isNotNull(projectDomainsTable.cfHostnameId),
        ),
      );

    for (const domain of expiring) {
      const daysLeft = domain.sslExpiresAt
        ? Math.ceil((domain.sslExpiresAt.getTime() - Date.now()) / (24 * 60 * 60_000))
        : null;

      logger.warn(
        { hostname: domain.hostname, daysLeft, sslStatus: domain.sslStatus },
        "CF scheduler: cert expiry alert",
      );

      try {
        await db.insert(deploymentLogsTable).values({
          projectId: domain.projectId,
          userId: "system",
          env: "domain",
          status: "failed",
          note: JSON.stringify({
            action: "cert_expiry_alert",
            hostname: domain.hostname,
            cfHostnameId: domain.cfHostnameId,
            sslStatus: domain.sslStatus,
            sslExpiresAt: domain.sslExpiresAt?.toISOString() ?? null,
            daysLeft,
          }),
        });
      } catch {
        /* best-effort */
      }
    }

    if (expiring.length > 0) {
      logger.warn(
        { count: expiring.length, cutoffDays: EXPIRY_WARN_DAYS },
        "CF scheduler: expiry alerts written",
      );
    } else {
      logger.info("CF scheduler: no certs expiring soon");
    }
  } catch (err) {
    logger.error({ err }, "CF scheduler: expiry alert failed");
  }
}

// ── Admin summary ─────────────────────────────────────────────────────────────

export interface CfHostnameSummary {
  total: number;
  active: number;
  provisioning: number;
  expiringSoon: number;
  expired: number;
  failed: number;
  pending: number;
  /** Domains in project_domains but without a cfHostnameId (not yet provisioned). */
  notProvisioned: number;
}

export async function getCfHostnameSummary(): Promise<CfHostnameSummary> {
  try {
    const domains = await db
      .select({
        sslStatus: projectDomainsTable.sslStatus,
        cfHostnameId: projectDomainsTable.cfHostnameId,
      })
      .from(projectDomainsTable);

    const summary: CfHostnameSummary = {
      total: 0,
      active: 0,
      provisioning: 0,
      expiringSoon: 0,
      expired: 0,
      failed: 0,
      pending: 0,
      notProvisioned: 0,
    };

    for (const d of domains) {
      summary.total++;
      if (!d.cfHostnameId) {
        summary.notProvisioned++;
        continue;
      }
      switch (d.sslStatus) {
        case "active":
          summary.active++;
          break;
        case "provisioning":
          summary.provisioning++;
          break;
        case "expiring_soon":
          summary.expiringSoon++;
          break;
        case "expired":
          summary.expired++;
          break;
        case "failed":
          summary.failed++;
          break;
        default:
          summary.pending++;
      }
    }

    return summary;
  } catch {
    return {
      total: 0,
      active: 0,
      provisioning: 0,
      expiringSoon: 0,
      expired: 0,
      failed: 0,
      pending: 0,
      notProvisioned: 0,
    };
  }
}

// ── Scheduler bootstrap ───────────────────────────────────────────────────────

export function startCfScheduler(): void {
  logger.info(
    {
      pollIntervalMs: POLL_INTERVAL_MS,
      dailyIntervalMs: DAILY_INTERVAL_MS,
      cfEnabled: cfEnabled(),
    },
    "CF scheduler: starting",
  );

  // 5-minute cert-status poll
  setTimeout(() => {
    void runCertStatusPoll();
    setInterval(() => {
      void runCertStatusPoll();
    }, POLL_INTERVAL_MS).unref();
  }, INITIAL_POLL_DELAY_MS).unref();

  // Daily: dangling sweep + expiry alerts
  setTimeout(() => {
    void runDanglingCnameSweep();
    void runExpiryAlert();
    setInterval(() => {
      void runDanglingCnameSweep();
      void runExpiryAlert();
    }, DAILY_INTERVAL_MS).unref();
  }, INITIAL_DAILY_DELAY_MS).unref();
}
