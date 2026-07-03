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

// Phase 2C shell: device-flow callback polling and encrypted token storage are
// not yet implemented.  getSession() intentionally returns null until Phase 2D
// adds the callback listener and credential persistence.
export class ProductionAuthAdapter implements AuthAdapter {
  async getSession(): Promise<AuthSession | null> {
    // TODO (Phase 2D): read stored session token from credential-store and
    // exchange/validate it; return null until that is implemented.
    return null;
  }

  async startSignIn(): Promise<void> {
    // Opens the MustaFlow device-login page in the user's default browser.
    // The app does NOT yet poll for the resulting token — that is deferred to
    // Phase 2D, which will add a local callback listener and store the session.
    const { shell } = await import("electron");
    const deviceFlowUrl =
      (process.env.ORAX_API_BASE_URL ?? "https://www.mustaflow.com") +
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
