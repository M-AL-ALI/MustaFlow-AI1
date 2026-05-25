// ─────────────────────────────────────────────────────────────────────────────
// Credits — GET /api/credits, GET /api/credits/transactions
//
// Provides current user credit balance and transaction history.
// Credits are auto-provisioned on first access (100 starter credits).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db, userCreditsTable, creditTransactionsTable } from "@workspace/db";

const router: IRouter = Router();

// Global kill switch — when false, credit checks/deductions are skipped so
// users can test the builder for free. Default OFF (no charging) until the
// owner flips CREDITS_ENFORCEMENT=true in env.
export const CREDITS_ENFORCEMENT_ENABLED = process.env.CREDITS_ENFORCEMENT === "true";

// Upsert user credit row, returning current balance.
export async function getOrCreateCredits(
  userId: string,
): Promise<{ id: number; userId: string; balance: number; updatedAt: Date }> {
  const [existing] = await db
    .select()
    .from(userCreditsTable)
    .where(eq(userCreditsTable.userId, userId));

  if (existing) return existing;

  const [created] = await db.insert(userCreditsTable).values({ userId, balance: 100 }).returning();

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

// Internal helper used by the builder to deduct credits.
// Returns the new balance after deduction, or null if insufficient.
export async function deductCredits(
  userId: string,
  amount: number,
  opts: {
    projectId?: number;
    type: "build" | "refine" | "plan" | "architect" | "senses" | "creative" | "converse";
    description: string;
  },
): Promise<{ newBalance: number } | { insufficient: true; balance: number }> {
  const credits = await getOrCreateCredits(userId);

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
  },
): Promise<{ newBalance: number } | { insufficient: true; balance: number }> {
  const credits = await getOrCreateCredits(userId);

  if (!CREDITS_ENFORCEMENT_ENABLED) {
    return { newBalance: credits.balance };
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
