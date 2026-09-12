import type { IncomingMessage } from "node:http";
import { clerkClient } from "@clerk/express";
import { parseMultiplayerProjectId } from "./multiplayer-admission";

export const MULTIPLAYER_AUTH_TIMEOUT_MS = 5_000;

/** Browser collaboration is same-origin; forwarded hosts are not an origin allowlist. */
function collaborationRequest(req: IncomingMessage): Request | null {
  if (req.method !== "GET") return null;
  const host = req.headers.host;
  const rawOrigin = req.headers.origin;
  if (!host || typeof rawOrigin !== "string" || /[\s,/@\\?#]/u.test(host)) return null;
  const forwardedProto = req.headers["x-forwarded-proto"];
  if (forwardedProto !== undefined && forwardedProto !== "http" && forwardedProto !== "https") {
    return null;
  }
  const encrypted = (req.socket as typeof req.socket & { encrypted?: boolean }).encrypted;
  const protocol = encrypted ? "https" : (forwardedProto ?? "http");
  const base = new URL(protocol + "://" + host);
  const origin = new URL(rawOrigin);
  if (rawOrigin !== origin.origin || origin.origin !== base.origin) return null;
  const rawPath = req.url ?? "";
  const pathMatch = rawPath.match(/^\/api\/projects\/(\d+)\/multiplayer(?:\?|$)/u);
  if (!pathMatch || parseMultiplayerProjectId(pathMatch[1]) === null) return null;
  const url = new URL(rawPath, base);
  if (!/^\/api\/projects\/\d+\/multiplayer$/u.test(url.pathname)) return null;
  // No identity or credential query parameter participates in authentication.
  url.search = "";
  url.hash = "";
  const headers = new Headers({
    host: base.host,
    origin: origin.origin,
    "x-forwarded-host": base.host,
    "x-forwarded-proto": protocol,
  });
  for (const name of [
    "cookie",
    "authorization",
    "user-agent",
    "sec-fetch-dest",
    "sec-fetch-mode",
    "sec-fetch-site",
  ]) {
    const value = req.headers[name];
    if (value !== undefined && typeof value !== "string") return null;
    if (value !== undefined) headers.set(name, value);
  }
  return new Request(url, { method: "GET", headers });
}

/** Verify with the configured Clerk client, never an uninitialized Express auth accessor. */
export async function authenticateMultiplayerUpgrade(req: IncomingMessage): Promise<string | null> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const request = collaborationRequest(req);
    if (!request) return null;
    const state = await Promise.race([
      clerkClient.authenticateRequest(request, {
        acceptsToken: "session_token",
        authorizedParties: [new URL(request.url).origin],
      }),
      new Promise<null>((resolve) => {
        timeout = setTimeout(() => resolve(null), MULTIPLAYER_AUTH_TIMEOUT_MS);
      }),
    ]);
    if (
      !state ||
      state.status !== "signed-in" ||
      !state.isAuthenticated ||
      state.tokenType !== "session_token" ||
      state.headers.has("location")
    )
      return null;
    const auth = state.toAuth({ treatPendingAsSignedOut: true });
    if (typeof auth.userId !== "string" || !auth.userId) return null;
    // Match the REST adapter's verified legacy identity mapping, not raw request fields.
    const legacyUserId = auth.sessionClaims?.["userId"];
    const userId = legacyUserId ?? auth.userId;
    return typeof userId === "string" && userId.trim().length > 0 ? userId : null;
  } catch {
    // Do not expose or log cookies, tokens, claims, or Clerk failure details.
    return null;
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}
