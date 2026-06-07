import { Router } from "express";
import { createHash } from "crypto";
import {
  createSession,
  validateSession,
  setSessionCookie,
  MSG_LIMIT_VALUE,
  FILE_LIMIT_VALUE,
  IMAGE_LIMIT_VALUE,
  IMAGE_ANALYSIS_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { oraSessionLimiter } from "../../lib/rateLimit";
import { resolveAuthedOraUser } from "../../lib/public-ai/authed-user";
import { getOraUsage } from "../../lib/public-ai/ora-usage";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * Returns a one-way 8-hex-char fingerprint of an IP for logging.
 * The full IP is never written to any log sink.
 */
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 8);
}

router.post("/public-ai/session", oraSessionLimiter, async (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";

  logger.info({ component: "ora-session", ipHash: hashIp(ip) }, "New Ora session created");

  const { token, payload } = createSession();
  setSessionCookie(res, token);

  // Signed-in users are metered by per-user rolling windows per tier; surface
  // current-window usage + reset time so the indicator is accurate from the
  // first paint. Anonymous visitors get the per-session cap.
  const authed = await resolveAuthedOraUser(req);
  if (authed) {
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

  const authed = await resolveAuthedOraUser(req);
  const usage = authed ? await getOraUsage(authed.userId, authed.tier) : null;

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
  const authed = await resolveAuthedOraUser(req);
  if (!authed) {
    res.status(401).json({ error: "Not signed in" });
    return;
  }
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
