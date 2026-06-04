import { pgTable, serial, text, boolean, timestamp, index } from "drizzle-orm/pg-core";

export const SUBSCRIPTION_TIERS = ["free", "core", "wave"] as const;
export type SubscriptionTier = (typeof SUBSCRIPTION_TIERS)[number];

// Tiers permitted to use Deep Thinking and connectors (GitHub, etc.).
// Free is Instant-only with no connectors.
export const PAID_TIERS: ReadonlySet<SubscriptionTier> = new Set(["core", "wave"]);

export const SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "grace_period",
  "canceled",
  "incomplete",
] as const;
export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export const TIER_MONTHLY_CREDITS: Record<SubscriptionTier, number> = {
  free: 150,
  core: 1500,
  wave: 4000,
};

export const TIER_MAX_CONCURRENT_BUILDS: Record<SubscriptionTier, number> = {
  free: 1,
  core: 3,
  wave: 10,
};

export const TIER_PRICE_USD: Record<SubscriptionTier, number> = {
  free: 0,
  core: 20,
  wave: 40,
};

// Monthly image-generation caps per tier (Image Studio + inline Ora images).
export const TIER_MONTHLY_IMAGE_CAP: Record<SubscriptionTier, number> = {
  free: 3,
  core: 12,
  wave: 30,
};

// Per-user subscription row. Created on first subscribe or free-tier initialisation.
export const userSubscriptionsTable = pgTable(
  "user_subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().unique(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    tier: text("tier").notNull().default("free"),
    status: text("status").notNull().default("active"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    gracePeriodEnd: timestamp("grace_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    lastMonthlyGrantAt: timestamp("last_monthly_grant_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("user_subscriptions_stripe_customer_idx").on(t.stripeCustomerId),
    index("user_subscriptions_stripe_sub_idx").on(t.stripeSubscriptionId),
  ],
);

export type UserSubscription = typeof userSubscriptionsTable.$inferSelect;
export type InsertUserSubscription = typeof userSubscriptionsTable.$inferInsert;
