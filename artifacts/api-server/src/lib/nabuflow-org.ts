// ─────────────────────────────────────────────────────────────────────────────
// NabuFlow Constellation — enterprise organization billing core (Task #1518).
//
// A company registers as an organization (its own company-flagged Stripe
// Customer — never a user's personal customer), buys volume-discounted bulk
// credit pools up front, and its seats draw builds from the shared pool
// through the SAME charge pipeline as self-serve plans (same credit unit,
// exactly `creditCostFor` amounts — no price changes here).
//
// Module DAG: nabuflow-plans → nabuflow-org → nabuflow-billing. This module
// never imports from nabuflow-billing (the billing core imports us), and it
// never touches Ora/Orax plan state or Stripe products.
//
// Money is integer USD cents. Pool draws are valued at the Constellation
// per-credit rate for spend-cap accounting; purchases are priced at the
// volume-discounted tier rate.
// ─────────────────────────────────────────────────────────────────────────────

import { and, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  notificationsTable,
  nabuflowOrgsTable,
  nabuflowOrgSeatsTable,
  nabuflowOrgPurchasesTable,
  nabuflowOrgLedgerTable,
  nabuflowOrgMonthsTable,
  nabuflowOrgSeatMonthsTable,
  nabuflowUsageEventsTable,
  type NabuflowOrg,
  type NabuflowOrgSeat,
  type NabuflowOrgPurchase,
  type NabuflowOrgMonth,
  type NabuflowOrgSeatMonth,
  type NabuflowUsageEvent,
} from "@workspace/db";
import {
  NABUFLOW_PLANS,
  NABUFLOW_WARNING_THRESHOLDS,
  nabuflowEffectiveSpendCapCents,
  nabuflowOrgDrawValueCents,
} from "./nabuflow-plans";
import { logger } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Month boundaries (UTC calendar months — org caps reset by construction)
// ─────────────────────────────────────────────────────────────────────────────

export function nabuflowOrgMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export function nextNabuflowOrgMonthStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookups
// ─────────────────────────────────────────────────────────────────────────────

export interface NabuflowOrgSeatContext {
  org: NabuflowOrg;
  seat: NabuflowOrgSeat;
}

/**
 * The enterprise org this account bills to, if any. UNIQUE(user_id) on seats
 * guarantees at most one — charge attribution is deterministic, and an active
 * seat takes precedence over any personal NabuFlow plan the user also holds.
 */
