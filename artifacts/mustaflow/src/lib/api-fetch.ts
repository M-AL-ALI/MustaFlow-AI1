import { getAuthToken } from "@workspace/api-client-react";

/**
 * authFetch — drop-in wrapper around the native `fetch` for same-origin `/api`
 * calls that bypass the generated Orval hooks (e.g. file downloads, streaming,
 * one-off mutations, Promise.all batches).
 *
 * Why this exists: Clerk dev-mode session JWTs expire every ~60 s and the
 * session cookie is not always refreshed in time inside the embedded preview
 * iframe (cross-site cookie context). Requests that rely on the cookie alone
 * then fail intermittently with 401 "Session expired". This wrapper attaches a
 * freshly-minted `Authorization: Bearer <token>` header (via Clerk's
 * getToken()) so auth no longer depends on the cookie being current. It also
 * always sets `credentials: "include"` so the cookie path keeps working as a
 * fallback (and in E2E mode where no token getter is registered).
 *
 * Use this instead of calling `fetch("/api/...")` directly.
 */
export async function authFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});

  // Only attach the bearer token to same-origin requests. This prevents an
  // accidental absolute third-party URL from ever leaking the session token.
  if (isSameOrigin(input) && !headers.has("authorization")) {
    const token = await getAuthToken();
    if (token) headers.set("Authorization", `Bearer ${token}`);
  }

  return fetch(input, {
    ...init,
    // After the spread so callers can never accidentally drop the cookie path.
    credentials: "include",
    headers,
  });
}

function isSameOrigin(url: string): boolean {
  // Resolve against the current document so relative paths ("/api/...",
  // "api/...", "./...") are correctly classified, while absolute and
  // protocol-relative ("//host/...") URLs resolve to their real origin and are
  // rejected when cross-origin. Non-http(s) schemes (data:, javascript:, blob:)
  // resolve to a non-matching origin and so never receive the token.
  try {
    return new URL(url, window.location.href).origin === window.location.origin;
  } catch {
    return false;
  }
}
