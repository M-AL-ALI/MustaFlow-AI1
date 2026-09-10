import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

const state = vi.hoisted(() => ({
  mutate: vi.fn(),
  invalidate: vi.fn(),
  toast: vi.fn(),
  workspaceProjects: vi.fn(),
  requestWorkspaceChoice: vi.fn(),
  setCurrentWorkspaceId: vi.fn(),
  retryWorkspaces: vi.fn(),
  project: { id: 901, name: "Fixture project", status: "draft", updatedAt: "2026-09-08T00:00:00Z" },
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetSecurityBadgeCountsByProject: () => ({ data: { counts: {} } }),
  getGetSecurityBadgeCountsByProjectQueryKey: () => ["security"],
  useDeleteProject: () => ({ mutateAsync: state.mutate }),
  getGetProjectsSummaryQueryKey: () => ["summary"],
  getGetRecentActivityQueryKey: () => ["activity"],
  getListProjectsQueryKey: () => ["projects"],
  getListTrashedProjectsQueryKey: () => ["trash"],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({
    isLoaded: true,
    isSignedIn: true,
    user: { id: "test-user", firstName: "Test" },
  }),
}));
vi.mock("@/hooks/use-workspace-projects", () => ({
  useWorkspaceProjects: state.workspaceProjects,
}));
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspace: () => ({
    hasChosenWorkspace: true,
    requestWorkspaceChoice: state.requestWorkspaceChoice,
    currentWorkspace: { id: 1, name: "Test workspace", ownerUserId: "test-user" },
    workspaces: [
      {
        id: 1,
        name: "Test workspace",
        ownerUserId: "test-user",
        type: "personal",
        createdAt: "2026-09-08T00:00:00Z",
        updatedAt: "2026-09-08T00:00:00Z",
        deletedAt: null,
      },
    ],
    isLoading: false,
    isError: false,
    isCreating: false,
    setCurrentWorkspaceId: state.setCurrentWorkspaceId,
    retryWorkspaces: state.retryWorkspaces,
  }),
}));
vi.mock("@/components/create-workspace-modal", () => ({
  CreateWorkspaceModal: () => null,
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@/hooks/use-voice-input", () => ({
  useVoiceInput: () => ({ isSupported: false, isRecording: false, toggle: vi.fn() }),
  useVoiceLang: () => "en-US",
}));
vi.mock("@/components/brainstorm-panel", () => ({ BrainstormPanel: () => null }));
// This tests the page-to-dialog callback contract, not the dialog's own validation,
// which retains its separate tests. The real dashboard and composer are rendered.
vi.mock("@/components/project-trash-dialog", () => ({
  ProjectTrashDialog: ({
    project,
    onConfirm,
    onClose,
  }: {
    project: { id: number; name: string };
    onConfirm: (project: { id: number; name: string }) => Promise<void>;
    onClose: () => void;
  }) => (
    <div role="dialog" aria-label="Trash confirmation">
      <p>{project.name}</p>
      <button
        onClick={() => {
          void onConfirm(project);
        }}
      >
        Confirm move
      </button>
      <button onClick={onClose}>Cancel move</button>
    </div>
  ),
}));
import ProjectsPage from "../projects";
beforeEach(() => {
  vi.clearAllMocks();
  state.mutate.mockResolvedValue(undefined);
  state.invalidate.mockResolvedValue(undefined);
  state.workspaceProjects.mockReturnValue({
    summaryQuery: {
      data: { total: 1, recent: [state.project] },
      isLoading: false,
      isError: false,
    },
    activityQuery: { data: [], isLoading: false, isError: false },
  });
});
afterEach(cleanup);

describe("Dashboard recoverable Trash callback integration", () => {
  it("does not mutate before confirmation, then sends the selected project ID and refreshes all affected lists", async () => {
    render(<ProjectsPage />);
    expect(state.workspaceProjects).toHaveBeenCalledWith("test-user", 1);
    fireEvent.click(screen.getByLabelText("Actions for Fixture project"));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    expect(screen.getByRole("dialog", { name: "Trash confirmation" })).toBeTruthy();
    expect(state.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Confirm move" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalledWith({ id: 901 }));
    await waitFor(() => expect(state.invalidate).toHaveBeenCalledTimes(4));
    for (const key of ["summary", "activity", "projects", "trash"]) {
      expect(state.invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    }
    expect(state.toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Project moved to Trash" }),
    );
  });
  it("cancels without making a deletion request", () => {
    render(<ProjectsPage />);
    fireEvent.click(screen.getByLabelText("Actions for Fixture project"));
    fireEvent.click(screen.getByRole("button", { name: "Move to Trash" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel move" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(state.mutate).not.toHaveBeenCalled();
  });
});
