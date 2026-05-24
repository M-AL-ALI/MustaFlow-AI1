// ─────────────────────────────────────────────────────────────────────────────
// Plan quotas — Task #558
//
// Maps plan tier → resource limits. Enforced server-side via enforceQuota().
// Quotas apply per workspace (org) for domain operations.
// ─────────────────────────────────────────────────────────────────────────────

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

/**
 * Resolve the plan tier for a workspace. In Phase 1 all workspaces are "free"
 * unless overridden via the PLAN_OVERRIDE_<WORKSPACE_ID> env var (for manual
 * upgrades before Stripe subscriptions are wired). The Stripe subscription
 * lookup will be wired here once the billing tables are expanded.
 */
export function resolveWorkspacePlan(workspaceId: number): PlanTier {
  const override = process.env[`PLAN_OVERRIDE_${workspaceId}`] as PlanTier | undefined;
  if (override && PLAN_TIERS.includes(override)) return override;
  // Global override for testing
  const globalOverride = process.env.DEFAULT_PLAN_TIER as PlanTier | undefined;
  if (globalOverride && PLAN_TIERS.includes(globalOverride)) return globalOverride;
  return "free";
}

/**
 * Check whether adding one more of `resource` is within the workspace's quota.
 * Does NOT throw — returns a result object so callers can respond with a
 * structured 402 including an upgrade CTA.
 */
export function enforceQuota(
  resource: QuotaResource,
  currentCount: number,
  workspaceId: number,
): QuotaEnforcementResult {
  const plan = resolveWorkspacePlan(workspaceId);
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
