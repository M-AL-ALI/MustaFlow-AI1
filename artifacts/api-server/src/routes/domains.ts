// ─────────────────────────────────────────────────────────────────────────────
// Multi-domain management routes — Task #552
//
//   GET    /api/projects/:id/domains                    — list attached domains
//   POST   /api/projects/:id/domains                    — attach a new domain
//   DELETE /api/projects/:id/domains/:domainId          — detach a domain
//   PATCH  /api/projects/:id/domains/:domainId/primary  — set as primary domain
//   PATCH  /api/projects/:id/domains/:domainId/www-redirect — toggle www↔apex redirect
//   POST   /api/projects/:id/domains/:domainId/verify   — trigger DNS verification
//   GET    /api/projects/:id/domains/:domainId/diagnose — live diagnostic checks
//
// Legacy single-slot routes are kept for backward compatibility:
//   GET    /api/projects/:id/domain
//   PATCH  /api/projects/:id/domain
//   DELETE /api/projects/:id/domain
//   POST   /api/projects/:id/domain/verify
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, isNull, and, asc } from "drizzle-orm";
import { promises as dns } from "dns";
import { randomBytes } from "crypto";
import { db, projectsTable, projectDomainsTable, deploymentLogsTable } from "@workspace/db";
import { requireProjectOwnership } from "../lib/auth";
import { activateSslForProject } from "./ssl";
import { createLimiterForDomainVerify } from "../lib/rateLimit";
import { publishDomainEvent } from "../lib/event-bus";

const router: IRouter = Router();

const CNAME_TARGET = process.env.PLATFORM_CNAME_TARGET ?? "hosted.mustaflow.app";
const PLATFORM_DOMAIN = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";

// ── Cloudflare proxy IP ranges (IPv4 CIDR) ────────────────────────────────────
// When A-record verification resolves to one of these IPs the domain is proxied
// through Cloudflare, which means the real DNS record is hidden. We surface a
// clear error instead of a confusing "CNAME not found" message.
const CLOUDFLARE_IP_RANGES = [
  "173.245.48.",
  "103.21.244.",
  "103.22.200.",
  "103.31.4.",
  "141.101.64.",
  "108.162.192.",
  "190.93.240.",
  "188.114.96.",
  "197.234.240.",
  "198.41.128.",
  "162.158.0.",
  "104.16.",
  "104.17.",
  "104.18.",
  "104.19.",
  "104.20.",
  "104.21.",
  "104.22.",
  "104.23.",
  "104.24.",
  "104.25.",
  "104.26.",
  "104.27.",
  "104.28.",
  "172.64.",
  "172.65.",
  "172.66.",
  "172.67.",
  "172.68.",
  "172.69.",
  "172.70.",
  "172.71.",
];

// ── Reserved subdomain label blocklist ───────────────────────────────────────
// Prevents users from attaching e.g. "admin.mustaflow.app" as a project domain.
// We only guard the first label of the entered hostname, not the full domain.
const RESERVED_LABELS = new Set([
  "admin",
  "api",
  "www",
  "mail",
  "smtp",
  "imap",
  "pop",
  "pop3",
  "ftp",
  "sftp",
  "ssh",
  "vpn",
  "ns",
  "ns1",
  "ns2",
  "dns",
  "mx",
  "relay",
  "support",
  "help",
  "status",
  "blog",
  "app",
  "dev",
  "staging",
  "test",
  "demo",
  "beta",
  "alpha",
  "cdn",
  "static",
  "assets",
  "media",
  "img",
  "images",
  "files",
  "upload",
  "uploads",
  "download",
  "downloads",
  "docs",
  "documentation",
  "portal",
  "dashboard",
  "panel",
  "console",
  "control",
  "manage",
  "management",
  "monitor",
  "monitoring",
  "analytics",
  "metrics",
  "health",
  "ping",
  "webhook",
  "webhooks",
  "auth",
  "login",
  "logout",
  "signup",
  "register",
  "account",
  "accounts",
  "billing",
  "payment",
  "payments",
  "shop",
  "store",
  "checkout",
  "cart",
  "socket",
  "ws",
  "wss",
  "graphql",
  "rpc",
  "grpc",
  "internal",
  "private",
  "corp",
  "intranet",
  "local",
  "localhost",
  "mustaflow",
]);

