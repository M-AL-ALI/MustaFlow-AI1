import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const PREVIEW_SESSION_COOKIE_NAME = "__prs";
export const PREVIEW_SHARE_DURATION_MS = 8 * 60 * 60 * 1000;

function sessionSecret(environment: Record<string, string | undefined>): string {
  const secret = environment.ENCRYPTION_KEY;
  if (!secret) throw new Error("ENCRYPTION_KEY env var is not set");
  return secret;
}

function hmacSign(value: string, environment: Record<string, string | undefined>): string {
  return createHmac("sha256", sessionSecret(environment)).update(value).digest("hex");
}

function hmacVerify(
  value: string,
  expected: string,
  environment: Record<string, string | undefined>,
): boolean {
  const actual = Buffer.from(hmacSign(value, environment), "hex");
  const supplied = Buffer.from(expected, "hex");
  return actual.length === supplied.length && timingSafeEqual(actual, supplied);
}

export function hashPreviewLaunchToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generatePreviewSessionId(): string {
  return randomBytes(8).toString("hex");
}

export function generatePreviewLaunchToken(): string {
  return randomBytes(32).toString("hex");
}

export function buildPreviewSessionCookie(
  sessionId: string,
  environment: Record<string, string | undefined> = process.env,
): string {
  const signature = hmacSign(`preview:${sessionId}`, environment);
  return `${PREVIEW_SESSION_COOKIE_NAME}=${sessionId}.${signature}; HttpOnly; Secure; SameSite=None; Max-Age=${PREVIEW_SHARE_DURATION_MS / 1000}; Path=/`;
}

export function parsePreviewSessionCookie(
  cookieHeader: string | undefined,
  environment: Record<string, string | undefined> = process.env,
): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp(`(?:^|;)\\s*${PREVIEW_SESSION_COOKIE_NAME}=([^;]+)`));
  const raw = match?.[1]?.trim();
  if (!raw) return null;
  const separator = raw.indexOf(".");
  if (separator < 1) return null;
  const sessionId = raw.slice(0, separator);
  const signature = raw.slice(separator + 1);
  if (!/^[0-9a-f]{16}$/.test(sessionId) || !/^[0-9a-f]{64}$/.test(signature)) return null;
  return hmacVerify(`preview:${sessionId}`, signature, environment) ? sessionId : null;
}

export function secretsMatchConstantTime(
  expected: string | undefined,
  supplied: string | undefined,
): boolean {
  if (!expected || !supplied) return false;
  const expectedDigest = createHash("sha256").update(expected).digest();
  const suppliedDigest = createHash("sha256").update(supplied).digest();
  return timingSafeEqual(expectedDigest, suppliedDigest);
}
