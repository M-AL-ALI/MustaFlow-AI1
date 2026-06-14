// Verify MustaFlow Ora subscription billing wiring against Stripe.
//
// Default mode is read-only:
//   pnpm --filter @workspace/scripts run verify:stripe-billing
//
// Optional smoke mode creates Checkout Sessions, but does not complete payment:
//   pnpm --filter @workspace/scripts run verify:stripe-billing -- --create-sessions
//
// This script never prints secret values.

import Stripe from "stripe";
import { getUncachableStripeClient } from "./stripeClient";

type PlanId = "core" | "wave";

interface PlanExpectation {
  id: PlanId;
  label: string;
  envVar: "STRIPE_CORE_PRICE_ID" | "STRIPE_WAVE_PRICE_ID";
  amountCents: number;
}

const PLANS: PlanExpectation[] = [
  {
    id: "core",
    label: "Core Pack",
    envVar: "STRIPE_CORE_PRICE_ID",
    amountCents: 2_000,
  },
  {
    id: "wave",
    label: "Deep Wave",
    envVar: "STRIPE_WAVE_PRICE_ID",
    amountCents: 6_500,
  },
];

function hasFlag(flag: string): boolean {
  return process.argv.slice(2).includes(flag);
}

function fail(message: string): never {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function maskedPresence(name: string): string {
  return process.env[name]?.trim() ? "present" : "missing";
}

async function retrievePrice(stripe: Stripe, plan: PlanExpectation): Promise<Stripe.Price> {
  const priceId = process.env[plan.envVar]?.trim();
  if (!priceId) {
    fail(`${plan.envVar} is missing. Set it to the Stripe recurring Price ID for ${plan.label}.`);
  }

  const price = await stripe.prices.retrieve(priceId);
  const recurring = price.recurring;
  if (!price.active) fail(`${plan.label} price is inactive (${price.id}).`);
  if (price.currency !== "usd")
    fail(`${plan.label} price currency is ${price.currency}, expected usd.`);
  if (price.type !== "recurring")
    fail(`${plan.label} price type is ${price.type}, expected recurring.`);
  if (recurring?.interval !== "month") {
    fail(`${plan.label} price interval is ${recurring?.interval ?? "missing"}, expected month.`);
  }
  if (price.unit_amount !== plan.amountCents) {
    fail(
      `${plan.label} price amount is ${price.unit_amount ?? "missing"} cents, expected ${plan.amountCents}.`,
    );
  }

  console.log(
    `OK: ${plan.label} price ${price.id} is active, recurring monthly, USD ${(
      plan.amountCents / 100
    ).toFixed(2)}.`,
  );
  return price;
}

async function createCheckoutSession(
  stripe: Stripe,
  plan: PlanExpectation,
  price: Stripe.Price,
): Promise<void> {
  const customer = await stripe.customers.create({
    metadata: {
      mustaflow_smoke: "stripe-billing",
      plan: plan.id,
    },
  });

  const session = await stripe.checkout.sessions.create({
    mode: "subscription",
    customer: customer.id,
    line_items: [{ price: price.id, quantity: 1 }],
    success_url: "https://example.com/mustaflow/billing-smoke/success",
    cancel_url: "https://example.com/mustaflow/billing-smoke/cancel",
    metadata: { userId: "stripe-billing-smoke", tier: plan.id },
    payment_method_collection: "always",
    saved_payment_method_options: { payment_method_save: "enabled" },
    subscription_data: {
      metadata: { userId: "stripe-billing-smoke", tier: plan.id },
    },
    allow_promotion_codes: true,
  });

  console.log(
    `OK: created ${plan.label} Checkout Session ${session.id} with saved payment method settings.`,
  );
  console.log(`    Complete manually with Stripe test card 4242 4242 4242 4242: ${session.url}`);
}

async function main(): Promise<void> {
  const createSessions = hasFlag("--create-sessions");

  console.log("Stripe env presence:");
  for (const name of [
    "STRIPE_SECRET_KEY",
    "STRIPE_PUBLISHABLE_KEY",
    "STRIPE_WEBHOOK_SECRET",
    "STRIPE_CORE_PRICE_ID",
    "STRIPE_WAVE_PRICE_ID",
  ]) {
    console.log(`  ${name}: ${maskedPresence(name)}`);
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    fail(
      "Stripe client unavailable. Connect the Replit Stripe integration or set STRIPE_SECRET_KEY.",
    );
  }

  const prices: Array<[PlanExpectation, Stripe.Price]> = [];
  for (const plan of PLANS) {
    prices.push([plan, await retrievePrice(stripe, plan)]);
  }

  if (!process.env.STRIPE_WEBHOOK_SECRET?.trim()) {
    console.warn(
      "WARN: STRIPE_WEBHOOK_SECRET is missing. Webhooks are not production-safe without it.",
    );
  }

  if (!createSessions) {
    console.log(
      "Read-only verification complete. Pass --create-sessions to create manual test Checkout links.",
    );
    return;
  }

  for (const [plan, price] of prices) {
    await createCheckoutSession(stripe, plan, price);
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  fail(`verify-stripe-billing failed: ${message}`);
});
