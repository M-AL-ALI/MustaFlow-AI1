// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow ↔ Stripe objects (Task #1516).
//
// Namespaced products/prices (`surface: nabuflow` metadata + stable
// lookup_keys), subscriptions on the account's EXISTING Stripe Customer,
// SetupIntent-based card capture, proration previews for plan switches, and
// pending invoice items for metered pay-as-you-go overage (swept into the
// cycle-close invoice automatically).
//
// Ora's products/prices (workspace tiers, Ora tiers, credit packages) are
// never read or written here.
// ─────────────────────────────────────────────────────────────────────────────

import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { db, nabuflowSubscriptionsTable, type NabuflowSubscription } from "@workspace/db";
import { getUncachableStripeClient } from "./stripeClient";
import {
  nabuflowPriceIdFromEnv,
  type NabuflowPlanConfig,
  type NabuflowPlanId,
} from "./nabuflow-plans";
import { logger } from "./logger";

export class NabuflowStripeError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "stripe_unavailable"
      | "plan_unavailable"
      | "no_payment_method"
      | "no_subscription"
      | "already_subscribed"
      | "payment_failed"
      | "stripe_error" = "stripe_error",
  ) {
    super(message);
    this.name = "NabuflowStripeError";
  }
}

export async function requireStripe(): Promise<Stripe> {
  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    throw new NabuflowStripeError(
      "Billing is not configured on this server yet. Try again later.",
      "stripe_unavailable",
    );
  }
  return stripe;
}

// Price-id cache: planId → priceId for the lifetime of the process (the
// underlying Stripe mode never changes within one process).
const priceCache = new Map<string, string>();

/** Test helper — clears the resolved-price cache. */
export function _clearNabuflowPriceCache(): void {
  priceCache.clear();
}

/**
 * Resolve (or lazily create) the Stripe price for a NabuFlow plan:
 *   1. env override (NABUFLOW_<PLAN>_PRICE_ID — env-scoped test vs live),
 *   2. lookup_key search,
 *   3. create product + price, namespaced with `surface: nabuflow` metadata.
 */
export async function resolveNabuflowPriceId(
  stripe: Stripe,
  plan: NabuflowPlanConfig,
): Promise<string> {
  if (!plan.available || plan.priceUsd === null) {
    throw new NabuflowStripeError(
      `The ${plan.name} plan isn't available for self-serve signup yet.`,
      "plan_unavailable",
    );
  }

  const envId = nabuflowPriceIdFromEnv(plan);
  if (envId) return envId;

  const cached = priceCache.get(plan.id);
  if (cached) return cached;

  const byLookup = await stripe.prices.list({
    lookup_keys: [plan.stripeLookupKey],
    limit: 1,
  });
  const found = byLookup.data[0];
  if (found?.id) {
    priceCache.set(plan.id, found.id);
    return found.id;
  }

  // Create namespaced product + price (idempotent enough: lookup_key is
  // unique in Stripe, so a concurrent create loses and we re-list).
  try {
    const product = await stripe.products.create({
      name: `NabuFlow ${plan.name}`,
      description: `NabuFlow Builder ${plan.name} plan — ${plan.includedMonthlyCredits.toLocaleString()} build credits/month`,
      metadata: { surface: "nabuflow", plan: plan.id },
    });
    const price = await stripe.prices.create({
      product: product.id,
      unit_amount: Math.round(plan.priceUsd * 100),
      currency: "usd",
      recurring: { interval: "month" },
      lookup_key: plan.stripeLookupKey,
      metadata: { surface: "nabuflow", plan: plan.id },
    });
    priceCache.set(plan.id, price.id);
    logger.info(
      { planId: plan.id, priceId: price.id, productId: product.id },
      "nabuflow: created namespaced Stripe product/price",
    );
    return price.id;
  } catch (err) {
    // Lost a creation race — the lookup_key now resolves.
    const retry = await stripe.prices.list({ lookup_keys: [plan.stripeLookupKey], limit: 1 });
    if (retry.data[0]?.id) {
      priceCache.set(plan.id, retry.data[0].id);
      return retry.data[0].id;
    }
    throw err;
  }
}

/** The customer's effective default payment method id, if any. */
export async function getCustomerDefaultPaymentMethod(
  stripe: Stripe,
  customerId: string,
): Promise<{ id: string; pm: Stripe.PaymentMethod | null } | null> {
  const customer = await stripe.customers.retrieve(customerId);
  if (!customer || (customer as Stripe.DeletedCustomer).deleted) return null;
  const c = customer as Stripe.Customer;
  const raw = c.invoice_settings?.default_payment_method;
  const id = typeof raw === "string" ? raw : (raw?.id ?? null);
  if (!id) return null;
  try {
    const pm = await stripe.paymentMethods.retrieve(id);
    return { id, pm };
  } catch {
    return { id, pm: null };
  }
}

