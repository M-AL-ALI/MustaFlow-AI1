// ─────────────────────────────────────────────────────────────────────────────
// Domain management routes
//
//   GET    /api/projects/:id/domain         — current domain info + subdomain
//   PATCH  /api/projects/:id/domain         — set / clear custom domain
//   POST   /api/projects/:id/domain/verify  — trigger DNS CNAME or TXT verification
//   DELETE /api/projects/:id/domain         — remove custom domain
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, isNull, and } from "drizzle-orm";
import { promises as dns } from "dns";
import { randomBytes } from "crypto";
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

/** Generate a fresh verification token. Format: mustaflow-verify=<32-hex-chars> */
function generateVerificationToken(): string {
  return `mustaflow-verify=${randomBytes(16).toString("hex")}`;
}

/** Catch PostgreSQL unique-constraint violation (code 23505). */
function isDuplicateKeyError(err: unknown): boolean {
  if (err && typeof err === "object" && "code" in err) {
    return (err as { code: string }).code === "23505";
  }
  return false;
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
        verificationToken: projectsTable.verificationToken,
      })
      .from(projectsTable)
      .where(
        and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)),
      );

    if (!project) {
      res.status(404).json({ error: "Project not found" });
      return;
    }

    const txtName = project.customDomain
      ? `_mustaflow.${project.customDomain}`
      : null;

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
      // TXT ownership verification
      verificationToken: project.verificationToken ?? null,
      txtName,
      txtValue: project.verificationToken ?? null,
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
      const cleaned = String(customDomain)
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");

      const hostnameRe = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
      if (!hostnameRe.test(cleaned)) {
        res.status(400).json({
          error:
            "Invalid domain format. Use a bare hostname like app.example.com — no protocol, no trailing slash.",
        });
        return;
      }

      // Warn on apex/root domain (no subdomain prefix) — recommend www or a subdomain
      const parts = cleaned.split(".");
      if (parts.length === 2) {
        res.status(400).json({
          error:
            "Apex (root) domains require special DNS records that vary by provider. Use a subdomain instead, e.g. www.example.com or app.example.com.",
        });
        return;
      }

      // Fetch existing token so we preserve it on re-save of the same domain
      const [existing] = await db
        .select({ verificationToken: projectsTable.verificationToken, customDomain: projectsTable.customDomain })
        .from(projectsTable)
        .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

      const token =
        existing?.customDomain === cleaned && existing.verificationToken
          ? existing.verificationToken
          : generateVerificationToken();

      try {
        await db
          .update(projectsTable)
          .set({
            customDomain: cleaned,
            domainStatus: "pending_verification",
            sslStatus: "pending",
            verificationToken: token,
            updatedAt: new Date(),
          })
          .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
      } catch (err) {
        if (isDuplicateKeyError(err)) {
          res.status(409).json({
            error: "This domain is already connected to another project.",
          });
          return;
        }
        throw err;
      }

      res.json({
        customDomain: cleaned,
        domainStatus: "pending_verification",
        sslStatus: "pending",
        cnameTarget: CNAME_TARGET,
        verificationToken: token,
        txtName: `_mustaflow.${cleaned}`,
        txtValue: token,
      });
    } else {
      // Clear the custom domain
      await db
        .update(projectsTable)
        .set({
          customDomain: null,
          domainStatus: "unconfigured",
          sslStatus: "pending",
          verificationToken: null,
          updatedAt: new Date(),
        })
        .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

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
        verificationToken: null,
        updatedAt: new Date(),
      })
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    res.json({ customDomain: null, domainStatus: "unconfigured" });
  },
);

// ── POST /api/projects/:id/domain/verify ─────────────────────────────────────
//
// Accepts both verification methods:
//   1. TXT record: _mustaflow.<domain>  =  mustaflow-verify=<token>  (preferred)
//   2. CNAME record: <domain>  →  hosted.mustaflow.app
//
// If either passes, the domain is marked active.
// SSL stays in "provisioning" state (manual cert setup required — not automated).
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/projects/:id/domain/verify",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);

    const [project] = await db
      .select({
        customDomain: projectsTable.customDomain,
        verificationToken: projectsTable.verificationToken,
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
    const token = project.verificationToken;
    const txtLookup = `_mustaflow.${domain}`;

    let txtVerified = false;
    let cnameVerified = false;
    let cnameRecords: string[] = [];
    let txtRecords: string[][] = [];

    try {
      // ── TXT check ──────────────────────────────────────────────────────────
      if (token) {
        try {
          txtRecords = await dns.resolveTxt(txtLookup);
          txtVerified = txtRecords
            .flat()
            .some((v) => v.trim() === token.trim());
        } catch {
          txtVerified = false;
        }
      }

      // ── CNAME check ────────────────────────────────────────────────────────
      const targetBase = CNAME_TARGET.replace(/\.$/, "").toLowerCase();
      try {
        cnameRecords = await dns.resolveCname(domain);
        cnameVerified = cnameRecords.some((r) =>
          r.replace(/\.$/, "").toLowerCase().endsWith(targetBase),
        );
      } catch {
        cnameVerified = false;
      }

      const verified = txtVerified || cnameVerified;
      const method = txtVerified ? "txt" : cnameVerified ? "cname" : null;

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
          method,
          domainStatus: "active",
          sslStatus: "provisioning",
          message: `Domain ownership confirmed via ${method === "txt" ? "TXT record" : "CNAME"}. SSL requires manual certificate setup — see your infrastructure team.`,
        });
      } else {
        // Build a specific, actionable error message
        const hints: string[] = [];

        if (token) {
          hints.push(
            `TXT not found — add a TXT record named "${txtLookup}" with value "${token}".`,
          );
        }

        if (cnameRecords.length > 0) {
          hints.push(
            `CNAME points to "${cnameRecords.join(", ")}" but must point to "${CNAME_TARGET}".`,
          );
        } else {
          hints.push(
            `CNAME not found — add a CNAME record for "${domain}" pointing to "${CNAME_TARGET}".`,
          );
        }

        hints.push(
          "DNS changes can take up to 48 hours to propagate.",
        );

        await db
          .update(projectsTable)
          .set({ domainStatus: "error", updatedAt: new Date() })
          .where(eq(projectsTable.id, projectId));

        res.json({
          verified: false,
          domainStatus: "error",
          txtLookup,
          txtExpected: token ?? "(no token — save domain first)",
          txtFound: txtRecords.flat(),
          cnameLookup: domain,
          cnameFound: cnameRecords,
          cnameExpected: CNAME_TARGET,
          message: hints.join(" "),
        });
      }
    } catch (err) {
      req.log.warn({ err, domain }, "Domain verification error");
      res.status(500).json({
        error: "DNS check failed — this can happen during heavy propagation. Please try again in a few minutes.",
      });
    }
  },
);

export default router;
