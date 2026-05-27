import { pgTable, serial, text, integer, timestamp } from "drizzle-orm/pg-core";

// Per-user credit balance. Created on first use with a default starter balance.
export const userCreditsTable = pgTable("user_credits", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull().unique(),
  balance: integer("balance").notNull().default(100),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  /** Last time a low-balance warning email was sent. Used to rate-limit to once per 24 h. */
  lastLowCreditEmailAt: timestamp("last_low_credit_email_at", { withTimezone: true }),
});

export const CREDIT_TRANSACTION_TYPES = [
  "starter_grant",
  "build",
  "refine",
  "plan",
  "architect",
  "senses",
  "creative",
  "manual_adjustment",
  "purchase",
  "subscription_grant",
  "refund",
  "lesson_contribution",
] as const;
export type CreditTransactionType = (typeof CREDIT_TRANSACTION_TYPES)[number];

// Transaction log — debit (negative amount) or credit (positive amount).
export const creditTransactionsTable = pgTable("credit_transactions", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  projectId: integer("project_id"),
  type: text("type").notNull().default("build"),
  amount: integer("amount").notNull(),
  description: text("description"),
  balanceAfter: integer("balance_after").notNull(),
  receiptUrl: text("receipt_url"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserCredit = typeof userCreditsTable.$inferSelect;
export type CreditTransaction = typeof creditTransactionsTable.$inferSelect;
