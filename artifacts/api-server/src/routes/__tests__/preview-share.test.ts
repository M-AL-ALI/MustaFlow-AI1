import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  insertedSessions: [] as Array<Record<string, unknown>>,
  insertedActivities: [] as Array<Record<string, unknown>>,
  runtime: { containerId: "runtime-52", containerStatus: "running" },
}));

const tables = vi.hoisted(() => ({
  projects: { id: "projects.id", containerId: "projects.container_id", containerStatus: "status" },
  sessions: {},
  activities: {},
}));

vi.mock("@workspace/db", () => {
  const tx = {
    insert: vi.fn((table: unknown) => ({
      values: async (value: Record<string, unknown>) => {
        if (table === tables.sessions) state.insertedSessions.push(value);
        if (table === tables.activities) state.insertedActivities.push(value);
      },
    })),
  };
  return {
    db: {
      select: vi.fn(() => ({
        from: () => ({ where: async () => [state.runtime] }),
      })),
      transaction: vi.fn(async (callback: (value: typeof tx) => Promise<void>) => callback(tx)),
    },
    projectsTable: tables.projects,
    previewSessionsTable: tables.sessions,
    projectActivityTable: tables.activities,
  };
});

vi.mock("../../lib/auth", () => ({
  requireProjectOwnership: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (req.get("x-owner") !== "test-user") {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    req.userId = "test-user";
    next();
  },
}));

import previewShareRouter from "../preview-share";

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use(previewShareRouter);
  return app;
}

beforeEach(() => {
  state.insertedSessions = [];
  state.insertedActivities = [];
  state.runtime = { containerId: "runtime-52", containerStatus: "running" };
});

describe("POST /projects/:id/preview-share", () => {
  it("does not mint for a caller who is not the project owner", async () => {
    const response = await request(buildApp()).post("/projects/52/preview-share");
    expect(response.status).toBe(404);
    expect(state.insertedSessions).toHaveLength(0);
    expect(state.insertedActivities).toHaveLength(0);
  });

  it("does not mint while the runtime is not running", async () => {
    state.runtime = { containerId: "runtime-52", containerStatus: "stopped" };
    const response = await request(buildApp())
      .post("/projects/52/preview-share")
      .set("x-owner", "test-user");
    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: "Start this preview before sharing it.",
      code: "preview_not_running",
    });
    expect(state.insertedSessions).toHaveLength(0);
  });

  it("mints an eight-hour invitation and its standard receipt together", async () => {
    const before = Date.now();
    const response = await request(buildApp())
      .post("/projects/52/preview-share")
      .set("x-owner", "test-user");
    const after = Date.now();
    expect(response.status).toBe(201);
    expect(response.body.previewUrl).toBe("https://p52.preview.mustaflow.com");
    expect(response.body.launchUrl).toMatch(
      /^https:\/\/p52\.preview\.mustaflow\.com\/__preview-launch\?t=[0-9a-f]{64}$/,
    );
    const expiresAt = Date.parse(response.body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 8 * 60 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(after + 8 * 60 * 60 * 1000);
    expect(state.insertedSessions).toHaveLength(1);
    expect(state.insertedActivities).toEqual([
      expect.objectContaining({
        projectId: 52,
        actorId: "test-user",
        eventType: "share_link_created",
        metadata: expect.objectContaining({ receipt: "preview-share-minted-v1" }),
      }),
    ]);
  });
});
