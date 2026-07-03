import type { AuthSession } from "../shared/types";

export interface AuthAdapter {
  getSession(): Promise<AuthSession | null>;
  startSignIn(): Promise<void>;
  signOut(): Promise<void>;
}

const IS_DEV_AUTH =
  process.env.NODE_ENV === "development" || process.env.ORAX_DEV_AUTH === "true";

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
    console.log("[DevAuth] startSignIn — set ORAX_DEV_TOKEN env var to authenticate");
  }

  async signOut(): Promise<void> {
    this._session = null;
  }
}

export class ProductionAuthAdapter implements AuthAdapter {
  async getSession(): Promise<AuthSession | null> {
    return null;
  }

  async startSignIn(): Promise<void> {
    const { shell } = await import("electron");
    const deviceFlowUrl = (process.env.ORAX_API_BASE_URL ?? "https://www.mustaflow.com") +
      "/orax/device-login";
    await shell.openExternal(deviceFlowUrl);
  }

  async signOut(): Promise<void> {
    const { storeEncrypted } = await import("./credential-store");
    storeEncrypted("orax-session-token", "");
  }
}

export function createAuthAdapter(): AuthAdapter {
  if (IS_DEV_AUTH) {
    console.log("[Auth] Dev auth mode enabled (ORAX_DEV_AUTH=true or NODE_ENV=development)");
    return new DevAuthAdapter();
  }
  return new ProductionAuthAdapter();
}
