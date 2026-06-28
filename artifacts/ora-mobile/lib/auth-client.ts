export type AuthTokenGetter = () => Promise<string | null> | string | null;

let _baseUrl: string | null = null;
let _authTokenGetter: AuthTokenGetter | null = null;
let _authIsSignedIn = false;
let _authIsLoaded = false;

export function setBaseUrl(url: string | null): void {
  _baseUrl = url ? url.replace(/\/+$/, "") : null;
}

export function getBaseUrl(): string | null {
  return _baseUrl;
}

export function setAuthTokenGetter(getter: AuthTokenGetter | null): void {
  _authTokenGetter = getter;
}

/**
 * Sync Clerk's isLoaded/isSignedIn into the module-level auth guard so that
 * requireAuthToken() can fail closed when the user is signed in but a token
 * cannot be obtained. Call from the root layout's useEffect whenever isLoaded
 * or isSignedIn changes.
 */
export function setAuthState(isLoaded: boolean, isSignedIn: boolean): void {
  _authIsLoaded = isLoaded;
  _authIsSignedIn = isSignedIn;
}

export function getAuthState(): { isLoaded: boolean; isSignedIn: boolean } {
  return { isLoaded: _authIsLoaded, isSignedIn: _authIsSignedIn };
}

export async function getAuthToken(): Promise<string | null> {
  if (!_authTokenGetter) return null;
  try {
    return await _authTokenGetter();
  } catch {
    return null;
  }
}

/**
 * Thrown when the user is signed in locally (isSignedIn=true) but a Clerk
 * bearer token cannot be obtained after one retry. Callers must surface a
 * "Re-sync sign-in" prompt rather than silently downgrading to anonymous mode.
 */
export class TokenUnavailableError extends Error {
  constructor() {
    super(
      "Your session token is temporarily unavailable. Please sign in again to re-sync your account.",
    );
    this.name = "TokenUnavailableError";
  }
}

/**
 * Use in place of getAuthToken() for any API call that MUST NOT silently
 * downgrade to anonymous mode while the user believes they are signed in.
 *
 * - isSignedIn=false → returns null (anonymous requests remain allowed).
 * - isSignedIn=true, token available → returns the bearer token.
 * - isSignedIn=true, token null after one retry → throws TokenUnavailableError.
 */
export async function requireAuthToken(): Promise<string | null> {
  if (!_authIsSignedIn) return null;
  const first = await getAuthToken();
  if (first) return first;
  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  const second = await getAuthToken();
  if (second) return second;
  throw new TokenUnavailableError();
}
