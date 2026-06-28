import type { Request } from "express";
import { getAuth } from "@clerk/express";
import { eq } from "drizzle-orm";
import { isSuperuser, SUPERUSER_ORA_TIER } from "../superusers";

// Tiers permitted to use Deep Thinking + connectors. Free is Instant-only.
export const PAID_TIERS = new Set(["core", "wave"]);

// Tier values a test may simulate via the x-e2e-test-tier header. Kept in sync
// with the subscription tiers; anything else is ignored (falls back to a real
// subscription lookup).
const ALLOWED_TEST_TIERS = new Set(["free", "core", "wave"]);

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing", "grace_period"]);

function isOraE2ETestAuthEnabled(): boolean {
  return process.env.NODE_ENV !== "production" && process.env.E2E_TEST_ENABLED === "true";
}

export interface AuthedOraUser {
  userId: string;
  tier: string;
  isPaid: boolean;
}

// 60-second in-process tier cache. Tier changes happen at subscription
// create/cancel — infrequent events — so a short TTL gives substantial
// latency savings on repeat messages (avoids a DB round-trip on every turn)
// without delaying visibility of plan changes by more than one minute.
const _tierCache = new Map<string, { result: AuthedOraUser; expiresAt: number }>();
const TIER_CACHE_TTL_MS = 60_000;

/** Evict a cached tier entry immediately (call after a subscription change). */
export function evictTierCache(userId: string): void {
  _tierCache.delete(userId);
}

/**
 * Resolve the effective subscription tier for a user from user_subscriptions.
 * Defaults to "free" if there is no active row or the table is unavailable.
 * Results are cached in-process for 60 seconds to avoid a DB round-trip on
 * every chat message.
 */
export async function resolveTierForUser(userId: string): Promise<AuthedOraUser> {
  const cached = _tierCache.get(userId);
  if (cached && cached.expiresAt > Date.now()) return cached.result;

  let tier = "free";
  try {
    const { db, userSubscriptionsTable } = await import("@workspace/db");
    const [sub] = await db
      .select({ tier: userSubscriptionsTable.tier, status: userSubscriptionsTable.status })
      .from(userSubscriptionsTable)
      .where(eq(userSubscriptionsTable.userId, userId));
    if (sub && ACTIVE_SUBSCRIPTION_STATUSES.has(sub.status)) tier = sub.tier ?? "free";
  } catch {
    // user_subscriptions may be unavailable in some envs — default to free.
  }
  if (!PAID_TIERS.has(tier) && (await isSuperuser(userId))) {
    tier = SUPERUSER_ORA_TIER;
  }
  const result: AuthedOraUser = { userId, tier, isPaid: PAID_TIERS.has(tier) };
  _tierCache.set(userId, { result, expiresAt: Date.now() + TIER_CACHE_TTL_MS });
  return result;
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
  if (isOraE2ETestAuthEnabled()) {
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
