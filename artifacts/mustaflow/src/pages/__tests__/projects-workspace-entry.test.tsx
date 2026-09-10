import * as ComposerModule from "@/components/projects/project-composer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useEffect, useRef, type AnchorHTMLAttributes } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  readCreationDraft,
  saveCreationDraft,
  savePublicCreationDraft,
  creationDraftDestination,
} from "@/lib/creation-draft";

type WorkspaceFixture = {
  id: number;
  name: string;
  ownerUserId: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: null;
};

const state = vi.hoisted(() => ({
  accountId: "account-a" as string | null,
  chosen: false,
  selectedId: 1,
  loading: false,
  error: false,
  workspaces: [] as WorkspaceFixture[],
  selectWorkspace: vi.fn(),
  requestWorkspaceChoice: vi.fn(),
  retryWorkspaces: vi.fn(),
  workspaceProjects: vi.fn(),
  securityQuery: vi.fn(),
  navigate: vi.fn(),
  invalidate: vi.fn(),
  toast: vi.fn(),
  deleteProject: vi.fn(),
  createProject: vi.fn(),
  readDraft: vi.fn(),
  saveDraft: vi.fn(),
  clearDraft: vi.fn(),
  composerMounted: vi.fn(),
  composerUnmounted: vi.fn(),
}));

vi.mock("@/lib/clerk-safe", () => ({
  useClerkUser: () => ({
    isLoaded: Boolean(state.accountId),
    isSignedIn: Boolean(state.accountId),
    user: state.accountId ? { id: state.accountId, firstName: "Test" } : null,
  }),
}));
vi.mock("@/contexts/workspace-context", () => ({
  useWorkspace: () => ({
    workspaces: state.workspaces,
    currentWorkspace:
      state.workspaces.find((workspace) => workspace.id === state.selectedId) ?? null,
    hasChosenWorkspace: state.chosen,
    isLoading: state.loading,
    isError: state.error,
    isCreating: false,
    setCurrentWorkspaceId: state.selectWorkspace,
    requestWorkspaceChoice: state.requestWorkspaceChoice,
    retryWorkspaces: state.retryWorkspaces,
  }),
}));
vi.mock("@/hooks/use-workspace-projects", () => ({
  useWorkspaceProjects: state.workspaceProjects,
}));
vi.mock("@workspace/api-client-react", () => ({
  useGetSecurityBadgeCountsByProject: state.securityQuery,
  getGetSecurityBadgeCountsByProjectQueryKey: () => ["security"],
  useDeleteProject: () => ({ mutateAsync: state.deleteProject }),
  useCreateProject: () => ({
    mutate: state.createProject,
    mutateAsync: state.createProject,
  }),
  getGetProjectsSummaryQueryKey: () => ["summary"],
  getGetRecentActivityQueryKey: () => ["activity"],
  getListProjectsQueryKey: () => ["projects"],
  getListTrashedProjectsQueryKey: () => ["trash"],
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries: state.invalidate }),
}));
vi.mock("wouter", () => ({
  useLocation: () => ["/projects", state.navigate],
  Link: ({
    href,
    children,
    ...props
  }: AnchorHTMLAttributes<HTMLAnchorElement> & { href: string }) => (
    <a
      {...props}
      href={href}
      onClick={(event) => {
        event.preventDefault();
        state.navigate(href);
      }}
    >
      {children}
    </a>
  ),
}));
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast: state.toast }) }));
vi.mock("@/hooks/use-voice-input", () => ({
  useVoiceInput: () => ({ isSupported: false, isRecording: false, toggle: vi.fn() }),
  useVoiceLang: () => "en-US",
}));
// Keep call observations while exercising the real sessionStorage boundary.
vi.mock("@/lib/creation-draft", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/creation-draft")>();
  return {
    ...actual,
    readCreationDraft: (...args: Parameters<typeof actual.readCreationDraft>) => {
      state.readDraft(...args);
      return actual.readCreationDraft(...args);
    },
    saveCreationDraft: (...args: Parameters<typeof actual.saveCreationDraft>) => {
      state.saveDraft(...args);
      return actual.saveCreationDraft(...args);
    },
    clearCreationDraft: (...args: Parameters<typeof actual.clearCreationDraft>) => {
      state.clearDraft(...args);
      return actual.clearCreationDraft(...args);
    },
  };
});
vi.mock("@/components/create-workspace-modal", () => ({
  CreateWorkspaceModal: () => null,
}));
vi.mock("@/components/brainstorm-panel", () => ({
  BrainstormPanel: ({ onClose }: { onClose: () => void }) => (
    <button type="button" onClick={onClose}>
      Close brainstorm
    </button>
  ),
}));
vi.mock("@/components/project-trash-dialog", () => ({ ProjectTrashDialog: () => null }));
vi.mock("@/components/projects/project-card-snapshot", () => ({
  ProjectCardSnapshot: () => null,
}));

