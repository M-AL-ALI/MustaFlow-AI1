// ─────────────────────────────────────────────────────────────────────────────
// Purchased domain routes — Task #559 (Namecheap reseller integration)
//
//   GET    /api/domains/search?q=<name>          — availability + price for top TLDs
//   GET    /api/domains/purchased                — list user's purchased domains
//   POST   /api/domains/purchase                 — buy a domain via Namecheap + Stripe
//   POST   /api/domains/transfer-in              — initiate inbound domain transfer
//   GET    /api/domains/purchased/:id            — single purchased domain detail
//   PATCH  /api/domains/purchased/:id/auto-renew — toggle auto-renew
//   PATCH  /api/domains/purchased/:id/whois      — update WHOIS contacts
//   POST   /api/domains/purchased/:id/renew      — manual renewal (charge + Namecheap)
//   GET    /api/domains/purchased/:id/auth-code  — get EPP code for transfer-out
//   POST   /api/domains/purchased/:id/release    — release domain (unlock + log)
//   PATCH  /api/domains/purchased/:id/project    — attach/detach to a project
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { eq, desc, and, sql } from "drizzle-orm";
import { db, purchasedDomainsTable, projectDomainsTable, projectsTable } from "@workspace/db";
import { isNull } from "drizzle-orm";
import {
  namecheapEnabled,
  checkAvailability,
  getPricing,
  register,
  renew as namecheapRenew,
  getInfo,
  setAutoRenew,
  setWhoisContacts,
  getAuthCode,
  setRegistrarLock,
  transferIn,
  type WhoisContact,
} from "../lib/namecheap";
import {
  getUncachableStripeClient,
  stripeAvailable,
  invalidateStripeCredentialCache,
} from "../lib/stripeClient";
import { activateSslForDomain } from "./ssl";
import { SUPPORT_EMAIL_ADDRESS } from "../lib/support-contact";
import { publishDomainEvent } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { checkProjectAccess } from "../lib/auth";

const router: IRouter = Router();

// ── Transfer-pending auth-code store ─────────────────────────────────────────
// Keeps EPP auth codes server-side (keyed by `${userId}:${hostname}`) while the
// Stripe Checkout session is in flight.  Entries expire after 2 h — long enough
// for the user to complete payment but short enough to limit exposure.
// In a multi-process deployment, replace with Redis or a DB-backed table.
const TRANSFER_PENDING_TTL_MS = 2 * 60 * 60 * 1_000; // 2 h
const transferPendingMap = new Map<string, { authCode: string; expiresAt: number }>();
function setTransferPending(userId: string, hostname: string, authCode: string): void {
  transferPendingMap.set(`${userId}:${hostname}`, {
    authCode,
    expiresAt: Date.now() + TRANSFER_PENDING_TTL_MS,
  });
}
function getTransferPending(userId: string, hostname: string): string | null {
  const entry = transferPendingMap.get(`${userId}:${hostname}`);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    transferPendingMap.delete(`${userId}:${hostname}`);
    return null;
  }
  return entry.authCode;
}
function clearTransferPending(userId: string, hostname: string): void {
  transferPendingMap.delete(`${userId}:${hostname}`);
}

// ── TLD catalogue — the top TLDs we check availability for ───────────────────
const TOP_TLDS = [
  ".com",
  ".net",
  ".org",
  ".io",
  ".co",
  ".app",
  ".dev",
  ".ai",
  ".tech",
  ".online",
  ".site",
  ".info",
  ".biz",
  ".store",
  ".shop",
  ".us",
  ".me",
  ".tv",
  ".xyz",
  ".live",
  ".club",
  ".pro",
  ".solutions",
  ".systems",
  ".digital",
  ".cloud",
  ".studio",
  ".design",
  ".agency",
  ".world",
];

// ── Availability search cache (60 s TTL) ─────────────────────────────────────
const availabilityCache = new Map<string, { data: unknown[]; expiresAt: number }>();

// ── Helper: ensure the requesting user owns a purchased domain ────────────────
async function getPurchasedDomainForUser(id: number, userId: string) {
  const [row] = await db
    .select()
    .from(purchasedDomainsTable)
    .where(and(eq(purchasedDomainsTable.id, id), eq(purchasedDomainsTable.userId, userId)));
  return row ?? null;
}

