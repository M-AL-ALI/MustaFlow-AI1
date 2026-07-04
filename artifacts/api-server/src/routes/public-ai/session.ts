import { Router } from "express";
import type { Request, Response, NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { createHash } from "crypto";
import {
  createSession,
  createExhaustedSession,
  validateSession,
  setSessionCookie,
  MSG_LIMIT_VALUE,
  FILE_LIMIT_VALUE,
  IMAGE_LIMIT_VALUE,
  IMAGE_ANALYSIS_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { oraSessionLimiter } from "../../lib/rateLimit";
import { isE2ETestAuthEnabled } from "../../lib/auth";
import { logger } from "../../lib/logger";

const router = Router();

/** Skip the session-creation rate limiter for E2E benchmark runs or authenticated users. */
function sessionRateLimiter(req: Request, res: Response, next: NextFunction): void {
  if (isE2ETestAuthEnabled() && req.headers["x-e2e-test-user"]) {
    next();
    return;
  }
  // Authenticated users are metered by per-user rolling-window quotas in the
  // database — not the anonymous IP session-creation count. Skip the 10/day IP
  // cap so signed-in users (e.g. Core Pack) are never blocked by it.
  if (getAuth(req).userId) {
    next();
    return;
  }
  oraSessionLimiter(req, res, next);
}

/**
 * Returns a one-way 8-hex-char fingerprint of an IP for logging.
 * The full IP is never written to any log sink.
 */
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 8);
}

router.post("/public-ai/session", sessionRateLimiter, async (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";

  logger.info({ component: "ora-session", ipHash: hashIp(ip) }, "New Ora session created");

  const useExhausted = isE2ETestAuthEnabled() && req.headers["x-e2e-exhaust"] === "true";
  const { token, payload } = useExhausted ? createExhaustedSession() : createSession();
  setSessionCookie(res, token);

  // Signed-in users are metered by per-user rolling windows per tier; surface
  // current-window usage + reset time so the indicator is accurate from the
  // first paint. Anonymous visitors get the per-session cap.
  const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
  const authed = await resolveAuthedOraUser(req);
  if (authed) {
    const { getOraUsage } = await import("../../lib/public-ai/ora-usage");
    const usage = await getOraUsage(authed.userId, authed.tier);
    res.json({
      sessionId: payload.sessionId,
      msgCount: usage.messageCount,
      msgLimit: usage.messageLimit,
      imageCount: usage.imageCount,
      imageLimit: usage.imageLimit,
      resetsAt: usage.resetsAt,
      windowHours: usage.windowHours,
      tier: authed.tier,
      isPaid: authed.isPaid,
    });
    return;
  }

  res.json({
    sessionId: payload.sessionId,
    msgCount: 0,
    msgLimit: MSG_LIMIT_VALUE,
  });
});

router.get("/public-ai/session", async (req, res) => {
  const sessionToken = req.cookies?.["ora-session"] as string | undefined;
  if (!sessionToken) {
    res.status(401).json({ error: "No session cookie found" });
    return;
  }
  const session = validateSession(sessionToken);
  if (!session) {
    res.status(401).json({ error: "Session expired or invalid" });
    return;
  }

  const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
  const authed = await resolveAuthedOraUser(req);
  const usage = authed
    ? await (await import("../../lib/public-ai/ora-usage")).getOraUsage(authed.userId, authed.tier)
    : null;

  res.json({
    sessionId: session.sessionId,
    msgCount: usage ? usage.messageCount : session.msgCount,
    msgLimit: usage ? usage.messageLimit : MSG_LIMIT_VALUE,
    fileCount: session.fileCount,
    fileLimit: FILE_LIMIT_VALUE,
    imageCount: usage ? usage.imageCount : session.imageCount,
    imageLimit: usage ? usage.imageLimit : IMAGE_LIMIT_VALUE,
    imageAnalysisCount: session.imageAnalysisCount,
    imageAnalysisLimit: IMAGE_ANALYSIS_LIMIT_VALUE,
    ...(usage ? { resetsAt: usage.resetsAt, windowHours: usage.windowHours } : {}),
    ...(authed ? { tier: authed.tier, isPaid: authed.isPaid } : {}),
  });
});

/**
 * The signed-in user's current rolling-window Ora usage. This is the ONLY usage
 * signal the standalone Ora UI surfaces — it must NEVER read the AI Builder
 * credit wallet. Unlike GET /public-ai/session it does not require an
 * ora-session cookie, so the sidebar usage indicator works regardless of chat
 * session state. Returns 401 for anonymous callers (the sidebar hides itself).
 */
router.get("/public-ai/usage", async (req, res) => {
  const { resolveAuthedOraUser } = await import("../../lib/public-ai/authed-user");
  const authed = await resolveAuthedOraUser(req);
  if (!authed) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
  const { getOraUsage } = await import("../../lib/public-ai/ora-usage");
  const usage = await getOraUsage(authed.userId, authed.tier);
  res.json({
    messageCount: usage.messageCount,
    messageLimit: usage.messageLimit,
    imageCount: usage.imageCount,
    imageLimit: usage.imageLimit,
    resetsAt: usage.resetsAt,
    windowHours: usage.windowHours,
  });
});

export default router;
