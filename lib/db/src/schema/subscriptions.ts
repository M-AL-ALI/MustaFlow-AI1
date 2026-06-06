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

// ── Ora message-based ROLLING-WINDOW quotas ─────────────────────────────────
// The standalone Ora assistant is metered by per-user ROLLING TIME WINDOWS per
// subscription tier — NOT by the AI Builder credit wallet, and NOT by a shared
// midnight-UTC clock. The window starts on the user's FIRST message after a
// reset and the full allowance refills exactly TIER_ORA_WINDOW_HOURS later.
// Messages and images share ONE window timer per user (they refill together).
// The Builder keeps its separate credit system untouched.
export const TIER_ORA_MESSAGE_LIMIT: Record<SubscriptionTier, number> = {
  free: 30,
  core: 100,
  wave: 280,
};

// Image generation/edit caps per tier (inline Ora images), per rolling window.
export const TIER_ORA_IMAGE_LIMIT: Record<SubscriptionTier, number> = {
  free: 4,
  core: 15,
  wave: 30,
};

// Length (in hours) of each tier's personal rolling usage window.
export const TIER_ORA_WINDOW_HOURS: Record<SubscriptionTier, number> = {
  free: 5,
  core: 3,
  wave: 3,
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

// Per-user Ora ROLLING-WINDOW usage counters. Drives Ora's message + image
// quotas (decoupled from the AI Builder credit wallet). Exactly ONE row per
// user: `window_start` marks when the current personal window opened (set on the
// user's first metered action after a reset); `message_count` / `image_count`
// accumulate within that window. Both counters reset together once
// now() - window_start >= the tier's window length. Counters are bumped
// atomically via upsert so concurrent requests can never overshoot the limit.
export const oraUsageWindowsTable = pgTable(
  "ora_usage_windows",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    // When the user's current rolling window opened.
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    messageCount: integer("message_count").notNull().default(0),
    imageCount: integer("image_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ora_usage_windows_user_uniq").on(t.userId)],
);

export type OraUsageWindow = typeof oraUsageWindowsTable.$inferSelect;
export type InsertOraUsageWindow = typeof oraUsageWindowsTable.$inferInsert;