function generateVerificationToken(): string {
  return `mustaflow-verify=${randomBytes(16).toString("hex")}`;
}

function buildSubdomain(slug: string | null | undefined): string | null {
  if (!slug) return null;
  return `${slug}.${PLATFORM_DOMAIN}`;
}

function isDuplicateKeyError(err: unknown): boolean {
  return !!(
    err &&
    typeof err === "object" &&
    "code" in err &&
    (err as { code: string }).code === "23505"
  );
}

/** Normalise a user-supplied hostname to a clean ASCII punycode label sequence.
 *  Returns null if the input is invalid (too long, bad chars, trailing dot, etc).
 */
function normaliseHostname(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, ""); // strip trailing dot

  if (!cleaned) return null;
  if (cleaned.length > 253) return null;

  // Try IDNA / Punycode normalisation via the URL API (uses the platform's built-in
  // ICU/IDNA table — no external package needed).
  try {
    const url = new URL(`http://${cleaned}`);
    const normalized = url.hostname;
    // Validate the resulting ASCII hostname
    const hostnameRe = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;
    if (!hostnameRe.test(normalized)) return null;
    return normalized;
  } catch {
    return null;
  }
}

/** Detect whether the first label of a platform-subdomain is reserved. */
function isReservedPlatformLabel(hostname: string): boolean {
  const firstLabel = hostname.split(".")[0] ?? "";
  return RESERVED_LABELS.has(firstLabel);
}

/** Detect whether an IP address belongs to a known Cloudflare proxy range. */
function isCloudflareIp(ip: string): boolean {
  return CLOUDFLARE_IP_RANGES.some((prefix) => ip.startsWith(prefix));
}

/** Write an audit row to deployment_logs for a domain action. */
async function writeDomainAudit(opts: {
  projectId: number;
  userId: string;
  action: string;
  hostname: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
}): Promise<void> {
  try {
    await db.insert(deploymentLogsTable).values({
      projectId: opts.projectId,
      userId: opts.userId,
      env: "domain",
      status: "passed",
      note: JSON.stringify({
        action: opts.action,
        hostname: opts.hostname,
        before: opts.before ?? null,
        after: opts.after ?? null,
      }),
    });
  } catch {
    /* best-effort — never throw from audit */
  }
}

// ── Rate limiter: 10 verify calls per minute per user+IP ─────────────────────
const domainVerifyLimiter = createLimiterForDomainVerify({
  windowMs: 60_000,
  max: 10,
  keyPrefix: "domain_verify",
  message: "Too many DNS verification attempts. Please wait before checking again.",
});

// ── Helper: get project + ownership check ────────────────────────────────────
async function getProjectOrNull(projectId: number) {
  const [project] = await db
    .select({
      id: projectsTable.id,
      publicSlug: projectsTable.publicSlug,
      customDomain: projectsTable.customDomain,
      domainStatus: projectsTable.domainStatus,
      sslStatus: projectsTable.sslStatus,
      publishedSnapshotId: projectsTable.publishedSnapshotId,
      verificationToken: projectsTable.verificationToken,
      cfHostnameId: projectsTable.cfHostnameId,
      redirectWwwApex: projectsTable.redirectWwwApex,
    })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
  return project ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW COLLECTION ROUTES
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/projects/:id/domains ─────────────────────────────────────────────
router.get("/projects/:id/domains", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);

  const project = await getProjectOrNull(projectId);
  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const domains = await db
    .select()
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.projectId, projectId))
    .orderBy(asc(projectDomainsTable.createdAt));

  res.json({
    domains,
    subdomain: buildSubdomain(project.publicSlug),
    subdomainUrl: project.publicSlug ? `https://${buildSubdomain(project.publicSlug)}` : null,
    cnameTarget: CNAME_TARGET,
    platformDomain: PLATFORM_DOMAIN,
    redirectWwwApex: project.redirectWwwApex,
  });
});

