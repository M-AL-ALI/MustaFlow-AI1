// ─────────────────────────────────────────────────────────────────────────────
// Credits — GET /api/credits, GET /api/credits/transactions
//
// Provides current user credit balance and transaction history.
// Credits are auto-provisioned on first access (100 starter credits).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, userCreditsTable, creditTransactionsTable } from "@workspace/db";
import { sendWelcomeEmail, sendLowCreditEmail } from "../lib/emailClient";
import { getClerkUserById } from "../lib/clerk-users";
import { isSuperuser } from "../lib/superusers";
import { logger } from "../lib/logger";

const router: IRouter = Router();

// Global kill switch — when false, credit checks/deductions are skipped so
// users can test the builder for free. Default OFF (no charging) until the
// owner flips CREDITS_ENFORCEMENT=true in env.
export const CREDITS_ENFORCEMENT_ENABLED = process.env.CREDITS_ENFORCEMENT === "true";

/** Low-balance threshold below which a warning email is sent. */
const LOW_CREDIT_THRESHOLD = 15;
/** Minimum gap between low-credit warning emails (24 hours). */
const LOW_CREDIT_EMAIL_COOLDOWN_MS = 24 * 60 * 60_000;

/** Base URL for user-facing links in emails. */
function platformBase(): string {
  const domain = process.env.PLATFORM_DOMAIN ?? "mustaflow.app";
  return `https://${domain}`;
}

// Upsert user credit row, returning current balance.
export async function getOrCreateCredits(userId: string): Promise<{
  id: number;
  userId: string;
  balance: number;
  updatedAt: Date;
  lastLowCreditEmailAt: Date | null;
}> {
  const [existing] = await db
    .select()
    .from(userCreditsTable)
    .where(eq(userCreditsTable.userId, userId));

  if (existing) return existing;

  const [created] = await db.insert(userCreditsTable).values({ userId, balance: 100 }).returning();

  // Fire-and-forget welcome email for brand-new users
  void (async () => {
    try {
      const clerkUser = await getClerkUserById(userId);
      if (clerkUser?.email) {
        await sendWelcomeEmail({
          to: clerkUser.email,
          displayName: clerkUser.displayName,
          ctaUrl: `${platformBase()}/projects`,
        });
      }
    } catch (err) {
      logger.warn({ err, userId }, "Welcome email failed (non-fatal)");
    }
  })();

  return created!;
}

router.get("/credits", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const credits = await getOrCreateCredits(userId);
  res.json({ userId: credits.userId, balance: credits.balance, updatedAt: credits.updatedAt });
});

router.get("/credits/transactions", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Not authenticated" });
    return;
  }

  const rows = await db
    .select()
    .from(creditTransactionsTable)
    .where(eq(creditTransactionsTable.userId, userId))
    .orderBy(desc(creditTransactionsTable.createdAt))
    .limit(50);

  res.json({ transactions: rows });
});

/**
 * @deprecated — use deductCreditsAtomic instead.
 * This function reads the balance, subtracts in JavaScript, and writes back — it is NOT
 * atomic and allows concurrent requests to both succeed when the balance is tight.
 * It is kept only to avoid a breaking change during migration; callers must be updated.
 */
export async function deductCredits(
  userId: string,
  amount: number,
  opts: {
    projectId?: number;
    type: "build" | "refine" | "plan" | "architect" | "senses" | "creative" | "converse";
    description: string;
  },
): Promise<{ newBalance: number } | { insufficient: true; balance: number }> {
  logger.warn(
    { userId, amount, description: opts.description },
    "deductCredits (non-atomic) called — migrate caller to deductCreditsAtomic",
  );
  const credits = await getOrCreateCredits(userId);

  // Superusers never get charged, regardless of CREDITS_ENFORCEMENT. No
  // deduction, no transaction row, never "insufficient".
  if (await isSuperuser(userId)) {
    return { newBalance: credits.balance };
  }

  // When credit enforcement is disabled, no-op: don't deduct, don't write
  // a transaction row, and never return "insufficient". Lets users test
  // the builder for free until charging is explicitly enabled.
  if (!CREDITS_ENFORCEMENT_ENABLED) {
    return { newBalance: credits.balance };
  }

  if (credits.balance < amount) {
    return { insufficient: true, balance: credits.balance };
  }

  const newBalance = credits.balance - amount;

  await db
    .update(userCreditsTable)
    .set({ balance: newBalance, updatedAt: sql`now()` })
    .where(eq(userCreditsTable.userId, userId));

  await db.insert(creditTransactionsTable).values({
    userId,
    projectId: opts.projectId ?? null,
    type: opts.type,
    amount: -amount,
    description: opts.description,
    balanceAfter: newBalance,
  });

  return { newBalance };
}

