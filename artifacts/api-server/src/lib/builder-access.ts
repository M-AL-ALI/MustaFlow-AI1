import type { RequestHandler } from "express";
import { getClerkUserById } from "./clerk-users";

export function parseBuilderAllowlist(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? "")
      .split(",")
      .map((email) => email.trim().toLowerCase())
      .filter(Boolean),
  );
}

export function isBuilderOpenToAll(raw: string | undefined = process.env.BUILDER_OPEN_TO_ALL) {
  return raw?.trim().toLowerCase() === "true";
}

export function hasBuilderAccess(
  email: string | null | undefined,
  options: { allowlist?: string; openToAll?: string } = {},
): boolean {
  if (isBuilderOpenToAll(options.openToAll ?? process.env.BUILDER_OPEN_TO_ALL)) return true;
  if (!email) return false;
  return parseBuilderAllowlist(options.allowlist ?? process.env.BUILDER_ALLOWLIST).has(
    email.trim().toLowerCase(),
  );
}

export const BUILDER_ACCESS_DENIED_MESSAGE = "AI Builder access is not enabled for this account.";

export type BuilderEmailLookup = (userId: string) => Promise<string | null | undefined>;

async function lookupBuilderEmail(userId: string): Promise<string | null> {
  return (await getClerkUserById(userId))?.email ?? null;
}

export function createBuilderAccessMiddleware(
  lookupEmail: BuilderEmailLookup = lookupBuilderEmail,
): RequestHandler {
  return async (req, res, next): Promise<void> => {
    // Preserve the launch override and avoid an unnecessary Clerk lookup.
    if (hasBuilderAccess(null)) {
      next();
      return;
    }

    let email: string | null | undefined;
    try {
      email = req.userId ? await lookupEmail(req.userId) : null;
    } catch {
      email = null;
    }

    if (!hasBuilderAccess(email)) {
      res.status(403).json({ error: BUILDER_ACCESS_DENIED_MESSAGE });
      return;
    }

    next();
  };
}

export const requireBuilderAccess = createBuilderAccessMiddleware();
