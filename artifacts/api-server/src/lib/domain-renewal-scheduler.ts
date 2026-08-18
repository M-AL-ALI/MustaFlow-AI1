/**
 * Domain Renewal Scheduler — Task #559
 *
 * Runs a daily sweep to:
 * 1. Send in-app renewal warning alerts at 60 / 30 / 7 / 1 days before expiry.
 * 2. Auto-renew domains that expire in ≤ 30 days and have autoRenew = true,
 *    using off-session Stripe charging when a saved customer/payment-method is
 *    present. Domains without a saved payment method get an actionable alert.
 * 3. Poll transfer status for domains in `transfer_pending` state and mark them
 *    `active` once Namecheap confirms the transfer is complete.
 *
 * Gracefully no-ops when Namecheap or Stripe credentials are not configured.
 */

import { db, purchasedDomainsTable, deploymentLogsTable } from "@workspace/db";
import { and, eq, lte, gte, sql } from "drizzle-orm";
import {
  namecheapEnabled,
  renew as namecheapRenew,
  getPricing,
  getTransferStatus,
} from "./namecheap";
import { getUncachableStripeClient } from "./stripeClient";
import { logger } from "./logger";
import { encryptionService } from "./encryption";
import { sendDomainRenewalWarning, sendDomainRenewalFailure } from "./emailClient";

const INITIAL_DELAY_MS = 60_000;
const INTERVAL_MS = 24 * 60 * 60 * 1000;

const WARNING_THRESHOLDS_DAYS = [60, 30, 7, 1];

// ── In-app alert helpers ───────────────────────────────────────────────────────

async function writeRenewalAlert(opts: {
  userId: string;
  hostname: string;
  daysUntilExpiry: number;
  isFailure: boolean;
  reason?: string;
}): Promise<void> {
  try {
    const note = JSON.stringify({
      action: opts.isFailure ? "renewal_failed" : "renewal_warning",
      hostname: opts.hostname,
      daysUntilExpiry: opts.daysUntilExpiry,
      ...(opts.reason ? { reason: opts.reason } : {}),
    });
    await db.insert(deploymentLogsTable).values({
      projectId: 0,
      userId: opts.userId,
      env: "domain",
      status: opts.isFailure ? "failed" : "passed",
      note,
    });
  } catch {
    /* best-effort */
  }
}

// ── Warning sweep ──────────────────────────────────────────────────────────────

function renewUrl(hostname: string): string {
  const base = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
  return `https://${base}/account/domains?renew=${encodeURIComponent(hostname)}`;
}

async function runWarningAlerts(): Promise<void> {
  const now = new Date();

  for (const days of WARNING_THRESHOLDS_DAYS) {
    const windowStart = new Date(now.getTime() + (days - 1) * 86_400_000);
    const windowEnd = new Date(now.getTime() + days * 86_400_000);

    try {
      const expiring = await db
        .select({
          id: purchasedDomainsTable.id,
          userId: purchasedDomainsTable.userId,
          hostname: purchasedDomainsTable.hostname,
          expiresAt: purchasedDomainsTable.expiresAt,
          whoisEmail: purchasedDomainsTable.whoisEmail,
        })
        .from(purchasedDomainsTable)
        .where(
          and(
            eq(purchasedDomainsTable.status, "active"),
            gte(purchasedDomainsTable.expiresAt, windowStart),
            lte(purchasedDomainsTable.expiresAt, windowEnd),
          ),
        );

      for (const domain of expiring) {
        // In-app alert (deployment_logs row)
        await writeRenewalAlert({
          userId: domain.userId,
          hostname: domain.hostname,
          daysUntilExpiry: days,
          isFailure: false,
        });

        // Email notification (best-effort; no-ops when SMTP not configured)
        if (domain.whoisEmail) {
          await sendDomainRenewalWarning({
            to: domain.whoisEmail,
            hostname: domain.hostname,
            daysUntilExpiry: days,
            renewUrl: renewUrl(domain.hostname),
          });
        }

        logger.info(
          { hostname: domain.hostname, daysUntilExpiry: days },
          "Domain renewal warning emitted",
        );
      }
    } catch (err) {
      logger.warn({ err, days }, "Domain renewal warning sweep error (non-fatal)");
    }
  }
}

// ── Auto-renewal sweep ─────────────────────────────────────────────────────────

