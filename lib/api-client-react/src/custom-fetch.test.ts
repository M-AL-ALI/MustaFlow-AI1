import { beforeEach, describe, expect, it, vi } from "vitest";
import { customFetch, setAuthTokenGetter } from "./custom-fetch";

function lastInit(): RequestInit {
  const mock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
  return mock.mock.calls[0][1] as RequestInit;
}

describe("customFetch auth transport", () => {
  beforeEach(() => {
    setAuthTokenGetter(null);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    );
  });

  it("includes cookies by default for generated API calls", async () => {
    await customFetch("/api/projects", { responseType: "json" });
    expect(lastInit().credentials).toBe("include");
  });

  it("allows callers to override credentials explicitly", async () => {
    await customFetch("/api/projects", { credentials: "omit", responseType: "json" });
    expect(lastInit().credentials).toBe("omit");
  });

  it("keeps bearer token attachment when configured", async () => {
    setAuthTokenGetter(() => "fresh-token");
    await customFetch("/api/projects", { responseType: "json" });
    expect(new Headers(lastInit().headers).get("authorization")).toBe("Bearer fresh-token");
  });

  it("still sends the request (cookie fallback) when the token getter throws", async () => {
    setAuthTokenGetter(() => {
      throw new Error("getToken failed");
    });
    await expect(customFetch("/api/projects", { responseType: "json" })).resolves.toEqual({
      ok: true,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(lastInit().headers).has("authorization")).toBe(false);
    expect(lastInit().credentials).toBe("include");
  });

  it("still sends the request (cookie fallback) when the token getter rejects", async () => {
    setAuthTokenGetter(() => Promise.reject(new Error("getToken rejected")));
    await expect(customFetch("/api/projects", { responseType: "json" })).resolves.toEqual({
      ok: true,
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(new Headers(lastInit().headers).has("authorization")).toBe(false);
  });

  it("does not invoke the token getter when an Authorization header is already provided", async () => {
    const getter = vi.fn(() => "fresh-token");
    setAuthTokenGetter(getter);
    await customFetch("/api/projects", {
      responseType: "json",
      headers: { authorization: "Bearer caller-supplied" },
    });
    expect(getter).not.toHaveBeenCalled();
    expect(new Headers(lastInit().headers).get("authorization")).toBe("Bearer caller-supplied");
  });
});
