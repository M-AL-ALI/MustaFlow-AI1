// ─────────────────────────────────────────────────────────────────────────────
// Personal Access Token (PAT) management — session-authenticated
//
//   GET    /api/tokens          — list caller's active PATs (masked)
//   POST   /api/tokens          — create a new PAT (raw token shown once)
//   DELETE /api/tokens/:id      — revoke a PAT
// ─────────────────────────────────────────────────────────────────────────────

import { Router, type IRouter } from "express";
import { and, asc, eq } from "drizzle-orm";
import { randomBytes, createHash } from "crypto";
import { db, personalAccessTokensTable } from "@workspace/db";
import { logger } from "../lib/logger";

const router: IRouter = Router();

const TOKEN_PREFIX = "mfp_";
const VALID_SCOPES = ["domains:read", "domains:write", "webhooks:read", "webhooks:write"];

function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function generateRawToken(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

// ── GET /api/tokens ───────────────────────────────────────────────────────────
router.get("/tokens", async (req, res): Promise<void> => {
  const userId = req.userId!;

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
      and(eq(personalAccessTokensTable.userId, userId), eq(personalAccessTokensTable.active, true)),
    )
    .orderBy(asc(personalAccessTokensTable.createdAt));

  res.json({ tokens });
});

// ── POST /api/tokens ──────────────────────────────────────────────────────────
router.post("/tokens", async (req, res): Promise<void> => {
  const userId = req.userId!;
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
    : ["domains:read", "domains:write"];

  if (resolvedScopes.length === 0) {
    res.status(400).json({ error: "At least one valid scope is required." });
    return;
  }

  const raw = generateRawToken();
  const tokenHash = hashToken(raw);
  const tokenPreview = `${raw.slice(0, 10)}•••••${raw.slice(-4)}`;

  const expiresAt =
    typeof expiresInDays === "number" && expiresInDays > 0
      ? new Date(Date.now() + expiresInDays * 86_400_000)
      : null;

  try {
    const [created] = await db
      .insert(personalAccessTokensTable)
      .values({
        userId,
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
        expiresAt: personalAccessTokensTable.expiresAt,
        createdAt: personalAccessTokensTable.createdAt,
      });

    logger.info({ userId, tokenId: created?.id }, "PAT created");

    res.status(201).json({
      token: created,
      rawToken: raw,
    });
  } catch (err) {
    logger.error({ err, userId }, "Failed to create PAT");
    throw err;
  }
});

// ── DELETE /api/tokens/:id ────────────────────────────────────────────────────
router.delete("/tokens/:id", async (req, res): Promise<void> => {
  const userId = req.userId!;
  const tokenId = parseInt(req.params.id ?? "", 10);

  if (!Number.isFinite(tokenId)) {
    res.status(400).json({ error: "Invalid token id." });
    return;
  }

  const [existing] = await db
    .select({ id: personalAccessTokensTable.id, userId: personalAccessTokensTable.userId })
    .from(personalAccessTokensTable)
    .where(
      and(eq(personalAccessTokensTable.id, tokenId), eq(personalAccessTokensTable.active, true)),
    );

  if (!existing || existing.userId !== userId) {
    res.status(404).json({ error: "Token not found." });
    return;
  }

  await db
    .update(personalAccessTokensTable)
    .set({ active: false })
    .where(eq(personalAccessTokensTable.id, tokenId));

  logger.info({ userId, tokenId }, "PAT revoked");

  res.json({ revoked: true });
});

export default router;
