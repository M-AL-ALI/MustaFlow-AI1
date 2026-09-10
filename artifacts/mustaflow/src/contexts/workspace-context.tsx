import { createContext, useContext, useState, useEffect, useRef, type ReactNode } from "react";
import {
  useListWorkspaces,
  useCreateWorkspace,
  getListWorkspacesQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@clerk/react";

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

type WorkspaceInput = {
  name: string;
  description?: string;
  type?: "personal" | "business" | "client" | "team";
};

type WorkspaceContextValue = {
  workspaces: WorkspaceItem[];
  currentWorkspace: WorkspaceItem | null;
  hasChosenWorkspace: boolean;
  requestWorkspaceChoice: () => void;
  setCurrentWorkspaceId: (id: number) => void;
  isLoading: boolean;
  isError: boolean;
  retryWorkspaces: () => void;
  createWorkspace: (data: WorkspaceInput) => Promise<WorkspaceItem>;
  isCreating: boolean;
};

const WorkspaceContext = createContext<WorkspaceContextValue>({
  workspaces: [],
  currentWorkspace: null,
  hasChosenWorkspace: false,
  requestWorkspaceChoice: () => {},
  setCurrentWorkspaceId: () => {},
  isLoading: true,
  isError: false,
  retryWorkspaces: () => {},
  createWorkspace: () => Promise.reject(new Error("workspace_provider_unavailable")),
  isCreating: false,
});

function storedWorkspaceId(key: string): number | null {
  try {
    const value = localStorage.getItem(key);
    const id = value && /^[1-9]\d*$/.test(value) ? Number(value) : NaN;
    return Number.isSafeInteger(id) ? id : null;
  } catch {
    return null;
  }
}

/** Remount all account-bound selection and mutation state before rendering another account. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { isSignedIn, isLoaded, userId } = useAuth();
  const accountId = isSignedIn && userId ? userId : null;
  return (
    <AccountWorkspaceProvider
      key={accountId ?? "signed-out"}
      accountId={accountId}
      authLoading={!isLoaded}
    >
      {children}
    </AccountWorkspaceProvider>
  );
}

function AccountWorkspaceProvider({
  children,
  accountId,
  authLoading,
}: {
  children: ReactNode;
  accountId: string | null;
  authLoading: boolean;
}) {
  const queryClient = useQueryClient();
  const queryKey = [...getListWorkspacesQueryKey(), { accountId }];
  const query = useListWorkspaces({ query: { queryKey, enabled: !!accountId } });
  const createWsMutation = useCreateWorkspace();
  const storageKey = `nabuflow_workspace_id:${encodeURIComponent(accountId ?? "signed-out")}`;
  const [currentId, setCurrentId] = useState<number | null>(() =>
    accountId ? storedWorkspaceId(storageKey) : null,
  );
  const [isCreating, setIsCreating] = useState(false);
  const [hasChosenWorkspace, setHasChosenWorkspace] = useState(false);
  const mounted = useRef(true);
  const creating = useRef<Promise<WorkspaceItem> | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // The current API lists owned workspaces. Do not accept a cached foreign-account row.
  const workspaces = accountId
    ? (query.data ?? []).filter(
        (workspace) => workspace.ownerUserId === accountId && !workspace.deletedAt,
      )
    : [];
  const currentWorkspace =
    workspaces.find((workspace) => workspace.id === currentId) ?? workspaces[0] ?? null;

  const remember = (id: number, explicit = false) => {
    setCurrentId(id);
    if (explicit) setHasChosenWorkspace(true);
    try {
      localStorage.setItem(storageKey, String(id));
    } catch {
      /* Selection still works without browser storage. */
    }
  };
  const selectedId = currentWorkspace?.id;
  useEffect(() => {
    if (selectedId && selectedId !== currentId) {
      setCurrentId(selectedId);
      try {
        localStorage.setItem(storageKey, String(selectedId));
      } catch {
        /* Optional preference storage. */
      }
    }
  }, [selectedId, currentId, storageKey]);

  const createWorkspace = (data: WorkspaceInput): Promise<WorkspaceItem> => {
    if (creating.current) return creating.current;
    if (!accountId || !data.name.trim())
      return Promise.reject(new Error("workspace_creation_unavailable"));
    const operation = (async () => {
      setIsCreating(true);
      try {
        const workspace = await createWsMutation.mutateAsync({
          data: { ...data, name: data.name.trim(), type: data.type ?? "personal" },
        });
        if (!mounted.current || workspace.ownerUserId !== accountId)
          throw new Error("workspace_account_changed");
        queryClient.setQueryData<WorkspaceItem[]>(queryKey, (existing = []) => [
          workspace,
          ...existing.filter((item) => item.id !== workspace.id),
        ]);
        remember(workspace.id, true);
        void queryClient.invalidateQueries({ queryKey });
        return workspace;
      } finally {
        creating.current = null;
        if (mounted.current) setIsCreating(false);
      }
    })();
    creating.current = operation;
    return operation;
  };

  return (
    <WorkspaceContext.Provider
      value={{
        workspaces,
        currentWorkspace,
        hasChosenWorkspace,
        requestWorkspaceChoice: () => setHasChosenWorkspace(false),
        setCurrentWorkspaceId: (id) => {
          if (
            !query.isLoading &&
            !query.isError &&
            workspaces.some((workspace) => workspace.id === id)
          )
            remember(id, true);
        },
        isLoading: authLoading || (!!accountId && query.isLoading),
        isError: !!accountId && query.isError,
        retryWorkspaces: () => {
          if (accountId) void query.refetch();
        },
        createWorkspace,
        isCreating,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspace() {
  return useContext(WorkspaceContext);
}
