import express, { type RequestHandler } from "express";
import { readFileSync } from "node:fs";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  process.env.DATABASE_URL ??= "postgresql://test:test@127.0.0.1:1/snapshot_observe";
  process.env.AI_INTEGRATIONS_OPENAI_BASE_URL ??= "http://127.0.0.1:9/v1";
  process.env.AI_INTEGRATIONS_OPENAI_API_KEY ??= "test-placeholder";
});
import {
  MAX_SNAPSHOT_BYTES,
  createSnapshotObserveRouter,
  snapshotPreviewClass,
  type SnapshotCompletionInput,
  type SnapshotObserveDependencies,
  type SnapshotProject,
} from "./snapshot-observe";

const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function png(bytes = 64): string {
  return Buffer.concat([PNG_MAGIC, Buffer.alloc(Math.max(0, bytes - PNG_MAGIC.length))]).toString(
    "base64",
  );
}

function project(overrides: Partial<SnapshotProject> = {}): SnapshotProject {
  return {
    id: 51,
    name: "Flag site",
    ownerId: "owner-1",
    status: "draft",
    agentMode: "eco",
    builderMode: "static-legacy",
    containerId: null,
    containerStatus: "stopped",
    ...overrides,
  };
}

const ownerOnly: RequestHandler = (req, res, next) => {
  req.userId = req.get("x-test-user") ?? undefined;
  if (req.userId !== "owner-1") {
    res.status(404).json({ error: "Project not found" });
    return;
  }
  next();
};

function body(overrides: Record<string, unknown> = {}) {
  return {
    path: "/",
    previewSource: "server",
    viewport: { width: 1280, height: 800 },
    ...overrides,
  };
}

function harness(options: {
  project?: SnapshotProject | null;
  capture?: SnapshotObserveDependencies["capture"];
}) {
  const writes = {
    receipts: 0,
    messages: 0,
    tasks: 0,
    credits: 0,
    files: 0,
    versions: 0,
    storage: 0,
    provenance: 0,
  };
  const completions: SnapshotCompletionInput[] = [];
  const captureImpl: SnapshotObserveDependencies["capture"] =
    options.capture ?? (async () => ({ ok: true, base64: png(), bytes: 64, status: 200 }));
  const capture = vi.fn(captureImpl);
  const complete = vi.fn(async (input: SnapshotCompletionInput) => {
    completions.push(input);
    writes.receipts += 1;
    writes.messages += 2;
    writes.tasks += 1;
    writes.credits += 1;
    return { ok: true, previewClass: input.previewClass };
  });
  const dependencies: SnapshotObserveDependencies = {
    loadProject: vi.fn(async () => (options.project === undefined ? project() : options.project)),
    capture,
    complete,
  };
  const app = express();
  app.use(express.json());
  app.use(createSnapshotObserveRouter(dependencies, ownerOnly));
  return { app, writes, completions, capture, complete };
}

function post(app: express.Express, payload = body(), user = "owner-1") {
  return request(app)
    .post("/projects/51/observe/snapshot")
    .set("x-test-user", user)
    .set("Cookie", "__session=session-token; unrelated=not-forwarded")
    .send(payload);
}

