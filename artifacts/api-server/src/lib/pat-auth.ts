/**
 * Personal Access Token (PAT) authentication middleware for the public REST API v1.
 *
 * Tokens are prefixed "mfp_" and stored as SHA-256 hashes.
 * On each request: extract Bearer token → hash → look up in personal_access_tokens.
 * On success: attaches req.userId and req.patProjectId to the request.
 *
 * patOrSessionAuthMiddleware accepts EITHER a valid PAT (Authorization: Bearer)
 * OR a valid Clerk session cookie — whichever is present. This lets the same
 * /api/v1/* endpoints be used from both server-to-server integrations and the
 * browser-based settings UI.
 */

import { createHash, randomBytes } from "crypto";
import type { Request, Response, NextFunction } from "express";
import { eq, and } from "drizzle-orm";
import { getAuth } from "@clerk/express";
import { db, personalAccessTokensTable } from "@workspace/db";
import { logger } from "./logger";

const TOKEN_PREFIX = "mfp_";

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function generateRawToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

declare module "express" {
  interface Request {
    patProjectId?: number | null;
    patScopes?: string[];
  }
}

/** Narrowed request type after PAT authentication — guarantees patScopes is set. */
export type PATRequest = Request & {
  userId: string;
  patProjectId: number | null;
  patScopes: string[];
};

/**
 * Middleware: authenticate via Bearer PAT.
 * Returns 401 if missing / invalid / expired / inactive.
 */
export async function patAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header. Use Bearer <token>." });
    return;
  }

  const raw = auth.slice("Bearer ".length).trim();
  if (!raw.startsWith(TOKEN_PREFIX)) {
    res.status(401).json({ error: "Invalid token format." });
    return;
  }

  const hash = hashToken(raw);

  try {
    const [token] = await db
      .select()
      .from(personalAccessTokensTable)
      .where(
        and(
          eq(personalAccessTokensTable.tokenHash, hash),
          eq(personalAccessTokensTable.active, true),
        ),
      );

    if (!token) {
      res.status(401).json({ error: "Invalid or revoked token." });
      return;
    }

    if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
      res.status(401).json({ error: "Token expired." });
      return;
    }

    // Attach identity
    req.userId = token.userId;
    req.patProjectId = token.projectId ?? null;
    req.patScopes = Array.isArray(token.scopes) ? (token.scopes as string[]) : [];

    // Update last used (best-effort, non-blocking)
    setImmediate(() => {
      void db
        .update(personalAccessTokensTable)
        .set({ lastUsedAt: new Date() })
        .where(eq(personalAccessTokensTable.id, token.id))
        .catch(() => {
          /* ignore */
        });
    });

    next();
  } catch (err) {
    logger.warn({ err }, "PAT auth lookup error");
    res.status(500).json({ error: "Authentication error" });
  }
}

/** Check that a PAT has a required scope. */
export function requireScope(scope: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.patScopes?.includes(scope)) {
      res.status(403).json({ error: `This token does not have the '${scope}' scope.` });
      return;
    }
    next();
  };
}

/**
 * Middleware: authenticate via Bearer PAT **or** Clerk session cookie.
 *
 * Decision tree:
 *  1. Authorization: Bearer <token> present → attempt PAT lookup.
 *     - Valid, active, unexpired token → attach userId / patProjectId / patScopes, continue.
 *     - Invalid / revoked / expired     → 401 (do NOT fall through to session; the caller
 *       explicitly opted into token auth).
 *  2. No Authorization header → attempt Clerk session auth.
 *     - Valid session → attach userId, patProjectId = null, patScopes = [] (full owner access),
 *       continue.
 *     - No valid session → 401.
 *
 * This lets /api/v1/* routes work from both server-to-server integrations (PAT)
 * and the browser-based settings UI (Clerk session cookie).
 */
export async function patOrSessionAuthMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers["authorization"];

  // ── Branch 1: Bearer token present → PAT auth ────────────────────────────
  if (authHeader) {
    if (!authHeader.startsWith("Bearer ")) {
      res
        .status(401)
        .json({ error: "Invalid Authorization header format. Use: Authorization: Bearer <token>" });
      return;
    }

    const raw = authHeader.slice("Bearer ".length).trim();
    if (!raw.startsWith(TOKEN_PREFIX)) {
      res.status(401).json({ error: "Invalid token format. Tokens must start with 'mfp_'." });
      return;
    }

    const hash = hashToken(raw);

    try {
      const [token] = await db
        .select()
        .from(personalAccessTokensTable)
        .where(
          and(
            eq(personalAccessTokensTable.tokenHash, hash),
            eq(personalAccessTokensTable.active, true),
          ),
        );

      if (!token) {
        res.status(401).json({ error: "Invalid or revoked token." });
        return;
      }

      if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
        res.status(401).json({ error: "Token expired." });
        return;
      }

      req.userId = token.userId;
      req.patProjectId = token.projectId ?? null;
      req.patScopes = Array.isArray(token.scopes) ? (token.scopes as string[]) : [];

      // Update last used (best-effort, non-blocking)
      setImmediate(() => {
        void db
          .update(personalAccessTokensTable)
          .set({ lastUsedAt: new Date() })
          .where(eq(personalAccessTokensTable.id, token.id))
          .catch(() => {
            /* ignore */
          });
      });

      next();
      return;
    } catch (err) {
      logger.warn({ err }, "PAT auth lookup error");
      res.status(500).json({ error: "Authentication error" });
      return;
    }
  }

  // ── Branch 2: No Bearer header → Clerk session auth ──────────────────────
  // clerkMiddleware() has already run (mounted in app.ts), so getAuth() is safe.
  const auth = getAuth(req);
  const userId = (auth?.sessionClaims?.["userId"] as string | undefined) ?? auth?.userId;

  if (!userId) {
    res.status(401).json({
      error:
        "Unauthenticated. Provide an Authorization: Bearer <token> header or a valid session cookie.",
    });
    return;
  }

  req.userId = userId;
  req.patProjectId = null;
  // Session-authenticated users (project owners) have full access — grant all scopes.
  req.patScopes = [
    "projects:read",
    "projects:write",
    "builds:read",
    "builds:trigger",
    "files:read",
    "files:write",
    "domains:read",
    "domains:write",
    "webhooks:read",
    "webhooks:write",
  ];
  next();
}