// Exercise the real entry picker, dashboard and page-owned composer state.
// The composer probe exposes only the existing controlled-input contract and
// mount lifetime; it does not implement workspace selection or draft storage.
vi.mock("@/components/projects/project-composer", () => ({
  ProjectComposer: function ComposerProbe({
    prompt,
    platform = "web",
    onPlatformChange,
    onPromptChange,
    onContinue,
  }: {
    prompt: string;
    platform?: "web" | "mobile";
    onPlatformChange?: (value: "web" | "mobile") => void;
    onPromptChange: (value: string) => void;
    onContinue: (value: string, platform: "web" | "mobile") => void;
  }) {
    const lifetime = useRef({});
    useEffect(() => {
      const token = lifetime.current;
      state.composerMounted(token);
      return () => {
        state.composerUnmounted(token);
      };
    }, []);
    return (
      <section aria-label="Project composer">
        <label htmlFor="fixture-project-brief">Project brief</label>
        <textarea
          id="fixture-project-brief"
          value={prompt}
          onChange={(event) => onPromptChange(event.target.value)}
        />
        <button
          type="button"
          aria-pressed={platform === "mobile"}
          onClick={() => onPlatformChange?.(platform === "mobile" ? "web" : "mobile")}
        >
          Mobile target
        </button>
        <button type="button" onClick={() => onContinue(prompt, platform)}>
          Continue to project details
        </button>
      </section>
    );
  },
}));

import ProjectsPage from "../projects";

const workspace = (id: number, name: string, ownerUserId = "account-a"): WorkspaceFixture => ({
  id,
  name,
  ownerUserId,
  type: "personal",
  createdAt: "2026-09-08T00:00:00Z",
  updatedAt: "2026-09-08T00:00:00Z",
  deletedAt: null,
});
const studio = workspace(1, "Studio");
const client = workspace(2, "Client");
const accountBWorkspace = workspace(1, "Account B studio", "account-b");