// ── POST /api/projects/:id/domains ────────────────────────────────────────────
router.post("/projects/:id/domains", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const userId = (req as { userId?: string }).userId ?? "unknown";
  const { hostname: rawHostname } = req.body as { hostname?: string };

  if (!rawHostname) {
    res.status(400).json({ error: "hostname is required." });
    return;
  }

  const hostname = normaliseHostname(rawHostname);
  if (!hostname) {
    res.status(400).json({
      error:
        "Invalid domain. Use a bare hostname like app.example.com or münchen.de — no protocol, no trailing slash, no path.",
    });
    return;
  }

  // Check reserved labels (only relevant when the user is trying to use a platform subdomain)
  if (hostname.endsWith("." + PLATFORM_DOMAIN) && isReservedPlatformLabel(hostname)) {
    res.status(400).json({
      error: `The subdomain label "${hostname.split(".")[0]}" is reserved and cannot be used.`,
    });
    return;
  }

  // Determine record type: apex domains (2 labels, e.g. "example.com") use A records;
  // subdomains use CNAME.
  const labels = hostname.split(".");
  const recordType: "a" | "cname" = labels.length === 2 ? "a" : "cname";

  const token = generateVerificationToken();

  // Count existing domains to determine if this should be primary
  const existing = await db
    .select({ id: projectDomainsTable.id })
    .from(projectDomainsTable)
    .where(eq(projectDomainsTable.projectId, projectId));

  const isPrimary = existing.length === 0;

  try {
    const [newDomain] = await db
      .insert(projectDomainsTable)
      .values({
        projectId,
        hostname,
        isPrimary,
        recordType,
        verificationToken: token,
        verificationStatus: "pending",
        sslStatus: "pending",
      })
      .returning();

    // Emit event to hot-reload routing table
    publishDomainEvent({ type: "added", hostname, projectId });

    await writeDomainAudit({
      projectId,
      userId,
      action: "domain_attached",
      hostname,
      after: { recordType, isPrimary },
    });

    // Keep legacy projects.customDomain in sync with primary domain
    if (isPrimary) {
      await db
        .update(projectsTable)
        .set({
          customDomain: hostname,
          domainStatus: "pending_verification",
          verificationToken: token,
          updatedAt: new Date(),
        })
        .where(eq(projectsTable.id, projectId));
    }

    res.status(201).json({
      domain: newDomain,
      cnameTarget: CNAME_TARGET,
      txtName: `_mustaflow.${hostname}`,
      txtValue: token,
    });
  } catch (err) {
    if (isDuplicateKeyError(err)) {
      res.status(409).json({ error: "This domain is already attached to a project." });
      return;
    }
    throw err;
  }
});

// ── DELETE /api/projects/:id/domains/:domainId ────────────────────────────────
router.delete(
  "/projects/:id/domains/:domainId",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const [domain] = await db
      .select()
      .from(projectDomainsTable)
      .where(
        and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    await db.delete(projectDomainsTable).where(eq(projectDomainsTable.id, domainId));

    // Emit event to hot-reload routing table
    publishDomainEvent({ type: "removed", hostname: domain.hostname, projectId });

    await writeDomainAudit({
      projectId,
      userId,
      action: "domain_detached",
      hostname: domain.hostname,
      before: { isPrimary: domain.isPrimary, verificationStatus: domain.verificationStatus },
    });

    // If this was the primary domain, promote the next domain (if any)
    if (domain.isPrimary) {
      const [next] = await db
        .select()
        .from(projectDomainsTable)
        .where(eq(projectDomainsTable.projectId, projectId))
        .orderBy(asc(projectDomainsTable.createdAt))
        .limit(1);

      if (next) {
        await db
          .update(projectDomainsTable)
          .set({ isPrimary: true, updatedAt: new Date() })
          .where(eq(projectDomainsTable.id, next.id));

        // Sync legacy column
        await db
          .update(projectsTable)
          .set({ customDomain: next.hostname, updatedAt: new Date() })
          .where(eq(projectsTable.id, projectId));
      } else {
        // No more domains — clear legacy column
        await db
          .update(projectsTable)
          .set({ customDomain: null, domainStatus: "unconfigured", updatedAt: new Date() })
          .where(eq(projectsTable.id, projectId));
      }
    }

    res.json({ deleted: true });
  },
);

