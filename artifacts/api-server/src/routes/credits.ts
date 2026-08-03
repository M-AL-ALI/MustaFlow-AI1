// ─────────────────────────────────────────────────────────────────────────────
// Credits — GET /api/credits, GET /api/credits/transactions
//
// Express route handlers only. All business logic lives in lib/credits.ts so
// lib/jobs.ts and other lib modules can import it without pulling in Express.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import {
  CREDITS_ENFORCEMENT_ENABLED,
  CreditDeductionResult,
  deductCredits,
  deductCreditsAtomic,
  getOrCreateCredits,
  getCreditTransactions,
  grantCredits,
  refundCredits,
} from "../lib/credits";

// Re-export so existing callers that import from routes/credits keep working.
export {
  CREDITS_ENFORCEMENT_ENABLED,
  deductCredits,
  deductCreditsAtomic,
  getOrCreateCredits,
  grantCredits,
  refundCredits,
};
export type { CreditDeductionResult };

const router: IRouter = Router();

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

  const rows = await getCreditTransactions(userId);
  res.json({ transactions: rows });
});

export default router;
