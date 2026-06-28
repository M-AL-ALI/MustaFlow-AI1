import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel: string) => readFileSync(path.join(__dirname, rel), "utf8");

describe("Mobile Settings — Account sync wiring", () => {
  const api = read("../api.ts");
  const settings = read("../../app/(home)/settings.tsx");

  it("exposes getAccountConsistency() pointing at the protected endpoint", () => {
    expect(api).toContain("export function getAccountConsistency()");
    expect(api).toContain('"/api/ora/account-consistency"');
    expect(api).toContain("OraAccountConsistency");
  });

  it("renders an Account sync section that runs the check", () => {
    expect(settings).toContain("getAccountConsistency");
    expect(settings).toContain('title="Account sync"');
    expect(settings).toContain("Check account sync");
  });

  it("renders the user fingerprint, plan, and per-user counts", () => {
    expect(settings).toContain("acctDiag.identity.userIdHash");
    expect(settings).toContain("acctDiag.identity.clerkUserIdLast4");
    expect(settings).toContain("acctDiag.billing.billingTier");
    expect(settings).toContain("acctDiag.chatSession.tier");
    expect(settings).toContain("acctDiag.counts.conversations");
    expect(settings).toContain("acctDiag.counts.projects");
    expect(settings).toContain("acctDiag.counts.userLevelMemories");
    expect(settings).toContain("acctDiag.counts.projectMemories");
    expect(settings).toContain("acctDiag.counts.assets");
    expect(settings).toContain("acctDiag.counts.supportTickets");
    expect(settings).toContain("acctDiag.api.host");
    expect(settings).toContain("acctDiag.api.environment");
  });

  it("shows red warnings for signed-in-no-token and billing/chat tier mismatch", () => {
    expect(settings).toContain("acctTokenWarn");
    expect(settings).toContain("acctTierMismatch");
    expect(settings).toContain('color: "#f87171"');
  });

  it("has NO Stripe / checkout / billing-portal path anywhere in mobile settings", () => {
    expect(settings).not.toMatch(/stripe/i);
    expect(settings).not.toMatch(/checkout/i);
    expect(settings).not.toMatch(/billing-portal|createCheckout|manageBilling/i);
  });

  it("Account sync derives public session tier from account-consistency (non-mutating)", () => {
    // Must NOT call getOraSession() — a POST that creates/overwrites the Ora session cookie.
    // Derive from acctDiag.chatSession returned by getAccountConsistency() instead.
    expect(settings).not.toContain("await getOraSession()");
    expect(settings).toContain("acctPublicSessionTier");
    expect(settings).toContain("acctPublicSessionIsPaid");
    expect(settings).toContain('"Public session tier"');
    expect(settings).toContain('"Local session tier"');
    expect(settings).toContain('"Session authenticated"');
    // Store must be synced with authoritative server value after each check.
    expect(settings).toContain("setCurrentSessionTier(data.chatSession.tier");
  });

  it("Account sync imports and reads getCurrentSessionTier() from session-store", () => {
    expect(settings).toContain("getCurrentSessionTier");
    expect(settings).toContain("getCurrentSessionTier()");
    expect(settings).toContain("acctLocalSessionTier");
  });

  it("Account sync warns on local session mismatch (startup race) before tier mismatch", () => {
    // acctPublicSessionMismatch removed — public session always equals billing by server contract.
    expect(settings).not.toContain("acctPublicSessionMismatch");
    expect(settings).toContain("acctLocalSessionMismatch");
    expect(settings).toContain("acctSessionAuthenticated");
    // In the acctWarnMessage ternary, the acctLocalSessionMismatch branch must
    // come before the acctTierMismatch branch so startup-race bugs surface first.
    const warnMessageStart = settings.indexOf("const acctWarnMessage =");
    expect(warnMessageStart).toBeGreaterThan(-1);
    const warnMessageBlock = settings.slice(warnMessageStart, warnMessageStart + 900);
    const localMismatchInWarn = warnMessageBlock.indexOf("acctLocalSessionMismatch");
    const tierMismatchInWarn = warnMessageBlock.indexOf("acctTierMismatch");
    expect(localMismatchInWarn).toBeGreaterThan(-1);
    expect(tierMismatchInWarn).toBeGreaterThan(-1);
    expect(localMismatchInWarn).toBeLessThan(tierMismatchInWarn);
  });

  it("Account sync runAccountCheck resets probe state and syncs store on each run", () => {
    const fnStart = settings.indexOf("const runAccountCheck = useCallback(async ()");
    expect(fnStart).toBeGreaterThan(-1);
    // Slice to the next const/function declaration so the full callback is captured
    // regardless of body length — avoids brittle fixed-char-count truncation.
    const nextDecl = settings.indexOf("\n  const ", fnStart + 1);
    const fnBody =
      nextDecl > fnStart ? settings.slice(fnStart, nextDecl) : settings.slice(fnStart);
    // Probe nulls must appear before any await so they reflect the check start state.
    expect(fnBody).toContain("setAcctPublicSessionTier(null)");
    expect(fnBody).toContain("setAcctPublicSessionIsPaid(null)");
    // acctPublicSessionError removed: probe is now non-mutating (no getOraSession() POST).
    expect(fnBody).not.toContain("setAcctPublicSessionError");
    expect(fnBody).toContain("setAcctLocalSessionTier(getCurrentSessionTier())");
    // Local session store must be synced with the authoritative server value.
    expect(fnBody).toContain("setCurrentSessionTier(data.chatSession.tier");
  });

  it("Plan & billing card surfaces a subscriptionError instead of silently showing Free", () => {
    expect(settings).toContain("subscriptionError");
    expect(settings).toContain("setSubscriptionError");
    // Must have an explicit error branch, not just a fallback to planLabel("free").
    const errorIdx = settings.indexOf("subscriptionError ?");
    expect(errorIdx).toBeGreaterThan(-1);
    const planCardBody = settings.slice(errorIdx, errorIdx + 1200);
    expect(planCardBody).toContain("Retry");
  });
});