// ── Helper: build a verification token ───────────────────────────────────────
function randomHex(bytes = 16): string {
  const arr = new Uint8Array(bytes);
  crypto.getRandomValues(arr);
  return Array.from(arr)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/domains/search?q=<name>
// Returns availability + price for the query name across all top TLDs.
// Results cached 60 s.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/domains/search", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const q = String(req.query.q ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "");
  if (!q || q.length < 2) {
    res.status(400).json({ error: "q must be at least 2 characters" });
    return;
  }

  const cacheKey = q;
  const cached = availabilityCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    res.json({ results: cached.data, namecheapEnabled: namecheapEnabled() });
    return;
  }

  const pricing = await getPricing(TOP_TLDS);
  const pricingMap = new Map(pricing.map((p) => [p.tld, p]));

  if (!namecheapEnabled()) {
    // Return static price placeholders so the UI works even without Namecheap creds
    const results = TOP_TLDS.map((tld) => ({
      domain: `${q}${tld}`,
      tld,
      available: null,
      price: pricingMap.get(tld)?.registerPrice ?? null,
      renewalPrice: pricingMap.get(tld)?.renewalPrice ?? null,
      isPremium: false,
    }));
    res.json({ results, namecheapEnabled: false });
    return;
  }

  const domainList = TOP_TLDS.map((tld) => `${q}${tld}`);
  const availability = await checkAvailability(domainList);
  const availMap = new Map(availability.map((a) => [a.domain, a]));

  const results = TOP_TLDS.map((tld) => {
    const domain = `${q}${tld}`;
    const avail = availMap.get(domain);
    const price = pricingMap.get(tld);
    return {
      domain,
      tld,
      available: avail?.available ?? null,
      isPremium: avail?.isPremium ?? false,
      price: avail?.isPremium
        ? (avail.premiumRegistrationPrice ?? price?.registerPrice ?? null)
        : (price?.registerPrice ?? null),
      renewalPrice: price?.renewalPrice ?? null,
    };
  });

  availabilityCache.set(cacheKey, { data: results, expiresAt: Date.now() + 60_000 });
  res.json({ results, namecheapEnabled: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/domains/purchased
// List all purchased domains for the authenticated user.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/domains/purchased", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const domains = await db
    .select()
    .from(purchasedDomainsTable)
    .where(eq(purchasedDomainsTable.userId, userId))
    .orderBy(desc(purchasedDomainsTable.createdAt));

  res.json({ domains });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/domains/purchased/:id
// Single purchased domain detail.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/domains/purchased/:id", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  res.json({ domain });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/domains/purchase
// Buy a domain via Stripe + Namecheap.
//
// Body:
//   hostname      — fully qualified domain name (e.g. "myapp.com")
//   projectId     — optional project to auto-attach after purchase
//   years         — registration years (default 1)
//   contact       — WHOIS contact fields
// ─────────────────────────────────────────────────────────────────────────────
router.post("/domains/purchase", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const {
    hostname: rawHostname,
    projectId,
    years = 1,
    contact: _contact,
    successUrl,
    cancelUrl,
  } = req.body as {
    hostname?: string;
    projectId?: number;
    years?: number;
    contact?: WhoisContact;
    successUrl?: string;
    cancelUrl?: string;
  };

  if (!rawHostname) {
    res.status(400).json({ error: "hostname is required" });
    return;
  }

  if (
    projectId !== undefined &&
    (await checkProjectAccess(userId, projectId, "member")) !== "granted"
  ) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const hostname = rawHostname.trim().toLowerCase();
  if (!/^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(hostname)) {
    res.status(400).json({ error: "Invalid hostname" });
    return;
  }

  // Check for duplicate purchase
  const [existing] = await db
    .select({ id: purchasedDomainsTable.id })
    .from(purchasedDomainsTable)
    .where(eq(purchasedDomainsTable.hostname, hostname));
  if (existing) {
    res.status(409).json({ error: "This domain is already registered in your account" });
    return;
  }

  // Verify availability if Namecheap is configured
  if (namecheapEnabled()) {
    const [avail] = await checkAvailability([hostname]);
    if (avail && !avail.available) {
      res.status(409).json({ error: "This domain is not available for registration" });
      return;
    }
  }

  // Look up price
  const tld = "." + hostname.split(".").slice(1).join(".");
  const pricing = await getPricing([tld]);
  const priceUsd = pricing[0]?.registerPrice ?? 12.99;
  const amountCents = Math.round(priceUsd * 100);

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    if (!(await stripeAvailable())) {
      res.json({
        setupRequired: true,
        message:
          "Stripe is not configured. Connect the Stripe integration to enable domain purchases.",
        priceUsd,
      });
      return;
    }
    res.status(503).json({ error: "Payment system unavailable" });
    return;
  }

  try {
    // Create a Stripe Checkout Session for the domain purchase
    if (successUrl && cancelUrl) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_creation: "always",
        payment_intent_data: {
          // save the payment method so auto-renewal can charge off-session later
          setup_future_usage: "off_session",
        },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: amountCents,
              product_data: {
                name: `Domain: ${hostname}`,
                description: `${years}-year registration for ${hostname} (auto-renewed annually)`,
              },
            },
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        metadata: {
          type: "domain_purchase",
          hostname,
          userId,
          projectId: projectId ? String(projectId) : "",
          years: String(years),
          priceUsd: String(priceUsd),
        },
      });

      res.json({
        sessionId: session.id,
        checkoutUrl: session.url,
        hostname,
        priceUsd,
        years,
      });
      return;
    }

    // Direct PaymentIntent path (for clients that handle their own UI)
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      metadata: {
        type: "domain_purchase",
        hostname,
        userId,
        projectId: projectId ? String(projectId) : "",
        years: String(years),
      },
      description: `Domain registration: ${hostname}`,
    });

    res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      hostname,
      priceUsd,
      years,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication|invalid_api_key/i.test(msg)) {
      invalidateStripeCredentialCache();
    }
    res.status(502).json({ error: `Payment error: ${msg}` });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/domains/purchase/confirm
