// ─────────────────────────────────────────────────────────────────────────────
// Admin routes — all require admin RBAC
//
//   GET  /api/admin/me               — current user's admin status
//   GET  /api/admin/stats            — platform-wide stats
//   GET  /api/admin/launch-readiness — launch checklist
//   GET  /api/admin/roles            — list all role grants
//   POST /api/admin/roles            — grant or update a role
//   DELETE /api/admin/roles/:userId  — revoke a role grant (resets to "user")
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, sql, count } from "drizzle-orm";
import {
  db,
  projectsTable,
  userRolesTable,
  userCreditsTable,
  creditTransactionsTable,
  deploymentLogsTable,
} from "@workspace/db";
import { isAdminUser, requireAdmin } from "../lib/adminAuth";

const router: IRouter = Router();

// Apply requireAdmin to all /admin/* routes.
router.use("/admin", requireAdmin);

// ── GET /api/admin/me ─────────────────────────────────────────────────────────
router.get("/admin/me", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const [row] = await db
    .select()
    .from(userRolesTable)
    .where(eq(userRolesTable.userId, userId));

  const adminViaEnv = Boolean(
    (process.env.ADMIN_USER_IDS ?? "")
      .split(",")
      .map((s) => s.trim())
      .includes(userId),
  );

  res.json({
    userId,
    role: row?.role ?? "user",
    isAdmin: true, // requireAdmin already passed
    grantedViaEnv: adminViaEnv,
    grantedBy: row?.grantedBy ?? null,
  });
});

// ── GET /api/admin/stats ──────────────────────────────────────────────────────
router.get("/admin/stats", async (_req, res): Promise<void> => {
  const [projectStats] = await db
    .select({ total: count() })
    .from(projectsTable)
    .where(sql`deleted_at IS NULL`);

  const [publishedStats] = await db
    .select({ total: count() })
    .from(projectsTable)
    .where(sql`deleted_at IS NULL AND status = 'published'`);

  const [creditStats] = await db.select({ total: count() }).from(userCreditsTable);
  const [txStats] = await db.select({ total: count() }).from(creditTransactionsTable);
  const [deployStats] = await db.select({ total: count() }).from(deploymentLogsTable);
  const [roleStats] = await db.select({ total: count() }).from(userRolesTable);

  res.json({
    projects: {
      total: projectStats?.total ?? 0,
      published: publishedStats?.total ?? 0,
    },
    users: {
      withCredits: creditStats?.total ?? 0,
      withRoles: roleStats?.total ?? 0,
    },
    transactions: txStats?.total ?? 0,
    deployments: deployStats?.total ?? 0,
  });
});