export async function setNabuflowDefaultPaymentMethod(
  customerId: string,
  paymentMethodId: string,
): Promise<void> {
  const stripe = await requireStripe();
  await stripe.customers.update(customerId, {
    invoice_settings: { default_payment_method: paymentMethodId },
  });
}

export async function retrieveNabuflowPaymentMethod(
  paymentMethodId: string,
): Promise<Stripe.PaymentMethod | null> {
  const stripe = await requireStripe();
  try {
    return await stripe.paymentMethods.retrieve(paymentMethodId);
  } catch {
    return null;
  }
}

/**
 * SetupIntent-based card capture: off-session usage so renewal + overage
 * charges work unattended. Confirmation state lands via the
 * `setup_intent.succeeded` webhook — never trusted from the client.
 */
export async function createNabuflowSetupIntent(
  customerId: string,
  userId: string,
): Promise<{ clientSecret: string; setupIntentId: string }> {
  const stripe = await requireStripe();
  const si = await stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: { surface: "nabuflow", userId },
  });
  if (!si.client_secret) {
    throw new NabuflowStripeError("Stripe did not return a client secret.");
  }
  return { clientSecret: si.client_secret, setupIntentId: si.id };
}

/**
 * Create the NabuFlow subscription on the account's existing Stripe Customer.
 * Requires a confirmed default payment method (hard card gate) and charges
 * immediately — `error_if_incomplete` turns a declined card into a calm,
 * structured error instead of a half-created subscription.
 */
