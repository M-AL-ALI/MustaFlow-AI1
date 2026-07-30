// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow Constellation ↔ Stripe (Task #1518).
//
// The enterprise lane bills a COMPANY-FLAGGED Stripe Customer (the
// organization entity — never any user's personal customer) on the same
// shared Stripe account, namespaced with `surface: nabuflow` +
// `entity: organization` metadata. Bulk credit-pool purchases are one-time
// invoices with human-readable line items, a purchase-order reference and —
// where terms are enabled — `send_invoice` collection with net-N terms.
//
// Ora's products/prices are never read or written here.
// ─────────────────────────────────────────────────────────────────────────────

import type Stripe from "stripe";
import type { NabuflowOrg } from "@workspace/db";
import {
  NabuflowStripeError,
  requireStripe,
  getCustomerDefaultPaymentMethod,
} from "./nabuflow-stripe";
import { nabuflowBulkTierFor, type NabuflowBulkTier } from "./nabuflow-plans";
import { logger } from "./logger";

export interface NabuflowOrgCompanyDetails {
  companyName: string;
  billingContactName?: string | null;
  billingContactEmail: string;
  taxId?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region?: string | null;
  postalCode: string;
  country: string;
  createdByUserId: string;
}

/**
 * Create the company-flagged Stripe Customer for an enterprise org.
 * `entity: organization` + `surface: nabuflow` metadata is the namespace the
 * webhook router keys on; the tax/VAT id is kept in metadata and echoed on
 * invoices as a custom field (no guessing of Stripe tax-id enum types).
 */
export async function createNabuflowOrgStripeCustomer(
  details: NabuflowOrgCompanyDetails,
): Promise<Stripe.Customer> {
  const stripe = await requireStripe();
  return stripe.customers.create({
    name: details.companyName,
    email: details.billingContactEmail,
    description: `${details.companyName} — organization (NabuFlow Constellation)`,
    address: {
      line1: details.addressLine1,
      ...(details.addressLine2 ? { line2: details.addressLine2 } : {}),
      city: details.city,
      ...(details.region ? { state: details.region } : {}),
      postal_code: details.postalCode,
      country: details.country,
    },
    metadata: {
      surface: "nabuflow",
      entity: "organization",
      company_name: details.companyName,
      ...(details.taxId ? { tax_id: details.taxId } : {}),
      ...(details.billingContactName ? { billing_contact: details.billingContactName } : {}),
      created_by_user_id: details.createdByUserId,
    },
  });
}

/** Back-link the org row id onto the customer once the row exists (best-effort). */
export async function linkNabuflowOrgCustomer(customerId: string, orgId: number): Promise<void> {
  try {
    const stripe = await requireStripe();
    await stripe.customers.update(customerId, { metadata: { org_id: String(orgId) } });
  } catch (err) {
    logger.warn({ err, customerId, orgId }, "nabuflow-org: customer org_id back-link failed");
  }
}

/**
 * Card capture for the COMPANY customer (billing admins only). Confirmation
 * lands via the shared `setup_intent.succeeded` webhook, which sets the
 * customer's default payment method — same flow as personal plans.
 */
export async function createNabuflowOrgSetupIntent(
  customerId: string,
  orgId: number,
  userId: string,
): Promise<{ clientSecret: string; setupIntentId: string }> {
  const stripe = await requireStripe();
  const si = await stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: {
      surface: "nabuflow",
      purpose: "org_card",
      org_id: String(orgId),
      userId,
    },
  });
  if (!si.client_secret) {
    throw new NabuflowStripeError("Stripe did not return a client secret.");
  }
  return { clientSecret: si.client_secret, setupIntentId: si.id };
}

/** Display summary of the company card on file, if any. */
export async function getNabuflowOrgCardSummary(customerId: string): Promise<{
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
} | null> {
  const stripe = await requireStripe();
  const pm = await getCustomerDefaultPaymentMethod(stripe, customerId);
  if (!pm) return null;
  const card = pm.pm?.card;
  return {
    brand: card?.brand ?? null,
    last4: card?.last4 ?? null,
    expMonth: card?.exp_month ?? null,
    expYear: card?.exp_year ?? null,
  };
}

export interface NabuflowOrgInvoiceResult {
  stripeInvoiceId: string;
  status: string;
  hostedInvoiceUrl: string | null;
  invoicePdfUrl: string | null;
  dueAt: Date | null;
  /** True when the card path charged successfully right now. */
  paid: boolean;
}

/**
 * Create, finalize and collect the Stripe invoice for a bulk credit-pool
 * purchase, billed to the company entity.
 *
 *   • line item: human-readable ("NabuFlow Constellation bulk credits —
 *     100,000 credits @ $0.008/credit"), attached DIRECTLY to the invoice
 *     (never a floating pending item — nothing else may sweep it),
 *   • custom fields: PO reference and Tax/VAT id, printed on the invoice,
 *   • `method: "card"` → charge_automatically + pay immediately (decline ⇒
 *     calm structured error, invoice voided, nothing half-charged),
 *   • `method: "invoice"` → send_invoice with the org's net-N terms; the pool
 *     is funded when `invoice.paid` arrives.
 */
