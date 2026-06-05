import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  index,
  integer,
  uniqueIndex,
} from "drizzle-orm/pg-core";

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

// ── Ora message-based daily quotas ──────────────────────────────────────────
// The standalone Ora assistant is metered by DAILY message + image limits per
// subscription tier — NOT by the AI Builder credit wallet. Limits reset at
// midnight UTC. The Builder keeps its separate credit system untouched.
export const TIER_DAILY_MESSAGE_LIMIT: Record<SubscriptionTier, number> = {
  free: 15,
  core: 30,
  wave: 55,
};

// Daily image generation/edit caps per tier (inline Ora images).
export const TIER_DAILY_IMAGE_LIMIT: Record<SubscriptionTier, number> = {
  free: 3,
  core: 10,
  wave: 20,
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

// Per-user, per-UTC-day Ora usage counters. Drives Ora's message-based daily
// quotas (decoupled from the AI Builder credit wallet). One row per user/day;
// counters are bumped atomically via upsert. Old rows are harmless history.
export const oraDailyUsageTable = pgTable(
  "ora_daily_usage",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    // Calendar day in UTC, formatted YYYY-MM-DD.
    usageDate: text("usage_date").notNull(),
    messageCount: integer("message_count").notNull().default(0),
    imageCount: integer("image_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ora_daily_usage_user_date_uniq").on(t.userId, t.usageDate)],
);

export type OraDailyUsage = typeof oraDailyUsageTable.$inferSelect;
export type InsertOraDailyUsage = typeof oraDailyUsageTable.$inferInsert;
