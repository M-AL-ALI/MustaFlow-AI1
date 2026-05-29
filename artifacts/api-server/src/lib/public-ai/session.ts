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
    };
  } catch {
    return null;
  }
}

export function incrementMessageCount(session: OraSessionPayload): {
  token: string;
  payload: OraSessionPayload;
} {
  const updated: OraSessionPayload = { ...session, msgCount: session.msgCount + 1 };
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
  });
}
