import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider, useMutation } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseTab } from "./database-tab";

const api = vi.hoisted(() => ({
  getProject: vi.fn(),
  getDatabaseStatus: vi.fn(),
  refetchProject: vi.fn(),
  refetchDatabaseStatus: vi.fn(),
  provision: vi.fn(),
  deprovision: vi.fn(),
  runQuery: vi.fn(),
  createSnapshot: vi.fn(),
  restoreSnapshot: vi.fn(),
  deleteSnapshot: vi.fn(),
}));

vi.mock("@workspace/api-client-react", () => ({
  useGetProject: api.getProject,
  useGetDatabaseStatus: api.getDatabaseStatus,
  useProvisionDatabase: (options?: { mutation?: { retry?: boolean } }) =>
    useMutation({
      mutationFn: (variables: { id: number; data: { provider: "postgres" } }) =>
        api.provision(variables),
      ...options?.mutation,
    }),
  useDeprovisionDatabase: () => ({ mutate: api.deprovision, isPending: false }),
  useQueryDatabase: () => ({ mutate: api.runQuery, isPending: false }),
  useGetDatabaseSchema: () => ({ data: { tables: [] }, isLoading: false }),
  useListDbSnapshots: () => ({ data: [], isLoading: false }),
  useCreateDbSnapshot: () => ({ mutate: api.createSnapshot, isPending: false }),
  useRestoreDbSnapshot: () => ({ mutate: api.restoreSnapshot, isPending: false }),
  useDeleteDbSnapshot: () => ({ mutate: api.deleteSnapshot, isPending: false }),
  getGetDatabaseStatusQueryKey: (id: number) => [`/api/projects/${id}/database`],
  getGetProjectQueryKey: (id: number) => [`/api/projects/${id}`],
  getListDbSnapshotsQueryKey: (id: number) => [`/api/projects/${id}/database/snapshots`],
}));

const PROJECT_ID = 75;
const projectRecord = Object.freeze({ id: PROJECT_ID, dbProvider: "postgres" });
const statusRecord = Object.freeze({ dbStatus: "error" });
const retryPayload = { id: PROJECT_ID, data: { provider: "postgres" } };
let queryClient: QueryClient;

function projectQuery() {
  return {
    data: projectRecord,
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: api.refetchProject,
  };
}

function statusQuery() {
  return {
    data: statusRecord,
    isLoading: false,
    isError: false,
    isSuccess: true,
    refetch: api.refetchDatabaseStatus,
  };
}

function renderDatabaseTab() {
  const tree = () => (
    <QueryClientProvider client={queryClient}>
      <DatabaseTab projectId={PROJECT_ID} />
    </QueryClientProvider>
  );
  const view = render(tree());
  return { rerender: () => view.rerender(tree()) };
}

function expectNoOtherDatabaseWrites() {
  for (const mutation of [
    api.deprovision,
    api.runQuery,
    api.createSnapshot,
    api.restoreSnapshot,
    api.deleteSnapshot,
  ]) {
    expect(mutation).not.toHaveBeenCalled();
  }
}

function expectRefreshOnly() {
  expect(screen.getByRole("button", { name: "Refresh database status" })).toBeEnabled();
  expect(screen.getAllByRole("button")).toHaveLength(1);
  expect(api.provision).not.toHaveBeenCalled();
  expectNoOtherDatabaseWrites();
}

beforeEach(() => {
  vi.resetAllMocks();
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      // Recovery must override application defaults that could retry writes.
      mutations: { retry: 2, retryDelay: 0 },
    },
  });
  api.getProject.mockReturnValue(projectQuery());
  api.getDatabaseStatus.mockReturnValue(statusQuery());
  api.refetchProject.mockResolvedValue(undefined);
  api.refetchDatabaseStatus.mockResolvedValue(undefined);
  api.provision.mockResolvedValue({ dbStatus: "provisioning" });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  vi.restoreAllMocks();
});

