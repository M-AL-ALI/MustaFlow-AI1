// ─────────────────────────────────────────────────────────────────────────────
// Credits — GET /api/credits, GET /api/credits/transactions
//
// Provides current user credit balance and transaction history.
// Credits are auto-provisioned on first access (100 starter credits).
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { desc, eq, sql } from "drizzle-orm";
import { db, userCreditsTable, creditTransactionsTable } from "@workspace/db";

const router: IRouter = Router();

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
    type: "build" | "refine" | "plan" | "architect";
    description: string;
  },
): Promise<{ newBalance: number } | { insufficient: true; balance: number }> {
  const credits = await getOrCreateCredits(userId);

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
