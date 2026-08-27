import { randomBytes, createHash } from "node:crypto";
import { Router } from "express";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { db, oraxDesktopAuthChallengesTable, oraxDesktopSessionsTable } from "@workspace/db";
import { encryptionService } from "../lib/encryption";
import { getSharedAccountProfile } from "../lib/clerk-users";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DESKTOP_TOKEN_PREFIX = "oraxdt_";

const startSchema = z.object({
  deviceName: z.string().trim().min(1).max(120).optional(),
  platform: z.string().trim().min(1).max(40).optional(),
  appVersion: z.string().trim().min(1).max(40).optional(),
  installId: z.string().trim().min(1).max(160).optional(),
  metadata: z.object({}).passthrough().optional(),
});

const completeSchema = z.object({
  challengeId: z.string().trim().min(1),
  userCode: z.string().trim().min(4).max(16),
  decision: z.enum(["approve", "deny"]).optional().default("approve"),
});

export const oraxDesktopAuthPublicRouter = Router();
export const oraxDesktopAuthRouter = Router();

export function hashOraxDesktopToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function createSecret(prefix = ""): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function createUserCode(): string {
  return randomBytes(4).toString("hex").slice(0, 6).toUpperCase();
}

function normalizeCode(code: string): string {
  return code
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

function buildVerificationUrl(
  req: { protocol: string; get(name: string): string | undefined },
  challengeId: string,
  userCode: string,
): string {
  const base =
    process.env.ORAX_WEB_BASE_URL ??
    process.env.WEB_BASE_URL ??
    process.env.MUSTAFLOW_WEB_URL ??
    `${req.protocol}://${req.get("host") ?? "www.mustaflow.com"}`;
  const url = new URL("/orax/desktop-auth/approve", base);
  url.searchParams.set("challengeId", challengeId);
  url.searchParams.set("userCode", userCode);
  return url.toString();
}

function publicSession(
  session: { userId: string; expiresAt: Date },
  token: string,
  identity: NonNullable<Awaited<ReturnType<typeof getSharedAccountProfile>>>,
) {
  return {
    userId: session.userId,
    email: identity.email ?? "",
    displayName: identity.displayName,
    imageUrl: identity.imageUrl,
    token,
    expiresAt: session.expiresAt.toISOString(),
  };
}

oraxDesktopAuthPublicRouter.post("/orax/desktop-auth/start", async (req, res) => {
  const parsed = startSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid desktop auth payload" });
    return;
  }

  const pollToken = createSecret();
  const userCode = createUserCode();
  const expiresAt = new Date(Date.now() + CHALLENGE_TTL_MS);

  const [challenge] = await db
    .insert(oraxDesktopAuthChallengesTable)
    .values({
      status: "pending",
      userCode,
      pollTokenHash: hashOraxDesktopToken(pollToken),
      deviceName: parsed.data.deviceName ?? null,
      platform: parsed.data.platform ?? null,
      appVersion: parsed.data.appVersion ?? null,
      installId: parsed.data.installId ?? null,
      expiresAt,
    })
    .returning({
      id: oraxDesktopAuthChallengesTable.id,
      userCode: oraxDesktopAuthChallengesTable.userCode,
      expiresAt: oraxDesktopAuthChallengesTable.expiresAt,
    });

  res.json({
    challengeId: challenge.id,
    pollToken,
    userCode: challenge.userCode,
    expiresAt: challenge.expiresAt.toISOString(),
    verificationUrl: buildVerificationUrl(req, challenge.id, challenge.userCode),
  });
});