async function runAutoRenewal(): Promise<void> {
  if (!namecheapEnabled()) return;

  const stripe = await getUncachableStripeClient();
  if (!stripe) return;

  const thirtyDaysFromNow = new Date(Date.now() + 30 * 86_400_000);

  // eslint-disable-next-line no-useless-assignment
  let domainsToRenew: Array<{
    id: number;
    userId: string;
    hostname: string;
    expiresAt: Date | null;
    renewalPriceUsd: string | null;
    stripePaymentIntentId: string | null;
    stripeCustomerId: string | null;
    whoisEmail: string | null;
  }> = [];

  try {
    domainsToRenew = await db
      .select({
        id: purchasedDomainsTable.id,
        userId: purchasedDomainsTable.userId,
        hostname: purchasedDomainsTable.hostname,
        expiresAt: purchasedDomainsTable.expiresAt,
        renewalPriceUsd: purchasedDomainsTable.renewalPriceUsd,
        stripePaymentIntentId: purchasedDomainsTable.stripePaymentIntentId,
        stripeCustomerId: purchasedDomainsTable.stripeCustomerId,
        whoisEmail: purchasedDomainsTable.whoisEmail,
      })
      .from(purchasedDomainsTable)
      .where(
        and(
          eq(purchasedDomainsTable.status, "active"),
          eq(purchasedDomainsTable.autoRenew, true),
          lte(purchasedDomainsTable.expiresAt, thirtyDaysFromNow),
        ),
      );
  } catch (err) {
    logger.warn({ err }, "Domain renewal: DB query failed");
    return;
  }

  for (const domain of domainsToRenew) {
    const daysUntilExpiry = Math.max(
      0,
      Math.ceil(((domain.expiresAt?.getTime() ?? Date.now()) - Date.now()) / 86_400_000),
    );

    try {
      if (domain.stripeCustomerId) {
        // ── Off-session automatic renewal ──────────────────────────────────
        // Retrieve the customer's default payment method, create an off-session
        // PaymentIntent, and — only if it succeeds — renew with Namecheap.
        logger.info(
          { hostname: domain.hostname, daysUntilExpiry },
          "Domain renewal: attempting off-session charge",
        );

        const tld = "." + domain.hostname.split(".").slice(1).join(".");
        const pricing = await getPricing([tld]);
        const priceUsd = pricing[0]?.renewalPrice ?? parseFloat(domain.renewalPriceUsd ?? "12.99");
        const amountCents = Math.round(priceUsd * 100);

        // Get default payment method from customer
        const customer = await stripe.customers.retrieve(domain.stripeCustomerId);
        if (customer.deleted) {
          throw new Error("Stripe customer has been deleted");
        }
        const paymentMethodId =
          (customer as { invoice_settings?: { default_payment_method?: string | null } })
            .invoice_settings?.default_payment_method ?? null;

        if (!paymentMethodId) {
          throw new Error("No default payment method on Stripe customer");
        }

        // Charge off-session
        const pi = await stripe.paymentIntents.create({
          amount: amountCents,
          currency: "usd",
          customer: domain.stripeCustomerId,
          payment_method: paymentMethodId,
          confirm: true,
          off_session: true,
          metadata: {
            type: "domain_renewal_auto",
            domainId: String(domain.id),
            hostname: domain.hostname,
            userId: domain.userId,
          },
          description: `Auto-renewal: ${domain.hostname}`,
        });

        if (pi.status !== "succeeded") {
          throw new Error(`PaymentIntent status: ${pi.status}`);
        }

        // Payment confirmed — now renew with Namecheap
        const renewResult = await namecheapRenew(domain.hostname, 1);
        if (renewResult && !renewResult.success) {
          throw new Error(`Namecheap error: ${renewResult.error}`);
        }

        await db
          .update(purchasedDomainsTable)
          .set({
            lastRenewalAt: new Date(),
            renewalStripePaymentIntentId: pi.id,
            renewalPriceUsd: String(priceUsd),
            renewalFailedAt: null,
            renewalFailureReason: null,
            expiresAt: domain.expiresAt
              ? new Date(domain.expiresAt.getTime() + 365 * 86_400_000)
              : new Date(Date.now() + 365 * 86_400_000),
            updatedAt: sql`now()`,
          })
          .where(eq(purchasedDomainsTable.id, domain.id));

        logger.info(
          { hostname: domain.hostname, piId: pi.id },
          "Domain auto-renewed successfully via off-session charge",
        );
      } else {
        // ── No saved payment method — emit actionable alert ────────────────
        logger.info(
          { hostname: domain.hostname, daysUntilExpiry },
          "Domain renewal: no saved payment method; writing manual renewal alert",
        );

        await writeRenewalAlert({
          userId: domain.userId,
          hostname: domain.hostname,
          daysUntilExpiry,
          isFailure: false,
          reason: "auto_renew_pending_payment — please renew from My Domains",
        });

        // Email the registrant contact so they can renew manually
        if (domain.whoisEmail) {
          await sendDomainRenewalWarning({
            to: domain.whoisEmail,
            hostname: domain.hostname,
            daysUntilExpiry,
            renewUrl: renewUrl(domain.hostname),
          });
        }
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : "Unexpected error";
      logger.error({ err, hostname: domain.hostname }, "Domain auto-renewal failed");

      // Record failure on the domain row
      await db
        .update(purchasedDomainsTable)
        .set({
          renewalFailedAt: new Date(),
          renewalFailureReason: reason,
          updatedAt: sql`now()`,
        })
        .where(eq(purchasedDomainsTable.id, domain.id))
        .catch(() => {});

      await writeRenewalAlert({
        userId: domain.userId,
        hostname: domain.hostname,
        daysUntilExpiry,
        isFailure: true,
        reason,
      }).catch(() => {});

      // Email the registrant contact about the failure
      if (domain.whoisEmail) {
        await sendDomainRenewalFailure({
          to: domain.whoisEmail,
          hostname: domain.hostname,
          reason,
          renewUrl: renewUrl(domain.hostname),
        }).catch(() => {});
      }
    }
  }
}

// ── Transfer status polling sweep ─────────────────────────────────────────────

async function runTransferPolling(): Promise<void> {
  if (!namecheapEnabled()) return;

  // eslint-disable-next-line no-useless-assignment
  let pendingTransfers: Array<{
    id: number;
    userId: string;
    hostname: string;
    // transferAuthCode stores the Namecheap TransferID after transfer initiation
    // (not the EPP code; that is kept only in the server-side pending map and cleared on confirm)
    transferAuthCode: string | null;
  }> = [];

  try {
    pendingTransfers = await db
      .select({
        id: purchasedDomainsTable.id,
        userId: purchasedDomainsTable.userId,
        hostname: purchasedDomainsTable.hostname,
        transferAuthCode: purchasedDomainsTable.transferAuthCode,
      })
      .from(purchasedDomainsTable)
      .where(eq(purchasedDomainsTable.status, "transfer_pending"));
  } catch (err) {
    logger.warn({ err }, "Transfer polling: DB query failed");
    return;
  }

  for (const domain of pendingTransfers) {
    try {
      // `transferAuthCode` is repurposed post-confirmation to store the Namecheap TransferID.
      const namecheapTransferId = domain.transferAuthCode
        ? encryptionService.decrypt(domain.transferAuthCode)
        : null;
      if (!namecheapTransferId) continue;

      const statusResult = await getTransferStatus(namecheapTransferId);
      if (!statusResult) continue;

      if (statusResult.status === "Completed") {
        await db
          .update(purchasedDomainsTable)
          .set({
            status: "active",
            registeredAt: new Date(),
            expiresAt: new Date(Date.now() + 365 * 86_400_000),
            updatedAt: sql`now()`,
          })
          .where(eq(purchasedDomainsTable.id, domain.id));

        logger.info({ hostname: domain.hostname }, "Transfer completed — domain marked active");
      } else if (statusResult.status === "Cancelled" || statusResult.status === "Failed") {
        await db
          .update(purchasedDomainsTable)
          .set({
            status: "transfer_failed",
            renewalFailureReason: statusResult.status,
            updatedAt: sql`now()`,
          })
          .where(eq(purchasedDomainsTable.id, domain.id));

        logger.warn(
          { hostname: domain.hostname, statusResult },
          "Transfer failed/cancelled — domain marked transfer_failed",
        );
      } else {
        logger.info(
          { hostname: domain.hostname, status: statusResult.status },
          "Transfer still in progress",
        );
      }
    } catch (err) {
      logger.warn({ err, hostname: domain.hostname }, "Transfer status poll error (non-fatal)");
    }
  }
}

export async function runDomainRenewalSweep(): Promise<void> {
  logger.info("Domain renewal scheduler: starting sweep");
  await runWarningAlerts();
  await runAutoRenewal();
  await runTransferPolling();
  logger.info("Domain renewal scheduler: sweep complete");
}

export function startDomainRenewalScheduler(): void {
  logger.info(
    { initialDelayMs: INITIAL_DELAY_MS, intervalMs: INTERVAL_MS },
    "Domain renewal scheduler: starting (daily sweep)",
  );
  setTimeout(() => {
    void runDomainRenewalSweep();
    setInterval(() => {
      void runDomainRenewalSweep();
    }, INTERVAL_MS);
  }, INITIAL_DELAY_MS);
}
