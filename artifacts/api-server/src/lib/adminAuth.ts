// ─────────────────────────────────────────────────────────────────────────────
// Admin Page access control — one gate, one role policy, one receipt writer.
// ─────────────────────────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { adminAccessReceiptsTable, db, userRolesTable, type StaffRole } from "@workspace/db";
import type { Request, Response, NextFunction } from "express";
import { logger } from "./logger";
import { staffRoleCanResolveSupportTicket } from "./support-ticket-workflow";

const STAFF_ROLE_SET = new Set<StaffRole>(["owner", "operator", "support", "analyst"]);
const RECEIPT_ATTACHED = Symbol("admin-receipt-attached");

export type StaffPrincipal = {
  userId: string;
  role: StaffRole;
  source: "user_roles";
  grantedBy: string | null;
};

export type AdminReceiptInput = {
  actorUserId: string;
  actorRole: StaffRole | "none";
  kind: "access" | "action" | "role_change" | "refusal";
  action: string;
  targetUserId?: string | null;
  targetWorkspaceId?: number | null;
  previousRole?: string | null;
  nextRole?: string | null;
  reason?: string | null;
  outcome: string;
  requestMethod?: string | null;
  requestPath?: string | null;
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      staffPrincipal?: StaffPrincipal;
      [RECEIPT_ATTACHED]?: boolean;
    }
  }
}

function asStaffRole(value: string | null | undefined): StaffRole | null {
  // Safe runtime bridge while the idempotent startup migration converts the
  // former broad `admin` role to the least-privileged operational role.
  if (value === "admin") return "operator";
  return value && STAFF_ROLE_SET.has(value as StaffRole) ? (value as StaffRole) : null;
}

export async function resolveStaffPrincipal(userId: string): Promise<StaffPrincipal | null> {
  const [row] = await db
    .select({ role: userRolesTable.role, grantedBy: userRolesTable.grantedBy })
    .from(userRolesTable)
    .where(eq(userRolesTable.userId, userId));
  const role = asStaffRole(row?.role);
  return role ? { userId, role, source: "user_roles", grantedBy: row?.grantedBy ?? null } : null;
}

/** Compatibility predicate used by non-console safety overrides. */
export async function isAdminUser(userId: string): Promise<boolean> {
  const principal = await resolveStaffPrincipal(userId);
  return principal?.role === "owner" || principal?.role === "operator";
}

function requestPath(req: Request): string {
  return req.originalUrl.split("?", 1)[0] ?? req.path;
}

function implicitAccountScope(path: string): string | null {
  return [
    "/api/admin/support-tickets",
    "/api/admin/billing/users",
    "/api/admin/billing/settlement-reconciliation",
    "/api/admin/audit-log",
    "/api/admin/inbox/recent-unread",
  ].includes(path)
    ? "multiple_accounts"
    : null;
}

function boundedTargetUserId(req: Request): string | null {
  const body = req.body as { userId?: unknown } | undefined;
  const candidate = req.params.userId ?? body?.userId;
  return typeof candidate === "string" && candidate.length <= 256
    ? candidate
    : implicitAccountScope(requestPath(req));
}

function boundedTargetWorkspaceId(req: Request): number | null {
  const body = req.body as { workspaceId?: unknown } | undefined;
  const raw = req.params.workspaceId ?? req.query.workspaceId ?? body?.workspaceId;
  const parsed = typeof raw === "string" || typeof raw === "number" ? Number(raw) : NaN;
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export async function writeAdminReceipt(input: AdminReceiptInput): Promise<void> {
  await db.insert(adminAccessReceiptsTable).values({
    actorUserId: input.actorUserId,
    actorRole: input.actorRole,
    kind: input.kind,
    action: input.action,
    targetUserId: input.targetUserId ?? null,
    targetWorkspaceId: input.targetWorkspaceId ?? null,
    previousRole: input.previousRole ?? null,
    nextRole: input.nextRole ?? null,
    reason: input.reason ?? null,
    outcome: input.outcome,
    requestMethod: input.requestMethod ?? null,
    requestPath: input.requestPath ?? null,
  });
}

const OWNER_ONLY_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/admin\/roles(?:\/|$)/,
  /^\/api\/admin\/accounts(?:\/|$)/,
  /^\/api\/admin\/billing\/refund(?:\/|$)/,
  /^\/api\/admin\/(?:providers|spend-ceilings|global-pause|unmask)(?:\/|$)/,
];

