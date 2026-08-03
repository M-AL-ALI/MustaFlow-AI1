/**
 * domain-fulfillment.ts — shared domain registration/transfer completion logic.
 *
 * Called from two paths:
 *   1. POST /api/domains/purchase/confirm   (browser return after Stripe checkout)
 *   2. POST /billing/webhook                (Stripe async fulfillment — idempotent)
 *
 * All functions are fully idempotent: they check for an existing row first and
 * return { alreadyRegistered: true } without re-registering.
 */

import { eq, and, isNull } from "drizzle-orm";
import { db, purchasedDomainsTable, projectDomainsTable, projectsTable } from "@workspace/db";
import { namecheapEnabled, register, getPricing, type WhoisContact } from "./namecheap";
import { publishDomainEvent } from "./event-bus";
import { logger } from "./logger";
import { randomBytes } from "crypto";
import { SUPPORT_EMAIL_ADDRESS } from "./support-contact";

function randomHex(): string {
  return randomBytes(12).toString("hex");
}

const DEFAULT_CONTACT: WhoisContact = {
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

// ── activateSslForDomain import (dynamic to avoid circular deps) ──────────────
async function triggerSsl(domainRowId: number, hostname: string, projectId: number): Promise<void> {
  try {
    const { activateSslForDomain } = await import("../routes/ssl");
    await activateSslForDomain(domainRowId, hostname, null, projectId, false);
  } catch {
    /* best-effort */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// fulfillDomainPurchase
// ─────────────────────────────────────────────────────────────────────────────

export interface DomainPurchaseFulfillOpts {
  hostname: string;
  userId: string;
  years?: number;
  pricePaidUsd: string;
  stripeCustomerId: string | null;
  stripePaymentIntentId: string | null;
  projectId?: number;
  contact?: WhoisContact;
}

export interface DomainPurchaseFulfillResult {
  domain: typeof purchasedDomainsTable.$inferSelect;
  alreadyRegistered: boolean;
}

/**
 * Register hostname with Namecheap (if enabled), insert the purchased_domains
 * row, and optionally auto-attach to a project.  Fully idempotent.
 *
 * Throws on unrecoverable errors (Namecheap registration failure after payment,
 * DB insert failure).  Callers should translate exceptions to appropriate HTTP
 * responses.
 */
export async function fulfillDomainPurchase(
  opts: DomainPurchaseFulfillOpts,
): Promise<DomainPurchaseFulfillResult> {
  const {
    hostname,
    userId,
    years = 1,
    pricePaidUsd,
    stripeCustomerId,
    stripePaymentIntentId,
    contact,
  } = opts;
  let { projectId } = opts;

  // Idempotency check — domain row already exists
  const [existing] = await db
    .select()
    .from(purchasedDomainsTable)
    .where(
      and(eq(purchasedDomainsTable.hostname, hostname), eq(purchasedDomainsTable.userId, userId)),
    );
  if (existing) {
    return { domain: existing, alreadyRegistered: true };
  }

  // Register with Namecheap
  const resolvedContact = contact ?? DEFAULT_CONTACT;
  let namecheapOrderId: string | undefined;
  let registeredAt: Date | undefined;
  let expiresAt: Date | undefined;

  if (namecheapEnabled()) {
    const result = await register(hostname, resolvedContact, years);
    if (!result?.success) {
      logger.error(
        { hostname, error: result?.error },
        "Namecheap registration failed after payment",
      );
      throw new Error(
        `Domain registration failed: ${result?.error ?? "Unknown Namecheap error"}. Your payment was captured — report this issue at /help?mode=report.`,
      );
    }
    namecheapOrderId = result.orderId;
    registeredAt = new Date();
    expiresAt = new Date(Date.now() + years * 365 * 86_400_000);
  } else {
    registeredAt = new Date();
    expiresAt = new Date(Date.now() + years * 365 * 86_400_000);
    logger.warn({ hostname }, "Namecheap not configured — recording purchase without registration");
  }

  // Insert domain row
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
      stripePaymentIntentId: stripePaymentIntentId ?? null,
      stripeCustomerId,
      projectId: projectId ?? null,
      pricePaidUsd,
      renewalPriceUsd,
      whoisFirstName: resolvedContact.firstName,
      whoisLastName: resolvedContact.lastName,
      whoisEmail: resolvedContact.email,
      whoisPhone: resolvedContact.phone,
      whoisAddress: resolvedContact.address,
      whoisCity: resolvedContact.city,
      whoisStateProvince: resolvedContact.stateProvince,
      whoisPostalCode: resolvedContact.postalCode,
      whoisCountry: resolvedContact.country,
    })
    .returning();

  if (!newDomain) {
    throw new Error("Failed to save domain record");
  }

  // Auto-attach to project (if provided and valid)
  if (projectId) {
    try {
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

      if (project) {
        const token = `mustaflow-verify=${randomHex()}`;
        const labels = hostname.split(".");
        const recordType: "a" | "cname" = labels.length === 2 ? "a" : "cname";
        const inserted = await db
          .insert(projectDomainsTable)
          .values({
            projectId,
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

        publishDomainEvent({ type: "added", hostname, projectId });

        const domainRowId = inserted[0]?.id;
        if (domainRowId) {
          setImmediate(() => {
            void triggerSsl(domainRowId, hostname, projectId!);
          });
        }
      } else {
        // Project not found or not owned by user — clear projectId so it doesn't
        // appear as attached in the response
        projectId = undefined;
      }
    } catch (err) {
      logger.warn({ err, hostname, projectId }, "Domain auto-attach to project failed (non-fatal)");
    }
  }

  logger.info({ hostname, userId, orderId: namecheapOrderId }, "Domain purchased and fulfilled");
  return { domain: newDomain, alreadyRegistered: false };
}
