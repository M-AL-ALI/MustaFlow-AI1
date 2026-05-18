// ─────────────────────────────────────────────────────────────────────────────
// Domain management routes
//
//   GET    /api/projects/:id/domain         — current domain info + subdomain
//   PATCH  /api/projects/:id/domain         — set / clear custom domain
//   POST   /api/projects/:id/domain/verify  — trigger DNS CNAME verification
//   DELETE /api/projects/:id/domain         — remove custom domain
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, isNull, and } from "drizzle-orm";
import { promises as dns } from "dns";
import { db, projectsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";

const router: IRouter = Router();

/** Canonical CNAME target that users must point their domain to. */
const CNAME_TARGET =
  process.env.PLATFORM_CNAME_TARGET ?? "hosted.mustaflow.app";

/** Platform root domain used to build auto-subdomains. */
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

function buildSubdomain(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return `${slug}.${PLATFORM_DOMAIN}`;
}

// ── GET /api/projects/:id/domain ─────────────────────────────────────────────
router.get(
  "/projects/:id/domain",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const [project] = await db
      .select({
        id: projectsTable.id,
        publicSlug: projectsTable.publicSlug,
        customDomain: projectsTable.customDomain,
        domainStatus: projectsTable.domainStatus,
        sslStatus: projectsTable.sslStatus,
        publishedSnapshotId: projectsTable.publishedSnapshotId,
      })
      .from(projectsTable)
      .where(
        and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)),
      );

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    res.json({
      subdomain: buildSubdomain(project.publicSlug),
      subdomainUrl: project.publicSlug
        ? `https://${buildSubdomain(project.publicSlug)}`
        : null,
      cnameTarget: CNAME_TARGET,
      platformDomain: PLATFORM_DOMAIN,
      customDomain: project.customDomain ?? null,
      domainStatus: project.domainStatus,
      sslStatus: project.sslStatus,
      isPublished: project.publishedSnapshotId !== null,
    });
  },
);

// ── PATCH /api/projects/:id/domain ───────────────────────────────────────────
router.patch(
  "/projects/:id/domain",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const { customDomain } = req.body as { customDomain?: string | null };

    if (customDomain !== undefined && customDomain !== null) {
      // Basic validation: must look like a hostname
      const cleaned = String(customDomain).trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
      const hostnameRe = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
      if (!hostnameRe.test(cleaned)) {
        res.status(400).json({ error: "Invalid domain format. Use a bare hostname like app.example.com" });
        return;
      }

      await db
        .update(projectsTable)
        .set({
          customDomain: cleaned,
          domainStatus: "pending_verification",
          sslStatus: "pending",
          updatedAt: new Date(),
        })
        .where(eq(projectsTable.id, projectId));

      res.json({
        customDomain: cleaned,
        domainStatus: "pending_verification",
        sslStatus: "pending",
        cnameTarget: CNAME_TARGET,
      });
    } else {
      // Clear the custom domain
      await db
        .update(projectsTable)
        .set({
          customDomain: null,
          domainStatus: "unconfigured",
          sslStatus: "pending",
          updatedAt: new Date(),
        })
        .where(eq(projectsTable.id, projectId));

      res.json({ customDomain: null, domainStatus: "unconfigured" });
    }
  },
);

// ── DELETE /api/projects/:id/domain ──────────────────────────────────────────
router.delete(
  "/projects/:id/domain",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    await db
      .update(projectsTable)
      .set({
        customDomain: null,
        domainStatus: "unconfigured",
        sslStatus: "pending",
        updatedAt: new Date(),
      })
      .where(eq(projectsTable.id, projectId));

    res.json({ customDomain: null, domainStatus: "unconfigured" });
  },
);

// ── POST /api/projects/:id/domain/verify ─────────────────────────────────────
router.post(
  "/projects/:id/domain/verify",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const [project] = await db
      .select({
        customDomain: projectsTable.customDomain,
      })
      .from(projectsTable)
      .where(
        and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)),
      );

    if (!project || !project.customDomain) {
      res.status(400).json({ error: "No custom domain configured" });
      return;
    }

    const domain = project.customDomain;

    try {
      // Attempt to resolve CNAME for the custom domain.
      // We accept if any CNAME record points at our CNAME_TARGET (or a subdomain of it).
      let cnameRecords: string[] = [];
      try {
        cnameRecords = await dns.resolveCname(domain);
      } catch {
        // CNAME lookup failed — could be propagation delay or wrong record type
        cnameRecords = [];
      }

      const targetBase = CNAME_TARGET.replace(/\.$/, "").toLowerCase();
      const verified = cnameRecords.some((r) =>
        r.replace(/\.$/, "").toLowerCase().endsWith(targetBase),
      );

      if (verified) {
        await db
          .update(projectsTable)
          .set({
            domainStatus: "active",
            sslStatus: "provisioning",
            updatedAt: new Date(),
          })
          .where(eq(projectsTable.id, projectId));

        res.json({
          verified: true,
          domainStatus: "active",
          sslStatus: "provisioning",
          message: `CNAME verified. SSL is being provisioned for ${domain}.`,
        });
      } else {
        await db
          .update(projectsTable)
          .set({ domainStatus: "error", updatedAt: new Date() })
          .where(eq(projectsTable.id, projectId));

        res.json({
          verified: false,
          domainStatus: "error",
          cnameFound: cnameRecords,
          cnameExpected: CNAME_TARGET,
          message: `CNAME not found. Add a CNAME record: ${domain} → ${CNAME_TARGET}`,
        });
      }
    } catch (err) {
      req.log.warn({ err, domain }, "Domain verification error");
      res.status(500).json({ error: "Verification check failed. Please try again." });
    }
  },
);

export default router;
