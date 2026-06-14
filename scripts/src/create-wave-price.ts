// One-shot script: find or create the Deep Wave recurring monthly USD price at $65.
// Usage: pnpm --filter @workspace/scripts run create-wave-price
//
// Prints ONLY the price ID to stdout (last line) so the caller can parse it.
// Never prints secret values.

import { getUncachableStripeClient } from "./stripeClient";

const AMOUNT_CENTS = 6_500;
const CURRENCY = "usd";
const INTERVAL = "month";
const PRODUCT_NAME = "Deep Wave";

async function main(): Promise<void> {
  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    console.error("ERROR: Stripe client unavailable (connector not connected or STRIPE_SECRET_KEY missing).");
    process.exit(1);
  }

  // 1. Search for an existing active recurring $65/month USD price across all products
  //    whose name contains "wave" (case-insensitive).
  const prices = await stripe.prices.list({ active: true, currency: CURRENCY, type: "recurring", limit: 100 });

  for (const p of prices.data) {
    if (
      p.unit_amount === AMOUNT_CENTS &&
      p.recurring?.interval === INTERVAL
    ) {
      // Check product name contains "wave"
      const productId = typeof p.product === "string" ? p.product : p.product?.id ?? "";
      if (productId) {
        const product = await stripe.products.retrieve(productId);
        if (product.name.toLowerCase().includes("wave")) {
          console.log(`Found existing Deep Wave price at $65/month: ${p.id}`);
          console.log(`PRICE_ID:${p.id}`);
          return;
        }
      }
    }
  }

  // 2. No match found — create a new product + price.
  console.log("No existing $65/month Deep Wave price found. Creating one…");

  // Find or create the Deep Wave product
  const products = await stripe.products.list({ active: true, limit: 100 });
  const existingProduct = products.data.find(p => p.name.toLowerCase().includes("wave"));
  let productId: string;
  if (existingProduct) {
    productId = existingProduct.id;
    console.log(`Using existing product: ${existingProduct.name} (${existingProduct.id})`);
  } else {
    const newProduct = await stripe.products.create({
      name: PRODUCT_NAME,
      description: "MustaFlow Deep Wave subscription",
    });
    productId = newProduct.id;
    console.log(`Created new product: ${newProduct.name} (${newProduct.id})`);
  }

  const newPrice = await stripe.prices.create({
    product: productId,
    unit_amount: AMOUNT_CENTS,
    currency: CURRENCY,
    recurring: { interval: INTERVAL },
    nickname: "Deep Wave $65/month",
  });

  console.log(`Created new price: ${newPrice.id} ($${AMOUNT_CENTS / 100}/month)`);
  console.log(`PRICE_ID:${newPrice.id}`);
}

main().catch((err) => {
  console.error("ERROR:", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
