import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
const DEFAULT_SCOPES = "repo read:user";
const STATE_TTL_MS = 10 * 60 * 1000;

function getStateSecret(): string {
  const secret = process.env.SESSION_SECRET ?? process.env.ENCRYPTION_KEY ?? "";
  if (!secret) {
    throw new Error("SESSION_SECRET (or ENCRYPTION_KEY) is required to sign GitHub OAuth state");
  }
  return secret;
}

export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
}

export function getGithubOAuthConfig(): GithubOAuthConfig | null {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

export function isGithubOAuthEnabled(): boolean {
  return getGithubOAuthConfig() !== null;
}

interface StatePayload {
  pid: number;
  uid: string;
  nonce: string;
  ts: number;
}

function b64urlEncode(buf: Buffer): string {
  return buf.toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function b64urlDecode(str: string): Buffer {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4));
  return Buffer.from(str.replace(/-/g, "+").replace(/_/g, "/") + pad, "base64");
}

export function signOAuthState(projectId: number, userId: string): string {
  const payload: StatePayload = {
    pid: projectId,
    uid: userId,
    nonce: randomBytes(12).toString("hex"),
    ts: Date.now(),
  };
  const encoded = b64urlEncode(Buffer.from(JSON.stringify(payload), "utf8"));
  const sig = createHmac("sha256", getStateSecret()).update(encoded).digest();
  return `${encoded}.${b64urlEncode(sig)}`;
}

export function verifyOAuthState(
  state: string,
): { ok: true; payload: StatePayload } | { ok: false; reason: string } {
  const parts = state.split(".");
  if (parts.length !== 2) return { ok: false, reason: "malformed state" };
  const [encoded, sig] = parts;
  if (!encoded || !sig) return { ok: false, reason: "malformed state" };

  const expected = createHmac("sha256", getStateSecret()).update(encoded).digest();
  let actual: Buffer;
  try {
    actual = b64urlDecode(sig);
  } catch {
    return { ok: false, reason: "bad signature encoding" };
  }
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "bad signature" };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(b64urlDecode(encoded).toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "bad payload" };
  }
  if (
    typeof payload.pid !== "number" ||
    typeof payload.uid !== "string" ||
    typeof payload.ts !== "number"
  ) {
    return { ok: false, reason: "bad payload shape" };
  }
  if (Date.now() - payload.ts > STATE_TTL_MS) {
    return { ok: false, reason: "state expired" };
  }
  return { ok: true, payload };
}

export function buildAuthorizeUrl(args: {
  clientId: string;
  redirectUri: string;
  state: string;
  scope?: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    scope: args.scope ?? DEFAULT_SCOPES,
    state: args.state,
    allow_signup: "true",
  });
  return `${GITHUB_AUTHORIZE_URL}?${params.toString()}`;
}

export async function exchangeCodeForToken(args: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ accessToken: string; scope: string; tokenType: string }> {
  const body = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
  });
  const res = await fetch(GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const json = (await res.json()) as {
    access_token?: string;
    scope?: string;
    token_type?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !json.access_token) {
    const msg = json.error_description ?? json.error ?? `GitHub token exchange failed (${res.status})`;
    throw new Error(msg);
  }
  return {
    accessToken: json.access_token,
    scope: json.scope ?? "",
    tokenType: json.token_type ?? "bearer",
  };
}

export function buildCallbackUrl(args: { protocol: string; host: string; projectId: number }): string {
  const override = process.env.GITHUB_OAUTH_REDIRECT_URL?.trim();
  if (override) {
    return override.replace(/\{id\}|\{projectId\}/g, String(args.projectId));
  }
  return `${args.protocol}://${args.host}/api/projects/${args.projectId}/github/oauth/callback`;
}