export async function createNabuflowStripeSubscription(opts: {
  customerId: string;
  userId: string;
  plan: NabuflowPlanConfig;
}): Promise<Stripe.Subscription> {
  const stripe = await requireStripe();
  const priceId = await resolveNabuflowPriceId(stripe, opts.plan);

  const defaultPm = await getCustomerDefaultPaymentMethod(stripe, opts.customerId);
  if (!defaultPm) {
    throw new NabuflowStripeError(
      "Add a payment method before choosing a plan. NabuFlow plans require a card on file.",
      "no_payment_method",
    );
  }

  try {
    return await stripe.subscriptions.create({
      customer: opts.customerId,
      items: [{ price: priceId }],
      payment_behavior: "error_if_incomplete",
      collection_method: "charge_automatically",
      metadata: { surface: "nabuflow", plan: opts.plan.id, userId: opts.userId },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NabuflowStripeError(
      `Your card couldn't be charged for the ${opts.plan.name} plan: ${message}`,
      "payment_failed",
    );
  }
}

export interface NabuflowProrationPreview {
  currentPlanId: string;
  targetPlanId: NabuflowPlanId;
  /** Amount due immediately (or credited, negative) in cents. */
  amountDueCents: number;
  currency: string;
  periodEnd: string | null;
  lines: Array<{ description: string | null; amountCents: number }>;
}

/**
 * Proration preview for a mid-cycle plan switch — what Stripe would invoice
 * if the switch were confirmed right now. Read-only.
 */
export async function previewNabuflowPlanSwitch(
  sub: NabuflowSubscription,
  targetPlan: NabuflowPlanConfig,
): Promise<NabuflowProrationPreview> {
  const stripe = await requireStripe();
  if (!sub.stripeSubscriptionId || !sub.stripeCustomerId || !sub.stripeItemId) {
    throw new NabuflowStripeError("No active NabuFlow subscription to switch.", "no_subscription");
  }
  const priceId = await resolveNabuflowPriceId(stripe, targetPlan);

  const preview = await stripe.invoices.createPreview({
    customer: sub.stripeCustomerId,
    subscription: sub.stripeSubscriptionId,
    subscription_details: {
      items: [{ id: sub.stripeItemId, price: priceId }],
      proration_behavior: "create_prorations",
    },
  });

  return {
    currentPlanId: sub.planId,
    targetPlanId: targetPlan.id,
    amountDueCents: preview.amount_due ?? 0,
    currency: preview.currency ?? "usd",
    periodEnd: preview.period_end ? new Date(preview.period_end * 1000).toISOString() : null,
    lines: (preview.lines?.data ?? []).map((l) => ({
      description: l.description ?? null,
      amountCents: l.amount ?? 0,
    })),
  };
}

/**
 * Confirm a mid-cycle plan switch with prorations. Plan/cycle state updates
 * arrive via the customer.subscription.updated webhook (webhook-driven state).
 */
export async function switchNabuflowStripePlan(
  sub: NabuflowSubscription,
  targetPlan: NabuflowPlanConfig,
): Promise<Stripe.Subscription> {
  const stripe = await requireStripe();
  if (!sub.stripeSubscriptionId || !sub.stripeItemId) {
    throw new NabuflowStripeError("No active NabuFlow subscription to switch.", "no_subscription");
  }
  const priceId = await resolveNabuflowPriceId(stripe, targetPlan);
  try {
    return await stripe.subscriptions.update(sub.stripeSubscriptionId, {
      items: [{ id: sub.stripeItemId, price: priceId }],
      proration_behavior: "create_prorations",
      payment_behavior: "error_if_incomplete",
      metadata: { surface: "nabuflow", plan: targetPlan.id, userId: sub.userId },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new NabuflowStripeError(
      `Couldn't switch to ${targetPlan.name}: ${message}`,
      "payment_failed",
    );
  }
}

/** Cancel at period end (default) or immediately. */
export async function cancelNabuflowStripeSubscription(
  sub: NabuflowSubscription,
  opts: { immediately?: boolean } = {},
): Promise<void> {
  const stripe = await requireStripe();
  if (!sub.stripeSubscriptionId) {
    throw new NabuflowStripeError("No active NabuFlow subscription to cancel.", "no_subscription");
  }
  if (opts.immediately) {
    await stripe.subscriptions.cancel(sub.stripeSubscriptionId);
  } else {
    await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: true });
    await db
      .update(nabuflowSubscriptionsTable)
      .set({ cancelAtPeriodEnd: true, updatedAt: sql`now()` })
      .where(eq(nabuflowSubscriptionsTable.id, sub.id));
  }
}

/** Un-cancel (resume) a subscription that was set to cancel at period end. */
export async function resumeNabuflowStripeSubscription(sub: NabuflowSubscription): Promise<void> {
  const stripe = await requireStripe();
  if (!sub.stripeSubscriptionId) {
    throw new NabuflowStripeError("No NabuFlow subscription to resume.", "no_subscription");
  }
  await stripe.subscriptions.update(sub.stripeSubscriptionId, { cancel_at_period_end: false });
  await db
    .update(nabuflowSubscriptionsTable)
    .set({ cancelAtPeriodEnd: false, updatedAt: sql`now()` })
    .where(eq(nabuflowSubscriptionsTable.id, sub.id));
}

/**
 * Metered pay-as-you-go overage → pending invoice item on the customer.
 * Pending items are swept into the next subscription invoice at cycle close,
 * which is exactly the "reaches Stripe for cycle-close invoicing" contract.
 */
export async function createNabuflowOverageInvoiceItem(opts: {
  customerId: string;
  subscriptionId: string | null;
  amountCents: number;
  credits: number;
  planId: string;
  userId: string;
  eventId: number;
}): Promise<string | null> {
  if (opts.amountCents <= 0) return null;
  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    logger.warn(
      { userId: opts.userId, eventId: opts.eventId },
      "nabuflow: Stripe unavailable — overage kept in ledger only",
    );
    return null;
  }
  const item = await stripe.invoiceItems.create({
    customer: opts.customerId,
    ...(opts.subscriptionId ? { subscription: opts.subscriptionId } : {}),
    amount: opts.amountCents,
    currency: "usd",
    description: `NabuFlow pay-as-you-go: ${opts.credits} credits over included (${opts.planId})`,
    metadata: {
      surface: "nabuflow",
      plan: opts.planId,
      userId: opts.userId,
      usageEventId: String(opts.eventId),
      credits: String(opts.credits),
    },
  });
  return item.id;
}

/** Best-effort removal of a pending overage item (refund/reversal path). */
export async function deleteNabuflowInvoiceItem(invoiceItemId: string): Promise<void> {
  const stripe = await getUncachableStripeClient();
  if (!stripe) return;
  await stripe.invoiceItems.del(invoiceItemId);
}

/** Card snapshot from the customer's default PM, for subscribe-time seeding. */
export async function snapshotCustomerCard(customerId: string): Promise<{
  defaultPaymentMethodId: string;
  cardBrand: string | null;
  cardLast4: string | null;
  cardExpMonth: number | null;
  cardExpYear: number | null;
} | null> {
  const stripe = await requireStripe();
  const dpm = await getCustomerDefaultPaymentMethod(stripe, customerId);
  if (!dpm) return null;
  return {
    defaultPaymentMethodId: dpm.id,
    cardBrand: dpm.pm?.card?.brand ?? null,
    cardLast4: dpm.pm?.card?.last4 ?? null,
    cardExpMonth: dpm.pm?.card?.exp_month ?? null,
    cardExpYear: dpm.pm?.card?.exp_year ?? null,
  };
}