describe("DatabaseTab guarded recovery", () => {
  it.each([
    ["project", false],
    ["project", true],
    ["status", false],
    ["status", true],
  ] as const)(
    "keeps a failed %s query read-only even with cached failure metadata: %s",
    async (query, cached) => {
      const user = userEvent.setup();
      const result = query === "project" ? projectQuery() : statusQuery();
      const hook = query === "project" ? api.getProject : api.getDatabaseStatus;
      hook.mockReturnValue({
        ...result,
        data: cached ? result.data : undefined,
        isError: true,
        isSuccess: false,
      });
      renderDatabaseTab();

      expect(screen.getByRole("status")).toHaveTextContent("We couldn't check");
      expectRefreshOnly();
      await user.click(screen.getByRole("button", { name: "Refresh database status" }));
      expect(api.refetchProject).toHaveBeenCalledTimes(1);
      expect(api.refetchDatabaseStatus).toHaveBeenCalledTimes(1);
      expectRefreshOnly();
    },
  );

  it.each(["project", "status"] as const)(
    "requires a successful %s query before offering recovery",
    (query) => {
      const result = query === "project" ? projectQuery() : statusQuery();
      const hook = query === "project" ? api.getProject : api.getDatabaseStatus;
      hook.mockReturnValue({ ...result, isSuccess: false });
      renderDatabaseTab();
      expectRefreshOnly();
    },
  );

  it.each([undefined, null, "unexpected"])(
    "keeps unknown recorded status %s read-only",
    (dbStatus) => {
      api.getDatabaseStatus.mockReturnValue({ ...statusQuery(), data: { dbStatus } });
      renderDatabaseTab();
      expect(screen.getByRole("status")).toHaveTextContent("has not been verified");
      expectRefreshOnly();
    },
  );

  it.each([undefined, null, "none", "mysql"])(
    "does not retry a recorded error for provider %s",
    (dbProvider) => {
      api.getProject.mockReturnValue({
        ...projectQuery(),
        data: { ...projectRecord, dbProvider },
      });
      renderDatabaseTab();
      expectRefreshOnly();
    },
  );

  it("offers an explicit retry for a fetched PostgreSQL error using only the existing payload", async () => {
    const user = userEvent.setup();
    renderDatabaseTab();

    expect(screen.getByRole("heading", { name: "Database setup needs attention" })).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent(
      "This does not mean the database or its data is absent.",
    );
    expect(screen.getAllByRole("button")).toHaveLength(2);
    expect(api.provision).not.toHaveBeenCalled();
    expectNoOtherDatabaseWrites();

    await user.click(screen.getByRole("button", { name: "Retry existing setup" }));
    await waitFor(() => expect(api.provision).toHaveBeenCalledExactlyOnceWith(retryPayload));
    expect(api.getProject).toHaveBeenCalledWith(PROJECT_ID);
    expect(api.getDatabaseStatus).toHaveBeenCalledWith(PROJECT_ID);
    expectNoOtherDatabaseWrites();
  });

  it("blocks immediate duplicate clicks and disables retry for the entire pending mutation", async () => {
    const user = userEvent.setup();
    let finish!: (value: { dbStatus: string }) => void;
    const pending = new Promise<{ dbStatus: string }>((resolve) => {
      finish = resolve;
    });
    api.provision.mockReturnValue(pending);
    renderDatabaseTab();
    const retry = screen.getByRole("button", { name: "Retry existing setup" });

    act(() => {
      retry.click();
      retry.click();
    });
    await waitFor(() => {
      expect(api.provision).toHaveBeenCalledExactlyOnceWith(retryPayload);
      expect(retry).toBeDisabled();
    });
    await user.click(retry);
    expect(api.provision).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Refresh database status" })).toBeEnabled();

    await act(async () => {
      finish({ dbStatus: "provisioning" });
      await pending;
    });
    await waitFor(() => expect(retry).toBeEnabled());
    expect(api.provision).toHaveBeenCalledTimes(1);
    expectNoOtherDatabaseWrites();
  });

  it("refreshes both existing project query keys after a successful retry", async () => {
    const user = userEvent.setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderDatabaseTab();
    expect(invalidate).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Retry existing setup" }));
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(2));
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [`/api/projects/${PROJECT_ID}/database`],
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: [`/api/projects/${PROJECT_ID}`] });
    expect(api.provision).toHaveBeenCalledExactlyOnceWith(retryPayload);
    expectNoOtherDatabaseWrites();
  });

  it("does not automatically retry a failed mutation and allows only another explicit retry", async () => {
    const user = userEvent.setup();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    api.provision
      .mockRejectedValueOnce(new Error("Existing setup still unavailable"))
      .mockResolvedValueOnce({ dbStatus: "provisioning" });
    renderDatabaseTab();
    const retry = screen.getByRole("button", { name: "Retry existing setup" });

    await user.click(retry);
    await waitFor(() => {
      expect(api.provision).toHaveBeenCalledTimes(1);
      expect(retry).toBeEnabled();
    });
    expect(invalidate).not.toHaveBeenCalled();

    await user.click(retry);
    await waitFor(() => expect(api.provision).toHaveBeenCalledTimes(2));
    expect(api.provision).toHaveBeenNthCalledWith(1, retryPayload);
    expect(api.provision).toHaveBeenNthCalledWith(2, retryPayload);
    expectNoOtherDatabaseWrites();
  });

  it("offers recovery only after refreshed queries confirm the recorded failure", async () => {
    const user = userEvent.setup();
    api.getDatabaseStatus.mockReturnValue({
      ...statusQuery(),
      isError: true,
      isSuccess: false,
    });
    const view = renderDatabaseTab();
    expectRefreshOnly();

    await user.click(screen.getByRole("button", { name: "Refresh database status" }));
    expect(api.refetchProject).toHaveBeenCalledTimes(1);
    expect(api.refetchDatabaseStatus).toHaveBeenCalledTimes(1);
    api.getDatabaseStatus.mockReturnValue(statusQuery());
    view.rerender();

    expect(screen.getByRole("button", { name: "Retry existing setup" })).toBeEnabled();
    expect(api.provision).not.toHaveBeenCalled();
    expectNoOtherDatabaseWrites();
  });

  it("removes recovery when a manual refresh fails even if recorded error data remains cached", async () => {
    const user = userEvent.setup();
    const view = renderDatabaseTab();
    expect(screen.getByRole("button", { name: "Retry existing setup" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: "Refresh database status" }));
    expect(api.refetchProject).toHaveBeenCalledTimes(1);
    expect(api.refetchDatabaseStatus).toHaveBeenCalledTimes(1);
    api.getProject.mockReturnValue({ ...projectQuery(), isError: true, isSuccess: false });
    view.rerender();

    expectRefreshOnly();
  });
});