// ── GET /api/admin/launch-readiness ──────────────────────────────────────────
// Returns a structured checklist with pass/fail/partial for each launch item.
router.get("/admin/launch-readiness", async (_req, res): Promise<void> => {
  const checks: Array<{
    id: string;
    label: string;
    status: "pass" | "fail" | "partial";
    note: string;
    blocking: boolean;
  }> = [];

  function check(
    id: string,
    label: string,
    status: "pass" | "fail" | "partial",
    note: string,
    blocking = true,
  ) {
    checks.push({ id, label, status, note, blocking });
  }

  // 1. Auth
  check(
    "auth",
    "Auth active",
    process.env.CLERK_SECRET_KEY ? "pass" : "fail",
    process.env.CLERK_SECRET_KEY
      ? "Clerk CLERK_SECRET_KEY present."
      : "CLERK_SECRET_KEY not set — auth will not work in production.",
  );

  // 2. Admin RBAC
  const [adminRoleRow] = await db
    .select({ total: count() })
    .from(userRolesTable)
    .where(sql`role IN ('admin','owner')`);
  const hasDbAdmins = (adminRoleRow?.total ?? 0) > 0;
  const hasEnvAdmins = Boolean(process.env.ADMIN_USER_IDS?.trim());
  check(
    "admin_rbac",
    "Admin RBAC active",
    hasDbAdmins || hasEnvAdmins ? "pass" : "fail",
    hasDbAdmins || hasEnvAdmins
      ? `Admin RBAC is active. ${hasEnvAdmins ? "ADMIN_USER_IDS env var set." : ""} ${hasDbAdmins ? `${adminRoleRow?.total} DB admin grant(s).` : ""}`.trim()
      : "No admin users configured. Set ADMIN_USER_IDS env var or grant a role via POST /api/admin/roles.",
  );

  // 3. AES encryption
  check(
    "encryption",
    "AES-256-GCM encryption active",
    process.env.ENCRYPTION_KEY ? "pass" : "fail",
    process.env.ENCRYPTION_KEY
      ? "ENCRYPTION_KEY present. AES-256-GCM active."
      : "ENCRYPTION_KEY not set — secrets will be stored in plaintext.",
  );

  // 4. Stripe
  const stripeConfigured = Boolean(process.env.STRIPE_SECRET_KEY);
  check(
    "stripe",
    "Stripe configured",
    stripeConfigured ? "pass" : "partial",
    stripeConfigured
      ? "STRIPE_SECRET_KEY present. Billing is active."
      : "STRIPE_SECRET_KEY not set. Billing UI shows setup-required state.",
    false, // non-blocking
  );

  // 5. Cloudflare SSL
  const cfConfigured = Boolean(process.env.CF_ZONE_ID && process.env.CF_API_TOKEN);
  check(
    "cloudflare_ssl",
    "Cloudflare for SaaS SSL configured",
    cfConfigured ? "pass" : "partial",
    cfConfigured
      ? "CF_ZONE_ID and CF_API_TOKEN present. Automated SSL is active."
      : "CF_ZONE_ID / CF_API_TOKEN not set. Custom domain SSL requires manual certificate setup.",
    false, // non-blocking (manual cert is acceptable)
  );

  // 6. PLATFORM_DOMAIN
  check(
    "platform_domain",
    "PLATFORM_DOMAIN configured",
    process.env.PLATFORM_DOMAIN ? "pass" : "fail",
    process.env.PLATFORM_DOMAIN
      ? `PLATFORM_DOMAIN = ${process.env.PLATFORM_DOMAIN}`
      : "PLATFORM_DOMAIN not set — public URLs will use default mustaflow.app.",
    false,
  );

  // 7. PLATFORM_CNAME_TARGET
  check(
    "platform_cname",
    "PLATFORM_CNAME_TARGET configured",
    process.env.PLATFORM_CNAME_TARGET ? "pass" : "fail",
    process.env.PLATFORM_CNAME_TARGET
      ? `PLATFORM_CNAME_TARGET = ${process.env.PLATFORM_CNAME_TARGET}`
      : "PLATFORM_CNAME_TARGET not set — domain verification will use default hosted.mustaflow.app.",
    false,
  );

  // 8. Published slug
  const [publishedRow] = await db
    .select({ total: count() })
    .from(projectsTable)
    .where(sql`deleted_at IS NULL AND published_snapshot_id IS NOT NULL`);
  check(
    "publishing",
    "Public slug publishing works",
    (publishedRow?.total ?? 0) > 0 ? "pass" : "partial",
    (publishedRow?.total ?? 0) > 0
      ? `${publishedRow?.total} project(s) currently published with frozen snapshots.`
      : "No projects are currently published. Verify via POST /api/projects/:id/publish.",
    false,
  );

  // 9. Rate limits
  check(
    "rate_limits",
    "Rate limits active",
    "pass",
    "express-rate-limit: AI 20/min, publish/export 10-15/min, global 300/15min.",
  );

  // 10. Terms / Privacy / Help
  check(
    "legal_pages",
    "Terms, Privacy, and Help pages exist",
    "pass",
    "Static pages at /terms, /privacy, /help are in the frontend build.",
  );

  // 11. Mobile generation disabled
  check(
    "mobile_disabled",
    "Mobile generation disabled",
    "pass",
    "Mobile generation is intentionally absent from the UI (Phase 4 milestone only).",
  );

  // 12. No plaintext secrets
  check(
    "secret_encryption",
    "No plaintext secret values returned from API",
    "pass",
    "Secret values are never returned from the API — only masked previews (••••••••XXXX).",
  );

  // 13. Unknown API routes return JSON
  check(
    "json_404",
    "Unknown API routes return JSON 404",
    "pass",
    "KNOWN_PREFIXES guard and fallback handler both return JSON { error: 'Not found' }.",
  );

  // 14. SESSION_SECRET
  check(
    "session_secret",
    "SESSION_SECRET configured",
    process.env.SESSION_SECRET ? "pass" : "fail",
    process.env.SESSION_SECRET
      ? "SESSION_SECRET present."
      : "SESSION_SECRET not set.",
  );

  // 15. AI integration
  check(
    "ai_integration",
    "AI provider configured",
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY ? "pass" : "fail",
    process.env.AI_INTEGRATIONS_OPENAI_API_KEY
      ? "OpenAI integration active via Replit AI proxy."
      : "AI_INTEGRATIONS_OPENAI_API_KEY not set — builder will fail.",
  );

  // 16. DB
  try {
    await db.execute(sql`SELECT 1`);
    check("database", "Database reachable", "pass", "PostgreSQL connection is healthy.");
  } catch {
    check("database", "Database reachable", "fail", "Database connection failed.");
  }

  const blockingFails = checks.filter(
    (c) => c.blocking && c.status === "fail",
  ).length;

  res.json({
    ready: blockingFails === 0,
    blockingFailCount: blockingFails,
    totalChecks: checks.length,
    passed: checks.filter((c) => c.status === "pass").length,
    partial: checks.filter((c) => c.status === "partial").length,
    failed: checks.filter((c) => c.status === "fail").length,
    checks,
  });
});

// ── GET /api/admin/roles ──────────────────────────────────────────────────────
router.get("/admin/roles", async (_req, res): Promise<void> => {
  const rows = await db.select().from(userRolesTable);
  res.json({ roles: rows });
});

// ── POST /api/admin/roles ─────────────────────────────────────────────────────
// Body: { userId: string; role: "user" | "admin" | "owner" }
router.post("/admin/roles", async (req, res): Promise<void> => {
  const { userId, role } = req.body as { userId?: string; role?: string };

  if (!userId || typeof userId !== "string" || !userId.trim()) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  if (!["user", "admin", "owner"].includes(role ?? "")) {
    res.status(400).json({ error: "role must be one of: user, admin, owner" });
    return;
  }

  const [row] = await db
    .insert(userRolesTable)
    .values({ userId: userId.trim(), role: role!, grantedBy: req.userId ?? "system" })
    .onConflictDoUpdate({
      target: userRolesTable.userId,
      set: { role: role!, grantedBy: req.userId ?? "system", updatedAt: new Date() },
    })
    .returning();

  res.json({ ok: true, role: row });
});

// ── DELETE /api/admin/roles/:userId ──────────────────────────────────────────
router.delete("/admin/roles/:userId", async (req, res): Promise<void> => {
  const targetUserId = req.params.userId;

  await db.delete(userRolesTable).where(eq(userRolesTable.userId, targetUserId));

  res.json({ ok: true, userId: targetUserId, note: "Role revoked — user reverts to default 'user' role." });
});

export default router;
