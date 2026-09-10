import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@workspace/api-client-react", () => ({
  customFetch: mocks.fetch,
  getListProjectsQueryKey: () => ["/api/projects"],
  getGetRecentActivityQueryKey: () => ["/api/activity"],
}));
import {
  readWorkspaceProjects,
  readWorkspaceActivity,
  workspaceHomeQueryKeys,
} from "./use-workspace-projects";
beforeEach(() => vi.resetAllMocks());
describe("workspace home data boundaries", () => {
  it("separates both account and workspace caches while keeping invalidation prefixes", () => {
    const first = workspaceHomeQueryKeys("a", 1);
    expect(first.projects[0]).toBe("/api/projects");
    expect(first.activity[0]).toBe("/api/activity");
    expect(first).not.toEqual(workspaceHomeQueryKeys("a", 2));
    expect(first).not.toEqual(workspaceHomeQueryKeys("b", 1));
  });
  it("requests the exact workspace and propagates cancellation", async () => {
    const signal = new AbortController().signal;
    mocks.fetch.mockResolvedValue([{ id: 1, workspaceId: 7 }]);
    expect(await readWorkspaceProjects(7, signal)).toEqual([{ id: 1, workspaceId: 7 }]);
    expect(mocks.fetch).toHaveBeenCalledWith("/api/projects?workspaceId=7", {
      signal,
      responseType: "json",
    });
    mocks.fetch.mockResolvedValue([]);
    await readWorkspaceActivity(7, signal);
    expect(mocks.fetch).toHaveBeenLastCalledWith("/api/activity?workspaceId=7", {
      signal,
      responseType: "json",
    });
  });
  it.each([0, -1, 1.5, NaN, Infinity, 2147483648])(
    "never sends an invalid workspace %s",
    async (id) => {
      await expect(readWorkspaceProjects(id)).rejects.toThrow("workspace_selection_invalid");
      await expect(readWorkspaceActivity(id)).rejects.toThrow("workspace_selection_invalid");
      expect(mocks.fetch).not.toHaveBeenCalled();
    },
  );
  it.each([[{ id: 1, workspaceId: 8 }], [{ id: 1 }], null, {}])(
    "rejects an unconfirmed or cross-workspace response",
    async (rows) => {
      mocks.fetch.mockResolvedValue(rows);
      await expect(readWorkspaceProjects(7)).rejects.toThrow("workspace_project_scope_unconfirmed");
    },
  );
  it("does not disguise failed scope refresh as an empty workspace", async () => {
    mocks.fetch.mockRejectedValue(new Error("unavailable"));
    await expect(readWorkspaceProjects(7)).rejects.toThrow("unavailable");
  });
});
