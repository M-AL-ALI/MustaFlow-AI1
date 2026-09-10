import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  authorized: true,
  execute:
    vi.fn<(sql: string, params: unknown[], method: string) => Promise<{ rows: unknown[][] }>>(),
}));
vi.mock("../lib/auth", () => ({
  requireProjectOwnership: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    if (!req.userId) {
      res.status(401).json({ error: "Unauthenticated" });
      return;
    }
    if (!state.authorized) {
      res.status(404).json({ error: "Project not found" });
      return;
    }
    next();
  },
}));
vi.mock("@workspace/db", async () => {
  const schema = await import("@workspace/db/schema");
  const { drizzle } = await import("drizzle-orm/pg-proxy");
  return { ...schema, db: drizzle(state.execute) };
});
import router from "./project-activity";
function appFor(signedIn = true) {
  const app = express();
  app.set("query parser", "extended");
  app.use((req, _res, next) => {
    if (signedIn) req.userId = "acceptance-owner";
    next();
  });
  app.use(router);
  return app;
}
beforeEach(() => {
  vi.resetAllMocks();
  state.authorized = true;
  state.execute.mockResolvedValue({ rows: [] });
});

describe("project activity terminal receipts", () => {
  it.each(["", "?eventType=build"])(
    "includes completed and failed tasks within the requested project: %s",
    async (query) => {
      state.execute.mockImplementation(async (sql) => ({
        rows: sql.includes('from "task_events"')
          ? [
              [
                901,
                315,
                "failed",
                "Compatibility repair required",
                { code: "zero_sealed_source_contract_error" },
                "2026-09-10T13:48:04.797Z",
              ],
            ]
          : [],
      }));
      const response = await request(appFor())
        .get("/projects/61/activity-log" + query)
        .expect(200);
      expect(response.body).toEqual([
        expect.objectContaining({
          projectId: 61,
          eventType: "build_failed",
          summary: "Compatibility repair required",
          metadata: expect.objectContaining({ taskId: 315, source: "task_event" }),
        }),
      ]);
      const taskQuery = state.execute.mock.calls.find(([sql]) =>
        sql.includes('from "task_events"'),
      )!;
      expect(taskQuery[0]).toContain('"agent_tasks"."project_id" = $1');
      expect(taskQuery[0]).toContain('"agent_tasks"."status" in ($2, $3)');
      expect(taskQuery[0]).toContain('"task_events"."event_type" in ($4, $5)');
      expect(taskQuery[1]).toEqual([61, "completed", "failed", "completed", "failed", 50]);
      expect(taskQuery[0]).toContain('inner join "agent_tasks"');
      if (query) {
        const projectQuery = state.execute.mock.calls.find(([sql]) =>
          sql.includes('from "project_activity"'),
        )!;
        expect(projectQuery[1]).toEqual([61, "build", "build_failed", 50]);
      }
    },
  );
  it("filters failures in SQL before the row limit", async () => {
    await request(appFor())
      .get("/projects/61/activity-log?eventType=build_failed&limit=100")
      .expect(200);
    const taskQuery = state.execute.mock.calls.find(([sql]) => sql.includes('from "task_events"'))!;
    expect(taskQuery[1]).toEqual([61, "completed", "failed", "failed", 100]);
    expect(taskQuery[0]).toContain('"task_events"."event_type" in ($4)');
  });
  it("does not query agent events for an unrelated filter", async () => {
    await request(appFor()).get("/projects/61/activity-log?eventType=publish").expect(200);
    expect(state.execute).toHaveBeenCalledTimes(1);
    expect(state.execute.mock.calls[0][1]).toEqual([61, "publish", 50]);
  });
  it("caps positive limits without widening project scope", async () => {
    await request(appFor()).get("/projects/61/activity-log?limit=1000").expect(200);
    for (const [, params] of state.execute.mock.calls) {
      expect(params[0]).toBe(61);
      expect(params.at(-1)).toBe(200);
    }
  });
  it.each([
    "limit=0",
    "limit=-1",
    "limit=NaN",
    "limit=1e2",
    "limit=1&limit=2",
    "limit[]=1",
    "eventType[]=build",
    "eventType=",
  ])("rejects malformed query %s before SQL", async (query) => {
    await request(appFor())
      .get("/projects/61/activity-log?" + query)
      .expect(400);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it.each(["61junk", "0", "2147483648"])("rejects a malformed project ID %s", async (projectId) => {
    await request(appFor())
      .get("/projects/" + projectId + "/activity-log")
      .expect(400);
    expect(state.execute).not.toHaveBeenCalled();
  });
  it("retains the authorization guard before any activity lookup", async () => {
    await request(appFor(false)).get("/projects/61/activity-log").expect(401);
    state.authorized = false;
    await request(appFor()).get("/projects/61/activity-log").expect(404);
    expect(state.execute).not.toHaveBeenCalled();
  });
});
