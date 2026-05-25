/**
 * Cookie-auth PAT management routes.
 * Mounted under the auth wall so users can manage their tokens from the web UI.
 *
 * Routes:
 *   GET    /me/tokens            — list caller's active tokens (masked)
 *   POST   /me/tokens            — create a new PAT; returns raw token once
 *   DELETE /me/tokens/:tokenId   — revoke a PAT
 */

import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, personalAccessTokensTable } from "@workspace/db";
import { generateRawToken, hashToken } from "../lib/pat-auth";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const TOKEN_PREFIX = "mfp_";
const VALID_SCOPES = [
  "projects:read",
  "projects:write",
  "builds:read",
  "builds:write",
  "files:read",
  "domains:read",
  "domains:write",
  "webhooks:read",
  "webhooks:write",
];

// ── GET /me/tokens ────────────────────────────────────────────────────────────
router.get("/me/tokens", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  try {
    const tokens = await db
      .select({
        id: personalAccessTokensTable.id,
        name: personalAccessTokensTable.name,
        tokenPreview: personalAccessTokensTable.tokenPreview,
        scopes: personalAccessTokensTable.scopes,
        projectId: personalAccessTokensTable.projectId,
        lastUsedAt: personalAccessTokensTable.lastUsedAt,
        expiresAt: personalAccessTokensTable.expiresAt,
        createdAt: personalAccessTokensTable.createdAt,
      })
      .from(personalAccessTokensTable)
      .where(
        and(
          eq(personalAccessTokensTable.userId, req.userId),
          eq(personalAccessTokensTable.active, true),
        ),
      )
      .orderBy(asc(personalAccessTokensTable.createdAt));
    res.json({ tokens });
  } catch (err) {
    logger.warn({ err }, "GET /me/tokens error");
    res.status(500).json({ error: "Failed to list tokens" });
  }
});

// ── POST /me/tokens ───────────────────────────────────────────────────────────
router.post("/me/tokens", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const { name, scopes, expiresInDays } = req.body as {
    name?: string;
    scopes?: string[];
    expiresInDays?: number;
  };

  if (!name || typeof name !== "string" || !name.trim()) {
    res.status(400).json({ error: "name is required." });
    return;
  }

  const resolvedScopes = Array.isArray(scopes)
    ? scopes.filter((s) => VALID_SCOPES.includes(s))
    : ["projects:read", "builds:read", "files:read", "domains:read", "domains:write"];

  if (resolvedScopes.length === 0) {
    res.status(400).json({ error: "At least one valid scope is required." });
    return;
  }

  // Max 20 active tokens per user
  const existing = await db
    .select({ id: personalAccessTokensTable.id })
    .from(personalAccessTokensTable)
    .where(
      and(
        eq(personalAccessTokensTable.userId, req.userId),
        eq(personalAccessTokensTable.active, true),
      ),
    );
  if (existing.length >= 20) {
    res.status(422).json({ error: "Maximum of 20 active tokens allowed. Revoke one first." });
    return;
  }

  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const tokenPreview = `${raw.slice(0, 10)}•••••••${raw.slice(-4)}`;

  const expiresAt =
    typeof expiresInDays === "number" && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 86_400_000)
      : null;

  try {
    const [created] = await db
      .insert(personalAccessTokensTable)
      .values({
        userId: req.userId,
        name: name.trim().slice(0, 100),
        tokenHash,
        tokenPreview,
        projectId: null,
        scopes: resolvedScopes,
        active: true,
        ...(expiresAt ? { expiresAt } : {}),
      })
      .returning({
        id: personalAccessTokensTable.id,
        name: personalAccessTokensTable.name,
        tokenPreview: personalAccessTokensTable.tokenPreview,
        scopes: personalAccessTokensTable.scopes,
        projectId: personalAccessTokensTable.projectId,
        expiresAt: personalAccessTokensTable.expiresAt,
        createdAt: personalAccessTokensTable.createdAt,
      });

    logger.info({ userId: req.userId, tokenId: created?.id }, "PAT created");

    res.status(201).json({
      token: created,
      rawToken: raw,
      note: "Store the raw token now — it will not be shown again.",
    });
  } catch (err) {
    logger.warn({ err }, "POST /me/tokens error");
    res.status(500).json({ error: "Failed to create token" });
  }
});

// ── DELETE /me/tokens/:tokenId ────────────────────────────────────────────────
router.delete("/me/tokens/:tokenId", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const tokenId = Number(req.params.tokenId);
  if (!Number.isFinite(tokenId)) {
    res.status(400).json({ error: "Invalid token id" });
    return;
  }

  try {
    const [existing] = await db
      .select({ id: personalAccessTokensTable.id, userId: personalAccessTokensTable.userId })
      .from(personalAccessTokensTable)
      .where(eq(personalAccessTokensTable.id, tokenId));

    if (!existing || existing.userId !== req.userId) {
      res.status(404).json({ error: "Token not found." });
      return;
    }

    await db
      .update(personalAccessTokensTable)
      .set({ active: false })
      .where(eq(personalAccessTokensTable.id, tokenId));

    logger.info({ userId: req.userId, tokenId }, "PAT revoked");

    res.json({ revoked: true });
  } catch (err) {
    logger.warn({ err }, "DELETE /me/tokens/:tokenId error");
    res.status(500).json({ error: "Failed to revoke token" });
  }
});

export default router;