export async function createNabuflowOrgBulkInvoice(opts: {
  org: NabuflowOrg;
  credits: number;
  amountUsdCents: number;
  tier: NabuflowBulkTier;
  method: "card" | "invoice";
  poReference?: string | null;
  requestedByUserId: string;
  purchaseId: number;
}): Promise<NabuflowOrgInvoiceResult> {
  const stripe = await requireStripe();
  const { org, credits, amountUsdCents, tier, method, purchaseId } = opts;
  if (!org.stripeCustomerId) {
    throw new NabuflowStripeError(
      "This organization has no Stripe customer yet. Re-run enterprise setup.",
      "stripe_error",
    );
  }

  const poReference = (opts.poReference ?? org.poReference ?? "").trim();
  const customFields: Stripe.InvoiceCreateParams.CustomField[] = [];
  if (poReference) customFields.push({ name: "PO reference", value: poReference.slice(0, 140) });
  if (org.taxId) customFields.push({ name: "Tax/VAT ID", value: org.taxId.slice(0, 140) });

  if (method === "card") {
    const defaultPm = await getCustomerDefaultPaymentMethod(stripe, org.stripeCustomerId);
    if (!defaultPm) {
      throw new NabuflowStripeError(
        "Add a company card before purchasing by card, or use invoice terms if enabled.",
        "no_payment_method",
      );
    }
  }

  const metadata = {
    surface: "nabuflow",
    entity: "organization",
    purpose: "org_pool_purchase",
    org_id: String(org.id),
    purchase_id: String(purchaseId),
    credits: String(credits),
    requested_by_user_id: opts.requestedByUserId,
  } as const;

  // 1. Draft invoice for the company entity (auto_advance off — collection is
  //    explicit below, so a webhook replay can never double-charge).
  const draft = await stripe.invoices.create({
    customer: org.stripeCustomerId,
    collection_method: method === "invoice" ? "send_invoice" : "charge_automatically",
    ...(method === "invoice" ? { days_until_due: org.termsNetDays } : {}),
    auto_advance: false,
    description: `NabuFlow Constellation — bulk build-credit purchase for ${org.companyName}`,
    ...(customFields.length ? { custom_fields: customFields } : {}),
    footer: `Billed to ${org.companyName}. Credits fund the organization's shared NabuFlow build pool and do not expire.`,
    metadata: { ...metadata },
  });
  if (!draft.id) throw new NabuflowStripeError("Stripe did not return an invoice id.");

  // 2. Human-readable line item, attached directly to this invoice.
  const perCredit = `$${tier.usdPerCredit.toFixed(3)}`;
  await stripe.invoiceItems.create({
    customer: org.stripeCustomerId,
    invoice: draft.id,
    amount: amountUsdCents,
    currency: "usd",
    description: `NabuFlow Constellation bulk credits — ${credits.toLocaleString("en-US")} build credits @ ${perCredit}/credit (volume tier: ${tier.label})`,
    metadata: { ...metadata },
  });

  // 3. Finalize (assigns number + hosted URL/PDF).
  await stripe.invoices.finalizeInvoice(draft.id);

  // 4. Collect.
  let invoice: Stripe.Invoice;
  let paid = false;
  if (method === "card") {
    try {
      invoice = await stripe.invoices.pay(draft.id);
      paid = invoice.status === "paid";
    } catch (err) {
      // Decline: void the invoice so nothing lingers, then surface calmly.
      try {
        await stripe.invoices.voidInvoice(draft.id);
      } catch (voidErr) {
        logger.warn({ voidErr, invoiceId: draft.id }, "nabuflow-org: void after decline failed");
      }
      const message = err instanceof Error ? err.message : String(err);
      throw new NabuflowStripeError(
        `The company card couldn't be charged: ${message}`,
        "payment_failed",
      );
    }
  } else {
    invoice = await stripe.invoices.sendInvoice(draft.id);
  }

  return {
    stripeInvoiceId: invoice.id ?? draft.id,
    status: invoice.status ?? "open",
    hostedInvoiceUrl: invoice.hosted_invoice_url ?? null,
    invoicePdfUrl: invoice.invoice_pdf ?? null,
    dueAt: invoice.due_date ? new Date(invoice.due_date * 1000) : null,
    paid,
  };
}

/** Guard: the tier must exist for the credited amount (route re-validates too). */
export function requireBulkTier(credits: number): NabuflowBulkTier {
  const tier = nabuflowBulkTierFor(credits);
  if (!tier) {
    throw new NabuflowStripeError(
      "That amount is below the Constellation bulk-purchase minimum.",
      "stripe_error",
    );
  }
  return tier;
}
