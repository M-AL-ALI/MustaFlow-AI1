import { useQuery } from "@tanstack/react-query";
import {
  customFetch,
  getListProjectsQueryKey,
  getGetRecentActivityQueryKey,
  type ActivityItem,
} from "@workspace/api-client-react";
import type { DashboardProject } from "@/components/projects/project-dashboard";

export type WorkspaceProject = DashboardProject & { workspaceId: number };
function workspaceId(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 2147483647) {
    throw new Error("workspace_selection_invalid");
  }
  return value;
}
export async function readWorkspaceProjects(
  id: number,
  signal?: AbortSignal,
): Promise<WorkspaceProject[]> {
  const rows = await customFetch<WorkspaceProject[]>(
    "/api/projects?workspaceId=" + workspaceId(id),
    { signal, responseType: "json" },
  );
  if (!Array.isArray(rows) || rows.some((row) => !row || row.workspaceId !== id)) {
    throw new Error("workspace_project_scope_unconfirmed");
  }
  return rows;
}
export async function readWorkspaceActivity(
  id: number,
  signal?: AbortSignal,
): Promise<ActivityItem[]> {
  const rows = await customFetch<ActivityItem[]>("/api/activity?workspaceId=" + workspaceId(id), {
    signal,
    responseType: "json",
  });
  if (!Array.isArray(rows)) throw new Error("workspace_activity_unavailable");
  return rows;
}
export function workspaceHomeQueryKeys(accountId: string, id: number) {
  return {
    projects: [...getListProjectsQueryKey(), { accountId, workspaceId: id }],
    activity: [...getGetRecentActivityQueryKey(), { accountId, workspaceId: id }],
  };
}
export function useWorkspaceProjects(accountId: string, id: number) {
  const keys = workspaceHomeQueryKeys(accountId, id);
  const projectsQuery = useQuery({
    queryKey: keys.projects,
    queryFn: ({ signal }) => readWorkspaceProjects(id, signal),
    enabled: Boolean(accountId),
    placeholderData: undefined,
  });
  const projects = projectsQuery.data ?? [];
  const projectIds = new Set(projects.map((project) => project.id));
  const activityQuery = useQuery({
    queryKey: keys.activity,
    queryFn: ({ signal }) => readWorkspaceActivity(id, signal),
    enabled: Boolean(accountId) && projectsQuery.isSuccess && projects.length > 0,
    placeholderData: undefined,
  });
  return {
    summaryQuery: {
      ...projectsQuery,
      data: projectsQuery.data ? { total: projects.length, recent: projects } : undefined,
    },
    activityQuery: {
      ...activityQuery,
      // Also remove cached events for projects no longer in this workspace.
      data: (activityQuery.data ?? []).filter((item) => projectIds.has(item.projectId)),
      isLoading: projects.length > 0 && activityQuery.isLoading,
    },
  };
}
