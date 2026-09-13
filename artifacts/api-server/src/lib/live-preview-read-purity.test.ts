import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  project: {} as Record<string, unknown>,
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
  delete: vi.fn(),
  runtimeProviderId: "fly",
  provisionContainer: vi.fn(async () => null),
  getContainerSecretMap: vi.fn(async () => ({})),
  withActiveProjectLifecycle: vi.fn(
    async (
      _projectId: number,
      callback: (session: { assertActive: () => Promise<boolean> }) => Promise<void>,
    ) => callback({ assertActive: async () => true }),
  ),
  serveProjectFilesPreview: vi.fn(async () => undefined),
  hasContainerLayerCredentials: vi.fn(() => false),
  isContainerLayerConfigured: vi.fn(async () => true),
  proxyUpgrade: vi.fn(),
  proxyHttp: vi.fn(async () => undefined),
  mintCloudflarePreviewGrant: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({ kind: "and" })),
  eq: vi.fn(() => ({ kind: "eq" })),
  isNull: vi.fn(() => ({ kind: "isNull" })),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: state.select,
    update: state.update,
    insert: state.insert,
    delete: state.delete,
  },
  projectsTable: {
    id: "id",
    deletedAt: "deletedAt",
    ownerId: "ownerId",
    organizationId: "organizationId",
    status: "status",
    builderMode: "builderMode",
    containerId: "containerId",
    containerStatus: "containerStatus",
    containerUrl: "containerUrl",
    stack: "stack",
    runtimePort: "runtimePort",
  },
  projectFilesTable: { projectId: "projectId", path: "path", content: "content" },
  orgMembersTable: { organizationId: "organizationId", userId: "userId", role: "role" },
}));

vi.mock("@clerk/express", () => ({ getAuth: vi.fn(() => ({ userId: null })) }));
vi.mock("http-proxy-middleware", () => ({
  createProxyMiddleware: vi.fn(() =>
    Object.assign(state.proxyHttp, { upgrade: state.proxyUpgrade }),
  ),
}));
vi.mock("./cloudflare-preview-grant", () => ({
  mintCloudflarePreviewGrant: state.mintCloudflarePreviewGrant,
}));
vi.mock("./container-secrets", () => ({
  getContainerSecretMap: state.getContainerSecretMap,
}));
vi.mock("./project-lifecycle", () => ({
  withActiveProjectLifecycle: state.withActiveProjectLifecycle,
}));
vi.mock("./logger", () => ({ logger: { info: vi.fn(), warn: vi.fn() } }));
vi.mock("./project-files-preview", () => ({
  previewFilePathFromUrl: vi.fn(() => "index.html"),
  serveProjectFilesPreview: state.serveProjectFilesPreview,
}));
vi.mock("./runtime-manifest", () => ({
  resolveProjectRuntimeManifest: vi.fn(() => ({ servicePort: 3000 })),
}));
vi.mock("./tenant-runtime", () => ({
  hasContainerLayerCredentials: state.hasContainerLayerCredentials,
  isContainerLayerConfigured: state.isContainerLayerConfigured,
  provisionContainer: state.provisionContainer,
  tenantRuntimeProvider: {
    get providerId() {
      return state.runtimeProviderId;
    },
    getGatewayHostname: vi.fn(() => "runtime.example.invalid"),
    getGatewayLabel: vi.fn(() => "runtime gateway"),
    isGatewayReachable: vi.fn(async () => true),
  },
}));

import {
  handleLivePreviewHttp,
  handleLivePreviewUpgrade,
  loadPreviewProject,
  userCanPreviewProject,
} from "./livePreviewProxy";

const previewProject = () => ({
  id: 17,
  ownerId: "owner-17",
  organizationId: null,
  status: "draft",
  builderMode: "agentic",
  containerId: "runtime-17",
  containerStatus: "running",
  containerUrl: "http://runtime.internal",
  stack: "node-api",
  runtimePort: 3000,
});

