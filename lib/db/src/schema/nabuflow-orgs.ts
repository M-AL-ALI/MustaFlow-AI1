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
import { organizationsTable } from "./organizations";

// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow Constellation — enterprise organization billing (Task #1518).
//
// A company registers as an organization, buys a volume-discounted bulk pool
// of build credits up front, and its seats draw builds from the shared pool
// through the exact same charge pipeline as self-serve plans. Invoices bill
// the company entity (its own company-flagged Stripe Customer — NOT any
// user's personal customer), with PO reference and net-terms support.
//
// Same credit unit, same shared Stripe account, namespaced to the enterprise
// product via `surface: nabuflow` + `entity: organization` metadata. Nothing
// here is read or written by any Ora/Orax surface.
//
// Money is integer USD cents (config speaks dollars, storage/API speak cents).
// ─────────────────────────────────────────────────────────────────────────────

export const NABUFLOW_ORG_STATUSES = ["active", "suspended"] as const;
export type NabuflowOrgStatus = (typeof NABUFLOW_ORG_STATUSES)[number];

export const NABUFLOW_ORG_SEAT_ROLES = ["billing_admin", "member"] as const;
export type NabuflowOrgSeatRole = (typeof NABUFLOW_ORG_SEAT_ROLES)[number];

// Company billing record. One row per enterprise organization; company
// details captured by the gated "Set up enterprise" flow, the company-flagged
// Stripe Customer id, the shared credit-pool balance and the org-wide monthly
// spend cap (NULL = Constellation plan default, always clamped to plan max).
export const nabuflowOrgsTable = pgTable(
  "nabuflow_orgs",
  {
    id: serial("id").primaryKey(),
    /**
     * Optional anchor to the platform `organizations` table (team orgs).
     * Nullable on purpose: enterprise billing registration must not force a
     * workspace org (slug, members UI, …) into existence — linking happens
     * when/if the company adopts team workspaces.
     */
    organizationId: integer("organization_id").references(() => organizationsTable.id, {
      onDelete: "set null",
    }),
    /** Legal company name — also the Stripe Customer `name`. */
    companyName: text("company_name").notNull(),
    billingContactName: text("billing_contact_name"),
    billingContactEmail: text("billing_contact_email").notNull(),
    /** Tax/VAT identifier, echoed on invoices as a custom field. */
    taxId: text("tax_id"),
    addressLine1: text("address_line1").notNull(),
    addressLine2: text("address_line2"),
    city: text("city").notNull(),
    region: text("region"),
    postalCode: text("postal_code").notNull(),
    /** ISO 3166-1 alpha-2 country code. */
    country: text("country").notNull(),
    /** Default purchase-order reference printed on invoices (per-purchase override allowed). */
    poReference: text("po_reference"),
    /** Pay bulk invoices by Stripe invoice with terms (net-N) instead of card-only. */
    invoiceTermsEnabled: boolean("invoice_terms_enabled").notNull().default(false),
    /** Net payment terms in days for send-invoice purchases (e.g. 30 = net-30). */
    termsNetDays: integer("terms_net_days").notNull().default(30),
    /** Company-flagged Stripe Customer (organization entity, never a user's). */
    stripeCustomerId: text("stripe_customer_id").unique(),
    status: text("status").notNull().default("active"),
    /**
     * Shared credit-pool balance. Draws happen at charge time and are never
     * refused mid-build (in-flight builds are never killed), so the balance
     * may dip below zero; the gate blocks NEW builds once it can't cover them.
     */
    poolCredits: integer("pool_credits").notNull().default(0),
    /**
     * Org-wide monthly spend cap in USD cents (draw value at the Constellation
     * per-credit rate). NULL = plan default; clamped to plan max on read.
     */
    monthlySpendCapUsdCents: integer("monthly_spend_cap_usd_cents"),
    /** Requesting account — the org's billing admin. */
    createdByUserId: text("created_by_user_id").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nabuflow_orgs_created_by_idx").on(t.createdByUserId)],
);

// Seat membership — which accounts draw from the org's shared pool.
// UNIQUE(user_id): an account bills to at most ONE enterprise pool, so charge
// attribution is deterministic (org pool takes precedence over any personal
// NabuFlow plan the seat may also hold).
export const nabuflowOrgSeatsTable = pgTable(
  "nabuflow_org_seats",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => nabuflowOrgsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().unique(),
    /** billing_admin — manages purchases/caps/seats; member — draws from the pool. */
    role: text("role").notNull().default("member"),
    /**
     * Optional per-seat monthly sub-cap in USD cents (same draw valuation as
     * the org cap). NULL = no seat-specific cap (org-wide cap still applies).
     */
    seatSpendCapUsdCents: integer("seat_spend_cap_usd_cents"),
    /** Email cached at add time for display without a Clerk round-trip. */
    email: text("email"),
    addedByUserId: text("added_by_user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nabuflow_org_seats_org_idx").on(t.orgId)],
);

export const NABUFLOW_ORG_PURCHASE_METHODS = ["card", "invoice"] as const;
export type NabuflowOrgPurchaseMethod = (typeof NABUFLOW_ORG_PURCHASE_METHODS)[number];

export const NABUFLOW_ORG_PURCHASE_STATUSES = ["pending", "paid", "failed", "void"] as const;
export type NabuflowOrgPurchaseStatus = (typeof NABUFLOW_ORG_PURCHASE_STATUSES)[number];

