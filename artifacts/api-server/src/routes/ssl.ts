// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare for SaaS — SSL automation routes
//
//   POST /api/projects/:id/domain/ssl-activate
//     Triggers Cloudflare custom hostname creation for a verified domain.
//     If CF env vars are missing, returns { cfRequired: true } for setup-required UI.
//
//   POST /api/domain/ssl-webhook  (PUBLIC — no auth, called by Cloudflare)
//     Receives Cloudflare webhook events and updates ssl_status.
//
// Required env vars (both must be set for real CF integration):
//   CF_ZONE_ID      — Cloudflare zone ID for mustaflow.app
//   CF_API_TOKEN    — Cloudflare API token with custom_hostnames:edit permission
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, isNull, and } from "drizzle-orm";
import { db, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const CF_ZONE_ID = process.env.CF_ZONE_ID;
const CF_API_TOKEN = process.env.CF_API_TOKEN;
const CF_API_BASE = "https://api.cloudflare.com/client/v4";

/** True when both CF env vars are present. */
function cfConfigured(): boolean {
  return Boolean(CF_ZONE_ID && CF_API_TOKEN);
}

// Cloudflare SSL status → our internal sslStatus
function mapCfSslStatus(
  cfSslStatus: string | undefined,
): "pending" | "provisioning" | "active" | "failed" {
  switch (cfSslStatus) {
    case "active":
      return "active";
    case "pending_validation":
    case "pending_issuance":
    case "pending_deployment":
      return "provisioning";
    case "initializing":
      return "provisioning";
    case "expired_certificate":
    case "blocked":
    case "deactivated":
    case "pending_blocked_validation":
    case "validation_timed_out":
      return "failed";
    default:
      return "provisioning";
  }
}

// ── Shared activation logic (called by ssl-activate endpoint AND domain verify) ──
// Returns the new sslStatus and optional cfHostnameId.
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
  if (!cfConfigured()) {
    await db
      .update(projectsTable)
      .set({ sslStatus: "provisioning" })
      .where(eq(projectsTable.id, projectId));

    return {
      sslStatus: "provisioning",
      cfHostnameId: null,
      cfRequired: true,
      message:
        "Cloudflare for SaaS is not configured. Set CF_ZONE_ID and CF_API_TOKEN env vars to enable automated SSL. SSL is marked as provisioning — configure manually via your infrastructure team.",
    };
  }

  try {
    let cfHostnameId = existingCfHostnameId ?? null;

    if (!cfHostnameId) {
      // Create the custom hostname in Cloudflare
      const createResp = await fetch(
        `${CF_API_BASE}/zones/${CF_ZONE_ID}/custom_hostnames`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${CF_API_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            hostname: domain,
            ssl: {
              method: "http",
              type: "dv",
              settings: {
                min_tls_version: "1.2",
                http2: "on",
              },
            },
          }),
        },
      );

      const createJson = (await createResp.json()) as {
        success: boolean;
        result?: { id: string; ssl?: { status: string } };
        errors?: Array<{ message: string }>;
      };

      if (!createResp.ok || !createJson.success) {
        const errMsg =
          createJson.errors?.map((e) => e.message).join("; ") ??
          "Unknown Cloudflare error";

        await db
          .update(projectsTable)
          .set({ sslStatus: "failed", sslError: errMsg })
          .where(eq(projectsTable.id, projectId));

        return {
          sslStatus: "failed",
          cfHostnameId: null,
          cfRequired: false,
          message: `Cloudflare API error: ${errMsg}`,
        };
      }

      cfHostnameId = createJson.result?.id ?? null;
      const initialSslStatus = mapCfSslStatus(
        createJson.result?.ssl?.status,
      );

      await db
        .update(projectsTable)
        .set({
          cfHostnameId,
          sslStatus: initialSslStatus,
          sslError: null,
        })
        .where(eq(projectsTable.id, projectId));

      return {
        sslStatus: initialSslStatus,
        cfHostnameId,
        cfRequired: false,
        message:
          "Cloudflare custom hostname created. SSL is provisioning — this typically takes 2–10 minutes.",
      };
    }

    // Existing CF hostname — poll current status
    const pollResp = await fetch(
      `${CF_API_BASE}/zones/${CF_ZONE_ID}/custom_hostnames/${cfHostnameId}`,
      {
        headers: { Authorization: `Bearer ${CF_API_TOKEN}` },
      },
    );
    const pollJson = (await pollResp.json()) as {
      success: boolean;
      result?: { ssl?: { status: string } };
    };

    const polledStatus = mapCfSslStatus(pollJson.result?.ssl?.status);

    await db
      .update(projectsTable)
      .set({
        sslStatus: polledStatus,
        sslVerifiedAt: polledStatus === "active" ? new Date() : undefined,
        sslError: null,
      })
      .where(eq(projectsTable.id, projectId));

    return {
      sslStatus: polledStatus,
      cfHostnameId,
      cfRequired: false,
      message:
        polledStatus === "active"
          ? "SSL is active."
          : "SSL is still provisioning.",
    };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Unexpected error contacting Cloudflare";

    await db
      .update(projectsTable)
      .set({ sslStatus: "failed", sslError: message })
      .where(eq(projectsTable.id, projectId));

    return {
      sslStatus: "failed",
      cfHostnameId: null,
      cfRequired: false,
      message: `SSL activation failed: ${message}`,
    };
  }
}

// ── Authenticated routes (project-scoped) ────────────────────────────────────
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
// Cloudflare posts hostname events here. We match the hostname to a project
// and update sslStatus accordingly.
// Webhook payload shape: { data: { hostname: string, ssl: { status: string } } }
sslWebhookRouter.post("/domain/ssl-webhook", async (req, res): Promise<void> => {
  // In production, verify the Cloudflare webhook signature here.
  // For now we trust the payload and match by hostname.

  const body = req.body as {
    data?: {
      hostname?: string;
      ssl?: { status?: string };
      id?: string;
    };
  };

  const hostname = body?.data?.hostname;
  const cfSslStatus = body?.data?.ssl?.status;
  const cfHostnameId = body?.data?.id;

  if (!hostname) {
    res.status(400).json({ error: "Missing hostname in webhook payload" });
    return;
  }

  // Find the project with this custom domain
  const [project] = await db
    .select({ id: projectsTable.id, sslStatus: projectsTable.sslStatus })
    .from(projectsTable)
    .where(and(eq(projectsTable.customDomain, hostname), isNull(projectsTable.deletedAt)));

  if (!project) {
    // Not found — acknowledge so CF doesn't retry
    res.json({ ok: true, acknowledged: true, matched: false });
    return;
  }

  const newSslStatus = mapCfSslStatus(cfSslStatus);

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
    })
    .where(eq(projectsTable.id, project.id));

  res.json({ ok: true, acknowledged: true, matched: true, newSslStatus });
});
