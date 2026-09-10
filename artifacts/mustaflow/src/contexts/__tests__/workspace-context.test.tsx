import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useMutation, useQuery } from "@tanstack/react-query";
import { WorkspaceProvider, useWorkspace, type WorkspaceItem } from "../workspace-context";

const state = vi.hoisted(() => ({
  userId: "user-a" as string | null,
  list: vi.fn(),
  create: vi.fn(),
  completion: vi.fn(),
}));
vi.mock("@clerk/react", () => ({
  useAuth: () => ({ isLoaded: true, isSignedIn: !!state.userId, userId: state.userId }),
}));
vi.mock("@workspace/api-client-react", () => ({
  getListWorkspacesQueryKey: () => ["/api/workspaces"],
  useListWorkspaces: ({ query }: { query: { queryKey: unknown[]; enabled: boolean } }) =>
    useQuery<WorkspaceItem[]>({ ...query, queryFn: () => state.list(state.userId), retry: false }),
  useCreateWorkspace: () => useMutation({ mutationFn: (input: unknown) => state.create(input) }),
}));

const row = (id: number, ownerUserId: string, name: string): WorkspaceItem => ({
  id,
  ownerUserId,
  name,
  type: "personal",
  createdAt: "2026-09-08",
  updatedAt: "2026-09-08",
});
function Probe() {
  const workspace = useWorkspace();
  return (
    <>
      <output aria-label="Current workspace">{workspace.currentWorkspace?.name ?? "none"}</output>
      <output aria-label="Workspace names">
        {workspace.workspaces.map((item) => item.name).join(",")}
      </output>
      <output aria-label="Workspace load state">
        {workspace.isError ? "error" : workspace.isLoading ? "loading" : "ready"}
      </output>
      <button onClick={() => workspace.setCurrentWorkspaceId(2)}>Select second</button>
      <button onClick={() => workspace.setCurrentWorkspaceId(999)}>Select unknown</button>
      <button
        onClick={() => {
          void workspace
            .createWorkspace({ name: " New studio " })
            .then(state.completion, state.completion);
        }}
      >
        Create
      </button>
      <button onClick={workspace.retryWorkspaces}>Retry</button>
    </>
  );
}
function mount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 }, mutations: { retry: false } },
  });
  const tree = () => (
    <QueryClientProvider client={client}>
      <WorkspaceProvider>
        <Probe />
      </WorkspaceProvider>
    </QueryClientProvider>
  );
  const view = render(tree());
  return { ...view, client, rerenderAccount: () => view.rerender(tree()) };
}
beforeEach(() => {
  state.userId = "user-a";
  state.list
    .mockReset()
    .mockImplementation(async (userId) =>
      userId === "user-a"
        ? [row(1, "user-a", "Personal A"), row(2, "user-a", "Client A")]
        : [row(3, "user-b", "Studio B")],
    );
  state.create.mockReset();
  state.completion.mockReset();
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("Account-bound workspace selection", () => {
  it("keeps selections per account and never uses the unscoped legacy preference", async () => {
    localStorage.setItem("mustaflow_workspace_id", "2");
    const view = mount();
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("Personal A"),
    );
    fireEvent.click(screen.getByText("Select second"));
    expect(localStorage.getItem("nabuflow_workspace_id:user-a")).toBe("2");
    state.userId = "user-b";
    view.rerenderAccount();
    expect(screen.getByLabelText("Workspace names").textContent).not.toContain("Client A");
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("Studio B"),
    );
    state.userId = "user-a";
    view.rerenderAccount();
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("Client A"),
    );
    fireEvent.click(screen.getByText("Select unknown"));
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Client A");
  });

  it("does not show foreign or retired rows even if supplied by a stale list", async () => {
    state.list.mockResolvedValue([
      row(1, "user-a", "Mine"),
      row(5, "user-b", "Foreign"),
      { ...row(6, "user-a", "Retired"), deletedAt: "2026-09-08" },
    ]);
    mount();
    await waitFor(() => expect(screen.getByLabelText("Workspace names").textContent).toBe("Mine"));
  });

  it("clears the visible account immediately on signout", async () => {
    const view = mount();
    await screen.findByText("Personal A", { selector: "output[aria-label='Current workspace']" });
    state.userId = null;
    view.rerenderAccount();
    expect(screen.getByLabelText("Current workspace").textContent).toBe("none");
    expect(screen.getByLabelText("Workspace names").textContent).toBe("");
  });

  it("fences a previous account's late creation response and deduplicates pending submissions", async () => {
    let resolveCreation!: (workspace: WorkspaceItem) => void;
    state.create.mockImplementation(
      () =>
        new Promise<WorkspaceItem>((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const view = mount();
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("Personal A"),
    );
    fireEvent.click(screen.getByText("Create"));
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() => expect(state.create).toHaveBeenCalledTimes(1));
    state.userId = "user-b";
    view.rerenderAccount();
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("Studio B"),
    );
    await act(async () => resolveCreation(row(10, "user-a", "Old account result")));
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Studio B");
    expect(localStorage.getItem("nabuflow_workspace_id:user-b")).toBe("3");
    expect(localStorage.getItem("nabuflow_workspace_id:user-a")).not.toBe("10");
    expect(state.completion.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });

  it("selects a confirmed creation immediately in the correct scoped cache", async () => {
    const created = row(8, "user-a", "New studio");
    state.create.mockImplementation(async () => {
      state.list.mockResolvedValue([created, row(1, "user-a", "Personal A")]);
      return created;
    });
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("Personal A"),
    );
    fireEvent.click(screen.getByText("Create"));
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("New studio"),
    );
    expect(state.create).toHaveBeenCalledWith({ data: { name: "New studio", type: "personal" } });
  });

  it("shows a load failure as an error and can retry without losing account context", async () => {
    state.list.mockRejectedValueOnce(new Error("network unavailable"));
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText("Workspace load state").textContent).toBe("error"),
    );
    fireEvent.click(screen.getByText("Retry"));
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("Personal A"),
    );
  });

  it("works when browser preference storage is unavailable", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("storage denied");
    });
    mount();
    await waitFor(() =>
      expect(screen.getByLabelText("Current workspace").textContent).toBe("Personal A"),
    );
    fireEvent.click(screen.getByText("Select second"));
    expect(screen.getByLabelText("Current workspace").textContent).toBe("Client A");
  });
});
