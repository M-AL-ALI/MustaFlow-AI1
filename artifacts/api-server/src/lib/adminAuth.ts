// ─────────────────────────────────────────────────────────────────────────────
// Admin RBAC helpers
//
// Bootstrap: users listed in ADMIN_USER_IDS env var (comma-separated) are
// always treated as admin regardless of the user_roles table.
//
// Dynamic grants: POST /api/admin/roles persists entries to user_roles table.
// ─────────────────────────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { db, userRolesTable } from "@workspace/db";
import type { Request, Response, NextFunction } from "express";

// Comma-separated list of user IDs that are always admin (no DB lookup needed).
const ADMIN_USER_IDS: Set<string> = new Set(
  (process.env.ADMIN_USER_IDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Returns true if the user is an admin or owner (env var or DB). */
export async function isAdminUser(userId: string): Promise<boolean> {
  if (ADMIN_USER_IDS.has(userId)) return true;

  const [row] = await db
    .select({ role: userRolesTable.role })
    .from(userRolesTable)
    .where(eq(userRolesTable.userId, userId));

  return row?.role === "admin" || row?.role === "owner";
}

/** Express middleware: 401 if not authenticated, 403 if not admin. */
export async function requireAdmin(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const admin = await isAdminUser(userId);
  if (!admin) {
    res.status(403).json({ error: "Forbidden — admin access required" });
    return;
  }

  next();
}
