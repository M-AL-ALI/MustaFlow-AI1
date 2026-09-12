import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import type { ProjectReviewClerk } from "@/lib/project-review-account-fence";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { TemplateDefinition } from "@/lib/templates";
import {
  readCreationDraft,
  saveCreationDraft,
  savePublicCreationDraft,
  claimCreationDraft,
  creationDraftDestination,
} from "@/lib/creation-draft";

const studioDraftScope = { accountId: "account-a", workspaceId: 7 };
const otherDraftScope = { accountId: "account-b", workspaceId: 8 };
import {
  readProjectReviewDraft as readAccountReviewDraft,
  saveProjectReviewDraft as saveAccountReviewDraft,
} from "@/components/projects/project-creation-state";
import NewProjectPage from "./new";

const readProjectReviewDraft = readAccountReviewDraft.bind(null, "account-a");
const saveProjectReviewDraft = saveAccountReviewDraft.bind(null, "account-a");

type ClerkListener = Parameters<ProjectReviewClerk["addListener"]>[0];
const clerkListeners = new Set<ClerkListener>();
let liveClerk: ProjectReviewClerk;
let originalClerk: PropertyDescriptor | undefined;

const mocks = vi.hoisted(() => ({
  mutate: vi.fn(),
  useCreateProject: vi.fn(),
  useWorkspace: vi.fn(),
  useClerkUser: vi.fn(),
  retryWorkspaces: vi.fn(),
  setLocation: vi.fn(),
  setQueryData: vi.fn(),
  invalidateQueries: vi.fn(),
  mobileTemplate: {
    id: "mobile-test",
    title: "Studio bookings",
    projectKind: "mobile-cross",
    seedPrompt: "Build a studio booking app",
    description: "",
    category: "Mobile",
    icon: "Smartphone",
  },
  unsupportedTemplate: {
    id: "slides-test",
    title: "Pitch slides",
    projectKind: "slides",
    seedPrompt: "Make slides",
    description: "",
    category: "Slides",
    icon: "Presentation",
  },
}));
vi.mock("wouter", async (importOriginal) => {
  const actual = await importOriginal<typeof import("wouter")>();
  return { useLocation: () => ["/projects/new", mocks.setLocation], useSearch: actual.useSearch };
});
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({
    setQueryData: mocks.setQueryData,
    invalidateQueries: mocks.invalidateQueries,
  }),
}));
vi.mock("@workspace/api-client-react", () => ({
  useCreateProject: mocks.useCreateProject,
  getGetProjectQueryKey: (id: number) => ["/api/projects/" + id],
  getListProjectsQueryKey: () => ["/api/projects"],
  getGetProjectsSummaryQueryKey: () => ["/api/projects/summary"],
  getGetRecentActivityQueryKey: () => ["/api/activity/recent"],
}));
vi.mock("@/contexts/workspace-context", () => ({ useWorkspace: mocks.useWorkspace }));
vi.mock("@/lib/clerk-safe", () => ({ useClerkUser: mocks.useClerkUser }));
vi.mock("@/lib/templates", () => ({
  TEMPLATES: [mocks.mobileTemplate, mocks.unsupportedTemplate],
  STARTER_PACKS: [],
}));
vi.mock("@/components/template-picker", () => ({
  TemplatePicker: ({
    onSelect,
    onStartFromScratch,
  }: {
    onSelect: (template: TemplateDefinition) => void;
    onStartFromScratch: () => void;
  }) => (
    <>
      <button type="button" onClick={() => onSelect(mocks.mobileTemplate as TemplateDefinition)}>
        Choose studio template
      </button>
      <button
        type="button"
        onClick={() => onSelect(mocks.unsupportedTemplate as TemplateDefinition)}
      >
        Choose slides template
      </button>
      <button type="button" onClick={onStartFromScratch}>
        Start from scratch
      </button>
    </>
  ),
}));

const workspaceState = (ownerId = "account-a") => {
  const currentWorkspace = {
    id: ownerId === "account-a" ? 7 : 8,
    name: ownerId === "account-a" ? "Studio" : "B workspace",
    ownerUserId: ownerId,
    type: "personal",
    deletedAt: null,
  };
  return {
    currentWorkspace,
    workspaces: [currentWorkspace],
    hasChosenWorkspace: true,
    isLoading: false,
    isError: false,
    retryWorkspaces: mocks.retryWorkspaces,
  };
};

const otherWorkspace = {
  id: 9,
  name: "Client",
  ownerUserId: "account-a",
  type: "client",
  deletedAt: null,
};

