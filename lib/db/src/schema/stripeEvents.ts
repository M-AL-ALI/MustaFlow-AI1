import { pgTable, text, timestamp, varchar } from "drizzle-orm/pg-core";

// Tracks Stripe webhook event IDs and their processing status, so that
// retries / replays do not double-credit users.
//
// Status lifecycle:
//   processing → succeeded  (happy path)
//   processing → failed     (handler threw; Stripe retries)
//
// A new event INSERT or a failed/stuck (>5 min) processing row can be claimed.
// A succeeded row is never re-processed.
export const stripeProcessedEventsTable = pgTable("stripe_processed_events", {
  eventId: text("event_id").primaryKey(),
  type: text("type"),
  processedAt: timestamp("processed_at", { withTimezone: true }).notNull().defaultNow(),
  status: varchar("status", { length: 20 }).notNull().default("succeeded"),
  processingStartedAt: timestamp("processing_started_at", { withTimezone: true }),
  succeededAt: timestamp("succeeded_at", { withTimezone: true }),
  failedAt: timestamp("failed_at", { withTimezone: true }),
  errorMessage: text("error_message"),
});

export type StripeProcessedEvent = typeof stripeProcessedEventsTable.$inferSelect;
