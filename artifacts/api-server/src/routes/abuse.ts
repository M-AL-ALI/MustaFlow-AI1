// ─────────────────────────────────────────────────────────────────────────────
// Abuse report intake — Task #560
//
//   POST /api/abuse-reports   — public endpoint, no auth required
//
// Creates an abuse_reports row. Rate-limited to 5/minute per IP to prevent spam.
// The report hostname is normalised and looked up in project_domains to link to
// the domainId when possible.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";
import { db, abuseReportsTable, projectDomainsTable } from "@workspace/db";
import { createLimiterForDomainVerify } from "../lib/rateLimit";

const router: IRouter = Router();

const abuseReportLimiter = createLimiterForDomainVerify({
  windowMs: 60_000,
  max: 5,
  keyPrefix: "abuse_report",
  message: "Too many abuse reports submitted. Please wait before submitting another.",
});

const VALID_CATEGORIES = new Set([
  "phishing",
  "malware",
  "spam",
  "impersonation",
  "illegal_content",
  "other",
]);

function hashIp(ip: string | undefined | null): string | null {
  if (!ip) return null;
  return createHash("sha256").update(ip).digest("hex").slice(0, 32);
}

function normaliseHostname(raw: string): string | null {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
  if (!cleaned || cleaned.length > 253) return null;
  try {
    const url = new URL(`http://${cleaned}`);
    return url.hostname || null;
  } catch {
    return null;
  }
}

// ── POST /api/abuse-reports ──────────────────────────────────────────────────
router.post("/abuse-reports", abuseReportLimiter, async (req, res): Promise<void> => {
  const body = (req.body ?? {}) as {
    hostname?: string;
    category?: string;
    reason?: string;
    details?: string;
    reporterEmail?: string;
  };

  const rawHostname = body.hostname;
  const category = body.category ?? "other";
  const reason = (body.reason ?? "").trim();
  const details = (body.details ?? "").trim() || null;
  const reporterEmail = (body.reporterEmail ?? "").trim() || null;

  if (!rawHostname) {
    res.status(400).json({ error: "hostname is required" });
    return;
  }

  const hostname = normaliseHostname(rawHostname);
  if (!hostname) {
    res.status(400).json({ error: "Invalid hostname" });
    return;
  }

  if (!VALID_CATEGORIES.has(category)) {
    res.status(400).json({
      error: `category must be one of: ${[...VALID_CATEGORIES].join(", ")}`,
    });
    return;
  }

  if (!reason || reason.length < 10) {
    res.status(400).json({ error: "reason must be at least 10 characters" });
    return;
  }

  if (reason.length > 2000) {
    res.status(400).json({ error: "reason must be at most 2000 characters" });
    return;
  }

  if (reporterEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(reporterEmail)) {
    res.status(400).json({ error: "Invalid reporter email address" });
    return;
  }

  const ip =
    (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    null;

  // Look up domainId (best-effort — may not exist if hostname is novel or deleted)
  let domainId: number | null = null;
  try {
    const [domainRow] = await db
      .select({ id: projectDomainsTable.id })
      .from(projectDomainsTable)
      .where(eq(projectDomainsTable.hostname, hostname));
    domainId = domainRow?.id ?? null;
  } catch {
    /* non-fatal */
  }

  const [report] = await db
    .insert(abuseReportsTable)
    .values({
      domainId,
      hostname,
      category,
      reason,
      details,
      reporterEmail,
      reporterIp: hashIp(ip),
      status: "open",
    })
    .returning({ id: abuseReportsTable.id });

  res.status(201).json({
    ok: true,
    reportId: report?.id ?? null,
    message:
      "Your report has been received and will be reviewed by our team. Thank you for helping keep the platform safe.",
  });
});

export default router;