// Called after Stripe payment succeeds to actually register the domain with
// Namecheap and create the purchased_domains row + project attachment.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/domains/purchase/confirm", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const {
    hostname,
    paymentIntentId,
    sessionId: checkoutSessionId,
    projectId,
    years = 1,
    contact,
  } = req.body as {
    hostname?: string;
    paymentIntentId?: string;
    sessionId?: string;
    projectId?: number;
    years?: number;
    contact?: WhoisContact;
  };

  if (!hostname || (!paymentIntentId && !checkoutSessionId)) {
    res
      .status(400)
      .json({ error: "hostname and either paymentIntentId or sessionId are required" });
    return;
  }

  // projectId can come from the request body OR be recovered from Stripe session metadata
  // (the UI redirects back with only sessionId; projectId isn't re-sent on every confirm)
  let resolvedProjectId: number | undefined = projectId;

  if (
    resolvedProjectId !== undefined &&
    (await checkProjectAccess(userId, resolvedProjectId, "member")) !== "granted"
  ) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Verify Stripe payment
  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.status(503).json({ error: "Payment system unavailable" });
    return;
  }

  let pricePaidUsd = "12.99";
  let resolvedStripeCustomerId: string | null = null;

  try {
    if (checkoutSessionId) {
      // Checkout Session flow: retrieve session to get PI + metadata + customer
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      if (session.payment_status !== "paid") {
        res
          .status(402)
          .json({ error: `Checkout session not paid (status: ${session.payment_status})` });
        return;
      }
      const meta = session.metadata ?? {};
      if (meta.type !== "domain_purchase") {
        res.status(400).json({ error: "Checkout session is not for a domain purchase" });
        return;
      }
      if (meta.userId && meta.userId !== userId) {
        res.status(403).json({ error: "Checkout session belongs to a different user" });
        return;
      }
      if (meta.hostname && meta.hostname !== hostname) {
        res.status(400).json({ error: "Checkout session was created for a different domain" });
        return;
      }
      if (session.amount_total) pricePaidUsd = String(session.amount_total / 100);
      // Save customer ID for future off-session renewals
      if (session.customer && typeof session.customer === "string") {
        resolvedStripeCustomerId = session.customer;
      }
      // Recover projectId from trusted Stripe session metadata when not in request body
      if (!resolvedProjectId && meta.projectId) {
        const parsed = parseInt(meta.projectId, 10);
        if (!isNaN(parsed) && parsed > 0) resolvedProjectId = parsed;
      }
    } else if (paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status !== "succeeded") {
        res.status(402).json({ error: `Payment not yet succeeded (status: ${pi.status})` });
        return;
      }
      // Verify PI metadata matches the requesting user and domain (prevents reuse of unrelated PIs)
      const meta = pi.metadata ?? {};
      if (meta.type !== "domain_purchase") {
        res.status(400).json({ error: "Payment intent is not for a domain purchase" });
        return;
      }
      if (meta.userId && meta.userId !== userId) {
        res.status(403).json({ error: "Payment intent belongs to a different user" });
        return;
      }
      if (meta.hostname && meta.hostname !== hostname) {
        res.status(400).json({ error: "Payment intent was created for a different domain" });
        return;
      }
      pricePaidUsd = String(pi.amount / 100);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown";
    res.status(502).json({ error: `Stripe error: ${msg}` });
    return;
  }

  if (
    resolvedProjectId !== undefined &&
    (await checkProjectAccess(userId, resolvedProjectId, "member")) !== "granted"
  ) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Check for duplicate (idempotent confirm)
  const [existing] = await db
    .select()
    .from(purchasedDomainsTable)
    .where(
      and(eq(purchasedDomainsTable.hostname, hostname), eq(purchasedDomainsTable.userId, userId)),
    );
  if (existing) {
    res.json({ domain: existing, alreadyRegistered: true });
    return;
  }

  // Register with Namecheap
  const defaultContact: WhoisContact = contact ?? {
    firstName: "MustaFlow",
    lastName: "User",
    email: SUPPORT_EMAIL_ADDRESS,
    phone: "+1.5005550001",
    address: "1 Main St",
    city: "San Francisco",
    stateProvince: "CA",
    postalCode: "94105",
    country: "US",
  };

  let namecheapOrderId: string | undefined;
  let registeredAt: Date | undefined;
  let expiresAt: Date | undefined;

  if (namecheapEnabled()) {
    const result = await register(hostname, defaultContact, years);
    if (!result?.success) {
      logger.error(
        { hostname, error: result?.error },
        "Namecheap registration failed after payment",
      );
      res.status(502).json({
        error: `Domain registration failed: ${result?.error ?? "Unknown Namecheap error"}`,
        paymentSucceeded: true,
        note: "Your payment was captured. Report this issue at /help?mode=report to complete the registration.",
      });
      return;
    }
    namecheapOrderId = result.orderId;
    registeredAt = new Date();
    expiresAt = new Date(Date.now() + years * 365 * 86_400_000);
  } else {
    // Sandbox / dev mode — record without actually registering
    registeredAt = new Date();
    expiresAt = new Date(Date.now() + years * 365 * 86_400_000);
    logger.warn({ hostname }, "Namecheap not configured — recording purchase without registration");
  }

  // Insert purchased_domains row
  const tld = "." + hostname.split(".").slice(1).join(".");
  const pricing = await getPricing([tld]);
  const renewalPriceUsd = String(pricing[0]?.renewalPrice ?? pricePaidUsd);

  const [newDomain] = await db
    .insert(purchasedDomainsTable)
    .values({
      userId,
      hostname,
      registrar: "namecheap",
      registeredAt,
      expiresAt,
      autoRenew: true,
      whoisPrivacy: true,
      status: "active",
      namecheapOrderId: namecheapOrderId ?? null,
      stripePaymentIntentId: paymentIntentId ?? null,
      stripeCustomerId: resolvedStripeCustomerId,
      projectId: resolvedProjectId ?? null,
      pricePaidUsd,
      renewalPriceUsd,
      whoisFirstName: defaultContact.firstName,
      whoisLastName: defaultContact.lastName,
      whoisEmail: defaultContact.email,
      whoisPhone: defaultContact.phone,
      whoisAddress: defaultContact.address,
      whoisCity: defaultContact.city,
      whoisStateProvince: defaultContact.stateProvince,
      whoisPostalCode: defaultContact.postalCode,
      whoisCountry: defaultContact.country,
    })
    .returning();

  if (!newDomain) {
    res.status(500).json({ error: "Failed to save domain record" });
    return;
  }

  // Auto-attach to project if provided (either from request body or recovered from session metadata)
  if (resolvedProjectId) {
    try {
      // Reconfirm that the project still exists before attaching the domain.
      const [project] = await db
        .select({ id: projectsTable.id })
        .from(projectsTable)
        .where(and(eq(projectsTable.id, resolvedProjectId), isNull(projectsTable.deletedAt)));

      if (project) {
        const token = `mustaflow-verify=${randomHex()}`;
        const labels = hostname.split(".");
        const recordType: "a" | "cname" = labels.length === 2 ? "a" : "cname";
        const inserted = await db
          .insert(projectDomainsTable)
          .values({
            projectId: resolvedProjectId,
            hostname,
            isPrimary: false,
            recordType,
            verificationToken: token,
            verificationStatus: "verified",
            sslStatus: "pending",
            environment: "production",
          })
          .onConflictDoNothing()
          .returning({ id: projectDomainsTable.id });

        publishDomainEvent({ type: "added", hostname, projectId: resolvedProjectId });

        // Kick off SSL issuance
        const domainRowId = inserted[0]?.id;
        if (domainRowId) {
          setImmediate(() => {
            void activateSslForDomain(domainRowId, hostname, null, resolvedProjectId!, false).catch(
              () => {},
            );
          });
        }
      }
    } catch (err) {
      logger.warn({ err, hostname, projectId }, "Auto-attach to project failed (non-fatal)");
    }
  }

  logger.info({ hostname, userId, orderId: namecheapOrderId }, "Domain purchased successfully");
  res.status(201).json({ domain: newDomain });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/domains/transfer-in
