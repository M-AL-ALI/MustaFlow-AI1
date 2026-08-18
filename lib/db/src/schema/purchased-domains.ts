import { pgTable, serial, text, boolean, timestamp, integer, index } from "drizzle-orm/pg-core";

export const PURCHASED_DOMAIN_STATUSES = [
  "active",
  "pending",
  "transfer_pending",
  "expired",
  "cancelled",
  "released",
] as const;
export type PurchasedDomainStatus = (typeof PURCHASED_DOMAIN_STATUSES)[number];

export const purchasedDomainsTable = pgTable(
  "purchased_domains",
  {
    id: serial("id").primaryKey(),
    // userId: Clerk user ID of the domain owner.
    userId: text("user_id").notNull(),
    // hostname: the fully-qualified domain name (e.g. "myapp.com").
    hostname: text("hostname").notNull().unique(),
    // registrar: always "namecheap" for now; left open for future providers.
    registrar: text("registrar").notNull().default("namecheap"),
    // registeredAt / expiresAt: registration dates from Namecheap.
    registeredAt: timestamp("registered_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    // autoRenew: whether to auto-charge and renew 30 days before expiry.
    autoRenew: boolean("auto_renew").notNull().default(true),
    // whoisPrivacy: whether WHOIS privacy protection is enabled.
    whoisPrivacy: boolean("whois_privacy").notNull().default(true),
    // status: lifecycle state of the purchased domain.
    status: text("status").notNull().default("pending"),
    // namecheapOrderId: Namecheap order ID returned at registration / transfer.
    namecheapOrderId: text("namecheap_order_id"),
    // stripePaymentIntentId: Stripe PaymentIntent used for the purchase / renewal.
    stripePaymentIntentId: text("stripe_payment_intent_id"),
    // projectId: project this domain is attached to (optional — can be detached).
    projectId: integer("project_id"),
    // renewalStripePaymentIntentId: last renewal charge PI (for auditing).
    renewalStripePaymentIntentId: text("renewal_stripe_payment_intent_id"),
    // lastRenewalAt: when the last successful renewal ran.
    lastRenewalAt: timestamp("last_renewal_at", { withTimezone: true }),
    // renewalFailedAt: when the last renewal attempt failed.
    renewalFailedAt: timestamp("renewal_failed_at", { withTimezone: true }),
    // renewalFailureReason: error message from failed renewal.
    renewalFailureReason: text("renewal_failure_reason"),
    // transferAuthCode: EPP auth code for outbound transfers, or the provider transfer ID
    // while an inbound transfer is pending. Stored with the platform AES-256-GCM envelope.
    transferAuthCode: text("transfer_auth_code"),
    // whoisContactData: JSONB blob of WHOIS contact fields for display / update.
    whoisFirstName: text("whois_first_name"),
    whoisLastName: text("whois_last_name"),
    whoisEmail: text("whois_email"),
    whoisPhone: text("whois_phone"),
    whoisAddress: text("whois_address"),
    whoisCity: text("whois_city"),
    whoisStateProvince: text("whois_state_province"),
    whoisPostalCode: text("whois_postal_code"),
    whoisCountry: text("whois_country"),
    // stripeCustomerId: Stripe Customer ID — stored after first checkout so auto-renewal
    // can charge the saved payment method off-session (requires setup_future_usage=off_session).
    stripeCustomerId: text("stripe_customer_id"),
    // pricePaidUsd: price charged for this purchase (in USD, decimal string for precision).
    pricePaidUsd: text("price_paid_usd"),
    // renewalPriceUsd: most recent renewal price.
    renewalPriceUsd: text("renewal_price_usd"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("purchased_domains_user_idx").on(t.userId),
    index("purchased_domains_project_idx").on(t.projectId),
    index("purchased_domains_expires_idx").on(t.expiresAt),
  ],
);

export type PurchasedDomain = typeof purchasedDomainsTable.$inferSelect;
export type InsertPurchasedDomain = typeof purchasedDomainsTable.$inferInsert;