// Bulk credit purchases — one row per company invoice. `creditedAt` is the
// idempotency latch for funding the pool: exactly one transition NULL → set,
// whether the credit lands via the synchronous card-payment path or the
// invoice.paid webhook (both may fire for the same invoice).
export const nabuflowOrgPurchasesTable = pgTable(
  "nabuflow_org_purchases",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => nabuflowOrgsTable.id, { onDelete: "cascade" }),
    credits: integer("credits").notNull(),
    /** Invoice total in USD cents at the volume-discounted rate. */
    amountUsdCents: integer("amount_usd_cents").notNull(),
    /** card = charged immediately; invoice = Stripe invoice with net terms. */
    method: text("method").notNull(),
    status: text("status").notNull().default("pending"),
    stripeInvoiceId: text("stripe_invoice_id").unique(),
    hostedInvoiceUrl: text("hosted_invoice_url"),
    invoicePdfUrl: text("invoice_pdf_url"),
    /** PO reference printed on this invoice (falls back to the org default). */
    poReference: text("po_reference"),
    requestedByUserId: text("requested_by_user_id").notNull(),
    /** Payment due date for send-invoice purchases (net terms). */
    dueAt: timestamp("due_at", { withTimezone: true }),
    paidAt: timestamp("paid_at", { withTimezone: true }),
    /** Set exactly once when the pool was funded for this purchase. */
    creditedAt: timestamp("credited_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("nabuflow_org_purchases_org_idx").on(t.orgId, t.createdAt)],
);

export const NABUFLOW_ORG_LEDGER_TYPES = [
  "purchase",
  "draw",
  "reversal",
  "adjustment",
] as const;
export type NabuflowOrgLedgerType = (typeof NABUFLOW_ORG_LEDGER_TYPES)[number];

// Append-only shared-pool ledger. Every pool movement (bulk purchase in, seat
// draw out, reversal back) records signed credits and the balance after, so
// the pool balance is fully auditable and reconciles with usage + invoices.
export const nabuflowOrgLedgerTable = pgTable(
  "nabuflow_org_ledger",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => nabuflowOrgsTable.id, { onDelete: "cascade" }),
    /** purchase | draw | reversal | adjustment */
    entryType: text("entry_type").notNull(),
    /** Signed credits: purchases/reversals positive, draws negative. */
    credits: integer("credits").notNull(),
    /** Pool balance immediately after this entry. */
    balanceAfter: integer("balance_after").notNull(),
    /** Signed USD-cent value (draw value at the Constellation rate; purchase totals). */
    usdCents: integer("usd_cents").notNull().default(0),
    /** Seat the draw/reversal belongs to (NULL for purchases/adjustments). */
    userId: text("user_id"),
    /** Usage-event linkage for draws/reversals (nabuflow_usage_events.id). */
    usageEventId: integer("usage_event_id"),
    /** Purchase linkage for pool top-ups (nabuflow_org_purchases.id). */
    purchaseId: integer("purchase_id"),
    description: text("description"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("nabuflow_org_ledger_org_idx").on(t.orgId, t.createdAt),
    index("nabuflow_org_ledger_user_idx").on(t.userId),
  ],
);

// Org-wide monthly draw counters (UTC calendar months). A fresh month is a
// fresh row, so the org cap resets by construction — mirroring how per-user
// cycle rows reset metered counters.
export const nabuflowOrgMonthsTable = pgTable(
  "nabuflow_org_months",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => nabuflowOrgsTable.id, { onDelete: "cascade" }),
    monthStart: timestamp("month_start", { withTimezone: true }).notNull(),
    creditsDrawn: integer("credits_drawn").notNull().default(0),
    /** Draw value in USD cents at the Constellation per-credit rate. */
    drawnUsdCents: integer("drawn_usd_cents").notNull().default(0),
    /** Highest warned threshold (0|50|80|100) for the org monthly cap. */
    capNotifyLevel: integer("cap_notify_level").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("nabuflow_org_months_unique").on(t.orgId, t.monthStart)],
);

// Per-seat monthly draw counters — enforce the optional per-seat sub-caps.
export const nabuflowOrgSeatMonthsTable = pgTable(
  "nabuflow_org_seat_months",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => nabuflowOrgsTable.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    monthStart: timestamp("month_start", { withTimezone: true }).notNull(),
    creditsDrawn: integer("credits_drawn").notNull().default(0),
    drawnUsdCents: integer("drawn_usd_cents").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("nabuflow_org_seat_months_unique").on(t.orgId, t.userId, t.monthStart),
    index("nabuflow_org_seat_months_user_idx").on(t.userId, t.monthStart),
  ],
);

export type NabuflowOrg = typeof nabuflowOrgsTable.$inferSelect;
export type InsertNabuflowOrg = typeof nabuflowOrgsTable.$inferInsert;
export type NabuflowOrgSeat = typeof nabuflowOrgSeatsTable.$inferSelect;
export type NabuflowOrgPurchase = typeof nabuflowOrgPurchasesTable.$inferSelect;
export type NabuflowOrgLedgerEntry = typeof nabuflowOrgLedgerTable.$inferSelect;
export type NabuflowOrgMonth = typeof nabuflowOrgMonthsTable.$inferSelect;
export type NabuflowOrgSeatMonth = typeof nabuflowOrgSeatMonthsTable.$inferSelect;
