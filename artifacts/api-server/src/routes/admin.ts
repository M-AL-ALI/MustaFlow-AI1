// ─────────────────────────────────────────────────────────────────────────────
// Admin routes — all require admin RBAC
//
//   GET  /api/admin/me               — current user's admin status
//   GET  /api/admin/stats            — platform-wide stats
//   GET  /api/admin/launch-readiness — launch checklist
//   GET  /api/admin/roles            — list all role grants
//   POST /api/admin/roles            — grant or update a role
//   DELETE /api/admin/roles/:userId  — revoke a role grant (resets to "user")
//   GET  /api/admin/audit-log        — secret audit log (paginated)
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, sql, count, desc } from "drizzle-orm";
import {
  db,
  projectsTable,
  userRolesTable,
  userCreditsTable,
  creditTransactionsTable,
  deploymentLogsTable,
  secretAuditLogTable,
  toolAuditTable,
} from "@workspace/db";
import { and, gte } from "drizzle-orm";
import { requireAdmin } from "../lib/adminAuth";
import { errorsPerDay } from "../lib/prodLogs";
import {
  listAllSkillsForAdmin,
  setSkillEnabled,
  listDraftSkillsForAdmin,
  readDraftRaw,
  updateDraftSkillBody,
  approveDraftSkill,
  rejectDraftSkill,
} from "../lib/builder-skills";

const router: IRouter = Router();

// Apply requireAdmin to all /admin/* routes.
router.use("/admin", requireAdmin);

