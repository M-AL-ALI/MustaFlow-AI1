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
});

describe("Mobile auth-stability guard", () => {
  const authClient = read("../auth-client.ts");
  const api = read("../api.ts");
  const layout = read("../../app/(home)/_layout.tsx");
  const settings = read("../../app/(home)/settings.tsx");

  it("auth-client exports requireAuthToken, TokenUnavailableError, and setAuthState", () => {
    expect(authClient).toContain("export async function requireAuthToken()");
    expect(authClient).toContain("export class TokenUnavailableError");
    expect(authClient).toContain("export function setAuthState(");
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
    expect(api).toContain('"/api/public-ai/chat"');
    expect(api).toContain('"/api/public-ai/usage"');
    expect(api).toContain('"/api/public-ai/realtime/session"');
    expect(api).toContain('"/api/ora/"');
    expect(api).toContain("requireAuthToken");
  });

  it("jsonRequest uses authHeadersRequired for guarded routes", () => {
    expect(api).toContain("pathRequiresAuth(path) ? authHeadersRequired : authHeaders");
  });

  it("streamChatNative uses authHeadersRequired (not plain authHeaders)", () => {
    const streamFnStart = api.indexOf("export async function streamChatNative(");
    expect(streamFnStart).toBeGreaterThan(-1);
    const streamFnBody = api.slice(streamFnStart, streamFnStart + 500);
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
});
