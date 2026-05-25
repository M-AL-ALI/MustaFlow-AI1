/**
 * Cookie-auth PAT management routes.
 * Mounted under the auth wall so users can manage their tokens from the web UI.
 *
 * Routes:
 *   GET    /tokens  (+ /me/tokens)            — list caller's active tokens
 *   POST   /tokens  (+ /me/tokens)            — create a new PAT; returns raw token once
 *   GET    /tokens/:id/test                   — validate a token is still active / not expired
 *   POST   /tokens/:id/rotate (+ /me/…)       — rotate a PAT; new secret, same id/name/scopes
 *   DELETE /tokens/:id (+ /me/tokens/:id)     — revoke a PAT
 */

import { Router, type RequestHandler } from "express";
import { and, asc, eq } from "drizzle-orm";
import { db, personalAccessTokensTable } from "@workspace/db";
import { generateRawToken, hashToken } from "../lib/pat-auth";
import { logger } from "../lib/logger";

const router = Router();

const VALID_SCOPES = [
  "projects:read",
  "projects:write",
  "builds:read",
  "builds:trigger",
  "builds:write",
  "files:read",
  "files:write",
  "domains:read",
  "domains:write",
  "webhooks:read",
  "webhooks:write",
];

// ── GET /tokens (also /me/tokens) ─────────────────────────────────────────────
const listTokens: RequestHandler = async (req, res): Promise<void> => {
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
        rotatedAt: personalAccessTokensTable.rotatedAt,
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
    logger.warn({ err }, "GET /tokens error");
    res.status(500).json({ error: "Failed to list tokens" });
  }
};

router.get("/tokens", listTokens);
router.get("/me/tokens", listTokens);

// ── POST /tokens (also /me/tokens) ────────────────────────────────────────────
const createToken: RequestHandler = async (req, res): Promise<void> => {
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
    logger.warn({ err }, "POST /tokens error");
    res.status(500).json({ error: "Failed to create token" });
  }
};

router.post("/tokens", createToken);
router.post("/me/tokens", createToken);

// ── GET /tokens/:id/test ───────────────────────────────────────────────────────
router.get("/tokens/:id/test", async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ ok: false, reason: "Unauthenticated" });
    return;
  }
  const tokenId = parseInt(req.params.id ?? "", 10);

  if (!Number.isFinite(tokenId)) {
    res.status(400).json({ ok: false, reason: "Invalid token id." });
    return;
  }

  const [token] = await db
    .select({
      id: personalAccessTokensTable.id,
      userId: personalAccessTokensTable.userId,
      active: personalAccessTokensTable.active,
      scopes: personalAccessTokensTable.scopes,
      expiresAt: personalAccessTokensTable.expiresAt,
    })
    .from(personalAccessTokensTable)
    .where(eq(personalAccessTokensTable.id, tokenId));

  if (!token || token.userId !== req.userId) {
    res.status(404).json({ ok: false, reason: "Token not found." });
    return;
  }

  if (!token.active) {
    res.json({ ok: false, reason: "Token has been revoked." });
    return;
  }

  if (token.expiresAt && new Date(token.expiresAt) < new Date()) {
    res.json({ ok: false, reason: "Token has expired." });
    return;
  }

  res.json({ ok: true, scopes: token.scopes ?? [] });
});

// ── POST /tokens/:id/rotate (also /me/tokens/:id/rotate) ──────────────────────
const rotateToken: RequestHandler<{ id: string }> = async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const tokenId = Number(req.params.id);
  if (!Number.isFinite(tokenId)) {
    res.status(400).json({ error: "Invalid token id" });
    return;
  }

  try {
    const [existing] = await db
      .select({
        id: personalAccessTokensTable.id,
        userId: personalAccessTokensTable.userId,
        active: personalAccessTokensTable.active,
      })
      .from(personalAccessTokensTable)
      .where(eq(personalAccessTokensTable.id, tokenId));

    if (!existing || existing.userId !== req.userId) {
      res.status(404).json({ error: "Token not found." });
      return;
    }
    if (!existing.active) {
      res.status(422).json({ error: "Cannot rotate a revoked token." });
      return;
    }

    const raw = generateRawToken();
    const tokenHash = hashToken(raw);
    const tokenPreview = `${raw.slice(0, 10)}•••••••${raw.slice(-4)}`;
    const rotatedAt = new Date();

    const [updated] = await db
      .update(personalAccessTokensTable)
      .set({ tokenHash, tokenPreview, rotatedAt })
      .where(eq(personalAccessTokensTable.id, tokenId))
      .returning({
        id: personalAccessTokensTable.id,
        name: personalAccessTokensTable.name,
        tokenPreview: personalAccessTokensTable.tokenPreview,
        scopes: personalAccessTokensTable.scopes,
        projectId: personalAccessTokensTable.projectId,
        expiresAt: personalAccessTokensTable.expiresAt,
        rotatedAt: personalAccessTokensTable.rotatedAt,
        createdAt: personalAccessTokensTable.createdAt,
      });

    logger.info({ userId: req.userId, tokenId }, "PAT rotated");

    res.json({
      token: updated,
      rawToken: raw,
      note: "Store the raw token now — it will not be shown again.",
    });
  } catch (err) {
    logger.warn({ err }, "POST /tokens/:id/rotate error");
    res.status(500).json({ error: "Failed to rotate token" });
  }
};

router.post("/tokens/:id/rotate", rotateToken);
router.post("/me/tokens/:id/rotate", rotateToken);

// ── DELETE /tokens/:id (also /me/tokens/:id) ──────────────────────────────────
const revokeToken: RequestHandler<{ id: string }> = async (req, res): Promise<void> => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }
  const tokenId = parseInt(req.params.id ?? "", 10);
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
    logger.warn({ err }, "DELETE /tokens/:id error");
    res.status(500).json({ error: "Failed to revoke token" });
  }
};

router.delete("/tokens/:id", revokeToken);
router.delete("/me/tokens/:id", revokeToken);

export default router;
