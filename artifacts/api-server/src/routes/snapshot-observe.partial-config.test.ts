import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/snapshot_observe_partial";
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??= "http://127.0.0.1:9/v1";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??= "test-placeholder";
});

const runtimeMocks = vi.hoisted(() => ({
  getGatewayHostname: vi.fn(() => {
    throw new Error("gateway-hostname must not resolve during import");
  }),
  getGatewayLabel: vi.fn(() => {
    throw new Error("gateway-label must not resolve during import");
  }),
  isGatewayReachable: vi.fn(async () => {
    throw new Error("gateway-reachability is unavailable");
  }),
}));

vi.mock("../lib/tenant-runtime", () => ({
  hasContainerLayerCredentials: () => false,
  isContainerLayerConfigured: async () => false,
  provisionContainer: vi.fn(),
  tenantRuntimeProvider: runtimeMocks,
}));

const ownerOnly: RequestHandler = (req, _res, next) => {
  req.userId = "owner-1";
  next();
};

describe("snapshot observe under partial runtime configuration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.TENANT_RUNTIME_PROVIDER = "cloudflare";
  });

  it("imports without resolving an unavailable runtime gateway", async () => {
    const imported = await import("./snapshot-observe");

    expect(imported.createSnapshotObserveRouter).toBeTypeOf("function");
    expect(runtimeMocks.getGatewayHostname).not.toHaveBeenCalled();
    expect(runtimeMocks.getGatewayLabel).not.toHaveBeenCalled();
    expect(runtimeMocks.isGatewayReachable).not.toHaveBeenCalled();
  });

  it("keeps a Cloudflare snapshot unavailable and write-free when capture is unavailable", async () => {
    const { createSnapshotObserveRouter } = await import("./snapshot-observe");
    const capture = vi.fn(async () => ({ ok: false, error: "runtime unavailable" }));
    const complete = vi.fn();
    const app = express();
    app.use(express.json());
    app.use(
      createSnapshotObserveRouter(
        {
          loadProject: async () => ({
            id: 51,
            name: "Flag site",
            ownerId: "owner-1",
            status: "draft",
            agentMode: "eco",
            builderMode: "agentic",
            containerId: "runtime-1",
            containerStatus: "running",
          }),
          capture,
          complete,
        },
        ownerOnly,
      ),
    );

    const response = await request(app)
      .post("/projects/51/observe/snapshot")
      .set("Cookie", "__session=session-token")
      .send({
        path: "/",
        previewSource: "server",
        viewport: { width: 1280, height: 800 },
      });

    expect(response.status).toBe(503);
    expect(response.body.code).toBe("snapshot_unavailable");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
    expect(runtimeMocks.getGatewayHostname).not.toHaveBeenCalled();
    expect(runtimeMocks.getGatewayLabel).not.toHaveBeenCalled();
    expect(runtimeMocks.isGatewayReachable).not.toHaveBeenCalled();
  });
});