// Initiate inbound domain transfer from another registrar.
//
// Body:
//   hostname   — the domain to transfer
//   authCode   — EPP / auth code from the current registrar
//   projectId  — optional project to attach after transfer completes
//   contact    — WHOIS contact fields
// ─────────────────────────────────────────────────────────────────────────────
router.post("/domains/transfer-in", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const {
    hostname: rawHostname,
    authCode,
    projectId,
    contact: _contact2,
    successUrl,
    cancelUrl,
  } = req.body as {
    hostname?: string;
    authCode?: string;
    projectId?: number;
    contact?: WhoisContact;
    successUrl?: string;
    cancelUrl?: string;
  };

  if (!rawHostname || !authCode) {
    res.status(400).json({ error: "hostname and authCode are required" });
    return;
  }

  if (
    projectId !== undefined &&
    (await checkProjectAccess(userId, projectId, "member")) !== "granted"
  ) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const hostname = rawHostname.trim().toLowerCase();

  // Duplicate check
  const [existing] = await db
    .select({ id: purchasedDomainsTable.id })
    .from(purchasedDomainsTable)
    .where(eq(purchasedDomainsTable.hostname, hostname));
  if (existing) {
    res.status(409).json({ error: "This domain is already in your account" });
    return;
  }

  // Transfer eligibility pre-check: if Namecheap is configured, verify the domain is actually
  // registered (not available for purchase). An "available" domain cannot be transferred.
  if (namecheapEnabled()) {
    const [avail] = await checkAvailability([hostname]);
    if (avail && avail.available === true) {
      res.status(409).json({
        error:
          "This domain does not appear to be registered. Unregistered domains cannot be transferred — use the search tab to purchase it instead.",
      });
      return;
    }
  }

  // Look up transfer price
  const tld = "." + hostname.split(".").slice(1).join(".");
  const pricing = await getPricing([tld]);
  const priceUsd = pricing[0]?.transferPrice ?? 12.99;
  const amountCents = Math.round(priceUsd * 100);

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    if (!(await stripeAvailable())) {
      res.json({
        setupRequired: true,
        message: "Stripe is not configured.",
        priceUsd,
      });
      return;
    }
    res.status(503).json({ error: "Payment system unavailable" });
    return;
  }

  try {
    // Store auth code server-side before redirecting to Stripe (never put EPP codes in
    // third-party metadata). The map is keyed by userId:hostname with a 2-hour TTL.
    setTransferPending(userId, hostname, authCode);

    if (successUrl && cancelUrl) {
      const session = await stripe.checkout.sessions.create({
        mode: "payment",
        customer_creation: "always",
        payment_intent_data: { setup_future_usage: "off_session" },
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: "usd",
              unit_amount: amountCents,
              product_data: {
                name: `Transfer: ${hostname}`,
                description: `Domain transfer for ${hostname}`,
              },
            },
          },
        ],
        success_url: successUrl,
        cancel_url: cancelUrl,
        // authCode intentionally omitted — stored in transferPendingMap server-side
        metadata: {
          type: "domain_transfer",
          hostname,
          userId,
          projectId: projectId ? String(projectId) : "",
          priceUsd: String(priceUsd),
        },
      });

      res.json({
        sessionId: session.id,
        checkoutUrl: session.url,
        hostname,
        priceUsd,
        note: "Transfer typically takes 5–7 days to complete.",
      });
      return;
    }

    // Direct PaymentIntent path — authCode still omitted from metadata (stored in map)
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      metadata: {
        type: "domain_transfer",
        hostname,
        userId,
        projectId: projectId ? String(projectId) : "",
      },
      description: `Domain transfer: ${hostname}`,
    });

    res.json({
      clientSecret: pi.client_secret,
      paymentIntentId: pi.id,
      hostname,
      priceUsd,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication|invalid_api_key/i.test(msg)) {
      invalidateStripeCredentialCache();
    }
    res.status(502).json({ error: `Payment error: ${msg}` });
  }
});

