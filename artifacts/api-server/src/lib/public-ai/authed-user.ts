import type { Request } from "express";
import { getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { db, userSubscriptionsTable } from "@workspace/db";
import { isE2ETestAuthEnabled } from "../auth";

// Tiers permitted to use Deep Thinking + connectors. Free is Instant-only.
export const PAID_TIERS = new Set(["core", "wave"]);

// Tier values a test may simulate via the x-e2e-test-tier header. Kept in sync
// with the subscription tiers; anything else is ignored (falls back to a real
// subscription lookup).
const ALLOWED_TEST_TIERS = new Set(["free", "core", "wave"]);

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "grace_period"]);

export interface AuthedOraUser {
  userId: string;
  tier: string;
  isPaid: boolean;
}

/**
 * Resolve the effective subscription tier for a user from user_subscriptions.
 * Defaults to "free" if there is no active row or the table is unavailable.
 */
export async function resolveTierForUser(userId: string): Promise<AuthedOraUser> {
  let tier = "free";
  try {
    const [sub] = await db
      .select({ tier: userSubscriptionsTable.tier, status: userSubscriptionsTable.status })
      .from(userSubscriptionsTable)
      .where(eq(userSubscriptionsTable.userId, userId));
    if (sub && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) tier = sub.tier ?? "free";
  } catch {
    // user_subscriptions may be unavailable in some envs — default to free.
  }
  return { userId, tier, isPaid: PAID_TIERS.has(tier) };
}

/**
 * Optionally resolve the signed-in Clerk user on the public Ora endpoint.
 * clerkMiddleware() runs before all routes, so getAuth(req) works here even
 * though this route sits in front of the auth wall. Returns null for visitors.
 *
 * Test-only authenticated path: the Ora chat endpoint reads the Clerk session
 * directly, so the attachUser() E2E bypass (which only sets req.userId on
 * auth-walled routes) never reaches it. To make authenticated Ora flows (Deep
 * mode, paid gating, memory, saved assets) verifiable in a real browser without
 * Google OAuth, this honours the same `x-e2e-test-user` header — but ONLY when
 * isE2ETestAuthEnabled() is true (NODE_ENV !== "production" AND
 * E2E_TEST_ENABLED === "true"), so it can never activate in production. An
 * optional `x-e2e-test-tier` header lets a test simulate a paid tier so
 * Deep-mode paid gating can be exercised without seeding the database; when it
 * is absent or invalid we fall back to the real subscription lookup so a seeded
 * user_subscriptions row is still respected.
 */
export async function resolveAuthedOraUser(req: Request): Promise<AuthedOraUser | null> {
  if (isE2ETestAuthEnabled()) {
    const testUser = req.headers["x-e2e-test-user"];
    if (typeof testUser === "string" && testUser.length > 0) {
      const testTier = req.headers["x-e2e-test-tier"];
      if (typeof testTier === "string" && ALLOWED_TEST_TIERS.has(testTier)) {
        return { userId: testUser, tier: testTier, isPaid: PAID_TIERS.has(testTier) };
      }
      return resolveTierForUser(testUser);
    }
  }

  let userId: string | undefined;
  try {
    const auth = getAuth(req);
    userId = (auth?.sessionClaims?.["userId"] as string | undefined) ?? auth?.userId ?? undefined;
  } catch {
    // getAuth throws when clerkMiddleware hasn't run (e.g. isolated tests).
    // Treat as an anonymous visitor rather than failing the whole request.
    return null;
  }
  if (!userId) return null;
  return resolveTierForUser(userId);
}
