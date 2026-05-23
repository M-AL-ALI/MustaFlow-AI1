import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

// Tracks Stripe webhook event IDs that have already been processed, so that
// retries / replays do not double-credit users. The webhook handler inserts
// with ON CONFLICT DO NOTHING and skips credit grant if the row already exists.
export const stripeProcessedEventsTable = pgTable("stripe_processed_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
});

export type StripeProcessedEvent = typeof stripeProcessedEventsTable.$inferSelect;
