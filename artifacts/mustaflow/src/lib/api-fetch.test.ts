import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@workspace/api-client-react", () => ({
  getAuthToken: vi.fn(async () => "test-token"),
}));

import { getAuthToken } from "@workspace/api-client-react";
import { authFetch } from "./api-fetch";

function lastInit(): RequestInit {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0][1] as RequestInit;
}

function authHeader(): string | null {
  return new Headers(lastInit().headers).get("authorization");
}

describe("authFetch bearer-token attachment (same-origin guard)", () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.mocked(getAuthToken).mockReset().mockResolvedValue("test-token");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true }) as Response),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("attaches the bearer token for a relative /api path", async () => {
    await authFetch("/api/credits");
    expect(authHeader()).toBe("Bearer test-token");
  });

  it("attaches the bearer token for a same-origin absolute URL", async () => {
    await authFetch(`${window.location.origin}/api/credits`);
    expect(authHeader()).toBe("Bearer test-token");
  });

  it("does NOT attach the token for a protocol-relative cross-origin URL", async () => {
    await authFetch("//attacker.example/steal");
    expect(authHeader()).toBeNull();
  });

  it("does NOT attach the token for an absolute cross-origin URL", async () => {
    await authFetch("https://attacker.example/steal");
    expect(authHeader()).toBeNull();
  });

  it("does NOT attach the token for a data: URL", async () => {
    await authFetch("data:text/plain,hello");
    expect(authHeader()).toBeNull();
  });

  it("always sends credentials so the cookie path keeps working", async () => {
    await authFetch("/api/credits");
    expect(lastInit().credentials).toBe("include");
  });

  it("does not overwrite an explicit Authorization header", async () => {
    await authFetch("/api/credits", {
      headers: { Authorization: "Bearer caller-supplied" },
    });
    expect(authHeader()).toBe("Bearer caller-supplied");
  });

  it("falls back to the same-origin cookie when token retrieval stalls", async () => {
    vi.useFakeTimers();
    vi.mocked(getAuthToken).mockReturnValueOnce(new Promise(() => undefined));

    const request = authFetch("/api/credits");
    await vi.advanceTimersByTimeAsync(3_000);
    await request;

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(authHeader()).toBeNull();
    expect(lastInit().credentials).toBe("include");
  });

  it("falls back to the same-origin cookie when token retrieval rejects", async () => {
    vi.mocked(getAuthToken).mockRejectedValueOnce(new Error("token refresh failed"));

    await authFetch("/api/credits");

    expect(globalThis.fetch).toHaveBeenCalledOnce();
    expect(authHeader()).toBeNull();
    expect(lastInit().credentials).toBe("include");
  });
});
