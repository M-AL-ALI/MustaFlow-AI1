import type { AuthSession } from "../shared/types";
import { getOrCreateInstallIdentity } from "./install-identity";

export interface AuthAdapter {
  getSession(): Promise<AuthSession | null>;
  startSignIn(): Promise<void>;
  signOut(): Promise<void>;
}

const IS_DEV_AUTH = process.env.NODE_ENV === "development" || process.env.ORAX_DEV_AUTH === "true";
const SESSION_STORE_KEY = "orax-session";
const DEFAULT_API_BASE = "https://www.mustaflow.com";
const POLL_INTERVAL_MS = 2_000;

interface StoredAuthSession {
  version: 1;
  session: AuthSession;
}

interface DesktopAuthStartResponse {
  challengeId: string;
  pollToken: string;
  userCode: string;
  verificationUrl: string;
  expiresAt: string;
}

interface DesktopAuthStatusResponse {
  status: "pending" | "approved" | "expired" | "denied";
  redeemed?: boolean;
  session?: AuthSession;
}

function apiBase(): string {
  return process.env.ORAX_API_BASE_URL ?? DEFAULT_API_BASE;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseStoredSession(raw: string | null): AuthSession | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAuthSession>;
    const session = parsed.session;
    if (!session?.userId || !session.token) return null;
    if (session.expiresAt && Date.parse(session.expiresAt) <= Date.now()) return null;
    return {
      userId: session.userId,
      email: session.email ?? "",
      displayName: session.displayName ?? "MustaFlow User",
      token: session.token,
      expiresAt: session.expiresAt,
    };
  } catch {
    return null;
  }
}

export class DevAuthAdapter implements AuthAdapter {
  private _session: AuthSession | null = null;

  async getSession(): Promise<AuthSession | null> {
    if (this._session) return this._session;
    const token = process.env.ORAX_DEV_TOKEN;
    if (!token) return null;
    this._session = {
      userId: process.env.ORAX_DEV_USER_ID ?? "dev-user-000",
      email: process.env.ORAX_DEV_EMAIL ?? "dev@orax.local",
      displayName: process.env.ORAX_DEV_DISPLAY_NAME ?? "Dev User",
      token,
    };
    return this._session;
  }

  async startSignIn(): Promise<void> {
    console.log("[DevAuth] startSignIn - set ORAX_DEV_TOKEN env var to authenticate");
  }

  async signOut(): Promise<void> {
    this._session = null;
  }
}

export class ProductionAuthAdapter implements AuthAdapter {
  async getSession(): Promise<AuthSession | null> {
    const { loadEncrypted, deleteEncrypted } = await import("./credential-store");
    const session = parseStoredSession(loadEncrypted(SESSION_STORE_KEY));
    if (!session) {
      deleteEncrypted(SESSION_STORE_KEY);
      return null;
    }
    return session;
  }

  async startSignIn(): Promise<void> {
    const { shell } = await import("electron");
    const { storeEncrypted } = await import("./credential-store");
    const identity = getOrCreateInstallIdentity();
    const start = await fetch(`${apiBase()}/api/orax/desktop-auth/start`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Client": "orax-desktop",
      },
      body: JSON.stringify({
        deviceName: identity.deviceName,
        platform: identity.platform,
        appVersion: identity.appVersion,
        installId: identity.installId,
      }),
    });
    if (!start.ok) throw new Error(`Could not start Orax Desktop sign-in (${start.status})`);

    const challenge = (await start.json()) as DesktopAuthStartResponse;
    await shell.openExternal(challenge.verificationUrl);

    const expiresAtMs = Date.parse(challenge.expiresAt);
    while (Date.now() < expiresAtMs) {
      await delay(POLL_INTERVAL_MS);
      const url = new URL(
        `/api/orax/desktop-auth/status/${encodeURIComponent(challenge.challengeId)}`,
        apiBase(),
      );
      url.searchParams.set("pollToken", challenge.pollToken);
      const statusRes = await fetch(url.toString(), {
        headers: { "X-Client": "orax-desktop" },
      });
      if (!statusRes.ok) {
        throw new Error(`Orax Desktop sign-in check failed (${statusRes.status})`);
      }
      const status = (await statusRes.json()) as DesktopAuthStatusResponse;
      if (status.status === "pending") continue;
      if (status.status === "approved" && status.session?.token) {
        const stored: StoredAuthSession = { version: 1, session: status.session };
        storeEncrypted(SESSION_STORE_KEY, JSON.stringify(stored));
        return;
      }
      if (status.status === "denied") throw new Error("Orax Desktop sign-in was denied.");
      throw new Error("Orax Desktop sign-in expired. Please try again.");
    }
    throw new Error("Orax Desktop sign-in expired. Please try again.");
  }

  async signOut(): Promise<void> {
    const { deleteEncrypted } = await import("./credential-store");
    deleteEncrypted(SESSION_STORE_KEY);
  }
}

export function createAuthAdapter(): AuthAdapter {
  if (IS_DEV_AUTH) {
    console.log("[Auth] Dev auth mode enabled (ORAX_DEV_AUTH=true or NODE_ENV=development)");
    return new DevAuthAdapter();
  }
  return new ProductionAuthAdapter();
}
