import jwt from "jsonwebtoken";
import { logger } from "../logger";

const SESSION_EXPIRY_SECONDS = 30 * 60;
const MSG_LIMIT = 20;

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
  createdAt: number;
}

export function createSession(): { token: string; payload: OraSessionPayload } {
  const payload: OraSessionPayload = {
    sessionId: crypto.randomUUID(),
    msgCount: 0,
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
      createdAt: decoded.createdAt,
    };
  } catch {
    return null;
  }
}

export function incrementMessageCount(session: OraSessionPayload): {
  token: string;
  payload: OraSessionPayload;
} {
  const updated: OraSessionPayload = {
    ...session,
    msgCount: session.msgCount + 1,
  };
  const token = jwt.sign(updated, getSecret(), { expiresIn: SESSION_EXPIRY_SECONDS });
  return { token, payload: updated };
}

export const MSG_LIMIT_VALUE = MSG_LIMIT;

export function setSessionCookie(res: import("express").Response, token: string): void {
  res.cookie("ora-session", token, {
    httpOnly: true,
    sameSite: "lax",
    path: "/api/public-ai",
    maxAge: SESSION_EXPIRY_SECONDS * 1000,
  });
}