describe("snapshot observe route", () => {
  beforeEach(() => {
    process.env.TENANT_RUNTIME_PROVIDER = "fly";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.TENANT_RUNTIME_PROVIDER;
  });

  it("captures a real PNG, hands the image to observe, and writes no build state", async () => {
    const { app, completions, capture, writes } = harness({});
    const response = await post(app);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, previewClass: "db-static" });
    expect(capture).toHaveBeenCalledTimes(1);
    expect(capture).toHaveBeenCalledWith(
      expect.objectContaining({
        url: expect.stringContaining("/api/projects/51/preview/"),
        fullPage: false,
        exactCookieOrigin: expect.any(String),
        exactOriginCookies: [{ name: "__session", value: "session-token" }],
      }),
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]?.dataUri).toMatch(/^data:image\/png;base64,/u);
    expect(completions[0]?.previewClass).toBe("db-static");
    expect(writes.files).toBe(0);
    expect(writes.versions).toBe(0);
    expect(writes.storage).toBe(0);
    expect(writes.provenance).toBe(0);
  });

  it("denies another user before capture or vision", async () => {
    const { app, capture, complete } = harness({});
    const response = await post(app, body(), "other-user");
    expect(response.status).toBe(404);
    expect(capture).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });

  it("never sends a session cookie to an unconfigured production Host", async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousDomains = process.env.REPLIT_DOMAINS;
    process.env.NODE_ENV = "production";
    process.env.REPLIT_DOMAINS = "www.mustaflow.com";
    try {
      const { app, capture, complete } = harness({});
      const response = await request(app)
        .post("/projects/51/observe/snapshot")
        .set("Host", "attacker.example")
        .set("x-test-user", "owner-1")
        .set("Cookie", "__session=opaque")
        .send(body());
      expect(response.status).toBe(503);
      expect(capture).not.toHaveBeenCalled();
      expect(complete).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousDomains === undefined) delete process.env.REPLIT_DOMAINS;
      else process.env.REPLIT_DOMAINS = previousDomains;
    }
  });

  it.each([
    ["absolute URL", body({ path: "https://example.com/" })],
    ["oversize path", body({ path: `/${"a".repeat(512)}` })],
    ["bad source", body({ previewSource: "browser" })],
    ["bad width", body({ viewport: { width: 319, height: 800 } })],
    ["bad height", body({ viewport: { width: 1280, height: 1201 } })],
  ])("rejects %s before capture with zero writes", async (_name, payload) => {
    const { app, capture, complete, writes } = harness({});
    const response = await post(app, payload);
    expect(response.status).toBe(400);
    expect(capture).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(Object.values(writes).every((count) => count === 0)).toBe(true);
  });

  it("returns typed unavailability for a WebContainer without touching any state", async () => {
    const { app, capture, complete, writes } = harness({});
    const response = await post(app, body({ previewSource: "webcontainer" }));
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("snapshot_unavailable");
    expect(capture).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
    expect(Object.values(writes).every((count) => count === 0)).toBe(true);
  });

  it.each([
    ["missing target", null, async () => ({ ok: true, base64: png() })],
    ["missing session", project(), async () => ({ ok: true, base64: png() })],
    ["Chromium unavailable", project(), async () => ({ ok: false, error: "no chromium" })],
    ["timeout", project(), async () => ({ ok: false, error: "timeout" })],
    [
      "unsafe redirect",
      project(),
      async () => ({
        ok: true,
        base64: png(),
        status: 200,
        finalUrl: "https://outside.example/preview",
      }),
    ],
    ["empty capture", project(), async () => ({ ok: true, base64: "" })],
  ])("keeps %s failures typed and write-free", async (name, loaded, capture) => {
    const { app, complete, writes } = harness({ project: loaded, capture });
    const pending = request(app)
      .post("/projects/51/observe/snapshot")
      .set("x-test-user", "owner-1")
      .send(body());
    const response =
      name === "missing session" ? await pending : await pending.set("Cookie", "__session=x");
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("snapshot_unavailable");
    expect(complete).not.toHaveBeenCalled();
    expect(Object.values(writes).every((count) => count === 0)).toBe(true);
  });

  it("accepts exactly 4 MiB and rejects 4 MiB plus one before persistence", async () => {
    const accepted = harness({
      capture: async () => ({ ok: true, base64: png(MAX_SNAPSHOT_BYTES) }),
    });
    expect((await post(accepted.app)).status).toBe(200);
    expect(accepted.complete).toHaveBeenCalledTimes(1);

    const rejected = harness({
      capture: async () => ({ ok: true, base64: png(MAX_SNAPSHOT_BYTES + 1) }),
    });
    const response = await post(rejected.app);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("snapshot_unavailable");
    expect(rejected.complete).not.toHaveBeenCalled();
  });

  it("classifies database, runtime-proxy, and Cloudflare-grant captures honestly", () => {
    expect(snapshotPreviewClass(project())).toBe("db-static");
    expect(
      snapshotPreviewClass(
        project({ builderMode: "agentic", containerId: "runtime-1", containerStatus: "running" }),
        "fly",
      ),
    ).toBe("runtime-proxy");
    expect(
      snapshotPreviewClass(
        project({ builderMode: "agentic", containerId: "runtime-1", containerStatus: "running" }),
        "cloudflare",
      ),
    ).toBe("cloudflare-grant");
  });

  it("accepts a real PNG through the Cloudflare-grant preview class", async () => {
    process.env.TENANT_RUNTIME_PROVIDER = "cloudflare";
    const { app, completions } = harness({
      project: project({
        builderMode: "agentic",
        containerId: "runtime-1",
        containerStatus: "running",
      }),
      capture: async () => ({ ok: true, base64: png(128), bytes: 128, status: 200 }),
    });
    const response = await post(app);
    expect(response.status).toBe(200);
    expect(response.body.previewClass).toBe("cloudflare-grant");
    expect(completions[0]?.dataUri).toMatch(/^data:image\/png;base64,/u);
  });

  it("does not invisibly retry when a consumed Cloudflare grant capture fails", async () => {
    const capture = vi.fn(async () => ({ ok: false, error: "grant already consumed" }));
    const { app, complete } = harness({
      project: project({
        builderMode: "agentic",
        containerId: "runtime-1",
        containerStatus: "running",
      }),
      capture,
    });
    process.env.TENANT_RUNTIME_PROVIDER = "cloudflare";
    const response = await post(app);
    expect(response.status).toBe(503);
    expect(response.body.code).toBe("snapshot_unavailable");
    expect(capture).toHaveBeenCalledTimes(1);
    expect(complete).not.toHaveBeenCalled();
  });

  it("pins the production creator to an observe receipt and a named preview-class response", () => {
    const source = readFileSync(new URL("./snapshot-observe.ts", import.meta.url), "utf8");
    expect(source).toContain('intent: "observe"');
    expect(source).toContain('decidingSource: "snapshot_control"');
    expect(source).toContain('reasonCode: "snapshot_request"');
    expect(source).toContain("mutationCapable: false");
    expect(source).toContain("I captured the ${input.previewClass} preview.");
    expect(source).not.toContain("mutationCapable: true");
  });
});
