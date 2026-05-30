// ─────────────────────────────────────────────────────────────────────────────
// Phase 8B-2: POST /vault/search/semantic
//
// Auth-gated. Enforces per-user ownership throughout.
// Rate-limited to 30 searches per hour per user.
// No RAG, no AI answer generation, no prompt injection.
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { z } from "zod";
import { semanticSearchVault } from "../lib/vault-search-service";

const router: IRouter = Router();

const HOURLY_LIMIT = 30;

const semanticSearchSchema = z.object({
  query: z.string().trim().min(1, "Query is required").max(1000),
  limit: z.number().int().min(1).max(30).optional(),
  category: z.string().trim().max(100).optional(),
  department: z.string().trim().max(200).optional(),
  tags: z.array(z.string().trim().max(100)).max(20).optional(),
  status: z.enum(["draft", "approved"]).optional(),
  includeArchived: z.boolean().optional(),
});

router.post("/vault/search/semantic", async (req, res): Promise<void> => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return;
  }

  const parsed = semanticSearchSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid request", detail: parsed.error.flatten() });
    return;
  }

  const result = await semanticSearchVault(parsed.data, userId);

  if (result.rateLimited) {
    res
      .status(429)
      .set("X-RateLimit-Limit", String(HOURLY_LIMIT))
      .set("X-RateLimit-Remaining", "0")
      .json({
        error: `Semantic search rate limit exceeded. Maximum ${HOURLY_LIMIT} searches per hour.`,
        retryAfter: result.retryAfterSec,
      });
    return;
  }

  res.json(result);
});

export default router;