oraxDesktopAuthPublicRouter.get("/orax/desktop-auth/status/:challengeId", async (req, res) => {
  const challengeId = String(req.params.challengeId ?? "");
  const pollToken = typeof req.query.pollToken === "string" ? req.query.pollToken : "";
  if (!challengeId || !pollToken) {
    res.status(400).json({ error: "Missing challenge or poll token" });
    return;
  }

  const [challenge] = await db
    .select()
    .from(oraxDesktopAuthChallengesTable)
    .where(eq(oraxDesktopAuthChallengesTable.id, challengeId));

  if (!challenge || challenge.pollTokenHash !== hashOraxDesktopToken(pollToken)) {
    res.status(404).json({ error: "Desktop sign-in challenge not found" });
    return;
  }

  if (challenge.status === "pending" && challenge.expiresAt.getTime() <= Date.now()) {
    await db
      .update(oraxDesktopAuthChallengesTable)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(oraxDesktopAuthChallengesTable.id, challenge.id));
    res.json({ status: "expired" });
    return;
  }

  if (challenge.status !== "approved") {
    res.json({ status: challenge.status });
    return;
  }

  if (!challenge.sessionId || !challenge.sessionTokenCiphertext || challenge.redeemedAt) {
    res.json({ status: "approved", redeemed: true });
    return;
  }

  const [session] = await db
    .select()
    .from(oraxDesktopSessionsTable)
    .where(eq(oraxDesktopSessionsTable.id, challenge.sessionId));

  if (!session || session.revokedAt || session.expiresAt.getTime() <= Date.now()) {
    res.json({ status: "expired" });
    return;
  }

  const identity = await getSharedAccountProfile(session.userId);
  if (!identity) {
    res.status(503).json({
      status: "approved",
      error: "Your shared account profile is temporarily unavailable.",
      code: "shared_profile_unavailable",
    });
    return;
  }

  const token = encryptionService.decrypt(challenge.sessionTokenCiphertext);
  await db
    .update(oraxDesktopAuthChallengesTable)
    .set({
      redeemedAt: new Date(),
      sessionTokenCiphertext: null,
      updatedAt: new Date(),
    })
    .where(eq(oraxDesktopAuthChallengesTable.id, challenge.id));

  res.json({
    status: "approved",
    session: publicSession(session, token, identity),
  });
});

oraxDesktopAuthRouter.post("/orax/desktop-auth/complete", async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: "Unauthenticated" });
    return;
  }

  const parsed = completeSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid desktop auth completion payload" });
    return;
  }

  const [challenge] = await db
    .select()
    .from(oraxDesktopAuthChallengesTable)
    .where(eq(oraxDesktopAuthChallengesTable.id, parsed.data.challengeId));

  if (!challenge || normalizeCode(challenge.userCode) !== normalizeCode(parsed.data.userCode)) {
    res.status(404).json({ error: "Desktop sign-in challenge not found" });
    return;
  }

  if (challenge.status !== "pending") {
    res.status(409).json({ error: "Desktop sign-in challenge is no longer pending" });
    return;
  }

  if (challenge.expiresAt.getTime() <= Date.now()) {
    await db
      .update(oraxDesktopAuthChallengesTable)
      .set({ status: "expired", updatedAt: new Date() })
      .where(eq(oraxDesktopAuthChallengesTable.id, challenge.id));
    res.status(410).json({ error: "Desktop sign-in challenge expired" });
    return;
  }

  if (parsed.data.decision === "deny") {
    await db
      .update(oraxDesktopAuthChallengesTable)
      .set({
        userId: req.userId,
        status: "denied",
        deniedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(oraxDesktopAuthChallengesTable.id, challenge.id));
    res.json({ status: "denied" });
    return;
  }

  const rawToken = createSecret(DESKTOP_TOKEN_PREFIX);
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
  const [session] = await db
    .insert(oraxDesktopSessionsTable)
    .values({
      userId: req.userId,
      tokenHash: hashOraxDesktopToken(rawToken),
      challengeId: challenge.id,
      installId: challenge.installId,
      deviceName: challenge.deviceName,
      platform: challenge.platform,
      appVersion: challenge.appVersion,
      expiresAt,
    })
    .returning({
      id: oraxDesktopSessionsTable.id,
      expiresAt: oraxDesktopSessionsTable.expiresAt,
    });

  await db
    .update(oraxDesktopAuthChallengesTable)
    .set({
      userId: req.userId,
      status: "approved",
      sessionId: session.id,
      sessionTokenCiphertext: encryptionService.encrypt(rawToken),
      approvedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(oraxDesktopAuthChallengesTable.id, challenge.id));

  res.json({ status: "approved", expiresAt: session.expiresAt.toISOString() });
});
