// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare for SaaS — SSL automation routes
//
//   POST /api/projects/:id/domain/ssl-activate
//     Triggers Cloudflare custom hostname creation for a verified domain.
//     If CF env vars are missing, returns { cfRequired: true } for setup-required UI.
//
//   POST /api/domain/ssl-webhook  (PUBLIC — no auth, called by Cloudflare)
//     Receives Cloudflare webhook events and updates ssl_status on both
//     project_domains and the legacy projects row.
//
// Required env vars (both must be set for real CF integration):
//   CF_ZONE_ID      — Cloudflare zone ID for mustaflow.app
//   CF_API_TOKEN    — Cloudflare API token with custom_hostnames:edit permission
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, isNull, and } from "drizzle-orm";
import { db, projectsTable, projectDomainsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import {
  cfEnabled,
  createCustomHostname,
  getCustomHostname,
  mapCfSslStatus,
} from "../lib/cloudflare";

// ── Shared activation logic ────────────────────────────────────────────────────

/**
 * Activate SSL for a specific project_domains row.
 *
 * - If CF is configured: creates or polls the CF custom hostname and writes
 *   cfHostnameId + sslStatus back to project_domains.
 * - If CF is not configured: marks sslStatus = "provisioning" so the UI
 *   prompts the operator to configure CF manually.
 * - Syncs projects.sslStatus + projects.cfHostnameId when isPrimary = true.
 *
 * Best-effort — never throws; callers can fire-and-forget.
 */
export async function activateSslForDomain(
  domainId: number,
  hostname: string,
  existingCfHostnameId: string | null | undefined,
  projectId: number,
  isPrimary: boolean,
): Promise<{
  sslStatus: string;
  cfHostnameId: string | null;
  cfRequired: boolean;
  message: string;
}> {
  if (!cfEnabled()) {
    await db
      .update(projectDomainsTable)
      .set({ sslStatus: "provisioning", updatedAt: new Date() })
      .where(eq(projectDomainsTable.id, domainId));

    if (isPrimary) {
      await db
        .update(projectsTable)
        .set({ sslStatus: "provisioning", updatedAt: new Date() })
        .where(eq(projectsTable.id, projectId));
    }

    return {
      sslStatus: "provisioning",
      cfHostnameId: null,
      cfRequired: true,
      message:
        "Cloudflare for SaaS is not configured. Set CF_ZONE_ID and CF_API_TOKEN to enable automated SSL.",
    };
  }

  try {
    let cfHostnameId = existingCfHostnameId ?? null;

    if (!cfHostnameId) {
      const created = await createCustomHostname(hostname);

      if (!created) {
        const errMsg = "Cloudflare API returned no result — check CF_ZONE_ID / CF_API_TOKEN.";
        await db
          .update(projectDomainsTable)
          .set({ sslStatus: "failed", updatedAt: new Date() })
          .where(eq(projectDomainsTable.id, domainId));

        if (isPrimary) {
          await db
            .update(projectsTable)
            .set({ sslStatus: "failed", sslError: errMsg, updatedAt: new Date() })
            .where(eq(projectsTable.id, projectId));
        }

        return { sslStatus: "failed", cfHostnameId: null, cfRequired: false, message: errMsg };
      }

      cfHostnameId = created.id;
      const initialStatus = mapCfSslStatus(created.ssl?.status);

      await db
        .update(projectDomainsTable)
        .set({
          cfHostnameId,
          sslStatus: initialStatus,
          sslLastCheckedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(projectDomainsTable.id, domainId));

      if (isPrimary) {
        await db
          .update(projectsTable)
          .set({ cfHostnameId, sslStatus: initialStatus, sslError: null, updatedAt: new Date() })
          .where(eq(projectsTable.id, projectId));
      }

      return {
        sslStatus: initialStatus,
        cfHostnameId,
        cfRequired: false,
        message:
          "Cloudflare custom hostname created. SSL is provisioning — typically takes 2–10 minutes.",
      };
    }

    // Existing CF hostname — poll current status
    const polled = await getCustomHostname(cfHostnameId);
    if (!polled) {
      return {
        sslStatus: "provisioning",
        cfHostnameId,
        cfRequired: false,
        message: "Could not reach Cloudflare to poll cert status. Will retry shortly.",
      };
    }

    const polledStatus = mapCfSslStatus(polled.ssl?.status);
    const expiresOn = polled.ssl?.expires_on ? new Date(polled.ssl.expires_on) : null;

    await db
      .update(projectDomainsTable)
      .set({
        sslStatus: polledStatus,
        sslLastCheckedAt: new Date(),
        sslExpiresAt: expiresOn ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(projectDomainsTable.id, domainId));

    if (isPrimary) {
      await db
        .update(projectsTable)
        .set({
          sslStatus: polledStatus,
          sslVerifiedAt: polledStatus === "active" ? new Date() : undefined,
          sslError: null,
          updatedAt: new Date(),
        })
        .where(eq(projectsTable.id, projectId));
    }

    return {
      sslStatus: polledStatus,
      cfHostnameId,
      cfRequired: false,
      message: polledStatus === "active" ? "SSL is active." : "SSL is still provisioning.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error contacting Cloudflare";

    await db
      .update(projectDomainsTable)
      .set({ sslStatus: "failed", updatedAt: new Date() })
      .where(eq(projectDomainsTable.id, domainId));

    if (isPrimary) {
      await db
        .update(projectsTable)
        .set({ sslStatus: "failed", sslError: message, updatedAt: new Date() })
        .where(eq(projectsTable.id, projectId));
    }

    return { sslStatus: "failed", cfHostnameId: null, cfRequired: false, message };
  }
}

/**
 * Legacy activation path — operates on projects.customDomain + projects.cfHostnameId.
 * Kept for backward compatibility with the legacy single-domain PATCH flow.
 *
 * For new multi-domain flow, call activateSslForDomain() instead.
 */
export async function activateSslForProject(
  projectId: number,
  domain: string,
  existingCfHostnameId: string | null | undefined,
): Promise<{
  sslStatus: "pending" | "provisioning" | "active" | "failed";
  cfHostnameId: string | null;
  cfRequired: boolean;
  message: string;
}> {
  // Find the matching project_domains row (if any) for richer per-domain tracking
  const [domainRow] = await db
    .select({
      id: projectDomainsTable.id,
      isPrimary: projectDomainsTable.isPrimary,
      cfHostnameId: projectDomainsTable.cfHostnameId,
    })
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.hostname, domain));

  if (domainRow) {
    const result = await activateSslForDomain(
      domainRow.id,
      domain,
      domainRow.cfHostnameId ?? existingCfHostnameId,
      projectId,
      domainRow.isPrimary,
    );
    return {
      sslStatus: result.sslStatus as "pending" | "provisioning" | "active" | "failed",
      cfHostnameId: result.cfHostnameId,
      cfRequired: result.cfRequired,
      message: result.message,
    };
  }

  // No project_domains row — operate directly on projects table (true legacy path)
  if (!cfEnabled()) {
    await db
      .update(projectsTable)
      .set({ sslStatus: "provisioning", updatedAt: new Date() })
      .where(eq(projectsTable.id, projectId));
    return {
      sslStatus: "provisioning",
      cfHostnameId: null,
      cfRequired: true,
      message: "Cloudflare for SaaS is not configured. Set CF_ZONE_ID and CF_API_TOKEN.",
    };
  }

  try {
    let cfHostnameId = existingCfHostnameId ?? null;

    if (!cfHostnameId) {
      const created = await createCustomHostname(domain);
      if (!created) {
        await db
          .update(projectsTable)
          .set({
            sslStatus: "failed",
            sslError: "CF API returned no result",
            updatedAt: new Date(),
          })
          .where(eq(projectsTable.id, projectId));
        return {
          sslStatus: "failed",
          cfHostnameId: null,
          cfRequired: false,
          message: "CF API error",
        };
      }
      cfHostnameId = created.id;
      const status = mapCfSslStatus(created.ssl?.status) as
        | "pending"
        | "provisioning"
        | "active"
        | "failed";
      await db
        .update(projectsTable)
        .set({ cfHostnameId, sslStatus: status, sslError: null, updatedAt: new Date() })
        .where(eq(projectsTable.id, projectId));
      return {
        sslStatus: status,
        cfHostnameId,
        cfRequired: false,
        message: "CF hostname created.",
      };
    }

    const polled = await getCustomHostname(cfHostnameId);
    const polledStatus = mapCfSslStatus(polled?.ssl?.status) as
      | "pending"
      | "provisioning"
      | "active"
      | "failed";
    await db
      .update(projectsTable)
      .set({
        sslStatus: polledStatus,
        sslVerifiedAt: polledStatus === "active" ? new Date() : undefined,
        sslError: null,
        updatedAt: new Date(),
      })
      .where(eq(projectsTable.id, projectId));
    return {
      sslStatus: polledStatus,
      cfHostnameId,
      cfRequired: false,
      message: "Polled CF status.",
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unexpected error";
    await db
      .update(projectsTable)
      .set({ sslStatus: "failed", sslError: message, updatedAt: new Date() })
      .where(eq(projectsTable.id, projectId));
    return { sslStatus: "failed", cfHostnameId: null, cfRequired: false, message };
  }
}

// ── Authenticated routes (project-scoped) ─────────────────────────────────────
const router: IRouter = Router();

// POST /api/projects/:id/domain/ssl-activate
router.post(
  "/projects/:id/domain/ssl-activate",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const [project] = await db
      .select({
        customDomain: projectsTable.customDomain,
        domainStatus: projectsTable.domainStatus,
        cfHostnameId: projectsTable.cfHostnameId,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    if (!project.customDomain) {
      res.status(400).json({ error: "No custom domain configured" });
      return;
    }

    if (project.domainStatus !== "active") {
      res.status(400).json({
        error:
          "Domain ownership must be verified before SSL can be activated. Run domain verification first.",
      });
      return;
    }

    const result = await activateSslForProject(
      projectId,
      project.customDomain,
      project.cfHostnameId,
    );

    res.json({
      ok: true,
      domain: project.customDomain,
      sslStatus: result.sslStatus,
      cfHostnameId: result.cfHostnameId,
      cfRequired: result.cfRequired,
      message: result.message,
    });
  },
);

export default router;

// ── Public webhook router (no auth — called by Cloudflare) ───────────────────
export const sslWebhookRouter: IRouter = Router();

// POST /api/domain/ssl-webhook
// Cloudflare posts hostname events here. We match the hostname and update sslStatus
// on both project_domains and the legacy projects row.
sslWebhookRouter.post("/domain/ssl-webhook", async (req, res): Promise<void> => {
  const body = req.body as {
    data?: {
      hostname?: string;
      ssl?: { status?: string; expires_on?: string };
      id?: string;
    };
  };

  const hostname = body?.data?.hostname;
  const cfSslStatus = body?.data?.ssl?.status;
  const cfHostnameId = body?.data?.id;
  const expiresOn = body?.data?.ssl?.expires_on ? new Date(body.data.ssl.expires_on) : null;

  if (!hostname) {
    res.status(400).json({ error: "Missing hostname in webhook payload" });
    return;
  }

  const newSslStatus = mapCfSslStatus(cfSslStatus);

  // Update project_domains row
  const [domainRow] = await db
    .select({
      id: projectDomainsTable.id,
      projectId: projectDomainsTable.projectId,
      isPrimary: projectDomainsTable.isPrimary,
    })
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.hostname, hostname));

  if (domainRow) {
    await db
      .update(projectDomainsTable)
      .set({
        sslStatus: newSslStatus,
        sslLastCheckedAt: new Date(),
        sslExpiresAt: expiresOn ?? undefined,
        cfHostnameId: cfHostnameId ?? undefined,
        updatedAt: new Date(),
      })
      .where(eq(projectDomainsTable.id, domainRow.id));

    // Sync legacy projects row
    if (domainRow.isPrimary) {
      await db
        .update(projectsTable)
        .set({
          sslStatus: newSslStatus,
          cfHostnameId: cfHostnameId ?? undefined,
          sslVerifiedAt:
            newSslStatus === "active" || newSslStatus === "expiring_soon" ? new Date() : undefined,
          sslError:
            newSslStatus === "failed"
              ? `Cloudflare reported SSL status: ${cfSslStatus ?? "unknown"}`
              : null,
          updatedAt: new Date(),
        })
        .where(eq(projectsTable.id, domainRow.projectId));
    }

    res.json({ ok: true, acknowledged: true, matched: true, newSslStatus });
    return;
  }

  // Fallback: try legacy projects.customDomain match
  const [project] = await db
    .select({ id: projectsTable.id, sslStatus: projectsTable.sslStatus })
    .from(projectsTable)
    .where(and(eq(projectsTable.customDomain, hostname), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.json({ ok: true, acknowledged: true, matched: false });
    return;
  }

  await db
    .update(projectsTable)
    .set({
      sslStatus: newSslStatus,
      cfHostnameId: cfHostnameId ?? undefined,
      sslVerifiedAt: newSslStatus === "active" ? new Date() : undefined,
      sslError:
        newSslStatus === "failed"
          ? `Cloudflare reported SSL status: ${cfSslStatus ?? "unknown"}`
          : null,
      updatedAt: new Date(),
    })
    .where(eq(projectsTable.id, project.id));

  res.json({ ok: true, acknowledged: true, matched: true, newSslStatus });
});
