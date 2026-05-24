// ─────────────────────────────────────────────────────────────────────────────
// Plan quotas — Task #558 + Task #644 (Stripe subscription wiring)
//
// Maps plan tier → resource limits. Enforced server-side via enforceQuota().
// Quotas apply per workspace (org) for domain operations.
//
// Plan tier resolution order (first match wins):
//   1. PLAN_OVERRIDE_<WORKSPACE_ID> env var (operator override, dev/test)
//   2. DEFAULT_PLAN_TIER env var (global override, dev/test)
//   3. workspace_subscriptions.planTier when status in (active, trialing)
//   4. "free"
// ─────────────────────────────────────────────────────────────────────────────

import { eq } from "drizzle-orm";
import { db, workspaceSubscriptionsTable } from "@workspace/db";

export const PLAN_TIERS = ["free", "starter", "pro", "enterprise"] as const;
export type PlanTier = (typeof PLAN_TIERS)[number];

export interface PlanQuota {
  /** Maximum number of custom domains per workspace */
  maxCustomDomains: number;
  /** Maximum bandwidth per month in GB (Infinity = unlimited) */
  maxBandwidthGbPerMonth: number;
  /** Maximum custom SSL certificates per workspace */
  maxCustomCerts: number;
  /** Maximum workspace domain roles (distinct users granted domain access) */
  maxDomainRoleGrants: number;
}

export const PLAN_QUOTAS: Record<PlanTier, PlanQuota> = {
  free: {
    maxCustomDomains: 1,
    maxBandwidthGbPerMonth: 5,
    maxCustomCerts: 1,
    maxDomainRoleGrants: 3,
  },
  starter: {
    maxCustomDomains: 5,
    maxBandwidthGbPerMonth: 50,
    maxCustomCerts: 5,
    maxDomainRoleGrants: 10,
  },
  pro: {
    maxCustomDomains: 25,
    maxBandwidthGbPerMonth: 500,
    maxCustomCerts: 25,
    maxDomainRoleGrants: 50,
  },
  enterprise: {
    maxCustomDomains: Infinity,
    maxBandwidthGbPerMonth: Infinity,
    maxCustomCerts: Infinity,
    maxDomainRoleGrants: Infinity,
  },
};

export type QuotaResource = "domain" | "cert" | "domainRole";

export interface QuotaEnforcementResult {
  allowed: boolean;
  /** Current count */
  current: number;
  /** Limit for this plan */
  limit: number;
  /** Plan tier in use */
  plan: PlanTier;
  /** Human-readable upgrade prompt */
  upgradeMessage?: string;
}

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);

function isValidPlanTier(value: string | undefined | null): value is PlanTier {
  return !!value && (PLAN_TIERS as readonly string[]).includes(value);
}

/**
 * Resolve the plan tier for a workspace. Reads the workspace_subscriptions
 * row (populated by the Stripe webhook on customer.subscription.* events)
 * and returns the tier when the subscription is active/trialing. Env-var
 * overrides remain supported for dev/test and one-off manual upgrades.
 */
export async function resolveWorkspacePlan(workspaceId: number): Promise<PlanTier> {
  const override = process.env[`PLAN_OVERRIDE_${workspaceId}`];
  if (isValidPlanTier(override)) return override;

  const globalOverride = process.env.DEFAULT_PLAN_TIER;
  if (isValidPlanTier(globalOverride)) return globalOverride;

  try {
    const [row] = await db
      .select({
        planTier: workspaceSubscriptionsTable.planTier,
        status: workspaceSubscriptionsTable.status,
      })
      .from(workspaceSubscriptionsTable)
      .where(eq(workspaceSubscriptionsTable.workspaceId, workspaceId))
      .limit(1);

    if (row && ACTIVE_SUBSCRIPTION_STATUSES.has(row.status) && isValidPlanTier(row.planTier)) {
      return row.planTier;
    }
  } catch {
    // Table may not exist yet in environments where the migration has not
    // been run. Fall through to "free" — fail-safe to the smallest plan.
  }

  return "free";
}

/**
 * Map a Stripe Price ID to the MustaFlow plan tier. Reads
 * PLAN_PRICE_STARTER / PLAN_PRICE_PRO / PLAN_PRICE_ENTERPRISE env vars.
 * Returns null when the price doesn't match any configured plan.
 */
export function planTierForStripePriceId(priceId: string | null | undefined): PlanTier | null {
  if (!priceId) return null;
  const map: Array<[PlanTier, string | undefined]> = [
    ["starter", process.env.PLAN_PRICE_STARTER],
    ["pro", process.env.PLAN_PRICE_PRO],
    ["enterprise", process.env.PLAN_PRICE_ENTERPRISE],
  ];
  for (const [tier, env] of map) {
    if (env && env.trim() === priceId) return tier;
  }
  return null;
}

/** Lookup the configured Stripe Price ID for a plan tier (env-driven). */
export function stripePriceIdForPlan(tier: PlanTier): string | undefined {
  switch (tier) {
    case "starter":
      return process.env.PLAN_PRICE_STARTER?.trim() || undefined;
    case "pro":
      return process.env.PLAN_PRICE_PRO?.trim() || undefined;
    case "enterprise":
      return process.env.PLAN_PRICE_ENTERPRISE?.trim() || undefined;
    default:
      return undefined;
  }
}

/**
 * Check whether adding one more of `resource` is within the workspace's quota.
 * Does NOT throw — returns a result object so callers can respond with a
 * structured 402 including an upgrade CTA.
 */
export async function enforceQuota(
  resource: QuotaResource,
  currentCount: number,
  workspaceId: number,
): Promise<QuotaEnforcementResult> {
  const plan = await resolveWorkspacePlan(workspaceId);
  const quota = PLAN_QUOTAS[plan];

  let limit: number;
  switch (resource) {
    case "domain":
      limit = quota.maxCustomDomains;
      break;
    case "cert":
      limit = quota.maxCustomCerts;
      break;
    case "domainRole":
      limit = quota.maxDomainRoleGrants;
      break;
  }

  const allowed = currentCount < limit;
  const upgradeMessage = allowed
    ? undefined
    : plan === "free"
      ? `You have reached the ${limit} custom domain limit on the Free plan. Upgrade to Starter (5 domains) or Pro (25 domains) to add more.`
      : plan === "starter"
        ? `You have reached the ${limit} custom domain limit on the Starter plan. Upgrade to Pro for up to 25 domains.`
        : `You have reached the ${limit} custom domain limit on the Pro plan. Contact us for an Enterprise plan with unlimited domains.`;

  return { allowed, current: currentCount, limit, plan, upgradeMessage };
}
