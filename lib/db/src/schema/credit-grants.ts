import { pgTable, serial, text, integer, timestamp, unique } from "drizzle-orm/pg-core";

// Tracks monthly credit grants per subscription billing period.
// The unique constraint on (subscription_id, period_start) is the atomicity
// guard that prevents duplicate credit grants when Stripe retries invoice.paid
// webhooks for the same billing cycle.
export const creditGrantsTable = pgTable(
  "credit_grants",
  {
    id: serial("id").primaryKey(),
    userId: text("user_id").notNull(),
    subscriptionId: text("subscription_id").notNull(),
    periodStart: timestamp("period_start", { withTimezone: true }).notNull(),
    amount: integer("amount").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("credit_grants_subscription_period_unique").on(t.subscriptionId, t.periodStart)],
);

export type CreditGrant = typeof creditGrantsTable.$inferSelect;
