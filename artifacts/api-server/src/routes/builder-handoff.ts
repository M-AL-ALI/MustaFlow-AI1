// ─────────────────────────────────────────────────────────────────────────────
// Phase 6 — POST /api/builder/handoff/exchange
//
// PROTECTED route (requires Clerk auth via attachUser middleware).
// Exchanges an opaque handoff token for the sanitized summary JSON.
// Token is consumed (single-use) on first successful exchange.
//
// Does NOT create a project automatically — the user reviews / edits the
// pre-filled idea and clicks Build manually (correction #8).
//
// Imports ONLY from handoff-store. No billing / credits / projects / secrets /
// users / Builder modules are imported here.
// ─────────────────────────────────────────────────────────────────────────────

import { Router } from "express";
import crypto from "crypto";
import { z } from "zod";
import { logger } from "../lib/logger";
import { exchangeHandoff } from "../lib/public-ai/handoff-store";

const router = Router();

const bodySchema = z.object({
  token: z.string().uuid(),
});

router.post("/builder/handoff/exchange", async (req, res) => {
  // Auth wall — req.userId set by attachUser middleware before this router
  if (!req.userId) {
    res.status(401).json({ error: "Authentication required." });
    return;
  }

  const parsed = bodySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid token format." });
    return;
  }

  const start = Date.now();
  const result = exchangeHandoff(parsed.data.token);
  const latencyMs = Date.now() - start;

  // Hashed identifiers only — never log raw token or userId (correction #9)
  const tokenHash = crypto
    .createHash("sha256")
    .update(parsed.data.token)
    .digest("hex")
    .slice(0, 16);
  const userIdHash = crypto.createHash("sha256").update(req.userId).digest("hex").slice(0, 16);

  if (!result.ok) {
    logger.info(
      {
        event: "handoff_exchange_failed",
        tokenHash,
        userIdHash,
        reason: result.reason,
        latencyMs,
      },
      "ora handoff exchange failed",
    );
    res.status(result.status).json({ error: result.error });
    return;
  }

  logger.info(
    {
      event: "handoff_exchanged",
      tokenHash,
      userIdHash,
      consumed: true,
      latencyMs,
    },
    "ora handoff token exchanged",
  );

  // Return summary only — no project is created here (correction #8)
  res.json(result.summary);
});

export default router;