// ── PATCH /api/projects/:id/domains/:domainId/primary ─────────────────────────
router.patch(
  "/projects/:id/domains/:domainId/primary",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const [domain] = await db
      .select()
      .from(projectDomainsTable)
      .where(
        and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    // Clear primary flag on all sibling domains
    await db
      .update(projectDomainsTable)
      .set({ isPrimary: false, updatedAt: new Date() })
      .where(eq(projectDomainsTable.projectId, projectId));

    // Set this domain as primary
    await db
      .update(projectDomainsTable)
      .set({ isPrimary: true, updatedAt: new Date() })
      .where(eq(projectDomainsTable.id, domainId));

    // Sync legacy column
    await db
      .update(projectsTable)
      .set({ customDomain: domain.hostname, updatedAt: new Date() })
      .where(eq(projectsTable.id, projectId));

    await writeDomainAudit({
      projectId,
      userId,
      action: "domain_set_primary",
      hostname: domain.hostname,
    });

    res.json({ domainId, isPrimary: true });
  },
);

// ── PATCH /api/projects/:id/domains/:domainId/www-redirect ────────────────────
router.patch(
  "/projects/:id/domains/:domainId/www-redirect",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";
    const { enabled } = req.body as { enabled?: boolean };

    if (typeof enabled !== "boolean") {
      res.status(400).json({ error: "enabled (boolean) is required." });
      return;
    }

    const [domain] = await db
      .select()
      .from(projectDomainsTable)
      .where(
        and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    await db
      .update(projectsTable)
      .set({ redirectWwwApex: enabled, updatedAt: new Date() })
      .where(eq(projectsTable.id, projectId));

    await writeDomainAudit({
      projectId,
      userId,
      action: "domain_www_redirect_toggled",
      hostname: domain.hostname,
      after: { redirectWwwApex: enabled },
    });

    res.json({ redirectWwwApex: enabled });
  },
);

