import type { IncomingHttpHeaders } from "node:http";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  proxyRes: null as
    | null
    | ((
        response: { headers: IncomingHttpHeaders },
        req: {
          url?: string;
          originalUrl?: string;
          mustaFlowPublicPreview?: { projectId: number; requestUrl: string };
        },
      ) => void),
}));
vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: (options: { on: { proxyRes: typeof state.proxyRes } }) => {
    state.proxyRes = options.on.proxyRes;
    return Object.assign(vi.fn(), { upgrade: vi.fn() });
  },
}));
vi.mock("@workspace/db", () => ({
  db: {},
  projectsTable: {},
  projectFilesTable: {},
  orgMembersTable: {},
}));
vi.mock("@clerk/express", () => ({ getAuth: vi.fn() }));
vi.mock("./container-secrets", () => ({ getContainerSecretMap: vi.fn() }));
vi.mock("./cloudflare-preview-grant", () => ({ mintCloudflarePreviewGrant: vi.fn() }));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("./project-files-preview", () => ({
  previewFilePathFromUrl: vi.fn(),
  serveProjectFilesPreview: vi.fn(),
}));
vi.mock("./runtime-manifest", () => ({ resolveProjectRuntimeManifest: vi.fn() }));
vi.mock("./project-lifecycle", () => ({ withActiveProjectLifecycle: vi.fn() }));
vi.mock("./tenant-runtime", () => ({
  isContainerLayerConfigured: vi.fn(),
  provisionContainer: vi.fn(),
  tenantRuntimeProvider: {
    getGatewayHostname: () => "runtime.invalid",
    getGatewayLabel: () => "Runtime",
    isGatewayReachable: vi.fn(),
  },
}));

import "./livePreviewProxy";

describe("actual private preview proxy response hook", () => {
  it.each(["/api/projects/71/preview/", "/projects/71/preview/app.html?version=3"])(
    "protects API-served runtime documents at %s",
    (url) => {
      const response = {
        headers: {
          "content-security-policy": "default-src 'self'; sandbox allow-scripts allow-same-origin",
          "set-cookie": ["__session=fixture; Path=/", "app_session=tenant; Path=/"],
        } as IncomingHttpHeaders,
      };
      state.proxyRes!(response, { url });
      expect(response.headers["content-security-policy"]).toEqual([
        "default-src 'self'; sandbox allow-scripts allow-same-origin",
        "sandbox allow-scripts allow-forms allow-popups",
      ]);
      expect(response.headers["set-cookie"]).toEqual(["app_session=tenant; Path=/"]);
      expect(response.headers["referrer-policy"]).toBe("no-referrer");
    },
  );
  it("recognizes the original private URL after the router rewrites req.url", () => {
    const response = { headers: {} as IncomingHttpHeaders };
    state.proxyRes!(response, { originalUrl: "/api/projects/71/preview/", url: "/" });
    expect(response.headers["content-security-policy"]).toContain(
      "sandbox allow-scripts allow-forms allow-popups",
    );
  });
  it("preserves the separate public-app response contract", () => {
    const response = {
      headers: { "content-security-policy": "default-src 'self'" } as IncomingHttpHeaders,
    };
    state.proxyRes!(response, {
      url: "/app",
      mustaFlowPublicPreview: { projectId: 71, requestUrl: "/app" },
    });
    expect(response.headers["content-security-policy"]).toBe("default-src 'self'");
  });
});
