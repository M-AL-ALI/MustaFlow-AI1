import {
  pgTable,
  serial,
  text,
  boolean,
  timestamp,
  integer,
  index,
  unique,
} from "drizzle-orm/pg-core";

// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow Builder billing — plan state fully SEPARATE from Ora's
// `user_subscriptions` (free/core/wave). Nothing here is read by any Ora
// surface, and Ora's tables are never written by NabuFlow billing code.
//
// Money is stored as integer USD cents so cycle arithmetic is exact and
// reconciles 1:1 with the Stripe invoice items we create for overage.
// ─────────────────────────────────────────────────────────────────────────────

export const NABUFLOW_SUBSCRIPTION_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "canceled",
  "incomplete",
] as const;
export type NabuflowSubscriptionStatus = (typeof NABUFLOW_SUBSCRIPTION_STATUSES)[number];

export const NABUFLOW_DUNNING_STATUSES = ["none", "retrying", "paused"] as const;
export type NabuflowDunningStatus = (typeof NABUFLOW_DUNNING_STATUSES)[number];

// Per-user NabuFlow Builder subscription. One row per user; plan, Stripe
// linkage, cycle anchor, rollover balance, card-on-file and dunning state.
export const nabuflowSubscriptionsTable = pgTable(
  "nabuflow_subscriptions",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull().unique(),
    /** orbit | comet | nova | constellation — see nabuflow-plans.ts */
    planId: text("plan_id").notNull(),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id"),
    /** Licensed subscription item id — needed for plan switches / proration. */
    stripeItemId: text("stripe_item_id"),
    status: text("status").notNull().default("incomplete"),
    cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
    /** Anchor of the current billing cycle (webhook-driven, lazily advanced). */
    currentCycleStart: timestamp("current_cycle_start", { withTimezone: true }),
    currentCycleEnd: timestamp("current_cycle_end", { withTimezone: true }),
    /** Credits carried INTO the current cycle (Comet/Nova: one cycle max). */
    rolloverCredits: integer("rollover_credits").notNull().default(0),
    // Card on file (webhook-driven; only safe display fields, never PANs).
    defaultPaymentMethodId: text("default_payment_method_id"),
    cardBrand: text("card_brand"),
    cardLast4: text("card_last4"),
    cardExpMonth: integer("card_exp_month"),
    cardExpYear: integer("card_exp_year"),
    // Dunning: retry → notify → pause-new-builds-after-grace.
    dunningStatus: text("dunning_status").notNull().default("none"),
    dunningStartedAt: timestamp("dunning_started_at", { withTimezone: true }),
    dunningGraceUntil: timestamp("dunning_grace_until", { withTimezone: true }),
    dunningPausedAt: timestamp("dunning_paused_at", { withTimezone: true }),
    dunningAttemptCount: integer("dunning_attempt_count").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nabuflow_subscriptions_stripe_sub_idx").on(t.stripeSubscriptionId),
    index("nabuflow_subscriptions_stripe_customer_idx").on(t.stripeCustomerId),
  ],
);

// Per-user billing settings that survive plan switches (spend cap).
export const nabuflowBillingSettingsTable = pgTable("nabuflow_billing_settings", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  /**
   * Monthly pay-as-you-go spend cap in USD cents. NULL = use the plan's
   * default cap. Always clamped to the plan's maximum on write AND read.
   */
  spendCapUsdCents: integer("spend_cap_usd_cents"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// One row per user per billing cycle: included-credit bucket, metered Pro/Deep
// counters, overage accumulation and notification watermarks. Counters reset
// by construction — a new cycle starts a fresh row (metered builds never roll
// over; only unused included credits may, per plan policy).
export const nabuflowBillingCyclesTable = pgTable(
  "nabuflow_billing_cycles",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    planId: text("plan_id").notNull(),
    cycleStart: timestamp("cycle_start", { withTimezone: true }).notNull(),
    cycleEnd: timestamp("cycle_end", { withTimezone: true }).notNull(),
    /** Plan monthly credits + rollover carried in. */
    includedCredits: integer("included_credits").notNull().default(0),
    /** Portion of includedCredits that came from last cycle's unused bucket. */
    rolloverCredits: integer("rollover_credits").notNull().default(0),
    usedIncludedCredits: integer("used_included_credits").notNull().default(0),
    overageCredits: integer("overage_credits").notNull().default(0),
    overageUsdCents: integer("overage_usd_cents").notNull().default(0),
    proBuildsUsed: integer("pro_builds_used").notNull().default(0),
    deepBuildsUsed: integer("deep_builds_used").notNull().default(0),
    /** Highest warned threshold (0|50|80|100) for the included-credit bucket. */
    bucketNotifyLevel: integer("bucket_notify_level").notNull().default(0),
    /** Highest warned threshold (0|50|80|100) for the spend cap. */
    capNotifyLevel: integer("cap_notify_level").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("nabuflow_cycles_user_cycle_unique").on(t.userId, t.cycleStart),
    index("nabuflow_cycles_user_idx").on(t.userId, t.cycleStart),
  ],
);

export const NABUFLOW_USAGE_ATTRIBUTIONS = ["included", "overage", "mixed"] as const;
export type NabuflowUsageAttribution = (typeof NABUFLOW_USAGE_ATTRIBUTIONS)[number];

// Per-build usage ledger. Every charged build records exactly what was drawn
// from the included bucket vs metered overage, with engine mode, deep flag,
// project and cycle attribution so dashboards and invoices reconcile exactly.
export const nabuflowUsageEventsTable = pgTable(
  "nabuflow_usage_events",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    cycleId: integer("cycle_id").notNull(),
    cycleStart: timestamp("cycle_start", { withTimezone: true }).notNull(),
    projectId: integer("project_id"),
    taskId: integer("task_id"),
    /** pipeline | background | queue | eas | architect | senses | converse | creative | plan */
    source: text("source").notNull().default("pipeline"),
    /** lite | eco | power | pro — null for mode-less charges (e.g. EAS). */
    engineMode: text("engine_mode"),
    deepReasoning: boolean("deep_reasoning").notNull().default(false),
    /** Total credits charged (exactly creditCostFor output — prices unchanged). */
    credits: integer("credits").notNull(),
    includedCredits: integer("included_credits").notNull().default(0),
    overageCredits: integer("overage_credits").notNull().default(0),
    /** Billable overage in USD cents (mirrors the Stripe invoice item). */
    overageUsdCents: integer("overage_usd_cents").notNull().default(0),
    /** Dollar value of the whole event at the plan's overage rate. */
    usdValueCents: integer("usd_value_cents").notNull().default(0),
    attribution: text("attribution").notNull().default("included"),
    description: text("description"),
    /** Pending invoice item created for the overage portion (cycle-close billing). */
    stripeInvoiceItemId: text("stripe_invoice_item_id"),
    stripeReportedAt: timestamp("stripe_reported_at", { withTimezone: true }),
    /** Set when a reserved charge was reversed (canceled/discarded background task). */
    reversedAt: timestamp("reversed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nabuflow_usage_events_user_idx").on(t.userId, t.createdAt),
    index("nabuflow_usage_events_cycle_idx").on(t.cycleId),
  ],
);

export type NabuflowSubscription = typeof nabuflowSubscriptionsTable.$inferSelect;
export type NabuflowBillingSettings = typeof nabuflowBillingSettingsTable.$inferSelect;
export type NabuflowBillingCycle = typeof nabuflowBillingCyclesTable.$inferSelect;
export type NabuflowUsageEvent = typeof nabuflowUsageEventsTable.$inferSelect;
