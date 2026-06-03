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
});
