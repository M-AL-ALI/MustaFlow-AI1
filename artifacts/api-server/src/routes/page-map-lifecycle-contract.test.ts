import express, { type RequestHandler } from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPageMapRouter } from "./page-map";
import { pageMapRevision } from "../lib/page-map-revision";
import type { PageMapRepository } from "../lib/page-map-repository";

const boundary = vi.hoisted(() => ({ events: [] as string[], allowed: true, analyze: vi.fn() }));
vi.mock("../lib/auth", () => ({
  requireProjectOwnership: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../lib/page-map", () => ({ extractPageMapForFiles: boundary.analyze }));
vi.mock("../lib/page-map-repository", () => ({ pageMapRepository: {} }));
// Composition proof, not a PostgreSQL lock simulation. Existing lifecycle helpers
// are replaced with observable admission/hold contracts; database races need PG tests.
vi.mock("../lib/project-lifecycle", () => ({
  requireActiveProjectLifecycleSession: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    boundary.events.push("admit:" + Number(req.params.id));
    if (!boundary.allowed) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    res.locals.fixtureAdmission = true;
    next();
  },
  holdResponseProjectLifecycleSession: (res: express.Response) => {
    if (!res.locals.fixtureAdmission) throw new Error("missing admission");
    boundary.events.push("hold");
    return async () => {
      boundary.events.push("release");
    };
  },
}));
const empty = { nodes: [], edges: [] };
const map = { web: empty, ios: empty, android: empty };

function harness() {
  let response: express.Response | undefined;
  const repository: PageMapRepository = {
    read: vi.fn(async () => {
      boundary.events.push("read");
      return { pageMapData: map };
    }),
    readFiles: vi.fn(async () => {
      boundary.events.push("files");
      return { files: [], revision: "files" };
    }),
    write: vi.fn(async () => {
      boundary.events.push("write");
      return true;
    }),
  };
  const owner: RequestHandler = (req, res, next) => {
    boundary.events.push("owner");
    if (req.get("x-owner") !== "yes") {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    next();
  };
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    response = res;
    Object.defineProperty(req, "log", { value: { info: vi.fn() } });
    next();
  });
  app.use(createPageMapRouter(repository, owner));
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(503).json({ error: "Fixture failure" });
    },
  );
  return { app, repository, response: () => response };
}
beforeEach(() => {
  boundary.events.length = 0;
  boundary.allowed = true;
  boundary.analyze.mockReset().mockImplementation(async () => {
    boundary.events.push("analyze");
    return empty;
  });
});

describe("Page Map mutation lifecycle composition (fake storage)", () => {
  it.each(["12", "0012", "%31%32"])(
    "admits decoded project %s and holds the save until completion",
    async (id) => {
      const h = harness();
      const response = await request(h.app)
        .put("/projects/" + id + "/page-map")
        .set("x-owner", "yes")
        .send({ web: empty, expectedRevision: pageMapRevision(map) });
      expect(response.status).toBe(200);
      expect(boundary.events).toEqual(["owner", "admit:12", "hold", "read", "write", "release"]);
    },
  );
  it.each(["12", "0012", "%31%32"])("holds analysis for decoded project %s", async (id) => {
    const h = harness();
    const response = await request(h.app)
      .post("/projects/" + id + "/page-map/analyze")
      .set("x-owner", "yes");
    expect(response.status).toBe(200);
    expect(boundary.events).toEqual([
      "owner",
      "admit:12",
      "hold",
      "read",
      "files",
      "analyze",
      "write",
      "release",
    ]);
  });
  it.each(["put", "post"] as const)(
    "rejects nonowners before lifecycle admission for %s",
    async (method) => {
      const h = harness();
      const pending = request(h.app)[method](
        "/projects/%31%32/page-map" + (method === "post" ? "/analyze" : ""),
      );
      const response = await pending.send({ web: empty, expectedRevision: pageMapRevision(map) });
      expect(response.status).toBe(404);
      expect(boundary.events).toEqual(["owner"]);
      expect(h.repository.read).not.toHaveBeenCalled();
    },
  );
  it("does not read files or call analysis when retirement won admission", async () => {
    boundary.allowed = false;
    const h = harness();
    const response = await request(h.app)
      .post("/projects/%31%32/page-map/analyze")
      .set("x-owner", "yes");
    expect(response.status).toBe(404);
    expect(boundary.events).toEqual(["owner", "admit:12"]);
    expect(h.repository.readFiles).not.toHaveBeenCalled();
    expect(boundary.analyze).not.toHaveBeenCalled();
  });
  it("releases a hold on validation failure without writing", async () => {
    const h = harness();
    const response = await request(h.app)
      .put("/projects/12/page-map")
      .set("x-owner", "yes")
      .send({ web: null });
    expect(response.status).toBe(400);
    expect(boundary.events).toEqual(["owner", "admit:12", "hold", "release"]);
    expect(h.repository.write).not.toHaveBeenCalled();
  });
  it("releases a hold when asynchronous analysis throws", async () => {
    const h = harness();
    boundary.analyze.mockRejectedValue(new Error("analysis failed"));
    const response = await request(h.app)
      .post("/projects/12/page-map/analyze")
      .set("x-owner", "yes");
    expect(response.status).toBe(503);
    expect(boundary.events.at(-1)).toBe("release");
    expect(h.repository.write).not.toHaveBeenCalled();
  });
  it("retains the hold through a response close event until pending analysis settles", async () => {
    const h = harness();
    let finish!: (value: typeof empty) => void;
    boundary.analyze.mockImplementation(
      () =>
        new Promise<typeof empty>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = request(h.app)
      .post("/projects/%31%32/page-map/analyze")
      .set("x-owner", "yes")
      .then((response) => response);
    await vi.waitFor(() => expect(boundary.analyze).toHaveBeenCalledOnce());
    h.response()!.emit("close");
    expect(boundary.events).toContain("hold");
    expect(boundary.events).not.toContain("release");
    finish(empty);
    expect((await pending).status).toBe(200);
    expect(boundary.events.at(-1)).toBe("release");
  });
});
