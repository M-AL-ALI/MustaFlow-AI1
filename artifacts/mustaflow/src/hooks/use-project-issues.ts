import {
  useListTasks,
  useGetCheckRuns,
  getListTasksQueryKey,
  getGetCheckRunsQueryKey,
} from "@workspace/api-client-react";

interface ProjectIssues {
  totalCount: number;
  hasFailedBuild: boolean;
  hasContainerError: boolean;
  hasCodeQuality: boolean;
}

export function useProjectIssues(
  projectId: number,
  containerStatus: string,
  builderMode?: string | null,
  includeCheckRuns = false,
): ProjectIssues {
  const { data: tasks = [] } = useListTasks(projectId, {
    query: {
      queryKey: getListTasksQueryKey(projectId),
      refetchInterval: 30_000,
      staleTime: 10_000,
    },
  });

  const { data: checkRuns = [] } = useGetCheckRuns(projectId, undefined, {
    query: {
      enabled: includeCheckRuns,
      queryKey: getGetCheckRunsQueryKey(projectId),
      staleTime: 60_000,
    },
  });

  const hasFailedBuild = tasks[0]?.status === "failed";
  const hasContainerError = containerStatus === "error" && builderMode === "agentic";
  const hasCodeQuality =
    includeCheckRuns &&
    checkRuns.some((r) => r.checkName === "code-quality" && r.status === "fail");

  const totalCount =
    (hasFailedBuild ? 1 : 0) + (hasContainerError ? 1 : 0) + (hasCodeQuality ? 1 : 0);

  return { totalCount, hasFailedBuild, hasContainerError, hasCodeQuality };
}