function responseRecorder() {
  const record = { status: 0, headers: new Map<string, string | string[]>(), body: "" };
  const response = {
    getHeader(name: string) {
      return record.headers.get(name);
    },
    setHeader(name: string, value: string | string[]) {
      record.headers.set(name, value);
      return response;
    },
    status(value: number) {
      record.status = value;
      return response;
    },
    type(value: string) {
      record.headers.set("Content-Type", value);
      return response;
    },
    send(value: string) {
      record.body = value;
      return response;
    },
    end() {
      return response;
    },
  } as unknown as Response;
  return { record, response };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.runtimeProviderId = "fly";
  state.project = previewProject();
  state.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => [state.project]),
    })),
  }));
  state.isContainerLayerConfigured.mockResolvedValue(true);
  state.mintCloudflarePreviewGrant.mockResolvedValue(null);
});

describe("preview reads never mutate runtime identity", () => {
  it("keeps repeated project reads free of DML", async () => {
    await loadPreviewProject(17);
    await loadPreviewProject(17);

    expect(state.select).toHaveBeenCalledTimes(2);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("keeps the load-before-auth denial path free of DML", async () => {
    const project = await loadPreviewProject(17);

    await expect(userCanPreviewProject(project!, null)).resolves.toBe(false);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("keeps the static fallback path free of DML", async () => {
    state.isContainerLayerConfigured.mockResolvedValue(false);
    const project = { ...previewProject(), containerId: null, containerUrl: null };

    await handleLivePreviewHttp(
      { originalUrl: "/api/projects/17/preview/" } as Request,
      {} as Response,
      vi.fn() as NextFunction,
      project,
    );

    expect(state.serveProjectFilesPreview).toHaveBeenCalledTimes(1);
    expect(state.update).not.toHaveBeenCalled();
  });

  it("never serves same-origin project code after runtime transport was selected", async () => {
    state.isContainerLayerConfigured.mockResolvedValue(false);
    const { record, response } = responseRecorder();

    await handleLivePreviewHttp(
      { originalUrl: "/api/projects/17/preview/" } as Request,
      response,
      vi.fn() as NextFunction,
      previewProject(),
    );

    expect(record.status).toBe(502);
    expect(record.headers.get("X-MustaFlow-Preview-State")).toBe("proxy-unavailable");
    expect(record.body).toContain("Container preview unavailable");
    expect(state.serveProjectFilesPreview).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("keeps the WebSocket upgrade path free of DML", async () => {
    state.project = { ...previewProject(), status: "published" };
    const socket = { destroy: vi.fn() } as unknown as Socket;
    const request = {
      url: "/api/projects/17/preview/socket",
      headers: {},
    } as IncomingMessage;

    await handleLivePreviewUpgrade(17, request, socket, Buffer.alloc(0));

    expect(state.proxyUpgrade).not.toHaveBeenCalled();
    expect(socket.destroy).toHaveBeenCalledTimes(1);
    expect(state.select).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });

  it.each(["draft", "published"])(
    "never proxies %s private HTML to a stale direct-container URL",
    async (status) => {
      const { record, response } = responseRecorder();
      await handleLivePreviewHttp(
        { originalUrl: "/api/projects/17/preview/" } as Request,
        response,
        vi.fn() as NextFunction,
        { ...previewProject(), status },
      );
      expect(record.status).toBe(502);
      expect(record.body).toContain("isolated Cloudflare preview");
      expect(record.headers.get("X-MustaFlow-Preview-State")).toBe("proxy-unavailable");
      expect(state.proxyHttp).not.toHaveBeenCalled();
      expect(state.proxyUpgrade).not.toHaveBeenCalled();
      expect(state.serveProjectFilesPreview).not.toHaveBeenCalled();
      expect(state.update).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "null", "https://www.mustaflow.com", "https://hostile.invalid"])(
    "does not reopen private API sockets for Origin %s",
    async (origin) => {
      const socket = { destroy: vi.fn() } as unknown as Socket;
      await handleLivePreviewUpgrade(
        17,
        {
          url: "/api/projects/17/preview/socket",
          headers: { origin, host: "www.mustaflow.com", cookie: "__session=fixture" },
        } as IncomingMessage,
        socket,
        Buffer.alloc(0),
      );
      expect(socket.destroy).toHaveBeenCalledTimes(1);
      expect(state.proxyUpgrade).not.toHaveBeenCalled();
      expect(state.select).not.toHaveBeenCalled();
    },
  );

  it("hands a private running runtime to isolated Cloudflare without same-origin HTML proxying", async () => {
    state.mintCloudflarePreviewGrant.mockResolvedValue({
      launchUrl:
        "https://runtime.example.workers.dev/_nabuflow/preview/v1/runtime-17/?__nfg=fixture",
    });
    const { record, response } = responseRecorder();
    await handleLivePreviewHttp(
      { originalUrl: "/api/projects/17/preview/dashboard?view=live" } as Request,
      response,
      vi.fn() as NextFunction,
      previewProject(),
    );
    expect(record.status).toBe(302);
    expect(record.headers.get("Location")).toBe(
      "https://runtime.example.workers.dev/_nabuflow/preview/v1/runtime-17/dashboard?__nfg=fixture&view=live",
    );
    expect(record.headers.get("Referrer-Policy")).toBe("no-referrer");
    expect(state.proxyHttp).not.toHaveBeenCalled();
    expect(state.proxyUpgrade).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });

  it("preserves stored runtime identity when local credentials are absent", async () => {
    const loaded = await loadPreviewProject(17);

    expect(loaded).toMatchObject({
      containerId: "runtime-17",
      containerUrl: "http://runtime.internal",
      containerStatus: "running",
    });
    expect(state.hasContainerLayerCredentials).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
  });
});

describe("embedded preview loading and failure documents", () => {
  it.each([
    {
      label: "starting",
      containerStatus: "starting",
      configured: true,
      status: 503,
      previewState: "container-starting",
    },
    {
      label: "runtime error",
      containerStatus: "error",
      configured: true,
      status: 502,
      previewState: "container-error",
    },
    {
      label: "missing runtime transport",
      containerStatus: "running",
      configured: false,
      status: 502,
      previewState: "proxy-unavailable",
    },
    {
      label: "missing private handoff",
      containerStatus: "running",
      configured: true,
      status: 502,
      previewState: "proxy-unavailable",
    },
  ])(
    "protects the $label response without reporting a successful preview",
    async ({ containerStatus, configured, status, previewState }) => {
      state.isContainerLayerConfigured.mockResolvedValue(configured);
      const { record, response } = responseRecorder();
      await handleLivePreviewHttp(
        { originalUrl: "/api/projects/17/preview/" } as Request,
        response,
        vi.fn() as NextFunction,
        { ...previewProject(), containerStatus },
      );
      expect(record.status).toBe(status);
      expect(record.headers.get("X-MustaFlow-Preview-State")).toBe(previewState);
      expect(record.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
      expect(record.headers.get("Content-Security-Policy")).toContain(
        "sandbox allow-scripts allow-forms allow-popups",
      );
      expect(record.headers.get("Referrer-Policy")).toBe("no-referrer");
      expect(record.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(record.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
      expect(state.proxyHttp).not.toHaveBeenCalled();
      expect(state.serveProjectFilesPreview).not.toHaveBeenCalled();
      expect(state.update).not.toHaveBeenCalled();
    },
  );

  it("preserves existing strict document policies on a starting response", async () => {
    const { record, response } = responseRecorder();
    response.setHeader("Content-Security-Policy", "default-src 'none'");
    response.setHeader("Cross-Origin-Embedder-Policy", 'require-corp; report-to="preview"');
    await handleLivePreviewHttp(
      { originalUrl: "/api/projects/17/preview/" } as Request,
      response,
      vi.fn() as NextFunction,
      { ...previewProject(), containerStatus: "starting" },
    );
    expect(record.headers.get("Content-Security-Policy")).toEqual([
      "default-src 'none'",
      "sandbox allow-scripts allow-forms allow-popups",
    ]);
    expect(record.headers.get("Cross-Origin-Embedder-Policy")).toBe(
      'require-corp; report-to="preview"',
    );
  });
});

describe("sealed Cloudflare preview GET recovery boundary", () => {
  const unavailableCases: Array<{
    label: string;
    containerStatus: string;
    containerUrl: string | null;
    containerId?: string | null;
    configured?: boolean;
    publicRequestUrl?: string;
    status?: number;
    previewState?: string;
  }> = [
    {
      label: "hibernated with a historical direct URL",
      containerStatus: "hibernated",
      containerUrl: "http://runtime.internal",
    },
    {
      label: "hibernated without a private direct URL",
      containerStatus: "hibernated",
      containerUrl: null,
    },
    {
      label: "stopped without a private direct URL",
      containerStatus: "stopped",
      containerUrl: null,
    },
    {
      label: "starting without a private direct URL",
      containerStatus: "starting",
      containerUrl: null,
    },
    {
      label: "failed without a private direct URL",
      containerStatus: "error",
      containerUrl: null,
      status: 502,
      previewState: "container-error",
    },
    {
      label: "running without a signed launch grant",
      containerStatus: "running",
      containerUrl: null,
      status: 502,
    },
    {
      label: "missing runtime identity",
      containerStatus: "hibernated",
      containerUrl: null,
      containerId: null,
    },
    {
      label: "unconfigured private transport",
      containerStatus: "hibernated",
      containerUrl: null,
      configured: false,
    },
    {
      label: "public-route cold preview",
      containerStatus: "hibernated",
      containerUrl: null,
      publicRequestUrl: "/notebook",
    },
  ];

  function expectNoRuntimeWork() {
    expect(state.provisionContainer).not.toHaveBeenCalled();
    expect(state.withActiveProjectLifecycle).not.toHaveBeenCalled();
    expect(state.getContainerSecretMap).not.toHaveBeenCalled();
    expect(state.select).not.toHaveBeenCalled();
    expect(state.update).not.toHaveBeenCalled();
    expect(state.insert).not.toHaveBeenCalled();
    expect(state.delete).not.toHaveBeenCalled();
    expect(state.proxyHttp).not.toHaveBeenCalled();
    expect(state.serveProjectFilesPreview).not.toHaveBeenCalled();
    expect(state.isContainerLayerConfigured).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  }

  it.each(unavailableCases)(
    "keeps $label read-only without an accepted-release lookup",
    async (sample) => {
      state.runtimeProviderId = "cloudflare";
      state.isContainerLayerConfigured.mockResolvedValue(sample.configured ?? true);
      // No accepted release or project files are available in this fixture.
      // The unavailable GET must not consult either store or manufacture a runtime.
      state.select.mockImplementation(() => ({
        from: vi.fn(() => ({ where: vi.fn(async () => []) })),
      }));
      vi.useFakeTimers({ toFake: ["setImmediate"] });
      try {
        for (let request = 0; request < 2; request += 1) {
          const { record, response } = responseRecorder();
          await handleLivePreviewHttp(
            { originalUrl: "/api/projects/17/preview/" } as Request,
            response,
            vi.fn() as NextFunction,
            {
              ...previewProject(),
              containerStatus: sample.containerStatus,
              containerId: sample.containerId === undefined ? "runtime-17" : sample.containerId,
              containerUrl: sample.containerUrl,
            },
            sample.publicRequestUrl ? { publicRequestUrl: sample.publicRequestUrl } : undefined,
          );
          expect(record.status).toBe(sample.status ?? 503);
          expect(record.headers.get("X-MustaFlow-Preview-State")).toBe(
            sample.previewState ?? "proxy-unavailable",
          );
          expect(record.body).toContain("Opening this page does not start or rebuild the app.");
          expect(record.body).toContain("Use Wake preview");
          expect(record.body).toContain("If a fresh build is required");
          expect(record.body).toContain("Retry Build in Project history");
          expect(record.body).not.toMatch(/http-equiv=["']refresh/i);
          expect(record.body).not.toContain("Starting your app");
          expect(record.headers.has("Location")).toBe(false);
          expect(record.headers.get("Cross-Origin-Embedder-Policy")).toBe("credentialless");
          expect(record.headers.get("Content-Security-Policy")).toContain(
            "sandbox allow-scripts allow-forms allow-popups",
          );
          expect(record.headers.get("Referrer-Policy")).toBe("no-referrer");
          expect(record.headers.get("X-Content-Type-Options")).toBe("nosniff");
          expect(record.headers.get("Cache-Control")).toBe("no-store, must-revalidate");
        }
        expectNoRuntimeWork();
        expect(state.mintCloudflarePreviewGrant).toHaveBeenCalledTimes(
          sample.containerStatus === "running" ? 2 : 0,
        );
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it.each([null, "http://runtime.internal"])(
    "preserves an existing signed running launch with direct URL %s",
    async (containerUrl) => {
      state.runtimeProviderId = "cloudflare";
      state.mintCloudflarePreviewGrant.mockResolvedValue({
        launchUrl:
          "https://runtime.example.workers.dev/_nabuflow/preview/v1/runtime-17/?__nfg=fixture",
      });
      vi.useFakeTimers({ toFake: ["setImmediate"] });
      try {
        const { record, response } = responseRecorder();
        await handleLivePreviewHttp(
          { originalUrl: "/api/projects/17/preview/notebook?lang=ar" } as Request,
          response,
          vi.fn() as NextFunction,
          { ...previewProject(), containerUrl },
        );
        expect(record.status).toBe(302);
        expect(record.headers.get("Location")).toBe(
          "https://runtime.example.workers.dev/_nabuflow/preview/v1/runtime-17/notebook?__nfg=fixture&lang=ar",
        );
        expect(record.headers.get("Cache-Control")).toBe("no-store");
        expect(record.headers.get("Referrer-Policy")).toBe("no-referrer");
        expect(record.body).toBe("");
        expectNoRuntimeWork();
      } finally {
        vi.clearAllTimers();
        vi.useRealTimers();
      }
    },
  );

  it("retains legacy provider cold-start provisioning where supported", async () => {
    state.runtimeProviderId = "fly";
    const files = [{ path: "index.html", content: "<h1>fixture</h1>" }];
    state.select.mockImplementation(() => ({
      from: vi.fn(() => ({ where: vi.fn(async () => files) })),
    }));
    vi.useFakeTimers({ toFake: ["setImmediate"] });
    try {
      const { record, response } = responseRecorder();
      await handleLivePreviewHttp(
        { originalUrl: "/api/projects/17/preview/" } as Request,
        response,
        vi.fn() as NextFunction,
        { ...previewProject(), containerStatus: "hibernated", containerUrl: null },
      );
      expect(record.status).toBe(503);
      expect(record.headers.get("X-MustaFlow-Preview-State")).toBe("container-starting");
      expect(record.body).toMatch(/http-equiv=["']refresh/i);
      expect(vi.getTimerCount()).toBe(1);
      await vi.runAllTimersAsync();
      expect(state.withActiveProjectLifecycle).toHaveBeenCalledTimes(1);
      expect(state.getContainerSecretMap).toHaveBeenCalledTimes(1);
      expect(state.provisionContainer).toHaveBeenCalledExactlyOnceWith(
        17,
        files,
        {},
        { servicePort: 3000 },
      );
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });
});
