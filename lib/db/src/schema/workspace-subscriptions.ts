import { pgTable, integer, text, timestamp, index } from "drizzle-orm/pg-core";
import { workspacesTable } from "./workspaces";

// Per-workspace Stripe subscription state (Task #644).
// Maps a workspace to its active Stripe subscription so resolveWorkspacePlan()
// can return the correct plan tier without operator env-var overrides.
// One row per workspace. status mirrors Stripe's subscription.status values
// (active, trialing, past_due, canceled, incomplete, ...). planTier is the
// MustaFlow plan key derived from the subscription's price ID.
export const workspaceSubscriptionsTable = pgTable(
  "workspace_subscriptions",
  {
    workspaceId: integer("workspace_id")
      .primaryKey()
      .references(() => workspacesTable.id, { onDelete: "cascade" }),
    stripeCustomerId: text("stripe_customer_id"),
    stripeSubscriptionId: text("stripe_subscription_id").unique(),
    stripePriceId: text("stripe_price_id"),
    planTier: text("plan_tier").notNull().default("free"),
    status: text("status").notNull().default("inactive"),
    currentPeriodEnd: timestamp("current_period_end", { withTimezone: true }),
    cancelAtPeriodEnd: text("cancel_at_period_end"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("workspace_subscriptions_customer_idx").on(t.stripeCustomerId),
    index("workspace_subscriptions_status_idx").on(t.status),
  ],
);

export type WorkspaceSubscription = typeof workspaceSubscriptionsTable.$inferSelect;
export type InsertWorkspaceSubscription = typeof workspaceSubscriptionsTable.$inferInsert;