// POST /api/domains/transfer-in/confirm — confirm after payment
router.post("/domains/transfer-in/confirm", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const {
    hostname,
    authCode: bodyAuthCode,
    paymentIntentId,
    sessionId: checkoutSessionId,
    projectId,
    contact,
  } = req.body as {
    hostname?: string;
    authCode?: string;
    paymentIntentId?: string;
    sessionId?: string;
    projectId?: number;
    contact?: WhoisContact;
  };

  if (!hostname || (!paymentIntentId && !checkoutSessionId)) {
    res.status(400).json({
      error: "hostname and either paymentIntentId or sessionId are required",
    });
    return;
  }

  // Resolve auth code: prefer server-side pending map over request body
  const resolvedAuthCode = getTransferPending(userId, hostname) ?? bodyAuthCode;
  if (!resolvedAuthCode) {
    res.status(400).json({
      error: "authCode is required (either via initiating transfer or request body)",
    });
    return;
  }

  // projectId can come from the request body OR be recovered from Stripe session metadata
  let resolvedTransferProjectId: number | undefined = projectId;

  if (
    resolvedTransferProjectId !== undefined &&
    (await checkProjectAccess(userId, resolvedTransferProjectId, "member")) !== "granted"
  ) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.status(503).json({ error: "Payment system unavailable" });
    return;
  }

  let pricePaidUsd = "12.99";
  let resolvedTransferCustomerId: string | null = null;

  try {
    if (checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      if (session.payment_status !== "paid") {
        res
          .status(402)
          .json({ error: `Checkout session not paid (status: ${session.payment_status})` });
        return;
      }
      const meta = session.metadata ?? {};
      if (meta.type !== "domain_transfer") {
        res.status(400).json({ error: "Checkout session is not for a domain transfer" });
        return;
      }
      if (meta.userId && meta.userId !== userId) {
        res.status(403).json({ error: "Checkout session belongs to a different user" });
        return;
      }
      if (meta.hostname && meta.hostname !== hostname) {
        res.status(400).json({ error: "Checkout session was created for a different domain" });
        return;
      }
      if (session.amount_total) pricePaidUsd = String(session.amount_total / 100);
      if (session.customer && typeof session.customer === "string") {
        resolvedTransferCustomerId = session.customer;
      }
      // Recover projectId from trusted Stripe session metadata when not in request body
      if (!resolvedTransferProjectId && meta.projectId) {
        const parsed = parseInt(meta.projectId, 10);
        if (!isNaN(parsed) && parsed > 0) resolvedTransferProjectId = parsed;
      }
    } else if (paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status !== "succeeded") {
        res.status(402).json({ error: `Payment not yet succeeded (status: ${pi.status})` });
        return;
      }
      // Verify PI metadata to prevent reuse of unrelated succeeded PaymentIntents
      const meta = pi.metadata ?? {};
      if (meta.type !== "domain_transfer") {
        res.status(400).json({ error: "Payment intent is not for a domain transfer" });
        return;
      }
      if (meta.userId && meta.userId !== userId) {
        res.status(403).json({ error: "Payment intent belongs to a different user" });
        return;
      }
      if (meta.hostname && meta.hostname !== hostname) {
        res.status(400).json({ error: "Payment intent was created for a different domain" });
        return;
      }
      pricePaidUsd = String(pi.amount / 100);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unknown";
    res.status(502).json({ error: `Stripe error: ${msg}` });
    return;
  }

  if (
    resolvedTransferProjectId !== undefined &&
    (await checkProjectAccess(userId, resolvedTransferProjectId, "member")) !== "granted"
  ) {
    res.status(404).json({ error: "Project not found" });
    return;
  }

  // Auth code consumed — clear from pending map
  clearTransferPending(userId, hostname);

  const defaultContact: WhoisContact = contact ?? {
    firstName: "MustaFlow",
    lastName: "User",
    email: SUPPORT_EMAIL_ADDRESS,
    phone: "+1.5005550001",
    address: "1 Main St",
    city: "San Francisco",
    stateProvince: "CA",
    postalCode: "94105",
    country: "US",
  };

  let transferId: string | undefined;
  let namecheapOrderId: string | undefined;

  if (namecheapEnabled()) {
    const result = await transferIn(hostname, resolvedAuthCode, defaultContact, 1);
    if (!result?.success) {
      res.status(502).json({
        error: `Transfer initiation failed: ${result?.error ?? "Unknown Namecheap error"}`,
        paymentSucceeded: true,
        note: "Your payment was captured. Report this issue at /help?mode=report.",
      });
      return;
    }
    transferId = result.transferId;
    namecheapOrderId = result.orderId;
  }

  const tld = "." + hostname.split(".").slice(1).join(".");
  const pricing = await getPricing([tld]);
  const renewalPriceUsd = String(pricing[0]?.renewalPrice ?? pricePaidUsd);

  const [newDomain] = await db
    .insert(purchasedDomainsTable)
    .values({
      userId,
      hostname,
      registrar: "namecheap",
      status: "transfer_pending",
      autoRenew: true,
      whoisPrivacy: true,
      namecheapOrderId: namecheapOrderId ?? null,
      stripePaymentIntentId: paymentIntentId ?? null,
      stripeCustomerId: resolvedTransferCustomerId,
      projectId: resolvedTransferProjectId ?? null,
      transferAuthCode: transferId ?? null,
      pricePaidUsd,
      renewalPriceUsd,
      whoisFirstName: defaultContact.firstName,
      whoisLastName: defaultContact.lastName,
      whoisEmail: defaultContact.email,
      whoisPhone: defaultContact.phone,
      whoisAddress: defaultContact.address,
      whoisCity: defaultContact.city,
      whoisStateProvince: defaultContact.stateProvince,
      whoisPostalCode: defaultContact.postalCode,
      whoisCountry: defaultContact.country,
    })
    .returning();

  res.status(201).json({
    domain: newDomain,
    note: "Transfer initiated. It typically takes 5–7 days to complete.",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/domains/purchased/:id/auto-renew
// Toggle auto-renew on/off.
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/domains/purchased/:id/auto-renew", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const { autoRenew } = req.body as { autoRenew?: boolean };

  if (typeof autoRenew !== "boolean") {
    res.status(400).json({ error: "autoRenew must be a boolean" });
    return;
  }

  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  // Update Namecheap (best-effort)
  void setAutoRenew(domain.hostname, autoRenew).catch(() => {});

  const [updated] = await db
    .update(purchasedDomainsTable)
    .set({ autoRenew, updatedAt: sql`now()` })
    .where(eq(purchasedDomainsTable.id, id))
    .returning();

  res.json({ domain: updated });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/domains/purchased/:id/whois
// Update WHOIS contact information.
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/domains/purchased/:id/whois", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  const contact = req.body as Partial<WhoisContact>;

  // Update Namecheap (best-effort)
  const fullContact: WhoisContact = {
    firstName: contact.firstName ?? domain.whoisFirstName ?? "MustaFlow",
    lastName: contact.lastName ?? domain.whoisLastName ?? "User",
    email: contact.email ?? domain.whoisEmail ?? SUPPORT_EMAIL_ADDRESS,
    phone: contact.phone ?? domain.whoisPhone ?? "+1.5005550001",
    address: contact.address ?? domain.whoisAddress ?? "1 Main St",
    city: contact.city ?? domain.whoisCity ?? "San Francisco",
    stateProvince: contact.stateProvince ?? domain.whoisStateProvince ?? "CA",
    postalCode: contact.postalCode ?? domain.whoisPostalCode ?? "94105",
    country: contact.country ?? domain.whoisCountry ?? "US",
  };
  void setWhoisContacts(domain.hostname, fullContact).catch(() => {});

  const [updated] = await db
    .update(purchasedDomainsTable)
    .set({
      whoisFirstName: fullContact.firstName,
      whoisLastName: fullContact.lastName,
      whoisEmail: fullContact.email,
      whoisPhone: fullContact.phone,
      whoisAddress: fullContact.address,
      whoisCity: fullContact.city,
      whoisStateProvince: fullContact.stateProvince,
      whoisPostalCode: fullContact.postalCode,
      whoisCountry: fullContact.country,
      updatedAt: sql`now()`,
    })
    .where(eq(purchasedDomainsTable.id, id))
    .returning();

  res.json({ domain: updated });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/domains/purchased/:id/renew
// Manual renewal — charge Stripe + call Namecheap.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/domains/purchased/:id/renew", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  const { successUrl, cancelUrl } = req.body as {
    successUrl?: string;
    cancelUrl?: string;
  };

  // Look up renewal price
  const tld = "." + domain.hostname.split(".").slice(1).join(".");
  const pricing = await getPricing([tld]);
  const priceUsd = pricing[0]?.renewalPrice ?? parseFloat(domain.renewalPriceUsd ?? "12.99");
  const amountCents = Math.round(priceUsd * 100);

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.status(503).json({ error: "Payment system unavailable" });
    return;
  }

  try {
    if (successUrl && cancelUrl) {
      const lineItems = [
        {
          quantity: 1,
          price_data: {
            currency: "usd",
            unit_amount: amountCents,
            product_data: {
              name: `Renew: ${domain.hostname}`,
              description: `1-year renewal for ${domain.hostname}`,
            },
          },
        },
      ];
      const sessionMeta = {
        type: "domain_renewal",
        domainId: String(id),
        hostname: domain.hostname,
        userId,
      };
      // Re-use existing Stripe customer if one was saved from a previous purchase,
      // otherwise create a new customer and save for future off-session renewals.
      const session = domain.stripeCustomerId
        ? await stripe.checkout.sessions.create({
            mode: "payment",
            customer: domain.stripeCustomerId,
            payment_intent_data: { setup_future_usage: "off_session" },
            line_items: lineItems,
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: sessionMeta,
          })
        : await stripe.checkout.sessions.create({
            mode: "payment",
            customer_creation: "always",
            payment_intent_data: { setup_future_usage: "off_session" },
            line_items: lineItems,
            success_url: successUrl,
            cancel_url: cancelUrl,
            metadata: sessionMeta,
          });
      res.json({ sessionId: session.id, checkoutUrl: session.url, priceUsd });
      return;
    }

    // Immediate PaymentIntent (for callers that handle payment themselves)
    const pi = await stripe.paymentIntents.create({
      amount: amountCents,
      currency: "usd",
      metadata: {
        type: "domain_renewal",
        domainId: String(id),
        hostname: domain.hostname,
        userId,
      },
      description: `Domain renewal: ${domain.hostname}`,
    });

    res.json({ clientSecret: pi.client_secret, paymentIntentId: pi.id, priceUsd });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    if (/api key|authentication|invalid_api_key/i.test(msg)) {
      invalidateStripeCredentialCache();
    }
    res.status(502).json({ error: `Payment error: ${msg}` });
  }
});

