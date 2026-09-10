import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../lib/agent-senses", () => ({ takeScreenshot: vi.fn() }));
vi.mock("../lib/builder", () => ({ runConversePipeline: vi.fn() }));
vi.mock("../lib/auth", () => ({ requireProjectOwnership: vi.fn() }));
vi.mock("../lib/tenant-runtime", () => ({ tenantRuntimeProvider: {} }));
vi.mock("../lib/livePreviewProxy", () => ({
  shouldRouteToLivePreview: () => true,
  resolveCloudflareLivePreviewLaunchUrl: vi.fn(),
}));
vi.mock("../lib/zero-intent-admission", () => ({ governIntentAdmission: vi.fn() }));
vi.mock("../lib/zero-intent-receipt-store", () => ({ intentReceiptStore: {} }));
vi.mock("../lib/zero-terminal-persistence", () => ({
  persistZeroTerminal: vi.fn(),
  zeroTerminalRef: vi.fn(),
}));
vi.mock("../lib/nabuflow-billing", () => ({ nabuflowGateHttpError: vi.fn() }));

import { createSnapshotObserveRouter, type SnapshotObserveDependencies } from "./snapshot-observe";
import type { PreviewVersionWitness } from "../lib/preview-version-provenance";

const witness: PreviewVersionWitness = {
  projectId: 81,
  versionId: 100,
  sourceSha256: "a".repeat(64),
  sealedArtifactSha256: "b".repeat(64),
  runtimeIdentity: "runtime-81",
  manifestRevision: "manifest-v1",
};
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");

function setup(witnesses?: Array<PreviewVersionWitness | null>) {
  const release = vi.fn(async () => {});
  const complete = vi.fn(async (input) => {
    expect(release).not.toHaveBeenCalled();
    return { versionId: input.project.versionId, provenance: input.versionProvenance };
  });
  const dependencies: SnapshotObserveDependencies = {
    loadProject: vi.fn(async () => ({
      id: 81,
      name: "Capture fixture",
      ownerId: "owner",
      status: "ready",
      builderMode: "agentic",
      agentMode: "eco",
      containerId: "runtime-81",
      containerStatus: "running",
      runtimePort: 3000,
      stack: "node",
      versionId: 999,
    })),
    resolveCloudflarePreview: vi.fn(async () => "https://capture.invalid/"),
    capture: vi.fn(async () => {
      expect(release).not.toHaveBeenCalled();
      return { ok: true, base64: png, finalUrl: "https://capture.invalid/" };
    }),
    complete,
    holdLifecycle: vi.fn(() => release),
    ...(witnesses ? { readVersionWitness: vi.fn(async () => witnesses.shift() ?? null) } : {}),
  };
  const app = express();
  app.use(express.json());
  app.use(
    createSnapshotObserveRouter(dependencies, (req, _res, next) => {
      req.userId = "owner";
      next();
    }),
  );
  return { app, dependencies, release, complete };
}

function capture(app: ReturnType<typeof express>) {
  return request(app)
    .post("/projects/81/observe/snapshot")
    .send({
      path: "/",
      previewSource: "server",
      viewport: { width: 1280, height: 800 },
    });
}

describe("snapshot observation version boundary", () => {
  beforeEach(() => vi.stubEnv("TENANT_RUNTIME_PROVIDER", "cloudflare"));

  it("does not attach the newest version without capture witnesses", async () => {
    const s = setup();
    const result = await capture(s.app);
    expect(result.status).toBe(200);
    expect(result.body.versionId).toBeNull();
    expect(result.body.provenance.state).toBe("unverified");
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it("binds the observed sealed version, never the latest-version shortcut", async () => {
    const s = setup([witness, { ...witness }]);
    const result = await capture(s.app);
    expect(result.status).toBe(200);
    expect(result.body.versionId).toBe(100);
    expect(result.body.provenance.state).toBe("verified");
    expect(s.dependencies.readVersionWitness).toHaveBeenCalledTimes(2);
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it("keeps the image unversioned when the running artifact changes during capture", async () => {
    const s = setup([witness, { ...witness, sealedArtifactSha256: "c".repeat(64) }]);
    const result = await capture(s.app);
    expect(result.status).toBe(200);
    expect(result.body.versionId).toBeNull();
    expect(result.body.provenance.state).toBe("unverified");
  });

  it("does not bind a foreign project's witness", async () => {
    const foreign = { ...witness, projectId: 82 };
    const s = setup([foreign, foreign]);
    const result = await capture(s.app);
    expect(result.body.versionId).toBeNull();
    expect(result.body.provenance.state).toBe("unverified");
  });

  it("releases the lifecycle hold after capture failure without persisting an image", async () => {
    const s = setup([witness]);
    vi.mocked(s.dependencies.capture).mockRejectedValue(new Error("capture unavailable"));
    const result = await capture(s.app);
    expect(result.status).toBe(503);
    expect(s.complete).not.toHaveBeenCalled();
    expect(s.release).toHaveBeenCalledTimes(1);
  });

  it("releases the lifecycle hold after persistence failure", async () => {
    const s = setup([witness, witness]);
    s.complete.mockRejectedValue(new Error("storage unavailable"));
    const result = await capture(s.app);
    expect(result.status).toBe(503);
    expect(s.release).toHaveBeenCalledTimes(1);
  });
});