export async function getNabuflowOrgSeatContext(
  userId: string,
): Promise<NabuflowOrgSeatContext | null> {
  const [row] = await db
    .select({ org: nabuflowOrgsTable, seat: nabuflowOrgSeatsTable })
    .from(nabuflowOrgSeatsTable)
    .innerJoin(nabuflowOrgsTable, eq(nabuflowOrgSeatsTable.orgId, nabuflowOrgsTable.id))
    .where(eq(nabuflowOrgSeatsTable.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function getNabuflowOrgById(orgId: number): Promise<NabuflowOrg | null> {
  const [row] = await db
    .select()
    .from(nabuflowOrgsTable)
    .where(eq(nabuflowOrgsTable.id, orgId))
    .limit(1);
  return row ?? null;
}

export async function findNabuflowOrgByStripeCustomerId(
  stripeCustomerId: string,
): Promise<NabuflowOrg | null> {
  const [row] = await db
    .select()
    .from(nabuflowOrgsTable)
    .where(eq(nabuflowOrgsTable.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row ?? null;
}

export async function listNabuflowOrgSeats(orgId: number): Promise<NabuflowOrgSeat[]> {
  return db
    .select()
    .from(nabuflowOrgSeatsTable)
    .where(eq(nabuflowOrgSeatsTable.orgId, orgId))
    .orderBy(nabuflowOrgSeatsTable.createdAt);
}

// ─────────────────────────────────────────────────────────────────────────────
// Effective caps (config speaks dollars; storage/API speak cents)
// ─────────────────────────────────────────────────────────────────────────────

/** Org-wide monthly spend cap in cents — NULL falls back to the Constellation default, always clamped to the plan max. */
export function nabuflowOrgEffectiveCapCents(org: NabuflowOrg): number {
  return nabuflowEffectiveSpendCapCents(NABUFLOW_PLANS.constellation, org.monthlySpendCapUsdCents);
}

/** Effective per-seat sub-cap in cents (never above the org cap), or null when the seat has none. */
export function nabuflowOrgSeatEffectiveCapCents(
  org: NabuflowOrg,
  seat: NabuflowOrgSeat,
): number | null {
  if (seat.seatSpendCapUsdCents === null || seat.seatSpendCapUsdCents === undefined) return null;
  return Math.max(0, Math.min(seat.seatSpendCapUsdCents, nabuflowOrgEffectiveCapCents(org)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Monthly draw counters
// ─────────────────────────────────────────────────────────────────────────────

export async function getNabuflowOrgMonth(
  orgId: number,
  monthStart: Date,
): Promise<NabuflowOrgMonth | null> {
  const [row] = await db
    .select()
    .from(nabuflowOrgMonthsTable)
    .where(
      and(
        eq(nabuflowOrgMonthsTable.orgId, orgId),
        eq(nabuflowOrgMonthsTable.monthStart, monthStart),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function getNabuflowOrgSeatMonth(
  orgId: number,
  userId: string,
  monthStart: Date,
): Promise<NabuflowOrgSeatMonth | null> {
  const [row] = await db
    .select()
    .from(nabuflowOrgSeatMonthsTable)
    .where(
      and(
        eq(nabuflowOrgSeatMonthsTable.orgId, orgId),
        eq(nabuflowOrgSeatMonthsTable.userId, userId),
        eq(nabuflowOrgSeatMonthsTable.monthStart, monthStart),
      ),
    )
    .limit(1);
  return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Gate state (consumed by the pure evaluator in nabuflow-billing.ts)
// ─────────────────────────────────────────────────────────────────────────────

/** Everything the pure gate evaluator needs to decide an org seat's build. */
export interface NabuflowOrgGateInfo {
  orgId: number;
  companyName: string;
  status: string;
  role: string;
  poolCredits: number;
  /** Effective org-wide monthly cap (cents). */
  capUsdCents: number;
  /** Org draw value so far this UTC month (cents). */
  monthDrawnUsdCents: number;
  /** Effective per-seat sub-cap (cents), or null when the seat has none. */
  seatCapUsdCents: number | null;
  /** This seat's draw value so far this UTC month (cents). */
  seatMonthDrawnUsdCents: number;
  /** When monthly draw counters reset (next UTC month start). */
  monthResetsAt: Date;
}

export async function buildNabuflowOrgGateInfo(
  ctx: NabuflowOrgSeatContext,
  now: Date = new Date(),
): Promise<NabuflowOrgGateInfo> {
  const monthStart = nabuflowOrgMonthStart(now);
  const [orgMonth, seatMonth] = await Promise.all([
    getNabuflowOrgMonth(ctx.org.id, monthStart),
    getNabuflowOrgSeatMonth(ctx.org.id, ctx.seat.userId, monthStart),
  ]);
  return {
    orgId: ctx.org.id,
    companyName: ctx.org.companyName,
    status: ctx.org.status,
    role: ctx.seat.role,
    poolCredits: ctx.org.poolCredits,
    capUsdCents: nabuflowOrgEffectiveCapCents(ctx.org),
    monthDrawnUsdCents: orgMonth?.drawnUsdCents ?? 0,
    seatCapUsdCents: nabuflowOrgSeatEffectiveCapCents(ctx.org, ctx.seat),
    seatMonthDrawnUsdCents: seatMonth?.drawnUsdCents ?? 0,
    monthResetsAt: nextNabuflowOrgMonthStart(now),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Pool draw — the enterprise charge path
// ─────────────────────────────────────────────────────────────────────────────

/** Structurally mirrors NabuflowChargeOpts (module DAG forbids importing it). */
export interface NabuflowOrgChargeOpts {
  projectId?: number | null;
  taskId?: number | null;
  type: string;
  description: string;
  engineMode?: string | null;
  deepReasoning?: boolean;
  source?: string | null;
  settlementKey?: string | null;
}

export interface NabuflowOrgChargeResult {
  event: NabuflowUsageEvent;
  /** Pool balance after the draw (may be negative — in-flight builds are never killed). */
  poolCredits: number;
  orgMonth: NabuflowOrgMonth;
  drawValueCents: number;
}

function orgSourceForCharge(opts: NabuflowOrgChargeOpts): string {
  if (opts.source) return opts.source;
  switch (opts.type) {
    case "architect":
      return "architect";
    case "senses":
      return "senses";
    case "converse":
      return "converse";
    case "creative":
      return "creative";
    case "plan":
      return "plan";
    default:
      return "pipeline";
  }
}

/**
 * Draw `amount` credits from the org's shared pool for one seat's build.
 *
 * All pool movement serializes on the org row lock, so the balance, ledger
 * `balanceAfter` chain and monthly counters stay exactly consistent under
 * concurrent seat builds. The draw NEVER fails a started build: the balance
 * may dip below zero — the gate blocks NEW builds once it can't cover them.
 *
 * The usage event lands in the same `nabuflow_usage_events` ledger as
 * self-serve charges (orgId set, cycleId NULL, attribution "pool"), so seats
 * see their builds in the normal usage surface.
 */
export async function chargeNabuflowOrgPool(
  orgId: number,
  userId: string,
  amount: number,
  opts: NabuflowOrgChargeOpts,
): Promise<NabuflowOrgChargeResult> {
  const now = new Date();
  const monthStart = nabuflowOrgMonthStart(now);
  const drawValueCents = nabuflowOrgDrawValueCents(amount);

  const result = await db.transaction(async (tx) => {
    const [org] = await tx
      .select()
      .from(nabuflowOrgsTable)
      .where(eq(nabuflowOrgsTable.id, orgId))
      .for("update");
    if (!org) throw new Error(`nabuflow-org: org ${orgId} not found for pool draw`);

    const poolAfter = org.poolCredits - amount;
    await tx
      .update(nabuflowOrgsTable)
      .set({ poolCredits: poolAfter, updatedAt: sql`now()` })
      .where(eq(nabuflowOrgsTable.id, orgId));

    const [orgMonth] = await tx
      .insert(nabuflowOrgMonthsTable)
      .values({
        orgId,
        monthStart,
        creditsDrawn: amount,
        drawnUsdCents: drawValueCents,
      })
      .onConflictDoUpdate({
        target: [nabuflowOrgMonthsTable.orgId, nabuflowOrgMonthsTable.monthStart],
        set: {
          creditsDrawn: sql`${nabuflowOrgMonthsTable.creditsDrawn} + ${amount}`,
          drawnUsdCents: sql`${nabuflowOrgMonthsTable.drawnUsdCents} + ${drawValueCents}`,
          updatedAt: sql`now()`,
        },
      })
      .returning();

    await tx
      .insert(nabuflowOrgSeatMonthsTable)
      .values({
        orgId,
        userId,
        monthStart,
        creditsDrawn: amount,
        drawnUsdCents: drawValueCents,
      })
      .onConflictDoUpdate({
        target: [
          nabuflowOrgSeatMonthsTable.orgId,
          nabuflowOrgSeatMonthsTable.userId,
          nabuflowOrgSeatMonthsTable.monthStart,
        ],
        set: {
          creditsDrawn: sql`${nabuflowOrgSeatMonthsTable.creditsDrawn} + ${amount}`,
          drawnUsdCents: sql`${nabuflowOrgSeatMonthsTable.drawnUsdCents} + ${drawValueCents}`,
          updatedAt: sql`now()`,
        },
      });

    const [event] = await tx
      .insert(nabuflowUsageEventsTable)
      .values({
        userId,
        orgId,
        cycleId: null,
        cycleStart: monthStart,
        projectId: opts.projectId ?? null,
        taskId: opts.taskId ?? null,
        source: orgSourceForCharge(opts),
        engineMode: opts.engineMode ?? null,
        deepReasoning: !!opts.deepReasoning,
        credits: amount,
        includedCredits: 0,
        overageCredits: 0,
        overageUsdCents: 0,
        usdValueCents: drawValueCents,
        attribution: "pool",
        description: opts.description,
        settlementKey: opts.settlementKey ?? null,
      })
      .returning();

    await tx.insert(nabuflowOrgLedgerTable).values({
      orgId,
      entryType: "draw",
      credits: -amount,
      balanceAfter: poolAfter,
      usdCents: -drawValueCents,
      userId,
      usageEventId: event.id,
      description: opts.description,
    });

    return { event, poolCredits: poolAfter, orgMonth, drawValueCents };
  });

  // Org-cap threshold warnings — fire-and-forget, never fails the build.
  void notifyNabuflowOrgCapThresholds(orgId, result.orgMonth).catch((err) => {
    logger.warn({ err, orgId }, "nabuflow-org: cap threshold notification failed");
  });

  return result;
}

/**
 * Reverse the most recent matching un-reversed pool draw (canceled/discarded
 * reserved builds) — the enterprise mirror of maybeRefundNabuflow. Returns the
 * pool balance after (no-op returns the current balance without fabricating
 * credits when nothing matches).
 */
export async function refundNabuflowOrgPool(
  orgId: number,
  userId: string,
  amount: number,
  opts: {
    projectId?: number | null;
    taskId?: number | null;
    settlementKey?: string;
    description?: string;
  },
): Promise<number> {
  const cutoff = new Date(Date.now() - 48 * 60 * 60_000);
  const conditions = [
    eq(nabuflowUsageEventsTable.userId, userId),
    eq(nabuflowUsageEventsTable.orgId, orgId),
    eq(nabuflowUsageEventsTable.credits, amount),
    isNull(nabuflowUsageEventsTable.reversedAt),
    gt(nabuflowUsageEventsTable.createdAt, cutoff),
  ];
  if (opts.projectId != null) {
    conditions.push(eq(nabuflowUsageEventsTable.projectId, opts.projectId));
  }
  if (opts.taskId != null) {
    conditions.push(eq(nabuflowUsageEventsTable.taskId, opts.taskId));
  }
  if (opts.settlementKey) {
    conditions.push(eq(nabuflowUsageEventsTable.settlementKey, opts.settlementKey));
  }
  const [event] = await db
    .select()
    .from(nabuflowUsageEventsTable)
    .where(and(...conditions))
    .orderBy(desc(nabuflowUsageEventsTable.createdAt))
    .limit(1);

  if (!event) {
    logger.warn(
      { orgId, userId, amount, projectId: opts.projectId },
      "nabuflow-org: pool refund requested with no matching draw — no-op",
    );
    const org = await getNabuflowOrgById(orgId);
    return org?.poolCredits ?? 0;
  }

  const refunded = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(nabuflowUsageEventsTable)
      .set({ reversedAt: sql`now()` })
      .where(
        and(eq(nabuflowUsageEventsTable.id, event.id), isNull(nabuflowUsageEventsTable.reversedAt)),
      )
      .returning();
    if (!claimed) return null; // concurrent reversal won

    const [org] = await tx
      .select()
      .from(nabuflowOrgsTable)
      .where(eq(nabuflowOrgsTable.id, orgId))
      .for("update");
    if (!org) return null;

    const poolAfter = org.poolCredits + event.credits;
    await tx
      .update(nabuflowOrgsTable)
      .set({ poolCredits: poolAfter, updatedAt: sql`now()` })
      .where(eq(nabuflowOrgsTable.id, orgId));

    const drawValue = event.usdValueCents;
    await tx
      .update(nabuflowOrgMonthsTable)
      .set({
        creditsDrawn: sql`GREATEST(${nabuflowOrgMonthsTable.creditsDrawn} - ${event.credits}, 0)`,
        drawnUsdCents: sql`GREATEST(${nabuflowOrgMonthsTable.drawnUsdCents} - ${drawValue}, 0)`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(nabuflowOrgMonthsTable.orgId, orgId),
          eq(nabuflowOrgMonthsTable.monthStart, event.cycleStart),
        ),
      );
    await tx
      .update(nabuflowOrgSeatMonthsTable)
      .set({
        creditsDrawn: sql`GREATEST(${nabuflowOrgSeatMonthsTable.creditsDrawn} - ${event.credits}, 0)`,
        drawnUsdCents: sql`GREATEST(${nabuflowOrgSeatMonthsTable.drawnUsdCents} - ${drawValue}, 0)`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(nabuflowOrgSeatMonthsTable.orgId, orgId),
          eq(nabuflowOrgSeatMonthsTable.userId, userId),
          eq(nabuflowOrgSeatMonthsTable.monthStart, event.cycleStart),
        ),
      );

    await tx.insert(nabuflowOrgLedgerTable).values({
      orgId,
      entryType: "reversal",
      credits: event.credits,
      balanceAfter: poolAfter,
      usdCents: drawValue,
      userId,
      usageEventId: event.id,
      description: opts.description ?? `Reversal of: ${event.description ?? `${amount} credits`}`,
    });

    return poolAfter;
  });

  if (refunded !== null) return refunded;
  const org = await getNabuflowOrgById(orgId);
  return org?.poolCredits ?? 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Bulk purchases — funding the pool (idempotent crediting)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fund the pool for a paid purchase — exactly once. The `creditedAt` NULL→set
 * transition is the idempotency latch: the synchronous card-payment path and
 * the invoice.paid webhook may both land here for the same invoice, but only
 * one claims the credit; the loser is a no-op.
 */
export async function creditNabuflowOrgPurchase(
  purchaseId: number,
  opts: { paidAt?: Date | null } = {},
): Promise<boolean> {
  const credited = await db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(nabuflowOrgPurchasesTable)
      .set({
        status: "paid",
        paidAt: opts.paidAt ?? sql`COALESCE(${nabuflowOrgPurchasesTable.paidAt}, now())`,
        creditedAt: sql`now()`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(nabuflowOrgPurchasesTable.id, purchaseId),
          isNull(nabuflowOrgPurchasesTable.creditedAt),
        ),
      )
      .returning();
    if (!claimed) return false;

    const [org] = await tx
      .select()
      .from(nabuflowOrgsTable)
      .where(eq(nabuflowOrgsTable.id, claimed.orgId))
      .for("update");
    if (!org) throw new Error(`nabuflow-org: org ${claimed.orgId} missing for purchase credit`);

    const poolAfter = org.poolCredits + claimed.credits;
    await tx
      .update(nabuflowOrgsTable)
      .set({ poolCredits: poolAfter, updatedAt: sql`now()` })
      .where(eq(nabuflowOrgsTable.id, org.id));

    await tx.insert(nabuflowOrgLedgerTable).values({
      orgId: org.id,
      entryType: "purchase",
      credits: claimed.credits,
      balanceAfter: poolAfter,
      usdCents: claimed.amountUsdCents,
      purchaseId: claimed.id,
      description: `Bulk credit purchase — ${claimed.credits.toLocaleString("en-US")} credits`,
    });

    return true;
  });

  if (credited) {
    logger.info({ purchaseId }, "nabuflow-org: pool credited for purchase");
  }
  return credited;
}

export async function getNabuflowOrgPurchaseByInvoiceId(
  stripeInvoiceId: string,
): Promise<NabuflowOrgPurchase | null> {
  const [row] = await db
    .select()
    .from(nabuflowOrgPurchasesTable)
    .where(eq(nabuflowOrgPurchasesTable.stripeInvoiceId, stripeInvoiceId))
    .limit(1);
  return row ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stripe webhook routing + handlers (invoice.paid / invoice.payment_failed)
// ─────────────────────────────────────────────────────────────────────────────

type StripeInvoiceLike = {
  id?: string;
  customer?: string | { id?: string } | null;
  metadata?: Record<string, string> | null;
  status?: string | null;
  hosted_invoice_url?: string | null;
  invoice_pdf?: string | null;
  status_transitions?: { paid_at?: number | null } | null;
} | null;

function invoiceCustomerId(invoice: StripeInvoiceLike): string | null {
  if (!invoice) return null;
  const c = invoice.customer;
  if (typeof c === "string") return c;
  if (c && typeof c === "object" && typeof c.id === "string") return c.id;
  return null;
}

/**
 * Does this invoice belong to the enterprise org lane? Metadata-first (the
 * shared-customer routing rule), then the local purchase record, then the
 * org's company customer. Personal NabuFlow subscription invoices and every
 * Ora invoice return false — both-direction isolation.
 */
export async function isNabuflowOrgInvoiceEvent(invoice: StripeInvoiceLike): Promise<boolean> {
  if (!invoice) return false;
  const meta = invoice.metadata ?? {};
  if (meta.surface === "nabuflow" && meta.purpose === "org_pool_purchase") return true;
  if (typeof invoice.id === "string" && invoice.id) {
    if (await getNabuflowOrgPurchaseByInvoiceId(invoice.id)) return true;
  }
  const customerId = invoiceCustomerId(invoice);
  if (customerId && (await findNabuflowOrgByStripeCustomerId(customerId))) return true;
  return false;
}

/** invoice.paid for an org bulk purchase → mark paid + fund the pool (idempotent). */
export async function handleNabuflowOrgInvoicePaid(invoice: StripeInvoiceLike): Promise<void> {
  const invoiceId = typeof invoice?.id === "string" ? invoice.id : null;
  if (!invoiceId) return;
  const purchase = await getNabuflowOrgPurchaseByInvoiceId(invoiceId);
  if (!purchase) {
    logger.warn({ invoiceId }, "nabuflow-org: invoice.paid with no matching purchase — ignored");
    return;
  }

  // Refresh invoice artifacts (hosted URL/PDF may only exist post-finalize).
  await db
    .update(nabuflowOrgPurchasesTable)
    .set({
      hostedInvoiceUrl: invoice?.hosted_invoice_url ?? purchase.hostedInvoiceUrl,
      invoicePdfUrl: invoice?.invoice_pdf ?? purchase.invoicePdfUrl,
      updatedAt: sql`now()`,
    })
    .where(eq(nabuflowOrgPurchasesTable.id, purchase.id));

  const paidAtSec = invoice?.status_transitions?.paid_at;
  const credited = await creditNabuflowOrgPurchase(purchase.id, {
    paidAt: typeof paidAtSec === "number" ? new Date(paidAtSec * 1000) : null,
  });

  if (credited) {
    const org = await getNabuflowOrgById(purchase.orgId);
    if (org) {
      await notifyNabuflowOrgAdmins(
        org.id,
        "nabuflow_org_pool_funded",
        "Credit pool funded",
        `${purchase.credits.toLocaleString("en-US")} credits were added to ${org.companyName}'s shared pool. New balance: ${org.poolCredits.toLocaleString("en-US")} credits.`,
        { purchaseId: purchase.id, credits: purchase.credits },
      );
    }
  }
}

/** invoice.payment_failed for an org bulk purchase → mark failed + tell the admins. */
export async function handleNabuflowOrgInvoicePaymentFailed(
  invoice: StripeInvoiceLike,
): Promise<void> {
  const invoiceId = typeof invoice?.id === "string" ? invoice.id : null;
  if (!invoiceId) return;
  const purchase = await getNabuflowOrgPurchaseByInvoiceId(invoiceId);
  if (!purchase) return;
  if (purchase.status === "paid") return; // already funded — a stray retry event

  await db
    .update(nabuflowOrgPurchasesTable)
    .set({ status: "failed", updatedAt: sql`now()` })
    .where(
      and(eq(nabuflowOrgPurchasesTable.id, purchase.id), isNull(nabuflowOrgPurchasesTable.paidAt)),
    );

  await notifyNabuflowOrgAdmins(
    purchase.orgId,
    "nabuflow_org_purchase_failed",
    "Bulk credit payment failed",
    `The payment for ${purchase.credits.toLocaleString("en-US")} credits didn't go through. Update the company card or retry the purchase from Billing.`,
    { purchaseId: purchase.id, credits: purchase.credits },
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration & seats (gated setup — no self-serve checkout)
// ─────────────────────────────────────────────────────────────────────────────

export class NabuflowOrgError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "already_in_org"
      | "not_in_org"
      | "not_billing_admin"
      | "seat_exists"
      | "seat_not_found"
      | "last_billing_admin"
      | "user_not_found"
      | "org_error" = "org_error",
  ) {
    super(message);
    this.name = "NabuflowOrgError";
  }
}

export interface RegisterNabuflowOrgInput {
  companyName: string;
  billingContactName?: string | null;
  billingContactEmail: string;
  taxId?: string | null;
  addressLine1: string;
  addressLine2?: string | null;
  city: string;
  region?: string | null;
  postalCode: string;
  country: string;
  poReference?: string | null;
  organizationId?: number | null;
}

/**
 * Register a company for the Constellation lane: create the company-flagged
 * Stripe Customer (organization entity, never the user's personal customer),
 * insert the org record, and seat the requester as billing admin.
 *
 * The UNIQUE(user_id) seat constraint is the backstop for a registration
 * race — the second insert loses and we surface `already_in_org`.
 */
export async function registerNabuflowOrg(
  userId: string,
  input: RegisterNabuflowOrgInput,
): Promise<{ org: NabuflowOrg; seat: NabuflowOrgSeat }> {
  const existing = await getNabuflowOrgSeatContext(userId);
  if (existing) {
    throw new NabuflowOrgError(
      `You're already part of ${existing.org.companyName}'s NabuFlow organization.`,
      "already_in_org",
    );
  }

  const { createNabuflowOrgStripeCustomer, linkNabuflowOrgCustomer } =
    await import("./nabuflow-org-stripe");
  const customer = await createNabuflowOrgStripeCustomer({
    companyName: input.companyName,
    billingContactName: input.billingContactName ?? null,
    billingContactEmail: input.billingContactEmail,
    taxId: input.taxId ?? null,
    addressLine1: input.addressLine1,
    addressLine2: input.addressLine2 ?? null,
    city: input.city,
    region: input.region ?? null,
    postalCode: input.postalCode,
    country: input.country,
    createdByUserId: userId,
  });

  try {
    const { org, seat } = await db.transaction(async (tx) => {
      const [org] = await tx
        .insert(nabuflowOrgsTable)
        .values({
          organizationId: input.organizationId ?? null,
          companyName: input.companyName,
          billingContactName: input.billingContactName ?? null,
          billingContactEmail: input.billingContactEmail,
          taxId: input.taxId ?? null,
          addressLine1: input.addressLine1,
          addressLine2: input.addressLine2 ?? null,
          city: input.city,
          region: input.region ?? null,
          postalCode: input.postalCode,
          country: input.country,
          poReference: input.poReference ?? null,
          stripeCustomerId: customer.id,
          createdByUserId: userId,
        })
        .returning();
      const [seat] = await tx
        .insert(nabuflowOrgSeatsTable)
        .values({
          orgId: org.id,
          userId,
          role: "billing_admin",
          addedByUserId: userId,
        })
        .returning();
      return { org, seat };
    });

    void linkNabuflowOrgCustomer(customer.id, org.id);
    logger.info(
      { orgId: org.id, userId, stripeCustomerId: customer.id },
      "nabuflow-org: organization registered",
    );
    return { org, seat };
  } catch (err) {
    // Unique-violation race (seat or customer) — surface calmly. The created
    // Stripe customer is left orphaned-but-inert (no card, no invoices);
    // logged for manual cleanup rather than risking deleting a live customer.
    logger.error({ err, userId, customerId: customer.id }, "nabuflow-org: registration failed");
    if (err instanceof NabuflowOrgError) throw err;
    const msg = err instanceof Error ? err.message : String(err);
    if (/unique|duplicate/i.test(msg)) {
      throw new NabuflowOrgError(
        "You're already part of a NabuFlow organization.",
        "already_in_org",
      );
    }
    throw err;
  }
}

/** Add a seat by account email (the account must already exist). */
export async function addNabuflowOrgSeat(
  org: NabuflowOrg,
  opts: { email: string; addedByUserId: string; seatSpendCapUsdCents?: number | null },
): Promise<NabuflowOrgSeat> {
  const { findClerkUserByEmail } = await import("./clerk-users");
  const user = await findClerkUserByEmail(opts.email);
  if (!user) {
    throw new NabuflowOrgError(
      `No account found for ${opts.email}. They need to sign up first.`,
      "user_not_found",
    );
  }

  const existing = await getNabuflowOrgSeatContext(user.userId);
  if (existing) {
    throw new NabuflowOrgError(
      existing.org.id === org.id
        ? `${opts.email} already has a seat in this organization.`
        : `${opts.email} already belongs to another NabuFlow organization.`,
      existing.org.id === org.id ? "seat_exists" : "already_in_org",
    );
  }

  const [seat] = await db
    .insert(nabuflowOrgSeatsTable)
    .values({
      orgId: org.id,
      userId: user.userId,
      role: "member",
      email: opts.email,
      seatSpendCapUsdCents: opts.seatSpendCapUsdCents ?? null,
      addedByUserId: opts.addedByUserId,
    })
    .returning();
  return seat;
}

/** Remove a seat — the last billing admin can never be removed. */
export async function removeNabuflowOrgSeat(org: NabuflowOrg, userId: string): Promise<void> {
  const seats = await listNabuflowOrgSeats(org.id);
  const seat = seats.find((s) => s.userId === userId);
  if (!seat) {
    throw new NabuflowOrgError("That account has no seat in this organization.", "seat_not_found");
  }
  if (
    seat.role === "billing_admin" &&
    seats.filter((s) => s.role === "billing_admin").length <= 1
  ) {
    throw new NabuflowOrgError(
      "An organization must keep at least one billing admin.",
      "last_billing_admin",
    );
  }
  await db.delete(nabuflowOrgSeatsTable).where(eq(nabuflowOrgSeatsTable.id, seat.id));
}

// ─────────────────────────────────────────────────────────────────────────────
// Notifications (in-app; same notification surface as personal billing)
// ─────────────────────────────────────────────────────────────────────────────

async function notifyNabuflowOrgAdmins(
  orgId: number,
  type: string,
  title: string,
  body: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const seats = await listNabuflowOrgSeats(orgId);
    const admins = seats.filter((s) => s.role === "billing_admin");
    for (const admin of admins) {
      await db.insert(notificationsTable).values({
        recipientId: admin.userId,
        type,
        title,
        body,
        resourceType: "nabuflow_billing",
        metadata: { ...metadata, orgId },
      });
    }
  } catch (err) {
    logger.warn({ err, orgId, type }, "nabuflow-org: admin notification failed");
  }
}

/** Highest warning threshold (0|50|80|100) reached by used/total (local copy — module DAG). */
function orgThresholdLevel(used: number, total: number): number {
  if (total <= 0) return 0;
  const pct = (used / total) * 100;
  let level = 0;
  for (const t of NABUFLOW_WARNING_THRESHOLDS) {
    if (pct >= t) level = t;
  }
  return level;
}

/**
 * 50/80/100% warnings for the org-wide monthly cap. The watermark update is
 * guarded (`WHERE cap_notify_level < new`) so concurrent draws produce exactly
 * one notification per threshold per month.
 */
export async function notifyNabuflowOrgCapThresholds(
  orgId: number,
  orgMonth: NabuflowOrgMonth,
): Promise<void> {
  const org = await getNabuflowOrgById(orgId);
  if (!org) return;
  const capCents = nabuflowOrgEffectiveCapCents(org);
  const level = orgThresholdLevel(orgMonth.drawnUsdCents, capCents);
  if (level <= orgMonth.capNotifyLevel) return;

  const [claimed] = await db
    .update(nabuflowOrgMonthsTable)
    .set({ capNotifyLevel: level, updatedAt: sql`now()` })
    .where(
      and(
        eq(nabuflowOrgMonthsTable.id, orgMonth.id),
        lt(nabuflowOrgMonthsTable.capNotifyLevel, level),
      ),
    )
    .returning();
  if (!claimed) return; // another draw already claimed this threshold

  const pct = level;
  await notifyNabuflowOrgAdmins(
    orgId,
    "nabuflow_org_cap_warning",
    pct >= 100 ? "Organization spend cap reached" : `Organization spend at ${pct}% of cap`,
    pct >= 100
      ? `${org.companyName} has reached its monthly spend cap. New builds are paused until the cap is raised or the month resets.`
      : `${org.companyName} has used ${pct}% of its monthly spend cap.`,
    { level, monthStart: orgMonth.monthStart.toISOString() },
  );
}
