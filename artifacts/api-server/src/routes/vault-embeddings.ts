import { Router, type IRouter } from "express";
import {
  getEmbeddingStatus,
  reindexVaultEntry,
  reindexAllVaultEntries,
} from "../lib/vault-embedding-service";

const router: IRouter = Router();

// ── GET /vault/:id/embedding-status ──────────────────────────────────────────
router.get("/vault/:id/embedding-status", async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const entryId = parseInt(req.params.id ?? "", 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }
  const status = await getEmbeddingStatus(entryId, userId);
  res.json(status);
});

// ── POST /vault/reindex — reindex ALL user entries (must be before /:id) ─────
router.post("/vault/reindex", async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const result = await reindexAllVaultEntries(userId);
  if (result.rateLimited) {
    res.status(429).json({
      error: "Rate limit exceeded. Maximum 5 full reindex operations per hour.",
      retryAfterSec: result.retryAfterSec,
    });
    return;
  }
  res.json(result);
});

// ── POST /vault/:id/reindex — reindex a single entry ─────────────────────────
router.post("/vault/:id/reindex", async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const entryId = parseInt(req.params.id ?? "", 10);
  if (isNaN(entryId)) {
    res.status(400).json({ error: "Invalid entry id" });
    return;
  }
  const result = await reindexVaultEntry(entryId, userId);
  if (result.error) {
    res.status(400).json({ error: result.error });
    return;
  }
  const statusResult = await getEmbeddingStatus(entryId, userId);
  res.json(statusResult);
});

export default router;
