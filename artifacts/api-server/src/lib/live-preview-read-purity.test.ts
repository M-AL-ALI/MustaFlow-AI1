import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { NextFunction, Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  project: {} as Record<string, unknown>,
  select: vi.fn(),
  update: vi.fn(),
  serveProjectFilesPreview: vi.fn(async () => undefined),
  hasContainerLayerCredentials: vi.fn(() => false),
  isContainerLayerConfigured: vi.fn(async () => true),
  proxyUpgrade: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  and: vi.fn(() => ({ kind: "and" })),
  eq: vi.fn(() => ({ kind: "eq" })),
}));

vi.mock("@workspace/db", () => ({
  db: {
    select: state.select,
    update: state.update,
  },
  projectsTable: {
    id: "id",
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
  createProxyMiddleware: vi.fn(() => Object.assign(vi.fn(), { upgrade: state.proxyUpgrade })),
}));
vi.mock("./cloudflare-preview-grant", () => ({
  mintCloudflarePreviewGrant: vi.fn(async () => null),
}));
vi.mock("./container-secrets", () => ({ getContainerSecretMap: vi.fn(async () => ({})) }));
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
  provisionContainer: vi.fn(),
  tenantRuntimeProvider: {
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
  const record = { status: 0, headers: new Map<string, string>(), body: "" };
  const response = {
    setHeader(name: string, value: string) {
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
  } as unknown as Response;
  return { record, response };
}

beforeEach(() => {
  vi.clearAllMocks();
  state.project = previewProject();
  state.select.mockImplementation(() => ({
    from: vi.fn(() => ({
      where: vi.fn(async () => [state.project]),
    })),
  }));
  state.isContainerLayerConfigured.mockResolvedValue(true);
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

    expect(state.proxyUpgrade).toHaveBeenCalledTimes(1);
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
