import type { IncomingMessage } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  authenticateMultiplayerUpgrade,
  MULTIPLAYER_AUTH_TIMEOUT_MS,
} from "./multiplayer-upgrade-auth";

const { verifyRequest } = vi.hoisted(() => ({ verifyRequest: vi.fn() }));
vi.mock("@clerk/express", () => ({ clerkClient: { authenticateRequest: verifyRequest } }));

function request(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    method: "GET",
    url: "/api/projects/61/multiplayer?location=Preview",
    headers: {
      host: "app.example.test",
      origin: "https://app.example.test",
      cookie: "__session=test-session-cookie",
      "x-forwarded-proto": "https",
    },
    socket: { encrypted: false },
    ...overrides,
  } as IncomingMessage;
}

function signedIn(userId = "verified-owner", legacyUserId?: unknown) {
  return {
    status: "signed-in",
    isAuthenticated: true,
    tokenType: "session_token",
    headers: new Headers(),
    toAuth: vi.fn(() => ({ userId, sessionClaims: { userId: legacyUserId } })),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  verifyRequest.mockResolvedValue(signedIn());
});
afterEach(() => vi.useRealTimers());

describe("verified collaboration upgrades", () => {
  it.each(["0", "2147483648", "9007199254740992", "9".repeat(400)])(
    "does not invoke the credential verifier for out-of-domain project %s",
    async (id) => {
      expect(
        await authenticateMultiplayerUpgrade(
          request({ url: "/api/projects/" + id + "/multiplayer" }),
        ),
      ).toBeNull();
      expect(verifyRequest).not.toHaveBeenCalled();
    },
  );

  it("verifies the existing cookie with the configured Clerk client and session-token policy", async () => {
    const req = request();
    expect(await authenticateMultiplayerUpgrade(req)).toBe("verified-owner");
    const [webRequest, options] = verifyRequest.mock.calls[0] as [Request, unknown];
    expect(webRequest).toBeInstanceOf(Request);
    expect(webRequest.url).toBe("https://app.example.test/api/projects/61/multiplayer");
    expect(webRequest.headers.get("cookie")).toBe("__session=test-session-cookie");
    expect(options).toEqual({
      acceptsToken: "session_token",
      authorizedParties: ["https://app.example.test"],
    });
  });

  it("passes an existing authorization header to verification, not to a query string", async () => {
    const req = request();
    delete req.headers.cookie;
    req.headers.authorization = "Bearer test-session-bearer";
    expect(await authenticateMultiplayerUpgrade(req)).toBe("verified-owner");
    const webRequest = verifyRequest.mock.calls[0][0] as Request;
    expect(webRequest.headers.get("authorization")).toBe("Bearer test-session-bearer");
    expect(new URL(webRequest.url).search).toBe("");
  });

  it("retains the REST-compatible identity from verified legacy claims", async () => {
    const state = signedIn("clerk-subject", "legacy-owner");
    verifyRequest.mockResolvedValue(state);
    expect(await authenticateMultiplayerUpgrade(request())).toBe("legacy-owner");
    expect(state.toAuth).toHaveBeenCalledWith({ treatPendingAsSignedOut: true });
  });

  it.each(["", "   ", 123, { userId: "claimed-owner" }])(
    "rejects a malformed verified legacy identity: %j",
    async (legacy) => {
      verifyRequest.mockResolvedValue(signedIn("clerk-subject", legacy));
      expect(await authenticateMultiplayerUpgrade(request())).toBeNull();
    },
  );

  it("ignores hostile user IDs and an injected Express auth accessor", async () => {
    const req = request({ url: "/api/projects/61/multiplayer?userId=claimed-owner" });
    Object.assign(req, { userId: "claimed-owner", auth: () => ({ userId: "claimed-owner" }) });
    verifyRequest.mockResolvedValue(signedIn("verified-outsider"));
    expect(await authenticateMultiplayerUpgrade(req)).toBe("verified-outsider");
    expect((verifyRequest.mock.calls[0][0] as Request).url).not.toContain("claimed-owner");
  });

  it.each([undefined, "null", "https://attacker.invalid", "https://app.example.test/path"])(
    "rejects an absent, opaque, or foreign origin: %s",
    async (origin) => {
      const req = request();
      req.headers.origin = origin;
      expect(await authenticateMultiplayerUpgrade(req)).toBeNull();
      expect(verifyRequest).not.toHaveBeenCalled();
    },
  );

  it("does not let a forwarded host override the checked request origin", async () => {
    const req = request();
    req.headers["x-forwarded-host"] = "attacker.invalid";
    expect(await authenticateMultiplayerUpgrade(req)).toBe("verified-owner");
    const webRequest = verifyRequest.mock.calls[0][0] as Request;
    expect(webRequest.headers.get("x-forwarded-host")).toBe("app.example.test");
    req.headers.origin = "https://attacker.invalid";
    expect(await authenticateMultiplayerUpgrade(req)).toBeNull();
    expect(verifyRequest).toHaveBeenCalledTimes(1);
  });

  it("accepts a direct TLS request without forwarded protocol metadata", async () => {
    const req = request();
    delete req.headers["x-forwarded-proto"];
    Object.assign(req.socket, { encrypted: true });
    expect(await authenticateMultiplayerUpgrade(req)).toBe("verified-owner");
  });

  it.each(["https,http", "ftp"])("rejects an ambiguous protocol: %s", async (protocol) => {
    const req = request();
    req.headers["x-forwarded-proto"] = protocol;
    expect(await authenticateMultiplayerUpgrade(req)).toBeNull();
    expect(verifyRequest).not.toHaveBeenCalled();
  });

  it.each(["signed-out", "handshake"])("does not admit a %s Clerk result", async (status) => {
    const toAuth = vi.fn();
    verifyRequest.mockResolvedValue({ status, isAuthenticated: false, toAuth });
    expect(await authenticateMultiplayerUpgrade(request())).toBeNull();
    expect(toAuth).not.toHaveBeenCalled();
  });

  it("does not admit a pending session whose auth object has no user", async () => {
    const state = signedIn();
    state.toAuth.mockReturnValue({
      userId: null as unknown as string,
      sessionClaims: { userId: undefined },
    });
    verifyRequest.mockResolvedValue(state);
    expect(await authenticateMultiplayerUpgrade(request())).toBeNull();
  });

  it("keeps unsigned and invalid credentials denied without exposing verifier details", async () => {
    verifyRequest.mockRejectedValue(new Error("private verifier detail"));
    expect(await authenticateMultiplayerUpgrade(request())).toBeNull();
  });

  it("bounds a stalled verifier and ignores its later result", async () => {
    vi.useFakeTimers();
    let finish!: (value: ReturnType<typeof signedIn>) => void;
    verifyRequest.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = authenticateMultiplayerUpgrade(request());
    await vi.advanceTimersByTimeAsync(MULTIPLAYER_AUTH_TIMEOUT_MS);
    expect(await pending).toBeNull();
    finish(signedIn());
  });
});
