// Seed Stripe Products + Prices for the MustaFlow credit packs.
//
// Usage:
//   pnpm --filter @workspace/scripts run seed:stripe
//
// Requires either the Replit Stripe connector to be connected, or
// STRIPE_SECRET_KEY to be set in the environment.
//
// Behavior:
//   - For each pack (Starter / Builder / Power), finds or creates a Product
//     keyed by metadata.mustaflow_pack_id, then ensures an active Price exists
//     at the configured USD amount (creates a new one if missing).
//   - Prints the Price IDs and a copy-pasteable block of env-var assignments
//     to set as Replit secrets:
//       STRIPE_PRICE_STARTER, STRIPE_PRICE_BUILDER, STRIPE_PRICE_POWER
//   - Safe to re-run: existing products/prices are reused.

import { getUncachableStripeClient } from "./stripeClient";

interface PackSeed {
  envVar: "STRIPE_PRICE_STARTER" | "STRIPE_PRICE_BUILDER" | "STRIPE_PRICE_POWER";
  packId: "starter" | "builder" | "power";
  name: string;
  description: string;
  credits: number;
  unitAmount: number; // cents
}

const PACKS: PackSeed[] = [
  {
    envVar: "STRIPE_PRICE_STARTER",
    packId: "starter",
    name: "MustaFlow Starter Pack",
    description: "500 build credits — good for everyday building",
    credits: 500,
    unitAmount: 500,
  },
  {
    envVar: "STRIPE_PRICE_BUILDER",
    packId: "builder",
    name: "MustaFlow Builder Pack",
    description: "2,500 build credits — best value for active builders",
    credits: 2500,
    unitAmount: 2000,
  },
  {
    envVar: "STRIPE_PRICE_POWER",
    packId: "power",
    name: "MustaFlow Power Pack",
    description: "10,000 build credits — for power users and teams",
    credits: 10000,
    unitAmount: 6500,
  },
];

async function main(): Promise<void> {
  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    console.error(
      "ERROR: Stripe client unavailable. Connect the Replit Stripe integration " +
        "or set STRIPE_SECRET_KEY in the environment, then re-run.",
    );
    process.exit(1);
  }

  const results: Array<{ envVar: string; priceId: string; productId: string }> = [];

  for (const pack of PACKS) {
    console.log(`\n→ ${pack.name}`);

    // 1. Find existing product by metadata.mustaflow_pack_id
    const search = await stripe.products.search({
      query: `metadata['mustaflow_pack_id']:'${pack.packId}' AND active:'true'`,
      limit: 1,
    });

    let product = search.data[0];
    if (product) {
      console.log(`  found existing product ${product.id}`);
    } else {
      product = await stripe.products.create({
        name: pack.name,
        description: pack.description,
        metadata: {
          mustaflow_pack_id: pack.packId,
          credits: String(pack.credits),
        },
      });
      console.log(`  created product ${product.id}`);
    }

    // 2. Find an active price matching amount + currency, else create one
    const prices = await stripe.prices.list({
      product: product.id,
      active: true,
      limit: 100,
    });
    let price = prices.data.find(
      (p) => p.unit_amount === pack.unitAmount && p.currency === "usd" && p.type === "one_time",
    );

    if (price) {
      console.log(`  found existing price  ${price.id} ($${pack.unitAmount / 100})`);
    } else {
      price = await stripe.prices.create({
        product: product.id,
        currency: "usd",
        unit_amount: pack.unitAmount,
        metadata: {
          mustaflow_pack_id: pack.packId,
          credits: String(pack.credits),
        },
      });
      console.log(`  created price        ${price.id} ($${pack.unitAmount / 100})`);
    }

    results.push({ envVar: pack.envVar, priceId: price.id, productId: product.id });
  }

  console.log("\n────────────────────────────────────────────────────────────");
  console.log("Set these as Replit secrets (Tools → Secrets):\n");
  for (const r of results) {
    console.log(`  ${r.envVar}=${r.priceId}`);
  }
  console.log("\nAlso ensure these secrets are set:");
  console.log("  STRIPE_SECRET_KEY        (from Stripe Dashboard → Developers → API keys)");
  console.log("  STRIPE_PUBLISHABLE_KEY   (from Stripe Dashboard → Developers → API keys)");
  console.log("  STRIPE_WEBHOOK_SECRET    (from Stripe Dashboard → Developers → Webhooks)");
  console.log("\nRegister the webhook endpoint in Stripe Dashboard:");
  console.log("  URL:    https://<your-domain>/api/billing/webhook");
  console.log("  Event:  checkout.session.completed");
  console.log("────────────────────────────────────────────────────────────\n");
}

main().catch((err) => {
  console.error("seed-stripe-products failed:", err);
  process.exit(1);
});