const ANALYST_READ_PATHS: ReadonlyArray<RegExp> = [
  /^\/api\/admin\/me$/,
  /^\/api\/admin\/stats$/,
  /^\/api\/admin\/telemetry\/calibration$/,
  /^\/api\/admin\/eval-results$/,
  /^\/api\/admin\/launch-readiness$/,
  /^\/api\/admin\/domain-metrics$/,
  /^\/api\/admin\/job-queue$/,
  /^\/api\/admin\/records(?:\/|$)/,
];

export function staffRoleAllowsRequest(role: StaffRole, method: string, path: string): boolean {
  if (role === "owner") return true;
  if (role === "support") {
    return (
      path === "/api/admin/me" ||
      /^\/api\/admin\/support-(?:tickets|assignees|grants|zero-sessions|defects)(?:\/|$)/.test(path)
    );
  }
  if (role === "analyst") {
    return method === "GET" && ANALYST_READ_PATHS.some((pattern) => pattern.test(path));
  }
  return !OWNER_ONLY_PATHS.some((pattern) => pattern.test(path));
}

async function recordRefusal(
  req: Request,
  actorUserId: string,
  actorRole: StaffRole | "none",
  outcome: string,
): Promise<void> {
  try {
    await writeAdminReceipt({
      actorUserId,
      actorRole,
      kind: "refusal",
      action: `${req.method} ${requestPath(req)}`,
      targetUserId: boundedTargetUserId(req),
      targetWorkspaceId: boundedTargetWorkspaceId(req),
      outcome,
      requestMethod: req.method,
      requestPath: requestPath(req),
    });
  } catch (error) {
    logger.error({ component: "admin-access", error }, "Failed to persist admin refusal receipt");
  }
}

/**
 * Console gate and least-privilege dispatcher. Nonstaff callers receive the
 * canonical unknown-route response so the Admin Page's existence is not leaked.
 */
export async function requireAdmin(req: Request, res: Response, next: NextFunction): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(404).json({ error: "Not found" });
    return;
  }

  const principal = await resolveStaffPrincipal(userId);
  if (!principal) {
    await recordRefusal(req, userId, "none", "not_allowlisted");
    res.status(404).json({ error: "Not found" });
    return;
  }

  const path = requestPath(req);
  if (!staffRoleAllowsRequest(principal.role, req.method, path)) {
    await recordRefusal(req, userId, principal.role, "role_lacks_action");
    res.status(403).json({
      error: "Your staff role does not allow this action.",
      code: "admin_role_forbidden",
    });
    return;
  }

  req.staffPrincipal = principal;
  if (!req[RECEIPT_ATTACHED]) {
    try {
      await writeAdminReceipt({
        actorUserId: userId,
        actorRole: principal.role,
        kind: req.method === "GET" ? "access" : "action",
        action: `${req.method} ${path}`,
        targetUserId: boundedTargetUserId(req),
        targetWorkspaceId: boundedTargetWorkspaceId(req),
        outcome: "authorized",
        requestMethod: req.method,
        requestPath: path,
      });
      req[RECEIPT_ATTACHED] = true;
    } catch (error) {
      logger.error({ component: "admin-access", error }, "Admin receipt ledger unavailable");
      res.status(503).json({
        error: "Admin access could not be audited. Please try again.",
        code: "admin_audit_unavailable",
      });
      return;
    }
  }

  next();
}

export async function requireOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (req.staffPrincipal?.role === "owner") {
    next();
    return;
  }
  const userId = req.userId;
  const principal = userId ? (req.staffPrincipal ?? (await resolveStaffPrincipal(userId))) : null;
  if (!principal) {
    res.status(404).json({ error: "Not found" });
    return;
  }
  await recordRefusal(req, principal.userId, principal.role, "owner_required");
  res.status(403).json({
    error: "Only an Owner can perform this action.",
    code: "admin_owner_required",
  });
}

/**
 * Central resolver gate for evidence-bearing support closure. Analysts may
 * inspect operational data but can never approve a terminal ticket verdict.
 */
export async function requireSupportResolver(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const principal = req.staffPrincipal;
  if (principal && staffRoleCanResolveSupportTicket(principal.role)) {
    next();
    return;
  }
  if (principal) {
    await recordRefusal(req, principal.userId, principal.role, "support_resolver_required");
  }
  res.status(403).json({
    error: "Your staff role cannot approve a support resolution.",
    code: "support_resolver_required",
  });
}