describe("Mobile auth-stability guard", () => {
  const authClient = read("../auth-client.ts");
  const api = read("../api.ts");
  const layout = read("../../app/(home)/_layout.tsx");
  const settings = read("../../app/(home)/settings.tsx");
  const index = read("../../app/(home)/index.tsx");
  const sessionStore = read("../session-store.ts");

  it("auth-client exports requireAuthToken, TokenUnavailableError, and setAuthState", () => {
    expect(authClient).toContain("export async function requireAuthToken()");
    expect(authClient).toContain("export class TokenUnavailableError");
    expect(authClient).toContain("export function setAuthState(");
  });

  it("requireAuthToken waits for auth to load before deciding signed-in state", () => {
    expect(authClient).toContain("waitForAuthLoaded");
    expect(authClient).toContain("async function waitForAuthLoaded(");
    expect(authClient).toContain("_authIsLoaded");
    // Must await load before checking _authIsSignedIn to prevent race.
    const fnBody = authClient.slice(
      authClient.indexOf("export async function requireAuthToken()"),
      authClient.indexOf("export async function requireAuthToken()") + 400,
    );
    expect(fnBody).toContain("waitForAuthLoaded");
    expect(fnBody).toContain("throw new TokenUnavailableError()");
  });

  it("requireAuthToken fails closed for signed-in users with missing token", () => {
    expect(authClient).toContain("_authIsSignedIn");
    expect(authClient).toContain("throw new TokenUnavailableError()");
    expect(authClient).toContain("if (!_authIsSignedIn) return null");
  });

  it("layout syncs isSignedIn into module-level auth state on every change", () => {
    expect(layout).toContain("setAuthState");
    expect(layout).toContain("isSignedIn");
    expect(layout).toContain("setAuthState(isLoaded, isSignedIn");
  });

  it("api.ts guards signed-in routes via pathRequiresAuth", () => {
    expect(api).toContain("function pathRequiresAuth(");
    expect(api).toContain("authHeadersRequired");
    expect(api).toContain('"/api/public-ai/session"');
    expect(api).toContain('"/api/public-ai/chat"');
    expect(api).toContain('"/api/public-ai/usage"');
    expect(api).toContain('"/api/public-ai/realtime/session"');
    expect(api).toContain('"/api/ora/"');
    expect(api).toContain("requireAuthToken");
  });

  it("/api/public-ai/session is in pathRequiresAuth so a signed-in user cannot silently get an anonymous session", () => {
    const pathRequiresAuthFn = api.slice(
      api.indexOf("function pathRequiresAuth("),
      api.indexOf("function pathRequiresAuth(") + 600,
    );
    expect(pathRequiresAuthFn).toContain('"/api/public-ai/session"');
    expect(pathRequiresAuthFn).not.toContain('"/api/public-ai/session" // excluded');
  });

  it("jsonRequest uses authHeadersRequired for guarded routes", () => {
    expect(api).toContain("pathRequiresAuth(path) ? authHeadersRequired : authHeaders");
  });

  it("streamChatNative uses authHeadersRequired (not plain authHeaders)", () => {
    const streamFnStart = api.indexOf("export async function streamChatNative(");
    expect(streamFnStart).toBeGreaterThan(-1);
    // Slice to the next exported declaration so the full function body is captured
    // regardless of function length — avoids brittle fixed-char-count truncation.
    const nextExport = api.indexOf("\nexport ", streamFnStart + 1);
    const streamFnBody =
      nextExport > streamFnStart ? api.slice(streamFnStart, nextExport) : api.slice(streamFnStart);
    expect(streamFnBody).toContain("authHeadersRequired");
    expect(streamFnBody).not.toMatch(/await authHeaders\(/);
  });

  it("Account Sync shows localSignedIn, tokenPresent, and serverRecognized rows", () => {
    expect(settings).toContain("acctLocalSignedIn");
    expect(settings).toContain("acctTokenPresent");
    expect(settings).toContain('"Local signed in"');
    expect(settings).toContain('"Token present"');
    expect(settings).toContain('"Server recognized"');
    expect(settings).toContain('"Ora session auth"');
  });

  it("Account Sync handles TokenUnavailableError without overwriting the token warning", () => {
    expect(settings).toContain("TokenUnavailableError");
    expect(settings).toContain("err instanceof TokenUnavailableError");
    expect(settings).toContain("setAcctTokenPresent(false)");
  });

  it("session-store exports setCurrentSessionTier, getCurrentSessionTier, getCurrentSessionIsPaid", () => {
    expect(sessionStore).toContain("export function setCurrentSessionTier(");
    expect(sessionStore).toContain("export function getCurrentSessionTier()");
    expect(sessionStore).toContain("export function getCurrentSessionIsPaid()");
  });

  it("index.tsx gates getOraSession() on isLoaded to prevent auth race on startup", () => {
    expect(index).toContain("isLoaded");
    // isLoaded must be destructured from useAuth
    const useAuthLine = index.slice(
      index.indexOf("const { isSignedIn"),
      index.indexOf("const { isSignedIn") + 80,
    );
    expect(useAuthLine).toContain("isLoaded");
    // The session effect must early-return when !isLoaded
    expect(index).toContain("if (!isLoaded) return");
  });

  it("index.tsx calls setCurrentSessionTier after a successful getOraSession()", () => {
    expect(index).toContain("setCurrentSessionTier");
    // Must be called with the session tier, not just null
    const sessionEffectStart = index.indexOf("getOraSession()");
    expect(sessionEffectStart).toBeGreaterThan(-1);
    const sessionEffectBody = index.slice(sessionEffectStart, sessionEffectStart + 300);
    expect(sessionEffectBody).toContain("setCurrentSessionTier(s.tier");
  });

  it("index.tsx catches TokenUnavailableError and does NOT fall to anonymous session", () => {
    expect(index).toContain("sessionSyncError");
    expect(index).toContain("setSessionSyncError");
    // When the error is TokenUnavailableError, must NOT call setSession(null) — that
    // would create an anonymous session object. The catch branch must distinguish.
    const catchBlock = index.slice(
      index.indexOf("catch ((err) => {"),
      index.indexOf("catch ((err) => {") + 300,
    );
    expect(index).toContain('err instanceof TokenUnavailableError');
    expect(index).toContain('setSessionSyncError("token_unavailable")');
  });

  it("index.tsx renders a re-sync banner when sessionSyncError is token_unavailable", () => {
    expect(index).toContain('sessionSyncError === "token_unavailable"');
    // Must show an error color and a retry affordance
    const bannerIdx = index.indexOf('sessionSyncError === "token_unavailable"');
    const bannerBody = index.slice(bannerIdx, bannerIdx + 2000);
    expect(bannerBody).toContain("#f87171");
    // Must render the RefreshCw retry icon and re-call getOraSession on press.
    expect(bannerBody).toContain("RefreshCw");
    expect(bannerBody.indexOf("getOraSession()")).toBeGreaterThan(-1);
  });

  it("index.tsx adds isLoaded to the getOraSession useEffect dependency array", () => {
    // isLoaded must be in deps so the effect re-runs once auth resolves.
    const effectClose = index.indexOf("}, [loadPreferences, isSignedIn, isLoaded]);");
    expect(effectClose).toBeGreaterThan(-1);
  });
});
