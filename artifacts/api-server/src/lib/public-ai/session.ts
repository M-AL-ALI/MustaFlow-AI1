import jwt from "jsonwebtoken";

const SESSION_EXPIRY_SECONDS = 30 * 60;
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
   * Cleared (and msgCount left unchanged) by the non-streaming /chat route on
   * a fallback retry, preventing an anonymous-session double-count.
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
 * not to double-count on a fallback retry.
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
 * flag on the session. The streaming route already consumed one quota slot; this
 * re-signs the JWT to clear the flag without incrementing msgCount further.
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
