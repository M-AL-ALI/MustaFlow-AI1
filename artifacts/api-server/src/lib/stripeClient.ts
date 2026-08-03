// Stripe client via the Replit Stripe connector.
// Credentials are fetched from the Replit connection API at runtime — never
// cached for long-term, since tokens can rotate. We do, however, keep a short
// in-memory cache of the secret key to avoid hitting the connection API on
// every checkout request.
//
// Falls back to STRIPE_SECRET_KEY env var when the connector is not available
// (e.g. local dev without Replit connectors hostname). This keeps the manual
// env-var path working alongside the connector.

import Stripe from "stripe";

interface StripeCredentials {
  publishableKey: string;
  secretKey: string;
}

let cached: { creds: StripeCredentials; expiresAt: number } | null = null;
const CACHE_TTL_MS = 60_000;

export function resolveEnvStripePublishableKey(env: Record<string, string | undefined>): string {
  for (const value of [
    env.STRIPE_PUBLISHABLE_KEY,
    env.STRIPE_TEST_PUBLISHABLE_KEY,
    env.VITE_STRIPE_PUBLISHABLE_KEY,
  ]) {
    if (value?.trim()) return value.trim();
  }
  return "";
}

async function fetchCredentialsFromConnector(): Promise<StripeCredentials | null> {
  const hostname = process.env.REPLIT_CONNECTORS_HOSTNAME;
  if (!hostname) return null;

  const xReplitToken = process.env.REPL_IDENTITY
    ? "repl " + process.env.REPL_IDENTITY
    : process.env.WEB_REPL_RENEWAL
      ? "depl " + process.env.WEB_REPL_RENEWAL
      : null;
  if (!xReplitToken) return null;

  const isProduction = process.env.REPLIT_DEPLOYMENT === "1";
  const targetEnvironment = isProduction ? "production" : "development";

  const url = new URL(`https://${hostname}/api/v2/connection`);
  url.searchParams.set("include_secrets", "true");
  url.searchParams.set("connector_names", "stripe");
  url.searchParams.set("environment", targetEnvironment);

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "X-Replit-Token": xReplitToken,
    },
  });

  if (!response.ok) return null;

  const data = (await response.json()) as {
    items?: Array<{ settings?: { publishable?: string; secret?: string } }>;
  };
  const item = data.items?.[0];
  if (!item?.settings?.publishable || !item.settings.secret) return null;

  return {
    publishableKey: item.settings.publishable,
    secretKey: item.settings.secret,
  };
}

async function getCredentials(): Promise<StripeCredentials | null> {
  if (cached && cached.expiresAt > Date.now()) return cached.creds;

  const fromConnector = await fetchCredentialsFromConnector().catch(() => null);
  if (fromConnector) {
    cached = { creds: fromConnector, expiresAt: Date.now() + CACHE_TTL_MS };
    return fromConnector;
  }

  const envSecret = process.env.STRIPE_SECRET_KEY;
  if (envSecret) {
    const creds: StripeCredentials = {
      publishableKey: resolveEnvStripePublishableKey(process.env),
      secretKey: envSecret,
    };
    cached = { creds, expiresAt: Date.now() + CACHE_TTL_MS };
    return creds;
  }

  return null;
}

export async function getStripeSecretKey(): Promise<string | null> {
  const creds = await getCredentials();
  return creds?.secretKey ?? null;
}

export async function getStripePublishableKey(): Promise<string | null> {
  const creds = await getCredentials();
  return creds?.publishableKey ?? null;
}

// WARNING: do not cache the returned client across calls. The underlying
// credentials can rotate. Always call this function before each Stripe API use.
export async function getUncachableStripeClient(): Promise<Stripe | null> {
  const secret = await getStripeSecretKey();
  if (!secret) return null;
  // apiVersion intentionally omitted — uses the account's default API version
  // as configured in the Stripe Dashboard. The installed stripe SDK pins its
  // own LATEST_API_VERSION type, which may lag the dashboard's "basil" pin.
  return new Stripe(secret);
}

export async function stripeAvailable(): Promise<boolean> {
  const secret = await getStripeSecretKey();
  return Boolean(secret);
}

// Drop the cached credentials. Call this when Stripe returns an auth error so
// the next request refetches a (possibly rotated) key from the connector.
export function invalidateStripeCredentialCache(): void {
  cached = null;
}