// POST /api/domains/purchased/:id/renew/confirm — confirm after payment
router.post("/domains/purchased/:id/renew/confirm", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const { paymentIntentId, sessionId: checkoutSessionId } = req.body as {
    paymentIntentId?: string;
    sessionId?: string;
  };

  if (!paymentIntentId && !checkoutSessionId) {
    res.status(400).json({ error: "paymentIntentId or sessionId is required" });
    return;
  }

  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  const stripe = await getUncachableStripeClient();
  if (!stripe) {
    res.status(503).json({ error: "Payment system unavailable" });
    return;
  }

  let renewalPriceUsd = domain.renewalPriceUsd ?? "12.99";
  let renewalStripeCustomerId: string | null = domain.stripeCustomerId ?? null;

  try {
    if (checkoutSessionId) {
      const session = await stripe.checkout.sessions.retrieve(checkoutSessionId);
      if (session.payment_status !== "paid") {
        res
          .status(402)
          .json({ error: `Checkout session not paid (status: ${session.payment_status})` });
        return;
      }
      const meta = session.metadata ?? {};
      if (meta.type !== "domain_renewal") {
        res.status(400).json({ error: "Checkout session is not for a domain renewal" });
        return;
      }
      if (meta.userId && meta.userId !== userId) {
        res.status(403).json({ error: "Checkout session belongs to a different user" });
        return;
      }
      if (meta.domainId && meta.domainId !== String(id)) {
        res.status(400).json({ error: "Checkout session was created for a different domain" });
        return;
      }
      if (session.amount_total) renewalPriceUsd = String(session.amount_total / 100);
      if (session.customer && typeof session.customer === "string") {
        renewalStripeCustomerId = session.customer;
      }
    } else if (paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
      if (pi.status !== "succeeded") {
        res.status(402).json({ error: `Payment not succeeded (status: ${pi.status})` });
        return;
      }
      // Verify PI metadata to prevent reuse of unrelated succeeded PaymentIntents
      const meta = pi.metadata ?? {};
      if (meta.type !== "domain_renewal") {
        res.status(400).json({ error: "Payment intent is not for a domain renewal" });
        return;
      }
      if (meta.userId && meta.userId !== userId) {
        res.status(403).json({ error: "Payment intent belongs to a different user" });
        return;
      }
      if (meta.domainId && meta.domainId !== String(id)) {
        res.status(400).json({ error: "Payment intent was created for a different domain" });
        return;
      }
      renewalPriceUsd = String(pi.amount / 100);
    }

    const renewResult = await namecheapRenew(domain.hostname, 1);
    if (renewResult && !renewResult.success) {
      res.status(502).json({
        error: `Namecheap renewal failed: ${renewResult.error}`,
        paymentSucceeded: true,
      });
      return;
    }

    const [updated] = await db
      .update(purchasedDomainsTable)
      .set({
        lastRenewalAt: new Date(),
        renewalStripePaymentIntentId: paymentIntentId ?? null,
        renewalPriceUsd,
        renewalFailedAt: null,
        renewalFailureReason: null,
        ...(renewalStripeCustomerId !== domain.stripeCustomerId
          ? { stripeCustomerId: renewalStripeCustomerId }
          : {}),
        expiresAt: domain.expiresAt
          ? new Date(domain.expiresAt.getTime() + 365 * 86_400_000)
          : new Date(Date.now() + 365 * 86_400_000),
        updatedAt: sql`now()`,
      })
      .where(eq(purchasedDomainsTable.id, id))
      .returning();

    res.json({ domain: updated });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Unexpected error";
    res.status(502).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/domains/purchased/:id/auth-code
// Retrieve EPP auth code for transfer-out.
// ─────────────────────────────────────────────────────────────────────────────
router.get("/domains/purchased/:id/auth-code", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  // Fetch from Namecheap if configured; fall back to stored code
  const authCode = namecheapEnabled()
    ? ((await getAuthCode(domain.hostname)) ?? domain.transferAuthCode)
    : domain.transferAuthCode;

  // Store the latest auth code for caching
  if (authCode && authCode !== domain.transferAuthCode) {
    await db
      .update(purchasedDomainsTable)
      .set({ transferAuthCode: authCode, updatedAt: sql`now()` })
      .where(eq(purchasedDomainsTable.id, id));
  }

  res.json({ hostname: domain.hostname, authCode: authCode ?? null });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/domains/purchased/:id/release
// Release domain: unlock registrar lock + log the action.
// No charge. The domain remains in purchased_domains with status=released.
// ─────────────────────────────────────────────────────────────────────────────
router.post("/domains/purchased/:id/release", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  // Unlock registrar lock (best-effort)
  void setRegistrarLock(domain.hostname, false).catch(() => {});

  const [updated] = await db
    .update(purchasedDomainsTable)
    .set({ status: "released", updatedAt: sql`now()` })
    .where(eq(purchasedDomainsTable.id, id))
    .returning();

  logger.info({ hostname: domain.hostname, userId }, "Domain released for transfer-out");

  res.json({
    domain: updated,
    note: "Registrar lock removed. Obtain the auth code and initiate the transfer at your new registrar.",
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PATCH /api/domains/purchased/:id/project
// Attach or detach the purchased domain from a project.
// Body: { projectId: number | null }
// ─────────────────────────────────────────────────────────────────────────────
router.patch("/domains/purchased/:id/project", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const { projectId } = req.body as { projectId?: number | null };

  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  if (projectId !== undefined && projectId !== null) {
    // Verify ownership
    const [project] = await db
      .select({ id: projectsTable.id })
      .from(projectsTable)
      .where(
        and(
          eq(projectsTable.id, projectId),
          eq(projectsTable.ownerId, userId),
          isNull(projectsTable.deletedAt),
        ),
      );
    if (!project) {
      res.status(404).json({ error: "Project not found or not owned by you" });
      return;
    }

    // Add to project_domains if not already there
    const token = `mustaflow-verify=${randomHex()}`;
    const labels = domain.hostname.split(".");
    const recordType: "a" | "cname" = labels.length === 2 ? "a" : "cname";
    const insertedDomain = await db
      .insert(projectDomainsTable)
      .values({
        projectId,
        hostname: domain.hostname,
        isPrimary: false,
        recordType,
        verificationToken: token,
        verificationStatus: "verified",
        sslStatus: "pending",
        environment: "production",
      })
      .onConflictDoNothing()
      .returning({ id: projectDomainsTable.id });

    publishDomainEvent({ type: "added", hostname: domain.hostname, projectId });
    const attachedDomainRowId = insertedDomain[0]?.id;
    if (attachedDomainRowId) {
      setImmediate(() => {
        void activateSslForDomain(
          attachedDomainRowId,
          domain.hostname,
          null,
          projectId,
          false,
        ).catch(() => {});
      });
    }
  } else if (projectId === null && domain.projectId) {
    // Detach: remove from project_domains
    await db
      .delete(projectDomainsTable)
      .where(
        and(
          eq(projectDomainsTable.hostname, domain.hostname),
          eq(projectDomainsTable.projectId, domain.projectId),
        ),
      );
  }

  const [updated] = await db
    .update(purchasedDomainsTable)
    .set({ projectId: projectId ?? null, updatedAt: sql`now()` })
    .where(eq(purchasedDomainsTable.id, id))
    .returning();

  res.json({ domain: updated });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/domains/purchased/:id/info
// Refresh domain info from Namecheap (expiry, NS, status).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/domains/purchased/:id/info", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const id = Number(req.params.id);
  const domain = await getPurchasedDomainForUser(id, userId);
  if (!domain) {
    res.status(404).json({ error: "Domain not found" });
    return;
  }

  const info = namecheapEnabled() ? await getInfo(domain.hostname) : null;

  if (info?.expiresAt) {
    const expiresAt = new Date(info.expiresAt);
    if (!isNaN(expiresAt.getTime())) {
      await db
        .update(purchasedDomainsTable)
        .set({ expiresAt, updatedAt: sql`now()` })
        .where(eq(purchasedDomainsTable.id, id));
    }
  }

  res.json({ domain, namecheapInfo: info });
});

export default router;