function queries(projectId: number, projectName: string, activity: string) {
  return {
    summaryQuery: {
      data: {
        total: 1,
        recent: [
          {
            id: projectId,
            name: projectName,
            status: "draft",
            updatedAt: "2026-09-08T00:00:00Z",
          },
        ],
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    },
    activityQuery: {
      data: [
        {
          id: projectId,
          projectName,
          summary: activity,
          createdAt: "2026-09-08T00:00:00Z",
        },
      ],
      isLoading: false,
      isError: false,
      isFetching: false,
      refetch: vi.fn().mockResolvedValue(undefined),
    },
  };
}
const queryResults = new Map<string, ReturnType<typeof queries>>();
const resultFor = (accountId: string, workspaceId: number) =>
  queryResults.get(accountId + ":" + workspaceId)!;
const editBrief = (value: string) =>
  fireEvent.change(screen.getByLabelText("Project brief"), { target: { value } });
type Page = ReturnType<typeof render>;

function choose(page: Page, name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Open workspace " + name }));
  // The provider is mocked. Publish the selection callback's new context value.
  page.rerender(<ProjectsPage />);
}

function switchToPicker(page: Page) {
  fireEvent.click(screen.getByRole("button", { name: "Switch workspace" }));
  page.rerender(<ProjectsPage />);
}

beforeEach(() => {
  vi.clearAllMocks();
  sessionStorage.clear();
  state.accountId = "account-a";
  state.chosen = false;
  state.selectedId = 1;
  state.loading = false;
  state.error = false;
  state.workspaces = [studio, client];
  queryResults.clear();
  queryResults.set("account-a:1", queries(901, "Studio project", "Studio project updated"));
  queryResults.set("account-a:2", queries(902, "Client project", "Client project updated"));
  queryResults.set("account-b:1", queries(903, "Account B project", "Account B project updated"));
  state.workspaceProjects.mockImplementation((accountId: string, workspaceId: number) => {
    const result = queryResults.get(accountId + ":" + workspaceId);
    if (!result) throw new Error("Unexpected account/workspace query");
    return result;
  });
  state.selectWorkspace.mockImplementation((id: number) => {
    state.selectedId = id;
    state.chosen = true;
  });
  state.requestWorkspaceChoice.mockImplementation(() => {
    state.chosen = false;
  });
  state.retryWorkspaces.mockResolvedValue(undefined);
  state.securityQuery.mockReturnValue({ data: { counts: {} } });
  state.invalidate.mockResolvedValue(undefined);
  state.deleteProject.mockResolvedValue(undefined);
});
afterEach(cleanup);

describe("Projects workspace entry integration", () => {
  it("shows the picker even with one remembered workspace until an explicit selection", () => {
    state.workspaces = [studio];
    const page = render(<ProjectsPage />);
    expect(screen.getByRole("heading", { name: "Choose a workspace" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Open workspace Studio" })).toBeEnabled();
    expect(screen.queryByLabelText("Project brief")).toBeNull();
    expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
    expect(state.workspaceProjects).not.toHaveBeenCalled();
    expect(state.selectWorkspace).not.toHaveBeenCalled();
    expect(state.createProject).not.toHaveBeenCalled();
    choose(page, "Studio");
    expect(state.selectWorkspace).toHaveBeenCalledWith(1);
    expect(state.workspaceProjects).toHaveBeenLastCalledWith("account-a", 1);
    expect(screen.getByRole("article", { name: "Studio project" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Choose a workspace" })).toBeNull();
  });

  it("scopes home queries and security cache identity to the account and chosen workspace", () => {
    state.chosen = true;
    state.selectedId = 2;
    render(<ProjectsPage />);
    expect(state.workspaceProjects).toHaveBeenLastCalledWith("account-a", 2);
    expect(state.securityQuery).toHaveBeenLastCalledWith({
      query: {
        queryKey: ["security", { accountId: "account-a", workspaceId: 2 }],
        enabled: true,
      },
    });
    expect(screen.getByRole("article", { name: "Client project" })).toBeInTheDocument();
    expect(screen.getByText("Client project updated")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
    expect(screen.queryByText("Studio project updated")).toBeNull();
  });

  it("unmounts the previous home on Switch workspace and shows no old project or draft in the picker or next home", () => {
    state.chosen = true;
    const page = render(<ProjectsPage />);
    editBrief("Studio-only private brief");
    const previousLifetime = state.composerMounted.mock.calls[0]![0];
    switchToPicker(page);
    expect(state.requestWorkspaceChoice).toHaveBeenCalledOnce();
    expect(state.composerUnmounted).toHaveBeenCalledWith(previousLifetime);
    expect(screen.queryByLabelText("Project brief")).toBeNull();
    expect(screen.queryByDisplayValue("Studio-only private brief")).toBeNull();
    expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
    expect(screen.queryByText("Studio project updated")).toBeNull();
    choose(page, "Client");
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(screen.getByRole("article", { name: "Client project" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
    expect(state.composerMounted).toHaveBeenCalledTimes(2);
  });

  it("keys home lifetime by workspace even when the sidebar changes selection directly", () => {
    state.chosen = true;
    const page = render(<ProjectsPage />);
    editBrief("Studio brief");
    const previousLifetime = state.composerMounted.mock.calls[0]![0];
    state.selectedId = 2;
    page.rerender(<ProjectsPage />);
    expect(state.composerUnmounted).toHaveBeenCalledWith(previousLifetime);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
    expect(state.workspaceProjects).toHaveBeenLastCalledWith("account-a", 2);
  });

  it("preserves independent in-memory composer drafts, including an explicitly cleared draft", () => {
    state.chosen = true;
    const page = render(<ProjectsPage />);
    editBrief("Studio draft");
    switchToPicker(page);
    choose(page, "Client");
    editBrief("Client draft");
    switchToPicker(page);
    choose(page, "Studio");
    expect(screen.getByLabelText("Project brief")).toHaveValue("Studio draft");
    editBrief("");
    switchToPicker(page);
    choose(page, "Client");
    expect(screen.getByLabelText("Project brief")).toHaveValue("Client draft");
    switchToPicker(page);
    choose(page, "Studio");
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(readCreationDraft({ accountId: "account-a", workspaceId: 1 })?.prompt).toBe("");
    expect(readCreationDraft({ accountId: "account-a", workspaceId: 2 })?.prompt).toBe(
      "Client draft",
    );
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toBeNull();
  });

  it("keeps persisted drafts private across account remounts, including returning to the first account", () => {
    state.chosen = true;
    const page = render(<ProjectsPage />);
    editBrief("Account A private draft");
    const previousLifetime = state.composerMounted.mock.calls[0]![0];
    state.accountId = "account-b";
    state.workspaces = [accountBWorkspace];
    page.rerender(<ProjectsPage />);
    expect(state.composerUnmounted).toHaveBeenCalledWith(previousLifetime);
    expect(state.workspaceProjects).toHaveBeenLastCalledWith("account-b", 1);
    expect(screen.getByRole("article", { name: "Account B project" })).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    editBrief("Account B private draft");
    state.accountId = "account-a";
    state.workspaces = [studio, client];
    page.rerender(<ProjectsPage />);
    expect(state.workspaceProjects).toHaveBeenLastCalledWith("account-a", 1);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Account A private draft");
    expect(screen.queryByRole("article", { name: "Account B project" })).toBeNull();
    expect(readCreationDraft({ accountId: "account-b", workspaceId: 1 })?.prompt).toBe(
      "Account B private draft",
    );
  });

  it.each(["loading", "error"] as const)(
    "hides a previously rendered home and cached workspace choices during workspace %s",
    (status) => {
      state.chosen = true;
      const page = render(<ProjectsPage />);
      editBrief("Retained Studio draft");
      const queriesBefore = state.workspaceProjects.mock.calls.length;
      state.loading = status === "loading";
      state.error = status === "error";
      page.rerender(<ProjectsPage />);
      expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
      expect(screen.queryByText("Studio project updated")).toBeNull();
      expect(screen.queryByLabelText("Project brief")).toBeNull();
      expect(screen.queryByRole("button", { name: "Open workspace Studio" })).toBeNull();
      expect(state.workspaceProjects).toHaveBeenCalledTimes(queriesBefore);
      if (status === "error") {
        fireEvent.click(screen.getByRole("button", { name: "Retry workspaces" }));
        expect(state.retryWorkspaces).toHaveBeenCalledOnce();
      }
      state.loading = false;
      state.error = false;
      page.rerender(<ProjectsPage />);
      expect(screen.getByLabelText("Project brief")).toHaveValue("Retained Studio draft");
    },
  );

  it("does not mount cached workspace home while the account identity is unavailable", () => {
    state.chosen = true;
    const page = render(<ProjectsPage />);
    editBrief("Account A private draft");
    const queriesBefore = state.workspaceProjects.mock.calls.length;
    state.accountId = null;
    page.rerender(<ProjectsPage />);
    expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
    expect(screen.queryByLabelText("Project brief")).toBeNull();
    expect(screen.queryByRole("button", { name: "Open workspace Studio" })).toBeNull();
    expect(state.workspaceProjects).toHaveBeenCalledTimes(queriesBefore);
  });

  it.each(["loading", "error"] as const)(
    "does not render cached project or activity rows while their queries are %s",
    (status) => {
      state.chosen = true;
      const page = render(<ProjectsPage />);
      const queries = resultFor("account-a", 1);
      queries.summaryQuery.isLoading = status === "loading";
      queries.summaryQuery.isError = status === "error";
      queries.activityQuery.isLoading = status === "loading";
      queries.activityQuery.isError = status === "error";
      page.rerender(<ProjectsPage />);
      expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
      expect(screen.queryByText("Studio project updated")).toBeNull();
      expect(screen.getByLabelText("Project brief")).toBeInTheDocument();
      if (status === "loading") {
        expect(screen.getByRole("status", { name: "Loading projects" })).toBeInTheDocument();
        expect(screen.getByText("Loading activity")).toBeInTheDocument();
      } else {
        expect(screen.getByText("We could not load your projects")).toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        expect(queries.summaryQuery.refetch).toHaveBeenCalledOnce();
        expect(
          screen.getByText("Activity is unavailable right now. Your project list is separate."),
        ).toBeInTheDocument();
      }
    },
  );

  it("opens a recent project in its existing editor without saving a creation draft or creating a project", () => {
    state.chosen = true;
    render(<ProjectsPage />);
    const project = screen.getByRole("link", { name: "Studio project" });
    expect(project).toHaveAttribute("href", "/projects/901");
    fireEvent.click(project);
    expect(state.navigate).toHaveBeenCalledOnce();
    expect(state.navigate).toHaveBeenCalledWith("/projects/901");
    expect(state.saveDraft).not.toHaveBeenCalled();
    expect(state.createProject).not.toHaveBeenCalled();
    expect(state.deleteProject).not.toHaveBeenCalled();
  });
});

describe("Arrival draft isolation regressions", () => {
  // These retain the original replay assertions and now exercise real storage,
  // including durable account claim and explicit workspace assignment.
  it("does not replay an untouched arrival draft into a newly selected workspace", () => {
    state.chosen = true;
    savePublicCreationDraft({
      intent: "build",
      prompt: "Idea assigned to Studio",
      platform: "web",
    });
    const page = render(<ProjectsPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Idea assigned to Studio");
    switchToPicker(page);
    choose(page, "Client");
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    switchToPicker(page);
    choose(page, "Studio");
    expect(screen.getByLabelText("Project brief")).toHaveValue("Idea assigned to Studio");
  });

  it("does not replay a signed-in account's saved creation handoff into another account", () => {
    state.chosen = true;
    const page = render(<ProjectsPage />);
    editBrief("Account A private creation handoff");
    fireEvent.click(screen.getByRole("button", { name: "Continue to project details" }));
    expect(state.saveDraft).toHaveBeenCalledWith(
      {
        intent: "build",
        prompt: "Account A private creation handoff",
        platform: "web",
      },
      { accountId: "account-a", workspaceId: 1 },
    );
    expect(state.navigate).toHaveBeenCalledWith(
      creationDraftDestination({ accountId: "account-a", workspaceId: 1 }),
    );
    state.accountId = "account-b";
    state.workspaces = [accountBWorkspace];
    page.rerender(<ProjectsPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(screen.queryByRole("article", { name: "Studio project" })).toBeNull();
  });
});

describe("Durable workspace idea and platform integration", () => {
  it("restores scoped prompt and platform after a full page remount and retains a deliberate empty edit", () => {
    state.chosen = true;
    const page = render(<ProjectsPage />);
    editBrief("Studio saved idea");
    fireEvent.click(screen.getByRole("button", { name: "Mobile target" }));
    page.unmount();
    const reloaded = render(<ProjectsPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Studio saved idea");
    expect(screen.getByRole("button", { name: "Mobile target" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    editBrief("");
    reloaded.unmount();
    const empty = render(<ProjectsPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Mobile target" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    state.selectedId = 2;
    empty.rerender(<ProjectsPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Mobile target" })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
  });

  it("claims a public idea to the account while the picker is open, then assigns only the explicitly chosen workspace", () => {
    const publicDraft = savePublicCreationDraft({
      intent: "build",
      prompt: "Pick my home",
      platform: "mobile",
    })!;
    const page = render(<ProjectsPage />);
    expect(screen.queryByLabelText("Project brief")).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toBeNull();
    expect(readCreationDraft({ accountId: "account-a", workspaceId: null })).toMatchObject({
      id: publicDraft.id,
    });
    choose(page, "Client");
    expect(screen.getByLabelText("Project brief")).toHaveValue("Pick my home");
    expect(screen.getByRole("button", { name: "Mobile target" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(readCreationDraft({ accountId: "account-a", workspaceId: null })).toBeNull();
    expect(readCreationDraft({ accountId: "account-a", workspaceId: 2 })).toMatchObject({
      id: publicDraft.id,
    });
    switchToPicker(page);
    choose(page, "Studio");
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
  });

  it("does not display public content if its durable claim cannot be written", () => {
    const publicDraft = savePublicCreationDraft({
      intent: "build",
      prompt: "Unclaimed idea",
      platform: "mobile",
    });
    state.chosen = true;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      render(<ProjectsPage />);
      expect(screen.getByLabelText("Project brief")).toHaveValue("");
      expect(screen.getByRole("button", { name: "Mobile target" })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      expect(
        JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
      ).toEqual(publicDraft);
      expect(readCreationDraft({ accountId: "account-a", workspaceId: 1 })).toBeNull();
    } finally {
      write.mockRestore();
    }
  });
});

describe("Persisted brainstorm close recovery", () => {
  it("does not reopen a just-closed brainstorm after remounting a home that started empty", async () => {
    const actual = await vi.importActual<typeof ComposerModule>(
      "@/components/projects/project-composer",
    );
    const composer = vi
      .spyOn(ComposerModule, "ProjectComposer")
      .mockImplementation(actual.ProjectComposer);
    try {
      state.chosen = true;
      const page = render(<ProjectsPage />);
      fireEvent.change(screen.getByRole("textbox", { name: "Describe your app" }), {
        target: { value: "A newly discussed idea" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Brainstorm first" }));
      expect(readCreationDraft({ accountId: "account-a", workspaceId: 1 })).toMatchObject({
        intent: "brainstorm",
        prompt: "A newly discussed idea",
      });
      fireEvent.click(screen.getByRole("button", { name: "Close brainstorm" }));
      expect(screen.queryByRole("button", { name: "Close brainstorm" })).toBeNull();

      page.unmount();
      render(<ProjectsPage />);
      expect(screen.queryByRole("button", { name: "Close brainstorm" })).toBeNull();
      expect(screen.getByRole("textbox", { name: "Describe your app" })).toHaveValue(
        "A newly discussed idea",
      );
      expect(readCreationDraft({ accountId: "account-a", workspaceId: 1 })?.intent).not.toBe(
        "brainstorm",
      );
    } finally {
      cleanup();
      composer.mockRestore();
    }
  });
});

describe("Brainstorm closure receipt identity", () => {
  it("does not overwrite newer saved work when an older brainstorm panel closes", async () => {
    const actual = await vi.importActual<typeof ComposerModule>(
      "@/components/projects/project-composer",
    );
    const composer = vi
      .spyOn(ComposerModule, "ProjectComposer")
      .mockImplementation(actual.ProjectComposer);
    try {
      state.chosen = true;
      const page = render(<ProjectsPage />);
      fireEvent.change(screen.getByRole("textbox", { name: "Describe your app" }), {
        target: { value: "Older brainstorm" },
      });
      fireEvent.click(screen.getByRole("button", { name: "Brainstorm first" }));
      const scope = { accountId: "account-a", workspaceId: 1 };
      const newer = saveCreationDraft(
        {
          intent: "build",
          prompt: "Newer saved work",
          platform: "mobile",
        },
        scope,
      )!;
      const before = sessionStorage.getItem("nabuflow.creation-drafts.v2");
      fireEvent.click(screen.getByRole("button", { name: "Close brainstorm" }));
      expect(readCreationDraft(scope)).toEqual(newer);
      expect(sessionStorage.getItem("nabuflow.creation-drafts.v2")).toBe(before);
      page.unmount();
      render(<ProjectsPage />);
      expect(screen.getByRole("textbox", { name: "Describe your app" })).toHaveValue(
        "Newer saved work",
      );
      expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.queryByRole("button", { name: "Close brainstorm" })).toBeNull();
    } finally {
      cleanup();
      composer.mockRestore();
    }
  });
});
