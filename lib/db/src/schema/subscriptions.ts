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

// ── Ora LIVE-VOICE ("Talk to Ora") rolling-window minute budgets ────────────
// "Talk to Ora" realtime voice is metered by ACTUAL spoken seconds per tier,
// independent of the message/image budget above. The window length reuses the
// same TIER_ORA_WINDOW_HOURS clock per tier (free 5h, core 3h, wave 3h) so the
// two budgets refill on the same cadence, but the SECOND allowance is a
// dedicated constant so message-budget changes never silently change voice.
// Anonymous visitors are metered with the free allowance.
export const TIER_ORA_REALTIME_LIMIT_SECONDS: Record<SubscriptionTier, number> = {
  free: 1200, // 20 minutes / 5h window
  core: 3600, // 60 minutes / 3h window
  wave: 7200, // 120 minutes / 3h window
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

// Per-key Ora LIVE-VOICE ROLLING-WINDOW budget ledger. Tracks ACTUAL spoken
// seconds toward the tier's voice minute budget. Exactly ONE row per usage key
// (signed-in: the user id; anonymous: "anon:"+hash). `window_start` marks when
// the current voice window opened (set on the first charged second after a
// reset); `used_seconds` accumulates within it and resets once
// now() - window_start >= the tier's window length. Charged atomically via
// upsert deltas so overlapping heartbeats can never lose or double-count time.
export const oraRealtimeUsageWindowsTable = pgTable(
  "ora_realtime_usage_windows",
  {
    id: serial("id").primaryKey(),
    // Metering key: user id for signed-in users, "anon:<hash>" for anonymous.
    usageKey: text("usage_key").notNull(),
    // When the user's current rolling voice window opened.
    windowStart: timestamp("window_start", { withTimezone: true }).notNull().defaultNow(),
    // Spoken seconds charged within the current window.
    usedSeconds: integer("used_seconds").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ora_realtime_usage_windows_key_uniq").on(t.usageKey)],
);

export type OraRealtimeUsageWindow = typeof oraRealtimeUsageWindowsTable.$inferSelect;
export type InsertOraRealtimeUsageWindow = typeof oraRealtimeUsageWindowsTable.$inferInsert;

// Per-session reconciliation / concurrency / audit record for a single minted
// "Talk to Ora" realtime session. The id is a server-issued unguessable UUID
// returned to the client and echoed on every heartbeat/end. `charged_seconds`
// is how much of this session's elapsed time has already been debited to the
// usage window; each heartbeat adds the delta up to `max_duration_seconds`.
// `status` is 'active' while live, 'ended' on graceful end, 'expired' when a
// stale session (no heartbeat past the grace period) is finalized.
export const oraRealtimeSessionsTable = pgTable(
  "ora_realtime_sessions",
  {
    // Server-issued UUID; also the client-facing realtimeSessionId.
    id: text("id").primaryKey(),
    usageKey: text("usage_key").notNull(),
    tier: text("tier").notNull(),
    // Hard per-session ceiling = min(remaining budget, technical per-session cap).
    maxDurationSeconds: integer("max_duration_seconds").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    lastHeartbeatAt: timestamp("last_heartbeat_at", { withTimezone: true }).notNull().defaultNow(),
    // Seconds of this session already debited to the usage window.
    chargedSeconds: integer("charged_seconds").notNull().default(0),
    status: text("status").notNull().default("active"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("ora_realtime_sessions_key_status_idx").on(t.usageKey, t.status),
    index("ora_realtime_sessions_status_heartbeat_idx").on(t.status, t.lastHeartbeatAt),
  ],
);

export type OraRealtimeSession = typeof oraRealtimeSessionsTable.$inferSelect;
export type InsertOraRealtimeSession = typeof oraRealtimeSessionsTable.$inferInsert;