// ── POST /api/projects/:id/domains/:domainId/verify ───────────────────────────
router.post(
  "/projects/:id/domains/:domainId/verify",
  requireProjectOwnership,
  domainVerifyLimiter,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const [domain] = await db
      .select()
      .from(projectDomainsTable)
      .where(
        and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const { hostname, verificationToken: token, recordType } = domain;
    const txtLookup = `_mustaflow.${hostname}`;
    const isApex = recordType === "a";

    let txtVerified = false;
    let recordVerified = false;
    let txtRecords: string[][] = [];
    let cnameRecords: string[] = [];
    let aRecords: string[] = [];
    let cfProxied = false;

    try {
      // ── TXT ownership check ────────────────────────────────────────────────
      try {
        txtRecords = await dns.resolveTxt(txtLookup);
        txtVerified = txtRecords.flat().some((v) => v.trim() === token.trim());
      } catch {
        txtVerified = false;
      }

      // ── DNS record check (CNAME for subdomain, A for apex) ─────────────────
      const targetBase = CNAME_TARGET.replace(/\.$/, "").toLowerCase();
      if (isApex) {
        try {
          aRecords = await dns.resolve4(hostname);
          // Check for Cloudflare proxy
          cfProxied = aRecords.some(isCloudflareIp);
          if (cfProxied) {
            // CF-proxied A record: warn the user clearly but still treat as
            // "record present" if TXT is verified (ownership is proven).
            recordVerified = false; // A record must point to our IPs (no CF proxy)
          } else {
            recordVerified = aRecords.length > 0; // Any A record present = pointing somewhere
          }
        } catch {
          recordVerified = false;
        }
      } else {
        try {
          cnameRecords = await dns.resolveCname(hostname);
          recordVerified = cnameRecords.some((r) =>
            r.replace(/\.$/, "").toLowerCase().endsWith(targetBase),
          );
          // Check for CF proxy on CNAME resolution too
          if (!recordVerified) {
            // Resolve to IPs and check for CF proxy
            try {
              const ips = await dns.resolve4(hostname);
              cfProxied = ips.some(isCloudflareIp);
            } catch {
              /* ignore */
            }
          }
        } catch {
          recordVerified = false;
        }
      }

      // Both TXT and DNS record must pass for full verification
      const verified = txtVerified && (recordVerified || (isApex && txtVerified));
      // For apex: TXT is sufficient if A record exists (even if not pointing to us yet)
      const apexTxtSufficient = isApex && txtVerified && aRecords.length > 0;
      const finalVerified = verified || apexTxtSufficient;

      if (finalVerified) {
        await db
          .update(projectDomainsTable)
          .set({
            verificationStatus: "verified",
            verifiedAt: new Date(),
            sslStatus: "provisioning",
            updatedAt: new Date(),
          })
          .where(eq(projectDomainsTable.id, domainId));

        // Sync legacy projects table if this is the primary domain
        if (domain.isPrimary) {
          await db
            .update(projectsTable)
            .set({
              domainStatus: "active",
              sslStatus: "provisioning",
              domainVerifiedAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(projectsTable.id, projectId));

          // Auto-trigger SSL (best-effort, non-fatal)
          const [proj] = await db
            .select({ cfHostnameId: projectsTable.cfHostnameId })
            .from(projectsTable)
            .where(eq(projectsTable.id, projectId));
          void activateSslForProject(projectId, hostname, proj?.cfHostnameId).catch(() => {
            /* best-effort */
          });
        }

        publishDomainEvent({ type: "verified", hostname, projectId });

        await writeDomainAudit({
          projectId,
          userId,
          action: "domain_verified",
          hostname,
          after: { method: txtVerified ? "txt" : isApex ? "a_record" : "cname" },
        });

        res.json({
          verified: true,
          domainId,
          hostname,
          verificationStatus: "verified",
          sslStatus: "provisioning",
          method: txtVerified ? "txt" : isApex ? "a_record" : "cname",
          message: `Domain ownership confirmed. SSL activation has been triggered.`,
        });
      } else {
        const hints: string[] = [];

        if (!txtVerified) {
          hints.push(
            `TXT not found — add a TXT record named "${txtLookup}" with value "${token}".`,
          );
        }

        if (cfProxied) {
          hints.push(
            `Your domain appears to be proxied through Cloudflare (orange cloud). Disable the Cloudflare proxy (grey cloud) so we can verify DNS ownership.`,
          );
        } else if (isApex) {
          if (aRecords.length === 0) {
            hints.push(`No A record found for "${hostname}". Add an A record pointing to our IP.`);
          }
        } else {
          if (cnameRecords.length > 0) {
            hints.push(
              `CNAME points to "${cnameRecords.join(", ")}" but must point to "${CNAME_TARGET}".`,
            );
          } else {
            hints.push(
              `CNAME not found — add a CNAME record for "${hostname}" pointing to "${CNAME_TARGET}".`,
            );
          }
        }

        hints.push("DNS changes can take up to 48 hours to propagate.");

        await db
          .update(projectDomainsTable)
          .set({ verificationStatus: "failed", updatedAt: new Date() })
          .where(eq(projectDomainsTable.id, domainId));

        await writeDomainAudit({
          projectId,
          userId,
          action: "domain_verify_failed",
          hostname,
          after: { cfProxied, txtVerified, recordVerified },
        });

        res.json({
          verified: false,
          domainId,
          hostname,
          verificationStatus: "failed",
          txtLookup,
          txtExpected: token,
          txtFound: txtRecords.flat(),
          ...(isApex
            ? { aLookup: hostname, aFound: aRecords }
            : { cnameLookup: hostname, cnameFound: cnameRecords, cnameExpected: CNAME_TARGET }),
          cfProxied,
          message: hints.join(" "),
        });
      }
    } catch (err) {
      req.log.warn({ err, hostname }, "Domain verification error");
      res.status(500).json({
        error: "DNS check failed. This can happen during heavy propagation. Please try again.",
      });
    }
  },
);

// ── GET /api/projects/:id/domains/:domainId/diagnose ──────────────────────────
router.get(
  "/projects/:id/domains/:domainId/diagnose",
  requireProjectOwnership,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const domainId = Number(req.params.domainId);

    const [domain] = await db
      .select()
      .from(projectDomainsTable)
      .where(
        and(eq(projectDomainsTable.id, domainId), eq(projectDomainsTable.projectId, projectId)),
      );

    if (!domain) {
      res.status(404).json({ error: "Domain not found" });
      return;
    }

    const { hostname, verificationToken: token, recordType } = domain;
    const isApex = recordType === "a";

    const checks: Array<{
      id: string;
      label: string;
      passed: boolean | null;
      detail: string;
      fixHint?: string;
    }> = [];

    // Check 1: DNS resolves
    let resolvedIps: string[] = [];
    let resolvedCnames: string[] = [];
    let dnsResolvesOk = false;
    try {
      if (isApex) {
        resolvedIps = await dns.resolve4(hostname);
        dnsResolvesOk = resolvedIps.length > 0;
      } else {
        resolvedCnames = await dns.resolveCname(hostname);
        dnsResolvesOk = resolvedCnames.length > 0;
      }
    } catch {
      dnsResolvesOk = false;
    }
    checks.push({
      id: "dns_resolves",
      label: "DNS resolves",
      passed: dnsResolvesOk,
      detail: dnsResolvesOk
        ? `Resolves to: ${isApex ? resolvedIps.join(", ") : resolvedCnames.join(", ")}`
        : `No DNS records found for ${hostname}`,
      fixHint: dnsResolvesOk
        ? undefined
        : `Add ${isApex ? "an A record" : "a CNAME record"} for ${hostname} in your DNS provider.`,
    });

    // Check 2: Record matches expected target
    let recordMatchOk = false;
    let cfProxied = false;
    if (dnsResolvesOk) {
      if (isApex) {
        cfProxied = resolvedIps.some(isCloudflareIp);
        recordMatchOk = !cfProxied && resolvedIps.length > 0;
      } else {
        const targetBase = CNAME_TARGET.replace(/\.$/, "").toLowerCase();
        recordMatchOk = resolvedCnames.some((r) =>
          r.replace(/\.$/, "").toLowerCase().endsWith(targetBase),
        );
      }
    }
    checks.push({
      id: "record_match",
      label: isApex ? "A record not Cloudflare-proxied" : `CNAME → ${CNAME_TARGET}`,
      passed: recordMatchOk,
      detail: cfProxied
        ? "Domain is proxied through Cloudflare (orange cloud). Disable the proxy."
        : isApex
          ? recordMatchOk
            ? `A record points to ${resolvedIps.join(", ")}`
            : "A record missing or Cloudflare-proxied"
          : recordMatchOk
            ? `CNAME → ${resolvedCnames.join(", ")}`
            : `CNAME points to ${resolvedCnames.join(", ") || "nothing"} — expected ${CNAME_TARGET}`,
      fixHint: cfProxied
        ? "In Cloudflare DNS, click the orange cloud icon next to your domain to turn it grey (DNS-only)."
        : isApex
          ? undefined
          : `Set your CNAME value to ${CNAME_TARGET}`,
    });

    // Check 3: TXT ownership proof
    let txtVerified = false;
    let txtRecords: string[][] = [];
    const txtName = `_mustaflow.${hostname}`;
    try {
      txtRecords = await dns.resolveTxt(txtName);
      txtVerified = txtRecords.flat().some((v) => v.trim() === token.trim());
    } catch {
      txtVerified = false;
    }
    checks.push({
      id: "txt_proof",
      label: "TXT ownership proof",
      passed: txtVerified,
      detail: txtVerified
        ? `TXT record found with correct token`
        : txtRecords.length > 0
          ? `TXT found but token mismatch: found [${txtRecords.flat().join(", ")}]`
          : `No TXT record at ${txtName}`,
      fixHint: txtVerified ? undefined : `Add TXT record: name="${txtName}", value="${token}"`,
    });

    // Check 4: Hostname middleware sighted
    const hostnameMiddlewareSeen = domainHasBeenSighted(hostname);
    checks.push({
      id: "middleware_sighted",
      label: "Hostname routing active",
      passed: hostnameMiddlewareSeen,
      detail: hostnameMiddlewareSeen
        ? "Hostname seen in recent requests — routing is active"
        : "No requests seen for this hostname yet. Visit your domain to activate routing.",
    });

    // Overall result
    const allRequired = checks.filter((c) => c.id !== "middleware_sighted");
    const allPassed = allRequired.every((c) => c.passed === true);

    res.json({
      hostname,
      isApex,
      recordType,
      verificationStatus: domain.verificationStatus,
      sslStatus: domain.sslStatus,
      checks,
      allPassed,
      cnameTarget: CNAME_TARGET,
      txtName,
      txtValue: token,
    });
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// LEGACY SINGLE-SLOT ROUTES (backward compatibility)
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /api/projects/:id/domain ─────────────────────────────────────────────
router.get("/projects/:id/domain", requireProjectOwnership, async (req, res): Promise<void> => {
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
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (!project) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const txtName = project.customDomain ? `_mustaflow.${project.customDomain}` : null;

  res.json({
    subdomain: buildSubdomain(project.publicSlug),
    subdomainUrl: project.publicSlug ? `https://${buildSubdomain(project.publicSlug)}` : null,
    cnameTarget: CNAME_TARGET,
    platformDomain: PLATFORM_DOMAIN,
    customDomain: project.customDomain ?? null,
    domainStatus: project.domainStatus,
    sslStatus: project.sslStatus,
    isPublished: project.publishedSnapshotId !== null,
    verificationToken: project.verificationToken ?? null,
    txtName,
    txtValue: project.verificationToken ?? null,
  });
});

// ── PATCH /api/projects/:id/domain ───────────────────────────────────────────
router.patch("/projects/:id/domain", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const userId = (req as { userId?: string }).userId ?? "unknown";
  const { customDomain } = req.body as { customDomain?: string | null };

  if (customDomain !== undefined && customDomain !== null) {
    const hostname = normaliseHostname(String(customDomain));

    if (!hostname) {
      res.status(400).json({
        error:
          "Invalid domain format. Use a bare hostname like app.example.com — no protocol, no trailing slash.",
      });
      return;
    }

    // Fetch existing token so we preserve it on re-save of the same domain
    const [existing] = await db
      .select({
        verificationToken: projectsTable.verificationToken,
        customDomain: projectsTable.customDomain,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    const token =
      existing?.customDomain === hostname && existing.verificationToken
        ? existing.verificationToken
        : generateVerificationToken();

    try {
      await db
        .update(projectsTable)
        .set({
          customDomain: hostname,
          domainStatus: "pending_verification",
          sslStatus: "pending",
          verificationToken: token,
          updatedAt: new Date(),
        })
        .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        res.status(409).json({ error: "This domain is already connected to another project." });
        return;
      }
      throw err;
    }

    // Upsert into project_domains for consistency
    const existingDomains = await db
      .select({ id: projectDomainsTable.id })
      .from(projectDomainsTable)
      .where(
        and(
          eq(projectDomainsTable.projectId, projectId),
          eq(projectDomainsTable.hostname, hostname),
        ),
      );

    if (existingDomains.length === 0) {
      const labels = hostname.split(".");
      const recordType: "a" | "cname" = labels.length === 2 ? "a" : "cname";
      try {
        await db.insert(projectDomainsTable).values({
          projectId,
          hostname,
          isPrimary: true,
          recordType,
          verificationToken: token,
          verificationStatus: "pending",
          sslStatus: "pending",
        });
        publishDomainEvent({ type: "added", hostname, projectId });
      } catch {
        /* ignore — may already exist */
      }
    }

    await writeDomainAudit({ projectId, userId, action: "domain_set_legacy", hostname });

    res.json({
      customDomain: hostname,
      domainStatus: "pending_verification",
      sslStatus: "pending",
      cnameTarget: CNAME_TARGET,
      verificationToken: token,
      txtName: `_mustaflow.${hostname}`,
      txtValue: token,
    });
  } else {
    // Clear the custom domain (legacy: only clears primary from projects table)
    const [proj] = await db
      .select({ customDomain: projectsTable.customDomain })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (proj?.customDomain) {
      publishDomainEvent({ type: "removed", hostname: proj.customDomain, projectId });
      await writeDomainAudit({
        projectId,
        userId,
        action: "domain_cleared_legacy",
        hostname: proj.customDomain,
      });
    }

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
});

// ── DELETE /api/projects/:id/domain ──────────────────────────────────────────
router.delete("/projects/:id/domain", requireProjectOwnership, async (req, res): Promise<void> => {
  const projectId = Number(req.params.id);
  const userId = (req as { userId?: string }).userId ?? "unknown";

  const [proj] = await db
    .select({ customDomain: projectsTable.customDomain })
    .from(projectsTable)
    .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

  if (proj?.customDomain) {
    publishDomainEvent({ type: "removed", hostname: proj.customDomain, projectId });
    await writeDomainAudit({
      projectId,
      userId,
      action: "domain_deleted_legacy",
      hostname: proj.customDomain,
    });
  }

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
});

// ── POST /api/projects/:id/domain/verify ─────────────────────────────────────
router.post(
  "/projects/:id/domain/verify",
  requireProjectOwnership,
  domainVerifyLimiter,
  async (req, res): Promise<void> => {
    const projectId = Number(req.params.id);
    const userId = (req as { userId?: string }).userId ?? "unknown";

    const [project] = await db
      .select({
        customDomain: projectsTable.customDomain,
        verificationToken: projectsTable.verificationToken,
      })
      .from(projectsTable)
      .where(and(eq(projectsTable.id, projectId), isNull(projectsTable.deletedAt)));

    if (!project?.customDomain) {
      res.status(400).json({ error: "No custom domain configured" });
      return;
    }

    const domain = project.customDomain;
    const token = project.verificationToken;
    const txtLookup = `_mustaflow.${domain}`;
    const labels = domain.split(".");
    const isApex = labels.length === 2;

    let txtVerified = false;
    let cnameVerified = false;
    let cnameRecords: string[] = [];
    let txtRecords: string[][] = [];

    try {
      if (token) {
        try {
          txtRecords = await dns.resolveTxt(txtLookup);
          txtVerified = txtRecords.flat().some((v) => v.trim() === token.trim());
        } catch {
          txtVerified = false;
        }
      }

      const targetBase = CNAME_TARGET.replace(/\.$/, "").toLowerCase();
      if (!isApex) {
        try {
          cnameRecords = await dns.resolveCname(domain);
          cnameVerified = cnameRecords.some((r) =>
            r.replace(/\.$/, "").toLowerCase().endsWith(targetBase),
          );
        } catch {
          cnameVerified = false;
        }
      }

      const verified = txtVerified || cnameVerified || (isApex && txtVerified);
      const method = txtVerified ? "txt" : cnameVerified ? "cname" : null;

      if (verified) {
        await db
          .update(projectsTable)
          .set({
            domainStatus: "active",
            sslStatus: "provisioning",
            domainVerifiedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(projectsTable.id, projectId));

        const [projectForSsl] = await db
          .select({ cfHostnameId: projectsTable.cfHostnameId })
          .from(projectsTable)
          .where(eq(projectsTable.id, projectId));

        void activateSslForProject(projectId, domain, projectForSsl?.cfHostnameId).catch(() => {
          /* best-effort */
        });

        publishDomainEvent({ type: "verified", hostname: domain, projectId });
        await writeDomainAudit({
          projectId,
          userId,
          action: "domain_verified_legacy",
          hostname: domain,
          after: { method },
        });

        res.json({
          verified: true,
          method,
          domainStatus: "active",
          sslStatus: "provisioning",
          message: `Domain ownership confirmed via ${method === "txt" ? "TXT record" : "CNAME"}. SSL activation has been triggered automatically.`,
        });
      } else {
        const hints: string[] = [];
        if (token) {
          hints.push(
            `TXT not found — add a TXT record named "${txtLookup}" with value "${token}".`,
          );
        }
        if (!isApex) {
          if (cnameRecords.length > 0) {
            hints.push(
              `CNAME points to "${cnameRecords.join(", ")}" but must point to "${CNAME_TARGET}".`,
            );
          } else {
            hints.push(
              `CNAME not found — add a CNAME record for "${domain}" pointing to "${CNAME_TARGET}".`,
            );
          }
        }
        hints.push("DNS changes can take up to 48 hours to propagate.");

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
        error:
          "DNS check failed — this can happen during heavy propagation. Please try again in a few minutes.",
      });
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// In-memory sighting tracker for diagnostic panel
// Records hostnames seen by the custom-domain middleware in recent requests.
// ─────────────────────────────────────────────────────────────────────────────
const recentlySightedHostnames = new Map<string, number>(); // hostname → last-seen epoch ms

export function recordHostnameSighting(hostname: string): void {
  recentlySightedHostnames.set(hostname, Date.now());
}

export function domainHasBeenSighted(hostname: string, windowMs = 5 * 60_000): boolean {
  const last = recentlySightedHostnames.get(hostname);
  return last !== undefined && Date.now() - last < windowMs;
}

// Prune stale sightings every 10 minutes
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [host, ts] of recentlySightedHostnames.entries()) {
    if (ts < cutoff) recentlySightedHostnames.delete(host);
  }
}, 10 * 60_000).unref();

export default router;
