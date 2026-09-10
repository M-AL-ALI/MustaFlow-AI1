import express, { type RequestHandler } from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { createPageMapRouter } from "./page-map";
import { pageMapRevision } from "../lib/page-map-revision";
// This suite isolates revision and persistence contracts; lifecycle ordering has its own suite.
vi.mock("../lib/project-lifecycle", () => ({
  requireActiveProjectLifecycleSession: (_req: unknown, _res: unknown, next: () => void) => next(),
  holdResponseProjectLifecycleSession: () => async () => {},
}));
import type { PageMapRepository } from "../lib/page-map-repository";
vi.mock("../lib/auth", () => ({
  requireProjectOwnership: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("@workspace/integrations-openai-ai-server", () => ({
  openai: {
    chat: { completions: { create: vi.fn().mockRejectedValue(new Error("AI unavailable")) } },
  },
}));
const node = {
  id: "home",
  label: "Home",
  pageType: "other" as const,
  filePath: "index.html",
  position: { x: 0, y: 0 },
  isNew: false,
  hasError: false,
  aiGenerated: true,
  notes: "",
};
const empty = { nodes: [], edges: [] };
function harness(conflict = false, missing = false) {
  const map = { web: { nodes: [node], edges: [] }, ios: empty, android: empty };
  const repository: PageMapRepository = {
    read: vi.fn(async () => (missing ? null : { pageMapData: map })),
    readFiles: vi.fn(async () => ({
      files: [{ path: "index.html", content: "<h1>Home</h1>", mimeType: "text/html" }],
      revision: "snapshot-one",
    })),
    write: vi.fn(async () => !conflict),
  };
  const owner: RequestHandler = (req, res, next) => {
    if (req.get("x-user") !== "owner") {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    next();
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, "log", { value: { info: vi.fn() } });
    next();
  });
  app.use(createPageMapRouter(repository, owner));
  return { app, repository, map };
}
describe("governed Page Map requests", () => {
  it("does not read another owner's map", async () => {
    const h = harness();
    expect((await request(h.app).get("/projects/901/page-map").set("x-user", "other")).status).toBe(
      404,
    );
    expect(h.repository.read).not.toHaveBeenCalled();
  });
  it("returns non-revealing not found for missing projects", async () => {
    const h = harness(false, true);
    expect((await request(h.app).get("/projects/901/page-map").set("x-user", "owner")).status).toBe(
      404,
    );
  });
  it("rejects malformed mutations before persistence", async () => {
    const h = harness();
    expect(
      (
        await request(h.app)
          .put("/projects/901/page-map")
          .set("x-user", "owner")
          .send({ web: { nodes: [null], edges: [] } })
      ).status,
    ).toBe(400);
    expect(h.repository.write).not.toHaveBeenCalled();
  });
  it("saves a valid change against the exact original map snapshot", async () => {
    const h = harness();
    expect(
      (
        await request(h.app)
          .put("/projects/901/page-map")
          .set("x-user", "owner")
          .send({ web: empty, expectedRevision: pageMapRevision(h.map) })
      ).status,
    ).toBe(200);
    expect(h.repository.write).toHaveBeenCalledWith(901, { ...h.map, web: empty }, h.map);
  });
  it("does not claim success when a concurrent save or retirement wins", async () => {
    const h = harness(true);
    expect(
      (
        await request(h.app)
          .put("/projects/901/page-map")
          .set("x-user", "owner")
          .send({ web: empty, expectedRevision: pageMapRevision(h.map) })
      ).status,
    ).toBe(409);
  });
  it("fences analysis against the files that were actually read", async () => {
    const h = harness();
    const response = await request(h.app)
      .post("/projects/901/page-map/analyze")
      .set("x-user", "owner");
    expect(response.status).toBe(200);
    expect(h.repository.write).toHaveBeenCalledWith(901, expect.any(Object), h.map, "snapshot-one");
  });
  it("rejects superseded analysis rather than overwrite a newer map", async () => {
    const h = harness(true);
    expect(
      (await request(h.app).post("/projects/901/page-map/analyze").set("x-user", "owner")).status,
    ).toBe(409);
  });
});
describe("Page Map browser revision handshake", () => {
  it("returns a revision tied to the snapshot and acknowledges the changed version", async () => {
    const h = harness();
    const initial = await request(h.app).get("/projects/901/page-map").set("x-user", "owner");
    expect(initial.body.revision).toBe(pageMapRevision(h.map));
    const saved = await request(h.app)
      .put("/projects/901/page-map")
      .set("x-user", "owner")
      .send({ web: empty, expectedRevision: initial.body.revision });
    expect(saved.status).toBe(200);
    expect(saved.body.revision).toBe(pageMapRevision({ ...h.map, web: empty }));
    expect(saved.body.revision).not.toBe(initial.body.revision);
  });
  it.each([undefined, "0".repeat(64)])(
    "rejects absent or stale editing versions without writing (%s)",
    async (expectedRevision) => {
      const h = harness();
      const response = await request(h.app)
        .put("/projects/901/page-map")
        .set("x-user", "owner")
        .send({ web: empty, expectedRevision });
      expect(response.status).toBe(409);
      expect(h.repository.write).not.toHaveBeenCalled();
    },
  );
  it("rejects malformed version tokens", async () => {
    const h = harness();
    expect(
      (
        await request(h.app)
          .put("/projects/901/page-map")
          .set("x-user", "owner")
          .send({ web: empty, expectedRevision: "not-a-revision" })
      ).status,
    ).toBe(400);
    expect(h.repository.write).not.toHaveBeenCalled();
  });
  it("does not overwrite a newer map with a client that read the earlier version", async () => {
    const h = harness();
    const earlier = pageMapRevision(h.map);
    vi.mocked(h.repository.read).mockResolvedValue({
      pageMapData: { ...h.map, web: { nodes: [{ ...node, notes: "Newer edit" }], edges: [] } },
    });
    expect(
      (
        await request(h.app)
          .put("/projects/901/page-map")
          .set("x-user", "owner")
          .send({ web: empty, expectedRevision: earlier })
      ).status,
    ).toBe(409);
    expect(h.repository.write).not.toHaveBeenCalled();
  });
  it("preserves all manual pages when analysis would exceed the node limit", async () => {
    const h = harness();
    const manual = Array.from({ length: 500 }, (_, i) => ({
      ...node,
      id: "manual-" + i,
      aiGenerated: false,
      filePath: "",
      label: "Manual " + i,
    }));
    vi.mocked(h.repository.read).mockResolvedValue({
      pageMapData: { ...h.map, web: { nodes: manual, edges: [] } },
    });
    expect(
      (await request(h.app).post("/projects/901/page-map/analyze").set("x-user", "owner")).status,
    ).toBe(422);
    expect(h.repository.write).not.toHaveBeenCalled();
  });
});
