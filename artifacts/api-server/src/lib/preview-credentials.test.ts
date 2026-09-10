import type { ClientRequest } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  filterPreviewResponseCookies,
  stripPreviewUpstreamCredentials,
} from "./preview-credentials";

function request(headers: Record<string, string | string[]>) {
  const values = new Map(
    Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
  );
  return {
    values,
    getHeaderNames: () => [...values.keys()],
    getHeader: (name: string) => values.get(name.toLowerCase()),
    setHeader: vi.fn((name: string, value: string) => values.set(name.toLowerCase(), value)),
    removeHeader: vi.fn((name: string) => values.delete(name.toLowerCase())),
  };
}

describe("preview upstream credential boundary", () => {
  it("removes platform sessions, bearer auth, preview grants and relay secrets while retaining app cookies", () => {
    const target = request({
      Cookie:
        "__session=platform; __session_app=platform; __clerk_db_jwt=platform; __client_uat=platform; __prs=grant; app_session=tenant; theme=dark",
      Authorization: "Bearer platform-token",
      "proxy-authorization": "proxy-token",
      "x-clerk-auth-token": "platform-token",
      "x-b5-relay-auth": "relay-token",
      "sec-websocket-protocol": "vite-hmr",
    });
    stripPreviewUpstreamCredentials(target as unknown as ClientRequest);
    expect(Object.fromEntries(target.values)).toEqual({
      cookie: "app_session=tenant; theme=dark",
      "sec-websocket-protocol": "vite-hmr",
    });
  });

  it("handles duplicate cookie arrays and whitespace without forwarding a platform credential", () => {
    const target = request({
      cookie: [" __session =platform", "app_session=one", "__session_app=two"],
    });
    stripPreviewUpstreamCredentials(target as unknown as ClientRequest);
    expect(target.values.get("cookie")).toBe("app_session=one");
  });

  it("omits Cookie entirely when only platform credentials are present", () => {
    const target = request({ cookie: "__session=platform; __prs=grant" });
    stripPreviewUpstreamCredentials(target as unknown as ClientRequest);
    expect(target.values.has("cookie")).toBe(false);
  });

  it("does not let a tenant response replace platform credentials", () => {
    expect(
      filterPreviewResponseCookies([
        "__session=forged; Path=/",
        "__prs=forged",
        "app_session=tenant; HttpOnly; Path=/",
      ]),
    ).toEqual(["app_session=tenant; HttpOnly; Path=/"]);
    expect(filterPreviewResponseCookies(["__session=forged"])).toBeUndefined();
    expect(filterPreviewResponseCookies(undefined)).toBeUndefined();
  });
});