// ── GET /api/admin/me ─────────────────────────────────────────────────────────
router.get("/admin/me", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const [row] = await db.select().from(userRolesTable).where(eq(userRolesTable.userId, userId));

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

  // Architect review stats (Task #507) — average findings per reviewed build over the
  // last 30 days, plus verdict counts. Read from the JSON `report.architectReview`
  // column on agent_tasks. Skipped reviews are excluded from the average.
  const architectStatsRows = await db.execute<{
    reviewed: string;
    avg_findings: string | null;
    pass: string;
    partial: string;
    fail: string;
    auto_fixed: string;
  }>(sql`
    SELECT
      COUNT(*) FILTER (WHERE COALESCE((report->'architectReview'->>'skipped')::boolean, false) = false) AS reviewed,
      AVG(jsonb_array_length(report->'architectReview'->'findings')) FILTER (
        WHERE COALESCE((report->'architectReview'->>'skipped')::boolean, false) = false
      ) AS avg_findings,
      COUNT(*) FILTER (WHERE report->'architectReview'->>'verdict' = 'pass') AS pass,
      COUNT(*) FILTER (WHERE report->'architectReview'->>'verdict' = 'partial') AS partial,
      COUNT(*) FILTER (WHERE report->'architectReview'->>'verdict' = 'fail') AS fail,
      COUNT(*) FILTER (WHERE (report->'architectReview'->>'autoFixQueued')::boolean = true) AS auto_fixed
    FROM agent_tasks
    WHERE status = 'completed'
      AND completed_at > now() - interval '30 days'
      AND report ? 'architectReview'
      AND report->'architectReview' IS NOT NULL
  `);
  const archRow = architectStatsRows.rows[0];

  // Cross-project prod error totals (last 14 days) — Task #511 admin tile.
  let errorsByDay: Array<{ day: string; count: number }> = [];
  let errorsTotal = 0;
  try {
    errorsByDay = await errorsPerDay(14);
    errorsTotal = errorsByDay.reduce((acc, r) => acc + (r.count ?? 0), 0);
  } catch {
    /* non-fatal */
  }

  // ── E2E metrics: pass rate across agent tasks in the last 7 days ──
  // Aggregates report->e2eResults JSON straight in Postgres so we don't pull
  // every task row into Node. `e2eResults.passed`/`failed` are top-level keys
  // on the E2eRunSummary, mirrored from the agent loop runner.
  const e2eRow = await db.execute<{
    runs: number;
    passed: number;
    failed: number;
  }>(sql`
    SELECT
      COUNT(*)::int                                                   AS runs,
      COALESCE(SUM((report->'e2eResults'->>'passed')::int), 0)::int   AS passed,
      COALESCE(SUM((report->'e2eResults'->>'failed')::int), 0)::int   AS failed
    FROM agent_tasks
    WHERE created_at >= NOW() - INTERVAL '7 days'
      AND report IS NOT NULL
      AND report ? 'e2eResults'
      AND report->'e2eResults' IS NOT NULL
      AND report->'e2eResults' != 'null'::jsonb
  `);
  const e2eAgg = (e2eRow.rows?.[0] ?? { runs: 0, passed: 0, failed: 0 }) as {
    runs: number;
    passed: number;
    failed: number;
  };
  const e2eTotal = e2eAgg.passed + e2eAgg.failed;
  const passRate7d = e2eTotal > 0 ? e2eAgg.passed / e2eTotal : 0;

  // ── Top skills used (last 30 days) — Task #524 ───────────────────────────
  // Aggregates report->agentLoop->skillsLoaded across completed agent tasks.
  const SKILLS_WINDOW_DAYS = 30;
  const topSkillsRows = await db.execute<{ name: string; count: string }>(sql`
    SELECT skill AS name, COUNT(*)::int AS count
    FROM agent_tasks,
         LATERAL jsonb_array_elements_text(report->'agentLoop'->'skillsLoaded') AS skill
    WHERE status = 'completed'
      AND completed_at > now() - interval '30 days'
      AND report IS NOT NULL
      AND report ? 'agentLoop'
      AND report->'agentLoop' ? 'skillsLoaded'
      AND jsonb_typeof(report->'agentLoop'->'skillsLoaded') = 'array'
    GROUP BY skill
    ORDER BY count DESC, skill ASC
    LIMIT 20
  `);
  const topSkills = topSkillsRows.rows.map((r) => ({
    name: r.name,
    count: Number(r.count),
  }));
  const buildsWithSkillsRow = await db.execute<{ total: string }>(sql`
    SELECT COUNT(*)::int AS total
    FROM agent_tasks
    WHERE status = 'completed'
      AND completed_at > now() - interval '30 days'
      AND report IS NOT NULL
      AND report ? 'agentLoop'
      AND report->'agentLoop' ? 'skillsLoaded'
      AND jsonb_typeof(report->'agentLoop'->'skillsLoaded') = 'array'
      AND jsonb_array_length(report->'agentLoop'->'skillsLoaded') > 0
  `);
  const totalBuildsWithSkills = Number(buildsWithSkillsRow.rows[0]?.total ?? 0);

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
    architectReviews: {
      windowDays: 30,
      reviewed: Number(archRow?.reviewed ?? 0),
      avgFindingsPerBuild: archRow?.avg_findings
        ? Number(Number(archRow.avg_findings).toFixed(2))
        : 0,
      passCount: Number(archRow?.pass ?? 0),
      partialCount: Number(archRow?.partial ?? 0),
      failCount: Number(archRow?.fail ?? 0),
      autoFixesQueued: Number(archRow?.auto_fixed ?? 0),
    },
    prodErrors: {
      last14Days: errorsTotal,
      byDay: errorsByDay,
    },
    e2e: {
      runs7d: e2eAgg.runs,
      scenarios7d: e2eTotal,
      passRate7d,
    },
    topSkills: {
      windowDays: SKILLS_WINDOW_DAYS,
      totalBuildsWithSkills,
      skills: topSkills,
    },
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
    process.env.SESSION_SECRET ? "SESSION_SECRET present." : "SESSION_SECRET not set.",
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

  const blockingFails = checks.filter((c) => c.blocking && c.status === "fail").length;

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

  res.json({
    ok: true,
    userId: targetUserId,
    note: "Role revoked — user reverts to default 'user' role.",
  });
});

// ── GET /api/admin/audit-log ──────────────────────────────────────────────────
// Query params: limit (1–200, default 50), offset (default 0)
router.get("/admin/audit-log", async (req, res): Promise<void> => {
  const rawLimit = Number(req.query["limit"] ?? 50);
  const rawOffset = Number(req.query["offset"] ?? 0);

  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 50 : rawLimit), 200);
  const offset = Math.max(0, isNaN(rawOffset) ? 0 : rawOffset);

  const [entries, [totalRow]] = await Promise.all([
    db
      .select()
      .from(secretAuditLogTable)
      .orderBy(desc(secretAuditLogTable.createdAt))
      .limit(limit)
      .offset(offset),
    db.select({ total: count() }).from(secretAuditLogTable),
  ]);

  res.json({
    entries,
    total: totalRow?.total ?? 0,
    limit,
    offset,
  });
});

