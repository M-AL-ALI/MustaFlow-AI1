// Stripe client for one-off scripts (seed, ops).
//
// Resolves credentials in this order:
//   1. Replit Stripe connector (REPLIT_CONNECTORS_HOSTNAME + REPL_IDENTITY / WEB_REPL_RENEWAL)
//   2. STRIPE_SECRET_KEY env var
//
// Mirrors artifacts/api-server/src/lib/stripeClient.ts so the seed script works
// in the same environments as the API server.

import Stripe from "stripe";

interface StripeCredentials {
  publishableKey: string;
  secretKey: string;
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
  const fromConnector = await fetchCredentialsFromConnector().catch(() => null);
  if (fromConnector) return fromConnector;

  const envSecret = process.env.STRIPE_SECRET_KEY;
  if (envSecret) {
    return {
      publishableKey: process.env.STRIPE_PUBLISHABLE_KEY ?? "",
      secretKey: envSecret,
    };
  }
  return null;
}

export async function getUncachableStripeClient(): Promise<Stripe | null> {
  const creds = await getCredentials();
  if (!creds) return null;
  return new Stripe(creds.secretKey);
}