function selectOtherWorkspace() {
  mocks.useWorkspace.mockReturnValue({
    ...workspaceState(),
    currentWorkspace: otherWorkspace,
    workspaces: [...workspaceState().workspaces, otherWorkspace],
  });
}
type Callbacks = {
  onSuccess: (project: { id: number; name: string }) => void;
  onError: (cause: unknown) => void;
};
const callbacks = () => mocks.mutate.mock.calls.at(-1)![1] as Callbacks;
const setField = (label: string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
const submit = () => fireEvent.submit(screen.getByRole("form", { name: "Create project" }));
const showOptions = () => fireEvent.click(screen.getByText("Starting point and advanced options"));

beforeEach(() => {
  vi.clearAllMocks();
  originalClerk = Object.getOwnPropertyDescriptor(window, "Clerk");
  clerkListeners.clear();
  liveClerk = {
    loaded: true,
    user: { id: "account-a" },
    addListener: (listener) => {
      clerkListeners.add(listener);
      listener({ user: liveClerk.user });
      return () => {
        clerkListeners.delete(listener);
      };
    },
  };
  Object.defineProperty(window, "Clerk", {
    configurable: true,
    writable: true,
    value: liveClerk,
  });
  sessionStorage.clear();
  window.history.replaceState({}, "", "/projects/new");
  mocks.setLocation.mockImplementation(() => undefined);
  mocks.invalidateQueries.mockResolvedValue(undefined);
  mocks.retryWorkspaces.mockResolvedValue(undefined);
  mocks.useCreateProject.mockReturnValue({ mutate: mocks.mutate, isPending: false });
  mocks.useWorkspace.mockReturnValue(workspaceState());
  mocks.useClerkUser.mockReturnValue({
    isLoaded: true,
    isSignedIn: true,
    user: { id: "account-a" },
  });
});
afterEach(() => {
  cleanup();
  if (originalClerk) Object.defineProperty(window, "Clerk", originalClerk);
  else Reflect.deleteProperty(window, "Clerk");
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function notifyClerk(ownerId: string | null, isLoaded = true) {
  liveClerk.loaded = isLoaded;
  liveClerk.user = ownerId ? { id: ownerId } : null;
  for (const listener of [...clerkListeners]) listener({ user: liveClerk.user });
}

function switchAccount(ownerId: string | null, isLoaded = true) {
  act(() => notifyClerk(ownerId, isLoaded));
  mocks.useClerkUser.mockReturnValue({
    isLoaded,
    isSignedIn: isLoaded && Boolean(ownerId),
    user: ownerId ? { id: ownerId } : null,
  });
  mocks.useWorkspace.mockReturnValue({
    ...workspaceState(ownerId ?? "account-a"),
    currentWorkspace: ownerId ? workspaceState(ownerId).currentWorkspace : null,
    workspaces: ownerId ? workspaceState(ownerId).workspaces : [],
  });
}

describe("Clerk notifications before React account commit", () => {
  it.each(["success", "error"] as const)(
    "fences pending %s using the live SDK principal before notification",
    (outcome) => {
      const entry = savePublicCreationDraft({
        intent: "build",
        prompt: "A private idea",
        platform: "web",
      });
      window.history.replaceState({}, "", "/projects/new?draft=1");
      render(<NewProjectPage />);
      submit();
      const pending = callbacks();
      const review = readAccountReviewDraft("account-a");
      act(() => {
        liveClerk.user = { id: "account-b" };
        if (outcome === "success") pending.onSuccess({ id: 99, name: "A private idea" });
        else pending.onError(new Error("Old principal error"));
      });
      expect(mocks.useClerkUser().user.id).toBe("account-a");
      expect(mocks.setLocation).not.toHaveBeenCalled();
      expect(mocks.setQueryData).not.toHaveBeenCalled();
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
      expect(screen.queryByText("Old principal error")).toBeNull();
      expect(readAccountReviewDraft("account-a")).toEqual(review);
      expect(readCreationDraft(studioDraftScope)).toMatchObject({
        id: entry!.id,
        accountId: "account-a",
        workspaceId: 7,
      });
    },
  );

  it.each(["success", "error"] as const)(
    "does not revive pending %s after A-to-B-to-A notifications before React commit",
    (outcome) => {
      render(<NewProjectPage />);
      setField("Project name", "Original A project");
      submit();
      const pending = callbacks();
      const replacement = saveAccountReviewDraft(
        "account-a",
        {
          ...readAccountReviewDraft("account-a")!.values,
          name: "Newer A draft",
        },
        null,
      );
      const other = saveAccountReviewDraft(
        "account-b",
        {
          ...replacement!.values,
          name: "B private draft",
        },
        null,
      );
      const handoff = savePublicCreationDraft({
        intent: "build",
        prompt: "New anonymous handoff",
        platform: "mobile",
      });
      act(() => {
        // Keep both the SDK getter and React snapshot at A; emissions alone must fence.
        for (const listener of [...clerkListeners]) listener({ user: { id: "account-b" } });
        for (const listener of [...clerkListeners]) listener({ user: { id: "account-a" } });
        if (outcome === "success") pending.onSuccess({ id: 99, name: "Original A project" });
        else pending.onError(new Error("Old principal error"));
      });
      expect(mocks.useClerkUser().user.id).toBe("account-a");
      expect(liveClerk.user?.id).toBe("account-a");
      expect(mocks.setLocation).not.toHaveBeenCalled();
      expect(mocks.setQueryData).not.toHaveBeenCalled();
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
      expect(screen.queryByText("Old principal error")).toBeNull();
      expect(readAccountReviewDraft("account-a")).toEqual(replacement);
      expect(readAccountReviewDraft("account-b")).toEqual(other);
      expect(
        JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
      ).toEqual(handoff);
    },
  );

  it("blocks a stale form submission before React receives the changed account", () => {
    render(<NewProjectPage />);
    setField("Project name", "A project");
    act(() => {
      liveClerk.user = { id: "account-b" };
      submit();
    });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("requires a confirmable Clerk instance without changing the anonymous handoff", () => {
    Reflect.deleteProperty(window, "Clerk");
    const handoff = savePublicCreationDraft({
      intent: "build",
      prompt: "Keep my idea",
      platform: "web",
    });
    window.history.replaceState({}, "", "/projects/new?draft=1");
    render(<NewProjectPage />);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    submit();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toEqual(handoff);
    expect(readAccountReviewDraft("account-a")).toBeNull();
  });

  it("stops remaining cache invalidations and navigation if the principal changes during cache delivery", () => {
    render(<NewProjectPage />);
    setField("Project name", "A project");
    submit();
    mocks.setQueryData.mockImplementationOnce(() => {
      liveClerk.user = { id: "account-b" };
    });
    act(() => callbacks().onSuccess({ id: 99, name: "A project" }));
    expect(mocks.setQueryData).toHaveBeenCalledOnce();
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    expect(mocks.setLocation).not.toHaveBeenCalled();
  });

  it("cleans up StrictMode subscriptions and fences pending callbacks after unmount", () => {
    const page = render(
      <StrictMode>
        <NewProjectPage />
      </StrictMode>,
    );
    expect(clerkListeners.size).toBe(1);
    setField("Project name", "A project");
    submit();
    const pending = callbacks();
    const draft = readAccountReviewDraft("account-a");
    const captured = [...clerkListeners][0];
    page.unmount();
    expect(clerkListeners.size).toBe(0);
    act(() => {
      captured({ user: { id: "account-b" } });
      pending.onSuccess({ id: 99, name: "A project" });
      pending.onError(new Error("Late unmounted error"));
    });
    expect(mocks.setLocation).not.toHaveBeenCalled();
    expect(mocks.setQueryData).not.toHaveBeenCalled();
    expect(mocks.invalidateQueries).not.toHaveBeenCalled();
    expect(readAccountReviewDraft("account-a")).toEqual(draft);
  });
});

describe("authenticated project review privacy", () => {
  it("remounts account A to B to A without inheriting another account's form state", () => {
    const page = render(<NewProjectPage />);
    setField("Project brief", "A private booking app");
    setField("Project name", "A private name");
    showOptions();
    setField("Stack", "nextjs");
    setField("Build setup", "fullstack");
    fireEvent.click(screen.getByRole("button", { name: "Mobile" }));
    switchAccount("account-b");
    page.rerender(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(screen.getByLabelText("Project name")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Web" })).toHaveAttribute("aria-pressed", "true");
    setField("Project brief", "B private diary");
    setField("Project name", "B private name");
    switchAccount("account-a");
    page.rerender(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("A private booking app");
    expect(screen.getByLabelText("Project name")).toHaveValue("A private name");
    expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-pressed", "true");
    expect(readAccountReviewDraft("account-a")?.values).toMatchObject({
      stack: "nextjs",
      appMode: "fullstack",
      nameEdited: true,
    });
    expect(readAccountReviewDraft("account-b")?.values.name).toBe("B private name");
  });

  it("does not read or render a review while authentication is loading or signed out", () => {
    switchAccount("account-a", false);
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    const page = render(<NewProjectPage />);
    expect(screen.queryByRole("form", { name: "Create project" })).toBeNull();
    expect(getItem).not.toHaveBeenCalled();
    switchAccount(null);
    page.rerender(<NewProjectPage />);
    expect(screen.queryByRole("form", { name: "Create project" })).toBeNull();
    expect(getItem).not.toHaveBeenCalled();
    switchAccount("account-b");
    page.rerender(<NewProjectPage />);
    expect(screen.getByLabelText("Project name")).toHaveValue("");
  });

  it("preserves the anonymous handoff until a loaded account can review it", () => {
    const entry = savePublicCreationDraft({
      intent: "build",
      prompt: "An anonymous idea",
      platform: "mobile",
    });
    window.history.replaceState({}, "", "/projects/new?draft=1");
    switchAccount(null, false);
    const page = render(<NewProjectPage />);
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toEqual(entry);
    expect(readAccountReviewDraft("account-a")).toBeNull();
    switchAccount("account-a");
    page.rerender(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("An anonymous idea");
    expect(readAccountReviewDraft("account-a")).toMatchObject({
      ownerId: "account-a",
      sourceDraftId: entry!.id,
    });
    expect(readCreationDraft(studioDraftScope)).toMatchObject({
      id: entry!.id,
      accountId: "account-a",
      workspaceId: 7,
    });
  });

  it.each(["success", "error"] as const)(
    "fences late %s while account B has its own pending creation",
    (outcome) => {
      const page = render(<NewProjectPage />);
      setField("Project name", "A project");
      submit();
      const previous = callbacks();
      const aDraft = readAccountReviewDraft("account-a");
      switchAccount("account-b");
      page.rerender(<NewProjectPage />);
      setField("Project name", "B project");
      submit();
      const current = callbacks();
      const bDraft = readAccountReviewDraft("account-b");
      act(() => {
        if (outcome === "success") previous.onSuccess({ id: 99, name: "A project" });
        else previous.onError(new Error("A request failed"));
      });
      expect(screen.getByLabelText("Project name")).toHaveValue("B project");
      expect(screen.getByRole("button", { name: "Creating project..." })).toBeDisabled();
      expect(screen.queryByText("A request failed")).toBeNull();
      expect(mocks.setLocation).not.toHaveBeenCalled();
      expect(mocks.setQueryData).not.toHaveBeenCalled();
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
      expect(readAccountReviewDraft("account-a")).toEqual(aDraft);
      expect(readAccountReviewDraft("account-b")).toEqual(bDraft);
      expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(7);
      expect(mocks.mutate.mock.calls[1][0].data.workspaceId).toBe(8);
      act(() => current.onSuccess({ id: 100, name: "B project" }));
      expect(mocks.setLocation).toHaveBeenCalledWith("/projects/100", { replace: true });
      expect(readAccountReviewDraft("account-b")).toBeNull();
      expect(readAccountReviewDraft("account-a")).toEqual(aDraft);
    },
  );

  it.each(["success", "error"] as const)(
    "fences late %s after returning from B to A",
    (outcome) => {
      const page = render(<NewProjectPage />);
      setField("Project name", "First A project");
      submit();
      const previous = callbacks();
      switchAccount("account-b");
      page.rerender(<NewProjectPage />);
      setField("Project name", "B retained project");
      const bDraft = readAccountReviewDraft("account-b");
      switchAccount("account-a");
      page.rerender(<NewProjectPage />);
      setField("Project name", "Resumed A project");
      submit();
      const current = callbacks();
      const aDraft = readAccountReviewDraft("account-a");
      act(() => {
        if (outcome === "success") previous.onSuccess({ id: 99, name: "First A project" });
        else previous.onError(new Error("Old A request failed"));
      });
      expect(screen.getByLabelText("Project name")).toHaveValue("Resumed A project");
      expect(screen.getByRole("button", { name: "Creating project..." })).toBeDisabled();
      expect(screen.queryByText("Old A request failed")).toBeNull();
      expect(mocks.setLocation).not.toHaveBeenCalled();
      expect(mocks.setQueryData).not.toHaveBeenCalled();
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
      expect(readAccountReviewDraft("account-a")).toEqual(aDraft);
      expect(readAccountReviewDraft("account-b")).toEqual(bDraft);
      act(() => current.onSuccess({ id: 101, name: "Resumed A project" }));
      expect(mocks.setLocation).toHaveBeenCalledWith("/projects/101", { replace: true });
      expect(readAccountReviewDraft("account-a")).toBeNull();
      expect(readAccountReviewDraft("account-b")).toEqual(bDraft);
    },
  );

  it("clears only the submitted owner's review while retaining another account's saved review", () => {
    render(<NewProjectPage />);
    setField("Project name", "A project");
    submit();
    const other = saveAccountReviewDraft(
      "account-b",
      {
        ...readAccountReviewDraft("account-a")!.values,
        name: "B retained project",
      },
      null,
    );
    act(() => callbacks().onSuccess({ id: 99, name: "A project" }));
    expect(readAccountReviewDraft("account-a")).toBeNull();
    expect(readAccountReviewDraft("account-b")).toEqual(other);
  });
});

describe("project review workspace binding", () => {
  it("keeps the draft's original workspace when the sidebar selection changes", () => {
    const page = render(<NewProjectPage />);
    setField("Project brief", "A studio booking app");
    setField("Project name", "Studio schedule");
    selectOtherWorkspace();
    page.rerender(<NewProjectPage />);
    expect(screen.getByText("Studio", { selector: "span" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Use Client for this draft" })).toBeEnabled();
    expect(readProjectReviewDraft()?.values).toMatchObject({ workspaceId: 7 });
    submit();
    expect(mocks.mutate.mock.calls[0][0].data).toMatchObject({
      workspaceId: 7,
      name: "Studio schedule",
      initialPrompt: "A studio booking app",
    });
  });

  it("restores the saved workspace after remounting under another sidebar selection", () => {
    const page = render(<NewProjectPage />);
    setField("Project name", "Retained Studio draft");
    page.unmount();
    selectOtherWorkspace();
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project name")).toHaveValue("Retained Studio draft");
    submit();
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(7);
  });

  it("moves only after an explicit form action and preserves the edited brief", () => {
    const page = render(<NewProjectPage />);
    setField("Project brief", "Keep my exact brief");
    setField("Project name", "Custom project");
    selectOtherWorkspace();
    page.rerender(<NewProjectPage />);
    fireEvent.click(screen.getByRole("button", { name: "Use Client for this draft" }));
    expect(screen.getByLabelText("Project brief")).toHaveValue("Keep my exact brief");
    expect(screen.getByLabelText("Project name")).toHaveValue("Custom project");
    expect(readProjectReviewDraft()?.values).toMatchObject({ workspaceId: 9 });
    submit();
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(9);
  });

  it("does not redirect a pending request or its retry after a sidebar switch", () => {
    const page = render(<NewProjectPage />);
    setField("Project name", "Studio schedule");
    submit();
    selectOtherWorkspace();
    page.rerender(<NewProjectPage />);
    expect(screen.getByText("Creating in Studio")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Use Client for this draft" })).toBeNull();
    act(() => callbacks().onError(new Error("Try again")));
    submit();
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(7);
    expect(mocks.mutate.mock.calls[1][0].data.workspaceId).toBe(7);
  });

  it("waits for ready owned workspaces before binding an unassigned draft", () => {
    mocks.useWorkspace.mockReturnValue({ ...workspaceState(), isLoading: true });
    const page = render(<NewProjectPage />);
    setField("Project name", "Draft while loading");
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    selectOtherWorkspace();
    page.rerender(<NewProjectPage />);
    submit();
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(9);
  });

  it("requires an explicit destination when the bound workspace disappears", () => {
    const page = render(<NewProjectPage />);
    setField("Project name", "Retained brief");
    mocks.useWorkspace.mockReturnValue({
      ...workspaceState(),
      currentWorkspace: otherWorkspace,
      workspaces: [otherWorkspace],
    });
    page.rerender(<NewProjectPage />);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    submit();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(readProjectReviewDraft()?.values).toMatchObject({ workspaceId: 7 });
    fireEvent.click(screen.getByRole("button", { name: "Use Client for this draft" }));
    submit();
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(9);
  });

  it("rejects a restored foreign-owner workspace even if present in cached results", () => {
    const page = render(<NewProjectPage />);
    setField("Project name", "Owned draft");
    page.unmount();
    mocks.useWorkspace.mockReturnValue({
      ...workspaceState(),
      currentWorkspace: otherWorkspace,
      workspaces: [
        { ...workspaceState().currentWorkspace, ownerUserId: "account-b" },
        otherWorkspace,
      ],
    });
    render(<NewProjectPage />);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    submit();
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("requires explicit recovery for a malformed legacy workspace identifier", () => {
    const page = render(<NewProjectPage />);
    setField("Project name", "Saved draft");
    page.unmount();
    const legacy = readProjectReviewDraft()!;
    const malformed = JSON.stringify({ ...legacy, values: { ...legacy.values, workspaceId: "7" } });
    const key = "nabuflow.project-review.v2." + encodeURIComponent("account-a");
    // Recreate a pre-upgrade browser with only the malformed old-format record.
    sessionStorage.removeItem("nabuflow.project-review.v3." + encodeURIComponent("account-a"));
    sessionStorage.setItem(key, malformed);
    render(<NewProjectPage />);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    expect(sessionStorage.getItem(key)).toBe(malformed);
    submit();
    expect(mocks.mutate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Use Studio for this draft" }));
    expect(readAccountReviewDraft("account-a", 7)?.values).toMatchObject({
      workspaceId: 7,
      name: "Saved draft",
    });
    submit();
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(7);
  });
});

describe("scoped creation handoff admission", () => {
  it("reviews the handoff's original workspace and platform even when another workspace is selected", () => {
    const draft = saveCreationDraft(
      {
        intent: "build",
        prompt: "Studio mobile app",
        platform: "mobile",
      },
      studioDraftScope,
    )!;
    selectOtherWorkspace();
    window.history.replaceState({}, "", creationDraftDestination(studioDraftScope));
    const page = render(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Studio mobile app");
    expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-pressed", "true");
    expect(readAccountReviewDraft("account-a")?.values).toMatchObject({
      workspaceId: 7,
      handoffWorkspaceId: 7,
    });
    page.unmount();
    render(<NewProjectPage />);
    submit();
    expect(mocks.mutate.mock.calls[0][0].data).toMatchObject({
      workspaceId: 7,
      kind: "mobile-cross",
    });
    act(() => callbacks().onSuccess({ id: 110, name: "Studio mobile app" }));
    expect(readCreationDraft(studioDraftScope)).toBeNull();
    expect(draft.accountId).toBe("account-a");
  });

  it("does not import a foreign account's scoped URL or clear its receipt", () => {
    const foreign = saveCreationDraft(
      { intent: "build", prompt: "A secret", platform: "mobile" },
      studioDraftScope,
    )!;
    const url = creationDraftDestination(studioDraftScope);
    switchAccount("account-b");
    window.history.replaceState({}, "", url);
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(readCreationDraft(studioDraftScope)).toEqual(foreign);
    setField("Project name", "B project");
    submit();
    expect(mocks.mutate).not.toHaveBeenCalled();
    expect(readCreationDraft(studioDraftScope)).toEqual(foreign);
    fireEvent.click(screen.getByRole("button", { name: "Use B workspace for this draft" }));
    submit();
    expect(mocks.mutate.mock.calls[0][0].data).toMatchObject({
      workspaceId: 8,
      name: "B project",
    });
    act(() => callbacks().onSuccess({ id: 111, name: "B project" }));
    expect(readCreationDraft(studioDraftScope)).toEqual(foreign);
  });

  it("claims account ownership before waiting for explicit workspace selection", () => {
    const publicDraft = savePublicCreationDraft({
      intent: "build",
      prompt: "Public idea",
      platform: "mobile",
    })!;
    mocks.useWorkspace.mockReturnValue({ ...workspaceState(), hasChosenWorkspace: false });
    window.history.replaceState({}, "", "/projects/new?draft=1");
    const page = render(<NewProjectPage />);
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toBeNull();
    expect(readCreationDraft({ accountId: "account-a", workspaceId: null })).toMatchObject({
      id: publicDraft.id,
    });
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    mocks.useWorkspace.mockReturnValue(workspaceState());
    page.rerender(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Public idea");
    expect(readCreationDraft(studioDraftScope)).toMatchObject({ id: publicDraft.id });
  });

  it("does not autosave unbound public content when its ownership write fails", () => {
    const publicDraft = savePublicCreationDraft({
      intent: "build",
      prompt: "Do not expose",
      platform: "web",
    });
    window.history.replaceState({}, "", "/projects/new?draft=1");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(readAccountReviewDraft("account-a")).toBeNull();
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toEqual(publicDraft);
  });

  it("keeps the original handoff cleanup scope after an explicit destination change", () => {
    saveCreationDraft(
      { intent: "build", prompt: "A studio app", platform: "web" },
      studioDraftScope,
    );
    window.history.replaceState({}, "", creationDraftDestination(studioDraftScope));
    selectOtherWorkspace();
    render(<NewProjectPage />);
    fireEvent.click(screen.getByRole("button", { name: "Use Client for this draft" }));
    const clientScope = { accountId: "account-a", workspaceId: 9 };
    const newer = saveCreationDraft(
      { intent: "build", prompt: "Client retained idea", platform: "mobile" },
      clientScope,
    );
    submit();
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(9);
    act(() => callbacks().onSuccess({ id: 112, name: "Moved draft" }));
    expect(readCreationDraft(studioDraftScope)).toBeNull();
    expect(readCreationDraft(clientScope)).toEqual(newer);
  });

  it("does not clear a newer same-scope handoff when the old creation completes", () => {
    saveCreationDraft({ intent: "build", prompt: "First idea", platform: "web" }, studioDraftScope);
    window.history.replaceState({}, "", creationDraftDestination(studioDraftScope));
    render(<NewProjectPage />);
    submit();
    const newer = saveCreationDraft(
      { intent: "build", prompt: "Replacement idea", platform: "mobile" },
      studioDraftScope,
    );
    const foreign = saveCreationDraft(
      { intent: "build", prompt: "Other owner idea", platform: "web" },
      otherDraftScope,
    );
    act(() => callbacks().onSuccess({ id: 113, name: "First idea" }));
    expect(readCreationDraft(studioDraftScope)).toEqual(newer);
    expect(readCreationDraft(otherDraftScope)).toEqual(foreign);
  });

  it("keeps a mode-selected account claim away from the next signed-in account", () => {
    savePublicCreationDraft({
      intent: "build",
      prompt: "Claimed before workspace",
      platform: "web",
    });
    const accountScope = { accountId: "account-a", workspaceId: null };
    const claimed = claimCreationDraft(accountScope);
    const destination = creationDraftDestination(accountScope);
    switchAccount("account-b");
    window.history.replaceState({}, "", destination);
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(readCreationDraft(accountScope)).toEqual(claimed);
  });
});

describe("project creation review", () => {
  it("restores the entry brief and mobile target with a visible meaningful name", () => {
    savePublicCreationDraft({
      intent: "build",
      prompt: "Build a booking app for my studio",
      platform: "mobile",
    });
    window.history.replaceState({ retained: true }, "", "/projects/new?draft=1&keep=1#brief");
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Build a booking app for my studio");
    expect(screen.getByLabelText("Project name")).toHaveValue("Booking app for my studio");
    expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-pressed", "true");
    expect(
      screen.getByText("Starting point and advanced options").closest("details"),
    ).not.toHaveAttribute("open");
    expect(window.location.search).toBe("?keep=1");
    expect(window.location.hash).toBe("#brief");
    expect(window.history.state).toEqual({ retained: true });
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("retains custom naming and every edited review detail across a refresh", () => {
    const first = render(<NewProjectPage />);
    setField("Project brief", "A booking app");
    setField("Project name", "Studio schedule");
    setField("Project brief", "  A booking app\nwith reminders  ");
    showOptions();
    setField("Stack", "nextjs");
    setField("Project type", "dashboard");
    setField("Build setup", "fullstack");
    first.unmount();
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project name")).toHaveValue("Studio schedule");
    expect(screen.getByLabelText("Project brief")).toHaveValue("  A booking app\nwith reminders  ");
    showOptions();
    expect(screen.getByLabelText("Stack")).toHaveValue("nextjs");
    expect(screen.getByLabelText("Project type")).toHaveValue("dashboard");
    expect(screen.getByLabelText("Build setup")).toHaveValue("fullstack");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("lets a fresh entry supersede an older review", () => {
    const first = render(<NewProjectPage />);
    setField("Project brief", "An older website");
    setField("Project name", "Old custom name");
    first.unmount();
    savePublicCreationDraft({ intent: "build", prompt: "A mobile diary", platform: "mobile" });
    window.history.replaceState({}, "", "/projects/new?draft=1");
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project name")).toHaveValue("Mobile diary");
    expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-pressed", "true");
  });

  it("retains URL prefills and allows creation when review storage is unavailable", () => {
    window.history.replaceState({}, "", "/projects/new?prompt=A%20booking%20app&platform=mobile");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    render(<NewProjectPage />);
    expect(screen.getByText(/Tab storage is unavailable/)).toBeInTheDocument();
    expect(window.location.search).toContain("prompt=");
    submit();
    expect(mocks.mutate.mock.calls[0][0].data).toMatchObject({
      name: "Booking app",
      kind: "mobile-cross",
      workspaceId: 7,
    });
  });

  it("requires a real name while permitting a named project without a brief", () => {
    render(<NewProjectPage />);
    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    submit();
    expect(mocks.mutate).not.toHaveBeenCalled();
    setField("Project name", "Studio schedule");
    submit();
    expect(mocks.mutate.mock.calls[0][0].data).toMatchObject({
      name: "Studio schedule",
      initialPrompt: undefined,
    });
  });

  it("guards same-tick double submission, retains errors and details, and permits an explicit retry", () => {
    render(<NewProjectPage />);
    setField("Project brief", "A booking app");
    const form = screen.getByRole("form", { name: "Create project" });
    act(() => {
      fireEvent.submit(form);
      fireEvent.submit(form);
    });
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.useCreateProject).toHaveBeenCalledWith({ mutation: { retry: false } });
    expect(screen.getByLabelText("Project brief")).toBeDisabled();
    expect(mocks.setLocation).not.toHaveBeenCalled();
    act(() => callbacks().onError(new Error("Creation unavailable")));
    expect(screen.getByRole("alert")).toHaveTextContent("Creation unavailable");
    expect(screen.getByLabelText("Project brief")).toHaveValue("A booking app");
    expect(readProjectReviewDraft()?.values.prompt).toBe("A booking app");
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
    submit();
    expect(mocks.mutate).toHaveBeenCalledTimes(2);
  });

  it("submits mobile without the hidden full-stack setting and uses the selected workspace", () => {
    render(<NewProjectPage />);
    setField("Project brief", "A booking app");
    showOptions();
    setField("Build setup", "fullstack");
    setField("Stack", "nextjs");
    fireEvent.click(screen.getByRole("button", { name: "Mobile" }));
    submit();
    expect(mocks.mutate.mock.calls[0][0].data).toEqual({
      name: "Booking app",
      description: "A booking app",
      initialPrompt: "A booking app",
      workspaceId: 7,
      kind: "mobile-cross",
      stack: undefined,
      builderMode: "static-legacy",
    });
    expect(screen.getByText("Creating in Studio")).toBeInTheDocument();
  });

  it.each(["loading", "error", "empty"] as const)(
    "blocks creation with a %s workspace state",
    (state) => {
      mocks.useWorkspace.mockReturnValue({
        ...workspaceState(),
        isLoading: state === "loading",
        isError: state === "error",
        currentWorkspace: state === "empty" ? null : workspaceState().currentWorkspace,
      });
      render(<NewProjectPage />);
      setField("Project name", "Studio schedule");
      expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
      submit();
      expect(mocks.mutate).not.toHaveBeenCalled();
      if (state === "error") {
        fireEvent.click(screen.getByRole("button", { name: "Retry workspaces" }));
        expect(mocks.retryWorkspaces).toHaveBeenCalledOnce();
      }
    },
  );

  it("uses server confirmation for cache, cleanup, and workspace navigation without a second create action", () => {
    savePublicCreationDraft({ intent: "build", prompt: "A booking app", platform: "web" });
    window.history.replaceState({}, "", "/projects/new?draft=1");
    render(<NewProjectPage />);
    submit();
    expect(readCreationDraft(studioDraftScope)).not.toBeNull();
    expect(readProjectReviewDraft()).not.toBeNull();
    act(() => callbacks().onSuccess({ id: 99, name: "Server-confirmed name" }));
    expect(mocks.setLocation).toHaveBeenCalledWith("/projects/99", { replace: true });
    expect(mocks.setQueryData).toHaveBeenCalledWith(["/api/projects/99"], {
      id: 99,
      name: "Server-confirmed name",
    });
    expect(mocks.invalidateQueries).toHaveBeenCalledTimes(3);
    expect(readCreationDraft(studioDraftScope)).toBeNull();
    expect(readProjectReviewDraft()).toBeNull();
    expect(screen.getByRole("heading", { name: "Server-confirmed name" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Create project" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  it("does not clear replacement drafts after the submitted project succeeds", () => {
    savePublicCreationDraft({ intent: "build", prompt: "A booking app", platform: "web" });
    window.history.replaceState({}, "", "/projects/new?draft=1");
    render(<NewProjectPage />);
    submit();
    const nextEntry = savePublicCreationDraft({
      intent: "build",
      prompt: "Another app",
      platform: "mobile",
    });
    const nextReview = saveProjectReviewDraft(
      { ...readProjectReviewDraft()!.values, name: "Another project" },
      nextEntry!.id,
    );
    act(() => callbacks().onSuccess({ id: 99, name: "Booking app" }));
    expect(
      JSON.parse(sessionStorage.getItem("nabuflow.creation-drafts.v2") ?? "null")?.public ?? null,
    ).toEqual(nextEntry);
    expect(readProjectReviewDraft()).toEqual(nextReview);
  });

  it("keeps a confirmed project available when navigation or cache updates fail", () => {
    render(<NewProjectPage />);
    setField("Project name", "Studio");
    mocks.setQueryData.mockImplementationOnce(() => {
      throw new Error("cache unavailable");
    });
    mocks.setLocation.mockImplementationOnce(() => {
      throw new Error("navigation unavailable");
    });
    submit();
    act(() => callbacks().onSuccess({ id: 99, name: "Studio" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Your project was created");
    fireEvent.click(screen.getByRole("button", { name: "Open workspace" }));
    expect(mocks.setLocation).toHaveBeenLastCalledWith("/projects/99", { replace: true });
    expect(mocks.mutate).toHaveBeenCalledOnce();
  });

  it("does not navigate or clear a review without a valid confirmed project ID", () => {
    render(<NewProjectPage />);
    setField("Project name", "Studio");
    submit();
    act(() => callbacks().onSuccess({ id: 0, name: "Studio" }));
    expect(mocks.setLocation).not.toHaveBeenCalled();
    expect(readProjectReviewDraft()).not.toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("did not confirm a project");
  });

  it("preserves edited briefs when choosing and removing a supported template", () => {
    render(<NewProjectPage />);
    setField("Project brief", "My exact brief");
    setField("Project name", "My custom name");
    showOptions();
    fireEvent.click(screen.getByRole("button", { name: "Browse templates" }));
    fireEvent.click(screen.getByRole("button", { name: "Choose studio template" }));
    expect(screen.getByLabelText("Project brief")).toHaveValue("My exact brief");
    expect(screen.getByLabelText("Project name")).toHaveValue("My custom name");
    expect(screen.getByRole("button", { name: "Mobile" })).toHaveAttribute("aria-pressed", "true");
    showOptions();
    fireEvent.click(screen.getByRole("button", { name: "Remove template" }));
    expect(screen.getByLabelText("Project brief")).toHaveValue("My exact brief");
  });

  it("explains unsupported template kinds without submitting or replacing the brief", () => {
    window.history.replaceState(
      {},
      "",
      "/projects/new?template=slides-test&prompt=Keep%20this%20brief",
    );
    render(<NewProjectPage />);
    expect(screen.getByText(/not supported by project creation yet/)).toBeInTheDocument();
    expect(screen.getByLabelText("Project brief")).toHaveValue("Keep this brief");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

describe("Scoped handoff rejection and pre-admission recovery", () => {
  it("rejects a foreign workspace-less draftId without assigning or overwriting the current account's ideas", () => {
    const foreign = saveCreationDraft(
      {
        intent: "build",
        prompt: "Account A receipt",
        platform: "mobile",
      },
      studioDraftScope,
    )!;
    const unassignedScope = { accountId: "account-b", workspaceId: null };
    const unassigned = saveCreationDraft(
      {
        intent: "build",
        prompt: "B unassigned idea",
        platform: "web",
      },
      unassignedScope,
    )!;
    const existing = saveCreationDraft(
      {
        intent: "build",
        prompt: "B existing workspace idea",
        platform: "mobile",
      },
      otherDraftScope,
    )!;
    switchAccount("account-b");
    window.history.replaceState(
      {},
      "",
      "/projects/new?draft=1&draftId=" + encodeURIComponent(foreign.id),
    );
    render(<NewProjectPage />);

    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(readCreationDraft(unassignedScope)).toEqual(unassigned);
    expect(readCreationDraft(otherDraftScope)).toEqual(existing);
    expect(readCreationDraft(studioDraftScope)).toEqual(foreign);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("keeps Retry workspaces usable while a scoped handoff is waiting for failed workspace loading", () => {
    const handoff = saveCreationDraft(
      {
        intent: "build",
        prompt: "Waiting for workspace admission",
        platform: "web",
      },
      studioDraftScope,
    )!;
    window.history.replaceState({}, "", creationDraftDestination(studioDraftScope));
    mocks.useWorkspace.mockReturnValue({ ...workspaceState(), isError: true });
    render(<NewProjectPage />);

    expect(screen.getByRole("button", { name: "Create project" })).toBeDisabled();
    const retry = screen.getByRole("button", { name: "Retry workspaces" });
    expect(retry).toBeEnabled();
    fireEvent.click(retry);
    expect(mocks.retryWorkspaces).toHaveBeenCalledOnce();
    expect(readCreationDraft(studioDraftScope)).toEqual(handoff);
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});

describe("explicit workspace project-review entry", () => {
  function enter(workspaceId: number) {
    window.history.replaceState({}, "", "/projects/new?reviewWorkspaceId=" + workspaceId);
  }
  it("retains separate names and briefs when sidebar targets change on the same page", () => {
    enter(7);
    const view = render(<NewProjectPage />);
    setField("Project brief", "Studio appointment app");
    setField("Project name", "My edited studio name");
    const studioReview = readAccountReviewDraft("account-a", 7)!;
    selectOtherWorkspace();
    act(() => enter(9));
    view.rerender(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("");
    expect(screen.getByLabelText("Project name")).toHaveValue("");
    expect(readAccountReviewDraft("account-a", 7)).toEqual(studioReview);
    setField("Project brief", "Client delivery portal");
    setField("Project name", "My edited client name");
    const clientReview = readAccountReviewDraft("account-a", 9)!;
    act(() => enter(7));
    view.rerender(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Studio appointment app");
    expect(screen.getByLabelText("Project name")).toHaveValue("My edited studio name");
    expect(readAccountReviewDraft("account-a", 9)).toEqual(clientReview);
    submit();
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(7);
  });

  it.each(["0", "-1", "7e0", "9007199254740992", "7&reviewWorkspaceId=9", "8"])(
    "does not fall back to another saved workspace for invalid or unavailable entry %s",
    (raw) => {
      const retainedValues = {
        name: "Retained studio review",
        nameEdited: true,
        prompt: "Private studio idea",
        platform: "web" as const,
        kind: "web" as const,
        stack: "react-vite" as const,
        appMode: "simple" as const,
        templateId: null,
        workspaceId: 7,
      };
      const retained = saveAccountReviewDraft("account-a", retainedValues, null)!;
      window.history.replaceState({}, "", "/projects/new?reviewWorkspaceId=" + raw);
      render(<NewProjectPage />);
      expect(screen.getByLabelText("Project brief")).toHaveValue("");
      expect(screen.getByLabelText("Project name")).toHaveValue("");
      submit();
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(readAccountReviewDraft("account-a", 7)).toEqual(retained);
    },
  );

  it("keeps both reviews when an explicit move targets an occupied workspace", () => {
    enter(7);
    const view = render(<NewProjectPage />);
    setField("Project brief", "Keep the studio brief");
    setField("Project name", "Studio review");
    const studioReview = readAccountReviewDraft("account-a", 7)!;
    const clientValues = {
      ...studioReview.values,
      workspaceId: 9,
      name: "Client review",
      prompt: "Keep the client brief",
    };
    const clientReview = saveAccountReviewDraft("account-a", clientValues, null)!;
    selectOtherWorkspace();
    view.rerender(<NewProjectPage />);
    fireEvent.click(screen.getByRole("button", { name: "Use Client for this draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Both reviews are unchanged");
    expect(readAccountReviewDraft("account-a", 7)).toEqual(studioReview);
    expect(readAccountReviewDraft("account-a", 9)).toEqual(clientReview);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Keep the studio brief");
    fireEvent.click(screen.getByRole("button", { name: "Open saved review in Client" }));
    expect(mocks.setLocation).toHaveBeenCalledWith("/projects/new?reviewWorkspaceId=9");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("does not change the destination or durable receipt when storing a move fails", () => {
    enter(7);
    const view = render(<NewProjectPage />);
    setField("Project name", "Studio review");
    const retained = readAccountReviewDraft("account-a", 7)!;
    selectOtherWorkspace();
    view.rerender(<NewProjectPage />);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    fireEvent.click(screen.getByRole("button", { name: "Use Client for this draft" }));
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Your draft and its workspace are unchanged",
    );
    expect(readAccountReviewDraft("account-a", 7)).toEqual(retained);
    expect(readAccountReviewDraft("account-a", 9)).toBeNull();
    expect(mocks.setLocation).not.toHaveBeenCalled();
  });

  it("moves an unoccupied review atomically and updates its explicit route without losing edits", () => {
    enter(7);
    const view = render(<NewProjectPage />);
    setField("Project brief", "Keep this edited brief");
    setField("Project name", "Keep this edited name");
    selectOtherWorkspace();
    view.rerender(<NewProjectPage />);
    mocks.setLocation.mockImplementation((to: string) => window.history.replaceState({}, "", to));
    fireEvent.click(screen.getByRole("button", { name: "Use Client for this draft" }));
    expect(window.location.search).toBe("?reviewWorkspaceId=9");
    expect(screen.getByLabelText("Project brief")).toHaveValue("Keep this edited brief");
    expect(screen.getByLabelText("Project name")).toHaveValue("Keep this edited name");
    expect(readAccountReviewDraft("account-a", 7)).toBeNull();
    expect(readAccountReviewDraft("account-a", 9)?.values).toMatchObject({ workspaceId: 9 });
    submit();
    expect(mocks.mutate.mock.calls[0][0].data.workspaceId).toBe(9);
  });

  it("keeps the explicit workspace selector when consuming other entry hints", () => {
    window.history.replaceState(
      {},
      "",
      "/projects/new?reviewWorkspaceId=7&prompt=URL%20idea&keep=1#brief",
    );
    render(<NewProjectPage />);
    expect(window.location.search).toBe("?reviewWorkspaceId=7&keep=1");
    expect(window.location.hash).toBe("#brief");
    setField("Project name", "Edited after handoff");
    expect(screen.getByLabelText("Project brief")).toHaveValue("URL idea");
    expect(readAccountReviewDraft("account-a", 7)?.values.name).toBe("Edited after handoff");
  });

  it.each(["success", "error"] as const)(
    "fences a late %s when the explicit route changes before React commits",
    (outcome) => {
      enter(7);
      render(<NewProjectPage />);
      setField("Project name", "Original studio submission");
      submit();
      const pending = callbacks();
      const retained = readAccountReviewDraft("account-a", 7)!;
      selectOtherWorkspace();
      act(() => {
        enter(9);
        if (outcome === "success")
          pending.onSuccess({ id: 701, name: "Original studio submission" });
        else pending.onError(new Error("Old workspace failure"));
      });
      expect(mocks.setLocation).not.toHaveBeenCalled();
      expect(mocks.setQueryData).not.toHaveBeenCalled();
      expect(mocks.invalidateQueries).not.toHaveBeenCalled();
      expect(screen.queryByText("Old workspace failure")).toBeNull();
      expect(readAccountReviewDraft("account-a", 7)).toEqual(retained);
      expect(screen.getByLabelText("Project name")).toHaveValue("");
    },
  );
});

it("keeps a successfully moved review recoverable if navigation throws", () => {
  window.history.replaceState({}, "", "/projects/new?reviewWorkspaceId=7");
  const view = render(<NewProjectPage />);
  setField("Project name", "Recoverable moved review");
  selectOtherWorkspace();
  view.rerender(<NewProjectPage />);
  mocks.setLocation.mockImplementation(() => {
    throw new Error("navigation unavailable");
  });
  fireEvent.click(screen.getByRole("button", { name: "Use Client for this draft" }));
  expect(screen.getByRole("alert")).toHaveTextContent("Your saved reviews are still available");
  expect(readAccountReviewDraft("account-a", 9)?.values.name).toBe("Recoverable moved review");
  expect(readAccountReviewDraft("account-a", 7)).toBeNull();
  expect(mocks.mutate).not.toHaveBeenCalled();
});

describe("multi-digit workspace admission", () => {
  const reviewValues = (workspaceId: number, name: string) => ({
    name,
    nameEdited: true,
    prompt: "Retained workspace brief",
    platform: "web" as const,
    kind: "web" as const,
    stack: "react-vite" as const,
    appMode: "fullstack" as const,
    templateId: null,
    workspaceId,
  });

  function admitWorkspace(id: number) {
    const existing = workspaceState();
    const bound = { ...existing.currentWorkspace, id, name: "Workspace " + id };
    mocks.useWorkspace.mockReturnValue({
      ...existing,
      workspaces: [...existing.workspaces, bound],
    });
  }

  it.each([10, 17, 99, 100])("restores and submits the explicitly requested workspace %s", (id) => {
    admitWorkspace(id);
    const sibling = saveAccountReviewDraft(
      "account-a",
      reviewValues(7, "Other workspace draft"),
      null,
    )!;
    saveAccountReviewDraft("account-a", reviewValues(id, "Preserved " + id), null);
    window.history.replaceState({}, "", "/projects/new?reviewWorkspaceId=" + id);
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project name")).toHaveValue("Preserved " + id);
    expect(screen.getByLabelText("Project brief")).toHaveValue("Retained workspace brief");
    expect(screen.getByRole("button", { name: "Create project" })).toBeEnabled();
    submit();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.mutate.mock.calls[0][0].data).toMatchObject({
      workspaceId: id,
      name: "Preserved " + id,
      initialPrompt: "Retained workspace brief",
    });
    expect(readAccountReviewDraft("account-a", 7)).toEqual(sibling);
  });

  it.each([10, 17, 99, 100])("starts a fresh review in explicitly requested workspace %s", (id) => {
    admitWorkspace(id);
    window.history.replaceState({}, "", "/projects/new?reviewWorkspaceId=" + id);
    render(<NewProjectPage />);
    setField("Project name", "Fresh " + id);
    submit();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.mutate.mock.calls[0][0].data).toMatchObject({
      workspaceId: id,
      name: "Fresh " + id,
    });
  });

  it.each([10, 17, 99, 100])("admits and consumes a build handoff for workspace %s", (id) => {
    admitWorkspace(id);
    const scope = { accountId: "account-a", workspaceId: id };
    const prompt = "Build workspace " + id + " notebook";
    const handoff = saveCreationDraft({ intent: "build", prompt, platform: "web" }, scope)!;
    window.history.replaceState({}, "", creationDraftDestination(scope));
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project brief")).toHaveValue(prompt);
    expect(readAccountReviewDraft("account-a", id)?.sourceDraftId).toBe(handoff.id);
    submit();
    expect(mocks.mutate).toHaveBeenCalledOnce();
    expect(mocks.mutate.mock.calls[0][0].data).toMatchObject({
      workspaceId: id,
      initialPrompt: prompt,
    });
    act(() => callbacks().onSuccess({ id: 1000 + id, name: "Workspace notebook" }));
    expect(readCreationDraft(scope)).toBeNull();
    expect(readAccountReviewDraft("account-a", id)).toBeNull();
  });

  it.each(["010", "1e1", "+10", "10.0", "10x", " 10", "0", "-10", "9007199254740992"])(
    "still rejects a noncanonical or unsafe explicit workspace: %s",
    (raw) => {
      admitWorkspace(17);
      const saved = saveAccountReviewDraft(
        "account-a",
        reviewValues(17, "Keep this review"),
        null,
      )!;
      window.history.replaceState(
        {},
        "",
        "/projects/new?reviewWorkspaceId=" + encodeURIComponent(raw),
      );
      render(<NewProjectPage />);
      setField("Project name", "Rejected destination");
      submit();
      expect(mocks.mutate).not.toHaveBeenCalled();
      expect(readAccountReviewDraft("account-a", 17)).toEqual(saved);
    },
  );
});

describe("editing a mounted review after a long pause", () => {
  it("saves the next edit after expiry and restores it when the page is reopened", () => {
    vi.useFakeTimers();
    const page = render(<NewProjectPage />);
    setField("Project name", "Before pause");
    setField("Project brief", "Keep these notebook requirements");
    const first = readAccountReviewDraft("account-a", 7)!;
    expect(first).not.toBeNull();
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    expect(readAccountReviewDraft("account-a", 7)).toBeNull();
    setField("Project name", "After pause");
    const renewed = readAccountReviewDraft("account-a", 7)!;
    expect(renewed).not.toBeNull();
    expect(renewed.id).not.toBe(first.id);
    expect(renewed.values).toMatchObject({
      name: "After pause",
      prompt: "Keep these notebook requirements",
      workspaceId: 7,
    });
    page.unmount();
    render(<NewProjectPage />);
    expect(screen.getByLabelText("Project name")).toHaveValue("After pause");
    expect(screen.getByLabelText("Project brief")).toHaveValue("Keep these notebook requirements");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });

  it("keeps the newer saved review when an older mounted form resumes editing", () => {
    vi.useFakeTimers();
    render(<NewProjectPage />);
    setField("Project name", "Older mounted form");
    const first = readAccountReviewDraft("account-a", 7)!;
    vi.setSystemTime(Date.now() + 31 * 60 * 1000);
    const replacement = saveAccountReviewDraft(
      "account-a",
      { ...first.values, name: "Newer saved review" },
      null,
    )!;
    expect(replacement).not.toBeNull();
    setField("Project name", "Stale resumed edits");
    expect(readAccountReviewDraft("account-a", 7)).toEqual(replacement);
    expect(screen.getByLabelText("Project name")).toHaveValue("Stale resumed edits");
    expect(mocks.mutate).not.toHaveBeenCalled();
  });
});