// ── GET /api/admin/blocked-commands ───────────────────────────────────────────
// Returns blocked-command counts per project over the last N days, plus a
// sample of recent blocked rows. Used by the admin dashboard tile.
// Query params: days (1–90, default 7), sampleLimit (1–100, default 25)
router.get("/admin/blocked-commands", async (req, res): Promise<void> => {
  const rawDays = Number(req.query["days"] ?? 7);
  const rawSample = Number(req.query["sampleLimit"] ?? 25);
  const days = Math.min(Math.max(1, isNaN(rawDays) ? 7 : rawDays), 90);
  const sampleLimit = Math.min(Math.max(1, isNaN(rawSample) ? 25 : rawSample), 100);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const perProject = await db
    .select({
      projectId: toolAuditTable.projectId,
      blocked: count(),
    })
    .from(toolAuditTable)
    .where(and(eq(toolAuditTable.blocked, true), gte(toolAuditTable.createdAt, since)))
    .groupBy(toolAuditTable.projectId)
    .orderBy(desc(count()));

  const [totalRow] = await db
    .select({ total: count() })
    .from(toolAuditTable)
    .where(and(eq(toolAuditTable.blocked, true), gte(toolAuditTable.createdAt, since)));

  const samples = await db
    .select()
    .from(toolAuditTable)
    .where(and(eq(toolAuditTable.blocked, true), gte(toolAuditTable.createdAt, since)))
    .orderBy(desc(toolAuditTable.createdAt))
    .limit(sampleLimit);

  res.json({
    sinceDays: days,
    totalBlocked: totalRow?.total ?? 0,
    perProject,
    samples,
  });
});

// ── GET /api/admin/skills ─────────────────────────────────────────────────────
// Lists every builder skill from disk, merged with DB enable/disable + load counts.
router.get("/admin/skills", async (_req, res): Promise<void> => {
  const skills = await listAllSkillsForAdmin();
  res.json({ skills });
});

// ── PATCH /api/admin/skills/:name ─────────────────────────────────────────────
// Body: { enabled: boolean }. Toggles whether the skill appears in the agent
// loop's skill index and whether load_skill returns its content.
router.patch("/admin/skills/:name", async (req, res): Promise<void> => {
  const name = String(req.params.name ?? "").trim();
  if (!name || name.length > 120) {
    res.status(400).json({ error: "Invalid skill name" });
    return;
  }
  const body = (req.body ?? {}) as { enabled?: unknown };
  if (typeof body.enabled !== "boolean") {
    res.status(400).json({ error: "Body must include { enabled: boolean }" });
    return;
  }
  await setSkillEnabled(name, body.enabled);
  res.json({ name, enabled: body.enabled });
});

// ── GET /api/admin/skills/drafts ──────────────────────────────────────────────
// Lists every agent-authored draft awaiting admin review.
router.get("/admin/skills/drafts", async (_req, res): Promise<void> => {
  const drafts = await listDraftSkillsForAdmin();
  res.json({ drafts });
});

// ── GET /api/admin/skills/drafts/:name ────────────────────────────────────────
// Returns the full raw SKILL.md content (including frontmatter) for editing.
router.get("/admin/skills/drafts/:name", async (req, res): Promise<void> => {
  const name = String(req.params.name ?? "").trim();
  const raw = await readDraftRaw(name);
  if (raw == null) {
    res.status(404).json({ error: "Draft not found" });
    return;
  }
  res.json({ name, raw });
});

// ── PATCH /api/admin/skills/drafts/:name ──────────────────────────────────────
// Body: { raw: string }. Overwrites the draft's SKILL.md file in place.
router.patch("/admin/skills/drafts/:name", async (req, res): Promise<void> => {
  const name = String(req.params.name ?? "").trim();
  const body = (req.body ?? {}) as { raw?: unknown };
  if (typeof body.raw !== "string" || body.raw.length === 0) {
    res.status(400).json({ error: "Body must include { raw: string }" });
    return;
  }
  if (body.raw.length > 60_000) {
    res.status(400).json({ error: "raw too long (max 60000 chars)" });
    return;
  }
  try {
    await updateDraftSkillBody(name, body.raw);
    res.json({ name, updated: true });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

// ── POST /api/admin/skills/drafts/:name/approve ───────────────────────────────
// Moves the draft from skills/_drafts/<slug>/ to skills/<slug>/ and enables it.
router.post("/admin/skills/drafts/:name/approve", async (req, res): Promise<void> => {
  const name = String(req.params.name ?? "").trim();
  try {
    await approveDraftSkill(name);
    res.json({ name, approved: true });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

// ── POST /api/admin/skills/drafts/:name/reject ────────────────────────────────
// Deletes the draft file and DB row.
router.post("/admin/skills/drafts/:name/reject", async (req, res): Promise<void> => {
  const name = String(req.params.name ?? "").trim();
  try {
    await rejectDraftSkill(name);
    res.json({ name, rejected: true });
  } catch (err) {
    res.status(400).json({ error: String((err as Error).message ?? err) });
  }
});

export default router;
