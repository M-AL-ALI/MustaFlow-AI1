import {
  pgTable,
  serial,
  integer,
  text,
  timestamp,
  jsonb,
  index,
  unique,
} from "drizzle-orm/pg-core";

/** Durable retry queue for non-blocking billing and telemetry settlement. */
export const billingSettlementOutboxTable = pgTable(
  "billing_settlement_outbox",
  {
    id: serial("id").primaryKey(),
    kind: text("kind").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    taskId: integer("task_id"),
    ownerId: text("owner_id"),
    amount: integer("amount"),
    context: jsonb("context").notNull().default({}),
    attempts: integer("attempts").notNull().default(0),
    nextRetryAt: timestamp("next_retry_at", { withTimezone: true }).notNull().defaultNow(),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("billing_settlement_outbox_dedupe_key_unique").on(t.dedupeKey),
    index("billing_settlement_outbox_due_idx").on(t.completedAt, t.nextRetryAt),
    index("billing_settlement_outbox_task_idx").on(t.taskId),
  ],
);

export type BillingSettlementOutbox = typeof billingSettlementOutboxTable.$inferSelect;
export type InsertBillingSettlementOutbox = typeof billingSettlementOutboxTable.$inferInsert;
