import type Stripe from "stripe";
import { eq, sql } from "drizzle-orm";
import { accountAssetQuotaTable, db, storageAddonSubscriptionsTable } from "@workspace/db";

export const ASSET_STORAGE_PLANS = {
  storage_5gb: {
    sku: "storage_5gb",
    label: "5 GB",
    allowanceBytes: 5 * 1024 * 1024 * 1024,
    monthlyCents: 199,
    lookupKey: "nabuflow_asset_storage_5gb_monthly",
  },
  storage_25gb: {
    sku: "storage_25gb",
    label: "25 GB",
    allowanceBytes: 25 * 1024 * 1024 * 1024,
    monthlyCents: 499,
    lookupKey: "nabuflow_asset_storage_25gb_monthly",
  },
  storage_100gb: {
    sku: "storage_100gb",
    label: "100 GB",
    allowanceBytes: 100 * 1024 * 1024 * 1024,
    monthlyCents: 1299,
    lookupKey: "nabuflow_asset_storage_100gb_monthly",
  },
} as const;

export type AssetStorageSku = keyof typeof ASSET_STORAGE_PLANS;

const priceCache = new Map<AssetStorageSku, string>();

export function isAssetStorageSku(value: unknown): value is AssetStorageSku {
  return typeof value === "string" && value in ASSET_STORAGE_PLANS;
}

export async function resolveAssetStoragePrice(
  stripe: Stripe,
  sku: AssetStorageSku,
): Promise<string> {
  const cached = priceCache.get(sku);
  if (cached) return cached;
  const plan = ASSET_STORAGE_PLANS[sku];
  const existing = await stripe.prices.list({ lookup_keys: [plan.lookupKey], limit: 1 });
  if (existing.data[0]?.id) {
    priceCache.set(sku, existing.data[0].id);
    return existing.data[0].id;
  }
  const product = await stripe.products.create({
    name: `NabuFlow asset storage — ${plan.label}`,
    description: `${plan.label} of additional private storage for NabuFlow uploads and generated assets.`,
    metadata: { surface: "asset_storage", sku },
  });
  const price = await stripe.prices.create({
    product: product.id,
    currency: "usd",
    unit_amount: plan.monthlyCents,
    recurring: { interval: "month" },
    lookup_key: plan.lookupKey,
    metadata: { surface: "asset_storage", sku },
  });
  priceCache.set(sku, price.id);
  return price.id;
}

export async function createAssetStorageCheckout(input: {
  stripe: Stripe;
  customerId: string;
  userId: string;
  sku: AssetStorageSku;
  returnBase: string;
}): Promise<{ id: string; url: string | null }> {
  const plan = ASSET_STORAGE_PLANS[input.sku];
  const price = await resolveAssetStoragePrice(input.stripe, input.sku);
  const metadata = {
    surface: "asset_storage",
    userId: input.userId,
    sku: input.sku,
    allowanceBytes: String(plan.allowanceBytes),
  };
  const session = await input.stripe.checkout.sessions.create({
    mode: "subscription",
    customer: input.customerId,
    line_items: [{ price, quantity: 1 }],
    metadata,
    subscription_data: { metadata },
    success_url: `${input.returnBase}/image-studio?storage=active`,
    cancel_url: `${input.returnBase}/image-studio?storage=cancelled`,
    payment_method_collection: "always",
    saved_payment_method_options: { payment_method_save: "enabled" },
    automatic_tax: { enabled: process.env.STRIPE_TAX_ENABLED === "true" },
  });
  return { id: session.id, url: session.url };
}

function subscriptionPeriodEnd(subscription: Stripe.Subscription): Date | null {
  const first = subscription.items.data[0] as Stripe.SubscriptionItem & {
    current_period_end?: number;
  };
  const legacy = subscription as Stripe.Subscription & { current_period_end?: number };
  const seconds = first?.current_period_end ?? legacy.current_period_end;
  return typeof seconds === "number" ? new Date(seconds * 1000) : null;
}

async function refreshPurchasedAllowance(userId: string): Promise<void> {
  await db
    .insert(accountAssetQuotaTable)
    .values({ userId })
    .onConflictDoNothing({ target: accountAssetQuotaTable.userId });
  const [{ total }] = await db
    .select({
      total: sql<number>`COALESCE(SUM(${storageAddonSubscriptionsTable.allowanceBytes}), 0)::bigint`,
    })
    .from(storageAddonSubscriptionsTable)
    .where(
      sql`${storageAddonSubscriptionsTable.userId} = ${userId}
          AND ${storageAddonSubscriptionsTable.status} IN ('active','trialing')`,
    );
  await db
    .update(accountAssetQuotaTable)
    .set({ purchasedAllowanceBytes: Number(total ?? 0), updatedAt: sql`NOW()` })
    .where(eq(accountAssetQuotaTable.userId, userId));
}

export async function syncAssetStorageSubscription(
  subscription: Stripe.Subscription,
): Promise<boolean> {
  const metadata = subscription.metadata ?? {};
  if (metadata.surface !== "asset_storage" || !isAssetStorageSku(metadata.sku)) return false;
  const userId = metadata.userId;
  if (!userId) throw new Error("asset_storage_user_missing");
  const plan = ASSET_STORAGE_PLANS[metadata.sku];
  const item = subscription.items.data[0];
  if (!item?.id) throw new Error("asset_storage_item_missing");
  await db
    .insert(storageAddonSubscriptionsTable)
    .values({
      userId,
      sku: metadata.sku,
      allowanceBytes: plan.allowanceBytes,
      stripeSubscriptionId: subscription.id,
      stripeItemId: item.id,
      status: subscription.status,
      currentPeriodEnd: subscriptionPeriodEnd(subscription),
    })
    .onConflictDoUpdate({
      target: storageAddonSubscriptionsTable.stripeSubscriptionId,
      set: {
        stripeItemId: item.id,
        status: subscription.status,
        currentPeriodEnd: subscriptionPeriodEnd(subscription),
        allowanceBytes: plan.allowanceBytes,
        updatedAt: sql`NOW()`,
      },
    });
  await refreshPurchasedAllowance(userId);
  return true;
}

export async function handleAssetStorageCheckout(
  stripe: Stripe,
  session: Stripe.Checkout.Session,
): Promise<boolean> {
  if (session.metadata?.surface !== "asset_storage") return false;
  const subscriptionId =
    typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  if (!subscriptionId) throw new Error("asset_storage_subscription_missing");
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  return syncAssetStorageSubscription(subscription);
}

export async function removeAssetStorageSubscription(subscriptionId: string): Promise<boolean> {
  const [existing] = await db
    .select({ userId: storageAddonSubscriptionsTable.userId })
    .from(storageAddonSubscriptionsTable)
    .where(eq(storageAddonSubscriptionsTable.stripeSubscriptionId, subscriptionId));
  if (!existing) return false;
  await db
    .update(storageAddonSubscriptionsTable)
    .set({ status: "canceled", updatedAt: sql`NOW()` })
    .where(eq(storageAddonSubscriptionsTable.stripeSubscriptionId, subscriptionId));
  await refreshPurchasedAllowance(existing.userId);
  return true;
}

export async function listAssetStorageSubscriptions(userId: string) {
  return db
    .select()
    .from(storageAddonSubscriptionsTable)
    .where(eq(storageAddonSubscriptionsTable.userId, userId));
}
