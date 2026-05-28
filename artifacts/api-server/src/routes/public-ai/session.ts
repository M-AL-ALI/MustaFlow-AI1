import { Router } from "express";
import { createHash } from "crypto";
import {
  createSession,
  validateSession,
  setSessionCookie,
  MSG_LIMIT_VALUE,
} from "../../lib/public-ai/session";
import { oraSessionLimiter } from "../../lib/rateLimit";
import { logger } from "../../lib/logger";

const router = Router();

/**
 * Returns a one-way 8-hex-char fingerprint of an IP for logging.
 * The full IP is never written to any log sink.
 */
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 8);
}

router.post("/public-ai/session", oraSessionLimiter, (req, res) => {
  const ip =
    (req.headers["x-forwarded-for"] as string)?.split(",")[0]?.trim() ??
    req.socket.remoteAddress ??
    "unknown";

  logger.info({ component: "ora-session", ipHash: hashIp(ip) }, "New Ora session created");

  const { token, payload } = createSession();
  setSessionCookie(res, token);
  res.json({
    sessionId: payload.sessionId,
    msgCount: 0,
    msgLimit: MSG_LIMIT_VALUE,
  });
});

router.get("/public-ai/session", (req, res) => {
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
  res.json({
    sessionId: session.sessionId,
    msgCount: session.msgCount,
    msgLimit: MSG_LIMIT_VALUE,
  });
});

export default router;
