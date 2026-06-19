import jwt from "jsonwebtoken";

const SESSION_EXPIRY_SECONDS = 30 * 60;
const FALLBACK_TOKEN_TTL_SECONDS = 60;
const MSG_LIMIT = 20;
const FILE_LIMIT = 3;
const IMAGE_LIMIT = 2;
const IMAGE_ANALYSIS_LIMIT = 2;

function getSecret(): string {
  const secret = process.env.ORA_SESSION_SECRET;
  if (!secret) {
    throw new Error("ORA_SESSION_SECRET is not set — Ora public-AI endpoints are unavailable");
  }
  return secret;
}

export function isOraSecretConfigured(): boolean {
  return Boolean(process.env.ORA_SESSION_SECRET);
}

export interface OraSessionPayload {
  sessionId: string;
  msgCount: number;
  fileCount: number;
  imageCount: number;
  imageAnalysisCount: number;
  createdAt: number;
  /**
   * Set to `true` by the streaming route when it pre-increments msgCount
   * before flushing SSE headers (the only window where Set-Cookie is possible).
   * Cleared by `acknowledgeStreamingIncrement` on a verified fallback retry,
   * preventing an anonymous-session double-count.
   */
  streamingPreIncremented?: true;
}

export function createSession(): { token: string; payload: OraSessionPayload } {
  const payload: OraSessionPayload = {
    sessionId: crypto.randomUUID(),
    msgCount: 0,
    fileCount: 0,
    imageCount: 0,
    imageAnalysisCount: 0,
    createdAt: Date.now(),
  };
  const token = jwt.sign(payload, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload };
}

/** E2E-only: creates a session already at the message limit so T49/T50 can test
 *  the upgrade CTA without burning 20 sequential chat calls to exhaust it. */
export function createExhaustedSession(): { token: string; payload: OraSessionPayload } {
  const payload: OraSessionPayload = {
    sessionId: crypto.randomUUID(),
    msgCount: MSG_LIMIT,
    fileCount: 0,
    imageCount: 0,
    imageAnalysisCount: 0,
    createdAt: Date.now(),
  };
  const token = jwt.sign(payload, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload };
}

export function validateSession(token: string): OraSessionPayload | null {
  try {
    const decoded = jwt.verify(token, getSecret()) as OraSessionPayload & {
      iat?: number;
      exp?: number;
    };
    return {
      sessionId: decoded.sessionId,
      msgCount: decoded.msgCount ?? 0,
      fileCount: decoded.fileCount ?? 0,
      imageCount: decoded.imageCount ?? 0,
      imageAnalysisCount: decoded.imageAnalysisCount ?? 0,
      createdAt: decoded.createdAt,
      ...(decoded.streamingPreIncremented ? { streamingPreIncremented: true as const } : {}),
    };
  } catch {
    return null;
  }
}

export function incrementMessageCount(session: OraSessionPayload): {
  token: string;
  payload: OraSessionPayload;
} {
  // Destructure out streamingPreIncremented so a stale flag from a prior
  // successful streaming turn is cleared in the new cookie. Without this,
  // every subsequent non-streaming /chat call would carry the flag forever.
  const { streamingPreIncremented: _, ...rest } = session;
  const updated: OraSessionPayload = { ...rest, msgCount: session.msgCount + 1 };
  const token = jwt.sign(updated, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload: updated };
}

/**
 * Used by the streaming route to pre-increment msgCount before `flushHeaders`
 * (the only window where a `Set-Cookie` header can be attached).
 * Sets `streamingPreIncremented: true` so the non-streaming /chat route knows
 * not to double-count on a verified fallback retry.
 */
export function markSessionAsPreIncremented(session: OraSessionPayload): {
  token: string;
  payload: OraSessionPayload;
} {
  const updated: OraSessionPayload = {
    ...session,
    msgCount: session.msgCount + 1,
    streamingPreIncremented: true,
  };
  const token = jwt.sign(updated, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload: updated };
}

/**
 * Used by the non-streaming /chat route when it detects a `streamingPreIncremented`
 * flag on the session together with a valid `streamFallbackToken`. The streaming
 * route already consumed one quota slot; this re-signs the JWT to clear the flag
 * without incrementing msgCount further.
 */
export function acknowledgeStreamingIncrement(session: OraSessionPayload): {
  token: string;
  payload: OraSessionPayload;
} {
  const { streamingPreIncremented: _, ...rest } = session;
  const updated: OraSessionPayload = rest;
  const token = jwt.sign(updated, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload: updated };
}

/**
 * Create a short-lived signed token that proves the streaming route emitted a
 * `stream_failed` event (pre-first-token failure) for the given session.
 *
 * This token is included in the SSE `stream_failed` error event so the client
 * can present it on the /chat fallback retry. The server verifies the signature
 * and `sessionId` match before honouring `acknowledgeStreamingIncrement`,
 * closing the client-forgery window that a plain boolean flag left open.
 *
 * The token is intentionally NOT stored server-side — single-use semantics are
 * enforced by clearing `streamingPreIncremented` from the session cookie on
 * the first valid redemption; subsequent requests with a stale cookie (flag
 * already cleared) fall through to `incrementMessageCount`.
 */
export function createStreamFallbackToken(session: OraSessionPayload): string {
  return jwt.sign({ sessionId: session.sessionId, type: "stream-fallback" }, getSecret(), {
    expiresIn: FALLBACK_TOKEN_TTL_SECONDS,
  });
}

/**
 * Returns true when `token` is a server-signed stream-fallback JWT that was
 * issued for the given session. Returns false on any verification failure
 * (wrong signature, expired, wrong session, missing type claim).
 */
export function verifyStreamFallbackToken(token: string, session: OraSessionPayload): boolean {
  try {
    const payload = jwt.verify(token, getSecret()) as {
      sessionId?: string;
      type?: string;
    };
    return payload.type === "stream-fallback" && payload.sessionId === session.sessionId;
  } catch {
    return false;
  }
}

export function incrementFileCount(session: OraSessionPayload): {
  token: string;
  payload: OraSessionPayload;
} {
  const updated: OraSessionPayload = { ...session, fileCount: session.fileCount + 1 };
  const token = jwt.sign(updated, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload: updated };
}

export function incrementImageCount(session: OraSessionPayload): {
  token: string;
  payload: OraSessionPayload;
} {
  const updated: OraSessionPayload = { ...session, imageCount: session.imageCount + 1 };
  const token = jwt.sign(updated, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload: updated };
}

export function incrementImageAnalysisCount(session: OraSessionPayload): {
  token: string;
  payload: OraSessionPayload;
} {
  const updated: OraSessionPayload = {
    ...session,
    imageAnalysisCount: session.imageAnalysisCount + 1,
  };
  const token = jwt.sign(updated, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload: updated };
}

export const MSG_LIMIT_VALUE = MSG_LIMIT;
export const FILE_LIMIT_VALUE = FILE_LIMIT;
export const IMAGE_LIMIT_VALUE = IMAGE_LIMIT;
export const IMAGE_ANALYSIS_LIMIT_VALUE = IMAGE_ANALYSIS_LIMIT;

export function setSessionCookie(res: import("express").Response, token: string): void {
  res.cookie("ora-session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/public-ai",
    maxAge: SESSION_EXPIRY_SECONDS * 1000,
    secure: process.env.NODE_ENV === "production",
  });
}
