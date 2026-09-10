import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.hoisted(() => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
});
const mocks = vi.hoisted(() => ({ retire: vi.fn() }));
vi.mock("../../lib/workspace-lifecycle", () => ({ retireEmptyWorkspace: mocks.retire }));
async function appFor(userId = "owner-a") {
  const app = express();
  app.use((req, _res, next) => {
    req.userId = userId;
    next();
  });
  app.use((await import("../workspaces")).default);
  return app;
}
describe("workspace retirement boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it.each([
    ["retired", 200, { deleted: true }],
    ["not-found", 404, { error: "Workspace not found" }],
    ["only-workspace", 400, { error: "Cannot delete your only workspace" }],
    [
      "projects-remain",
      409,
      {
        error:
          "This workspace still contains projects, including any in Trash. Resolve those projects before deleting the workspace.",
        code: "workspace_projects_remain",
      },
    ],
  ] as const)("maps %s without changing the retirement result", async (outcome, status, body) => {
    mocks.retire.mockResolvedValue(outcome);
    const result = await request(await appFor()).delete("/workspaces/301");
    expect(result.status).toBe(status);
    expect(result.body).toEqual(body);
    expect(mocks.retire).toHaveBeenCalledWith({ workspaceId: 301, userId: "owner-a" });
  });
  it.each(["3e2", "301oops", "2147483648", "-1", "0", "1.5"])(
    "rejects malformed workspace id %s before lifecycle queries",
    async (id) => {
      const result = await request(await appFor()).delete("/workspaces/" + id);
      expect(result.status).toBe(400);
      expect(mocks.retire).not.toHaveBeenCalled();
    },
  );
  it("requires authentication before lifecycle admission", async () => {
    const result = await request(await appFor("")).delete("/workspaces/301");
    expect(result.status).toBe(401);
    expect(mocks.retire).not.toHaveBeenCalled();
  });
});
