import { createContext, useContext, useState, useEffect, type ReactNode } from "react";
import {
  useListWorkspaces,
  useCreateWorkspace,
  getListWorkspacesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";

export type WorkspaceItem = {
  id: number;
  ownerUserId: string;
  name: string;
  description?: string | null;
  type: string;
  createdAt: string;
  updatedAt: string;
  deletedAt?: string | null;
};

type WorkspaceContextValue = {
  workspaces: WorkspaceItem[];
  currentWorkspace: WorkspaceItem | null;
  setCurrentWorkspaceId: (id: number) => void;
  isLoading: boolean;
  createWorkspace: (data: { name: string; description?: string; type?: string }) => void;
  isCreating: boolean;
};

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  currentWorkspace: null,
  setCurrentWorkspaceId: () => {},
  isLoading: true,
  createWorkspace: () => {},
  isCreating: false,
});

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const { data: workspaces = [], isLoading } = useListWorkspaces({
    query: { queryKey: getListWorkspacesQueryKey() },
  });
  const createWsMutation = useCreateWorkspace();

  const [currentId, setCurrentId] = useState<number | null>(() => {
    const stored = localStorage.getItem("mustaflow_workspace_id");
    return stored ? parseInt(stored, 10) : null;
  });

  const currentWorkspace =
    (workspaces as WorkspaceItem[]).find((w) => w.id === currentId) ??
    (workspaces as WorkspaceItem[])[0] ??
    null;

  const setCurrentWorkspaceId = (id: number) => {
    setCurrentId(id);
    localStorage.setItem("mustaflow_workspace_id", String(id));
  };

  useEffect(() => {
    const list = workspaces as WorkspaceItem[];
    if (list.length > 0 && !currentId) {
      setCurrentWorkspaceId(list[0].id);
    }
  }, [workspaces, currentId]);

  const createWorkspace = (data: { name: string; description?: string; type?: string }) => {
    createWsMutation.mutate(
      {
        data: {
          name: data.name,
          description: data.description,
          type: (data.type as "personal" | "business" | "client" | "team") ?? "personal",
        },
      },
      {
        onSuccess: (ws) => {
          void queryClient.invalidateQueries({ queryKey: getListWorkspacesQueryKey() });
          setCurrentWorkspaceId((ws as WorkspaceItem).id);
        },
      },
    );
  };

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces: workspaces as WorkspaceItem[],
        currentWorkspace,
        setCurrentWorkspaceId,
        isLoading,
        createWorkspace,
        isCreating: createWsMutation.isPending,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