// Atomic credit deduction — uses a conditional UPDATE so concurrent requests
// cannot both succeed when the balance is tight. Falls back gracefully when
// CREDITS_ENFORCEMENT is disabled. Returns { insufficient } when balance < amount.
export async function deductCreditsAtomic(
  userId: string,
  amount: number,
  opts: {
    projectId?: number;
    type: "build" | "refine" | "plan" | "architect" | "senses" | "creative" | "converse";
    description: string;
    /** NabuFlow ledger attribution (Task #1516) — build entry points pass these. */
    engineMode?: string | null;
    deepReasoning?: boolean;
    taskId?: number | null;
    source?: string | null;
  },
): Promise<{ newBalance: number } | { insufficient: true; balance: number }> {
  const credits = await getOrCreateCredits(userId);

  // Superusers never get charged, regardless of CREDITS_ENFORCEMENT. No
  // deduction, no transaction row, never "insufficient".
  if (await isSuperuser(userId)) {
    return { newBalance: credits.balance };
  }

  if (!CREDITS_ENFORCEMENT_ENABLED) {
    return { newBalance: credits.balance };
  }

  // NabuFlow billing (Task #1516): allow-listed owners build free with no
  // charge; users on an active NabuFlow plan charge through cycle accounting
  // (included credits first, then metered pay-as-you-go overage) with exactly
  // this `amount` — never "insufficient", since the build gate authorized the
  // run before it started. Charge amounts stay identical to creditCostFor.
  try {
    const nabuflow = await import("../lib/nabuflow-billing");
    if (await nabuflow.isBuilderAllowlistExempt(userId)) {
      return { newBalance: credits.balance };
    }
    const nabuCharge = await nabuflow.maybeChargeNabuflow(userId, amount, {
      projectId: opts.projectId ?? null,
      taskId: opts.taskId ?? null,
      type: opts.type,
      description: opts.description,
      engineMode: opts.engineMode ?? null,
      deepReasoning: opts.deepReasoning ?? false,
      source: opts.source ?? null,
    });
    if (nabuCharge) return nabuCharge;
  } catch (err) {
    logger.error(
      { err, userId, amount },
      "NabuFlow charge delegation failed — falling back to wallet path",
    );
  }

  if (credits.balance < amount) {
    return { insufficient: true, balance: credits.balance };
  }

  // Single conditional UPDATE — only succeeds if balance is still >= amount
  const [updated] = await db
    .update(userCreditsTable)
    .set({ balance: sql`balance - ${amount}`, updatedAt: sql`now()` })
    .where(and(eq(userCreditsTable.userId, userId), sql`balance >= ${amount}`))
    .returning({ balance: userCreditsTable.balance });

  if (!updated) {
    // Concurrent request won the race — re-read and report insufficient
    const current = await getOrCreateCredits(userId);
    return { insufficient: true, balance: current.balance };
  }

  await db.insert(creditTransactionsTable).values({
    userId,
    projectId: opts.projectId ?? null,
    type: opts.type,
    amount: -amount,
    description: opts.description,
    balanceAfter: updated.balance,
  });

  // Fire-and-forget low-balance warning email when balance crosses below threshold
  if (updated.balance < LOW_CREDIT_THRESHOLD) {
    void (async () => {
      try {
        const now = Date.now();
        const lastSent = credits.lastLowCreditEmailAt?.getTime() ?? 0;
        if (now - lastSent < LOW_CREDIT_EMAIL_COOLDOWN_MS) return; // within cooldown

        const clerkUser = await getClerkUserById(userId);
        if (!clerkUser?.email) return;

        // Stamp the timestamp before sending to prevent a second concurrent send
        await db
          .update(userCreditsTable)
          .set({ lastLowCreditEmailAt: new Date() })
          .where(eq(userCreditsTable.userId, userId));

        await sendLowCreditEmail({
          to: clerkUser.email,
          balance: updated.balance,
          topUpUrl: `${platformBase()}/settings?tab=billing`,
        });
      } catch (err) {
        logger.warn({ err, userId }, "Low-credit email failed (non-fatal)");
      }
    })();
  }

  return { newBalance: updated.balance };
}

// Refund credits — used when a background job is canceled, discarded, or fails
// after its credits were reserved upfront at enqueue time.
export async function refundCredits(
  userId: string,
  amount: number,
  opts: { projectId?: number; description: string },
): Promise<number> {
  if (amount <= 0) {
    const c = await getOrCreateCredits(userId);
    return c.balance;
  }

  // NabuFlow billing (Task #1516): users on an active NabuFlow plan get the
  // matching usage-ledger event reversed (bucket, counters, pending overage
  // invoice item) instead of a legacy wallet credit.
  try {
    const { nabuflowChargeActive, maybeRefundNabuflow } = await import("../lib/nabuflow-billing");
    if (await nabuflowChargeActive(userId)) {
      const remaining = await maybeRefundNabuflow(userId, amount, {
        projectId: opts.projectId ?? null,
        description: opts.description,
      });
      if (remaining !== null) return remaining;
    }
  } catch (err) {
    logger.error(
      { err, userId, amount },
      "NabuFlow refund delegation failed — falling back to wallet refund",
    );
  }

  const credits = await getOrCreateCredits(userId);
  const newBalance = credits.balance + amount;

  await db
    .update(userCreditsTable)
    .set({ balance: newBalance, updatedAt: sql`now()` })
    .where(eq(userCreditsTable.userId, userId));

  await db.insert(creditTransactionsTable).values({
    userId,
    projectId: opts.projectId ?? null,
    type: "manual_adjustment",
    amount,
    description: `Refund: ${opts.description}`,
    balanceAfter: newBalance,
  });

  return newBalance;
}

// Internal helper to grant credits (starter grant, admin adjustment, etc.)
export async function grantCredits(
  userId: string,
  amount: number,
  description: string,
): Promise<number> {
  const credits = await getOrCreateCredits(userId);
  const newBalance = credits.balance + amount;

  await db
    .update(userCreditsTable)
    .set({ balance: newBalance, updatedAt: sql`now()` })
    .where(eq(userCreditsTable.userId, userId));

  await db.insert(creditTransactionsTable).values({
    userId,
    type: "manual_adjustment",
    amount,
    description,
    balanceAfter: newBalance,
  });

  return newBalance;
}

export default router;
