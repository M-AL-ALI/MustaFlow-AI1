import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ProjectWorkspacePage from "./[id]";
import * as confirmedTaskStop from "./components/confirmed-task-stop";
import * as builderFollowup from "@/lib/builder-followup-submit";

const testState = vi.hoisted(() => ({
  projectId: 47,
  billing: {
    data: undefined as
      | {
          enforcementEnabled: boolean;
          exempt: boolean;
          canBuild: boolean;
          blockedReason: null;
          plan: { overageUsdPerCredit: number | null } | null;
          subscription: { currentCycleStart: string | null } | null;
          card: null;
          spendCap: null;
          cycle: { remainingIncludedCredits: number } | null;
        }
      | undefined,
    isLoading: false,
    isError: false,
  },
  sendMessageMutate: vi.fn(),
  sendMessagePending: false,
  cancelTaskMutate: vi.fn(),
  clearComposer: vi.fn(),
  tasks: [] as Array<Record<string, unknown>>,
  messages: [
    {
      id: 1,
      role: "user",
      content: "Existing project",
      plan: null,
      planMode: false,
      createdAt: "2026-07-30T00:00:00.000Z",
    },
  ] as Array<Record<string, unknown>>,
  eventSources: [] as Array<{
    url: string;
    onmessage: ((event: MessageEvent<string>) => void) | null;
    onerror: (() => void) | null;
    close: ReturnType<typeof vi.fn>;
  }>,
  queryClient: null as QueryClient | null,
  guidanceRequest: null as { content: string; intent: "build" | undefined } | null,
  builderMode: "static" as "static" | "agentic",
}));

vi.mock("wouter", () => ({
  useParams: () => ({ id: String(testState.projectId) }),
  useLocation: () => [`/projects/${testState.projectId}`, vi.fn()],
  Link: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

vi.mock("@workspace/api-client-react", () => ({
  getGetCveScanStatusQueryKey: () => ["cve-status"],
  getGetMyPreferencesQueryKey: () => ["preferences"],
  getGetNabuflowBillingStateQueryKey: () => ["nabuflow-billing-state"],
  getGetPageMapQueryKey: (projectId: number) => ["page-map", projectId],
  getGetProjectQueryKey: (projectId: number) => ["project", projectId],
  getGetUserCreditsQueryKey: () => ["credits"],
  getListMessagesQueryKey: (projectId: number) => ["messages", projectId],
  getListProjectFilesQueryKey: (projectId: number) => ["files", projectId],
  getListSuggestionsQueryKey: (projectId: number) => ["suggestions", projectId],
  getListTaskEventsQueryKey: (projectId: number, taskId: number) => [
    "task-events",
    projectId,
    taskId,
  ],
  getListTasksQueryKey: (projectId: number) => ["tasks", projectId],
  getListVersionsQueryKey: (projectId: number) => ["versions", projectId],
  getAuthToken: vi.fn().mockResolvedValue(null),
  getBillingSubscription: vi.fn().mockResolvedValue({ tier: "core" }),
  getContainerStatus: vi.fn().mockResolvedValue({ status: "stopped" }),
  getProjectProvisioningStatus: vi.fn().mockResolvedValue({ status: "idle" }),
  listVersions: vi.fn().mockResolvedValue([]),
  resumePausedQueue: vi.fn().mockResolvedValue({ resumed: 0 }),
  retryProjectProvisioning: vi.fn().mockResolvedValue(undefined),
  startContainer: vi.fn().mockResolvedValue(undefined),
  stopContainer: vi.fn().mockResolvedValue(undefined),
  submitProjectQueue: vi.fn().mockResolvedValue(undefined),
  useAcknowledgeCveScan: () => ({ mutate: vi.fn() }),
  useCancelTask: (options?: {
    mutation?: {
      onSuccess?: (
        data: { id: number; status: string },
        variables: { id: number; taskId: number },
        context: unknown,
      ) => void;
    };
  }) => ({
    mutateAsync: async (variables: { id: number; taskId: number }) => {
      await testState.cancelTaskMutate(variables);
      return { id: variables.taskId, status: "canceled" };
    },
    mutate: (variables: { id: number; taskId: number }) => {
      testState.cancelTaskMutate(variables);
      options?.mutation?.onSuccess?.(
        { id: variables.taskId, status: "canceled" },
        variables,
        undefined,
      );
    },
    isPending: false,
  }),
  useGetCveScanStatus: () => ({ data: undefined }),
  useGetMyPreferences: () => ({
    data: { dismissedOnboarding: true, containerLayerConfigured: false },
  }),
  useGetNabuflowBillingState: () => testState.billing,
  useGetProject: () => ({
    data: {
      id: testState.projectId,
      name: "Run 8 recovery scratch",
      status: "ready",
      agentMode: "power",
      builderMode: testState.builderMode,
      projectFormat: "static",
      kind: "web",
    },
    isLoading: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  }),
  useGetUserCredits: () => ({ data: { balance: 1600 }, isLoading: false }),
  useListMessages: () => ({ data: testState.messages }),
  useListProjectFiles: () => ({ data: [] }),
  useListSuggestions: () => ({ data: [] }),
  useListTaskEvents: () => ({ data: [] }),
  useListTasks: () => ({ data: testState.tasks }),
  useRollbackVersion: () => ({ mutate: vi.fn(), isPending: false }),
  useSendMessage: () => ({
    mutate: testState.sendMessageMutate,
    isPending: testState.sendMessagePending,
  }),
  useUpdateMyPreferences: () => ({ mutate: vi.fn() }),
  useUpdateProject: () => ({ mutate: vi.fn(), mutateAsync: vi.fn() }),
}));

vi.mock("@/hooks/use-web-container", () => ({
  useWebContainer: () => ({}),
}));

vi.mock("@/hooks/use-project-issues", () => ({
  useProjectIssues: () => ({
    totalCount: 0,
    hasFailedBuild: false,
    hasContainerError: false,
    hasCodeQuality: false,
  }),
}));

vi.mock("@/hooks/use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/lib/builder-lazy", () => ({
  builderLazy: () => () => null,
}));

vi.mock("./components/queue-composer", () => ({
  QueueComposer: ({
    agentMode,
    runInBackground,
    onRunInBackgroundChange,
    onSingleSend,
    disabled,
    promptValue,
    onPromptValueChange,
  }: {
    agentMode: string;
    runInBackground: boolean;
    onRunInBackgroundChange: (enabled: boolean) => void;
    disabled?: boolean;
    promptValue?: string;
    onPromptValueChange?: (value: string) => void;
    onSingleSend: (
      content: string,
      intent: "build" | undefined,
      attachments: undefined,
      brainstormContext: undefined,
      clearComposer: () => void,
    ) => void;
  }) => (
    <div>
      <output data-testid="composer-value">{promptValue ?? ""}</output>
      <input
        aria-label="Draft text"
        value={promptValue ?? ""}
        onChange={(event) => onPromptValueChange?.(event.currentTarget.value)}
      />
      <button
        type="button"
        data-testid="real-send-path"
        data-agent-mode={agentMode}
        disabled={disabled}
        onClick={() =>
          onSingleSend(
            testState.guidanceRequest?.content ??
              "Migrate the shared status API across the project",
            testState.guidanceRequest ? testState.guidanceRequest.intent : "build",
            undefined,
            undefined,
            testState.clearComposer,
          )
        }
      >
        Send Power build
      </button>
      <button type="button" onClick={() => onRunInBackgroundChange(!runInBackground)}>
        {runInBackground ? "Disable background work" : "Work in background"}
      </button>
    </div>
  ),
}));

vi.mock("./components/preview-tab", () => ({
  PreviewTab: () => null,
}));

vi.mock("./components/workspace-tour", () => ({
  WorkspaceTour: () => null,
  useCompleteWorkspaceTourOnBuild: () => undefined,
}));

vi.mock("./components/use-project-images", () => ({
  useProjectImages: () => ({
    images: [],
    loading: false,
    isGenerating: false,
    error: null,
    generateImage: vi.fn(),
    regenerateImage: vi.fn(),
    insertIntoProject: vi.fn(),
    hasMoreHistory: false,
    loadMoreHistory: vi.fn(),
  }),
}));

vi.mock("./components/use-cve-critical-high-count", () => ({
  useCveCriticalHighCount: () => 0,
}));

vi.mock("@/components/credit-balance-pill", () => ({
  CreditBalancePill: () => null,
}));

vi.mock("@/components/notifications-bell", () => ({
  NotificationsBell: () => null,
}));

vi.mock("@/components/buy-credits-sheet", () => ({
  BuyCreditsSheet: () => null,
  CreditsSuccessBanner: () => null,
}));

vi.mock("@/components/agentic-onboarding-tooltip", () => ({
  AgenticOnboardingTooltip: () => null,
}));

vi.mock("./components/getting-started-checklist", () => ({
  GettingStartedChecklist: () => null,
}));

vi.mock("./components/memory-indicator", () => ({
  MemoryIndicator: () => null,
}));

vi.mock("./components/brand-pill", () => ({
  BrandPill: () => null,
}));

vi.mock("./components/connection-quality-indicator", () => ({
  ConnectionQualityIndicator: () => null,
}));

vi.mock("./components/provisioning-progress", () => ({
  ProvisioningProgress: () => null,
}));

vi.mock("./components/queue-progress-strip", () => ({
  QueueProgressStrip: () => null,
}));

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  testState.queryClient = queryClient;
  return render(
    <QueryClientProvider client={queryClient}>
      <ProjectWorkspacePage />
    </QueryClientProvider>,
  );
}

function installCapturedTaskEventSource() {
  testState.eventSources = [];
  vi.stubGlobal(
    "EventSource",
    class {
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      onerror: (() => void) | null = null;
      close = vi.fn();

      constructor(public readonly url: string) {
        testState.eventSources.push(this);
      }
    },
  );
}

afterEach(() => {
  testState.projectId = 47;
  testState.sendMessagePending = false;
  testState.tasks = [];
  testState.messages = [
    {
      id: 1,
      role: "user",
      content: "Existing project",
      plan: null,
      planMode: false,
      createdAt: "2026-07-30T00:00:00.000Z",
    },
  ];
  testState.eventSources = [];
  testState.queryClient = null;
});

async function sendPowerBuild() {
  const user = userEvent.setup();
  const send = await screen.findByTestId("real-send-path");
  await waitFor(() => expect(send).toHaveAttribute("data-agent-mode", "power"));
  await user.click(send);
}

describe("project send — no confirmation dialog", () => {
  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
    testState.cancelTaskMutate.mockReset();
    testState.tasks = [];
    testState.messages = [
      {
        id: 1,
        role: "user",
        content: "Existing project",
        plan: null,
        planMode: false,
        createdAt: "2026-07-30T00:00:00.000Z",
      },
    ];
    testState.billing = {
      data: undefined,
      isLoading: false,
      isError: false,
    };
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((event: MessageEvent<string>) => void) | null = null;
        onerror: (() => void) | null = null;
        close() {}
      },
    );
  });

  it("submits an exempt Power build directly — no dialog, send proceeds", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: true,
        canBuild: true,
        blockedReason: null,
        plan: null,
        subscription: null,
        card: null,
        spendCap: null,
        cycle: null,
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await sendPowerBuild();

    // No confirmation dialog for any user
    expect(screen.queryByRole("alertdialog", { name: /Confirm.*build/ })).not.toBeInTheDocument();
    await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
    expect(testState.sendMessageMutate.mock.calls[0]?.[0]).toMatchObject({
      id: 47,
      data: {
        content: "Migrate the shared status API across the project",
        agentMode: "power",
        agentIntent: "mutate",
      },
    });
    expect(testState.clearComposer).toHaveBeenCalledTimes(1);
  });

  it("submits a non-exempt Power build directly — dialog is gone, no gate for any user", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: null,
        subscription: null,
        card: null,
        spendCap: null,
        cycle: null,
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await sendPowerBuild();

    // No alertdialog for non-exempt users either — dialog is removed
    expect(screen.queryByRole("alertdialog", { name: /Confirm.*build/ })).not.toBeInTheDocument();
    await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
    expect(testState.clearComposer).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["absent", { data: undefined, isLoading: false, isError: false }],
    [
      "loading",
      {
        data: {
          enforcementEnabled: true,
          exempt: true,
          canBuild: true,
          blockedReason: null,
          plan: null,
          subscription: null,
          card: null,
          spendCap: null,
          cycle: null,
        },
        isLoading: true,
        isError: false,
      },
    ],
    [
      "errored",
      {
        data: {
          enforcementEnabled: true,
          exempt: true,
          canBuild: true,
          blockedReason: null,
          plan: null,
          subscription: null,
          card: null,
          spendCap: null,
          cycle: null,
        },
        isLoading: false,
        isError: true,
      },
    ],
  ])(
    "sends immediately while billing state is %s — no blocking dialog",
    async (_label, billing) => {
      testState.billing = billing;
      renderPage();

      await sendPowerBuild();

      // Dialog is removed entirely — no gate for unknown billing state either
      expect(screen.queryByRole("alertdialog", { name: /Confirm.*build/ })).not.toBeInTheDocument();
      await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
      expect(testState.clearComposer).toHaveBeenCalledTimes(1);
    },
  );
});

describe("project request failure recovery", () => {
  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
    testState.tasks = [];
    testState.billing = { data: undefined, isLoading: false, isError: false };
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    installCapturedTaskEventSource();
  });

  it("keeps a rejected request visible and restores text without sending again", async () => {
    renderPage();
    await sendPowerBuild();
    await act(async () => {
      testState.sendMessageMutate.mock.calls[0]?.[1].onError({
        status: 403,
        message: "<!doctype html>private-response-token",
      });
    });
    expect(await screen.findByRole("alert", { name: "Request blocked" })).toHaveTextContent(
      "HTTP 403",
    );
    expect(screen.queryByText(/private-response-token/)).not.toBeInTheDocument();
    expect(screen.getAllByText("Request blocked")).toHaveLength(2);
    await userEvent.setup().click(screen.getByRole("button", { name: "Restore text" }));
    expect(screen.getByTestId("composer-value")).toHaveTextContent(
      "Migrate the shared status API across the project",
    );
    expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Restore text" })).toBeDisabled();
  });

  it("does not claim a network failure means no task was started", async () => {
    renderPage();
    await sendPowerBuild();
    await act(async () => {
      testState.sendMessageMutate.mock.calls[0]?.[1].onError(new Error("network unavailable"));
    });
    expect(await screen.findByRole("alert", { name: "Request not confirmed" })).toHaveTextContent(
      "may still have started",
    );
    expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1);
  });

  it("ignores an older failure after a newer logical request", async () => {
    renderPage();
    await sendPowerBuild();
    await sendPowerBuild();
    expect(testState.sendMessageMutate).toHaveBeenCalledTimes(2);
    await act(async () => {
      testState.sendMessageMutate.mock.calls[0]?.[1].onError({ status: 403 });
    });
    expect(screen.queryByRole("alert", { name: "Request blocked" })).not.toBeInTheDocument();
    await act(async () => {
      testState.sendMessageMutate.mock.calls[1]?.[1].onError({ status: 500 });
    });
    expect(await screen.findByRole("alert", { name: "Request not confirmed" })).toBeInTheDocument();
  });
});

describe("request recovery across navigation and newer drafts", () => {
  beforeEach(() => {
    testState.projectId = 47;
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
    testState.tasks = [];
    testState.billing = { data: undefined, isLoading: false, isError: false };
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    installCapturedTaskEventSource();
  });

  it("does not let an older success clear a newer failure or activate an older task", async () => {
    renderPage();
    await sendPowerBuild();
    await sendPowerBuild();
    await act(async () => {
      testState.sendMessageMutate.mock.calls[1]?.[1].onError({ status: 500 });
    });
    expect(await screen.findByRole("alert", { name: "Request not confirmed" })).toBeInTheDocument();
    await act(async () => {
      testState.sendMessageMutate.mock.calls[0]?.[1].onSuccess({
        assistantMessage: { plan: { kind: "queued", taskId: 999 } },
      });
    });
    expect(screen.getByRole("alert", { name: "Request not confirmed" })).toBeInTheDocument();
    expect(
      testState.eventSources.some((source) => source.url.includes("/tasks/999/events/stream")),
    ).toBe(false);
    expect(testState.sendMessageMutate).toHaveBeenCalledTimes(2);
  });

  it.each([
    { label: "A to B", routeIds: [48] },
    { label: "A to B to A", routeIds: [48, 47] },
  ])("ignores old callbacks after $label", async ({ routeIds }) => {
    const view = renderPage();
    await sendPowerBuild();
    const oldCallbacks = testState.sendMessageMutate.mock.calls[0]?.[1];
    for (const id of routeIds) {
      testState.projectId = id;
      view.rerender(
        <QueryClientProvider client={testState.queryClient!}>
          <ProjectWorkspacePage />
        </QueryClientProvider>,
      );
    }
    await act(async () => {
      oldCallbacks.onError({ status: 403 });
      oldCallbacks.onSuccess({ assistantMessage: { plan: { kind: "queued", taskId: 999 } } });
    });
    expect(screen.queryByRole("alert", { name: "Request blocked" })).not.toBeInTheDocument();
    expect(
      testState.eventSources.some((source) => source.url.includes("/tasks/999/events/stream")),
    ).toBe(false);
    expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1);
  });

  it("preserves newer draft B when request A fails without sending or overwriting B", async () => {
    renderPage();
    await sendPowerBuild();
    const user = userEvent.setup();
    const draft = screen.getByRole("textbox", { name: "Draft text" });
    await user.type(draft, "A newer unsent draft that must remain");
    await act(async () => {
      testState.sendMessageMutate.mock.calls[0]?.[1].onError({ status: 403 });
    });
    expect(await screen.findByRole("alert", { name: "Request blocked" })).toHaveTextContent(
      "Migrate the shared status API across the project",
    );
    expect(draft).toHaveValue("A newer unsent draft that must remain");
    const restore = screen.getByRole("button", { name: "Restore text" });
    expect(restore).toBeDisabled();
    await user.click(restore);
    expect(draft).toHaveValue("A newer unsent draft that must remain");
    expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1);
  });
});

describe("project Stop with captured task 189 planning traffic", () => {
  beforeEach(() => {
    testState.cancelTaskMutate.mockReset();
    testState.sendMessageMutate.mockReset();
    testState.tasks = [
      {
        id: 189,
        projectId: 47,
        kind: "plan",
        status: "planning",
        title: "Plan: Run 8 Activity Scratch B 2026-07-31",
        prompt: "Analyze this project idea and create a structured plan",
        createdAt: "2026-07-31T06:32:09.379Z",
      },
    ];
    testState.messages = [
      {
        id: 1890,
        role: "user",
        content: "Analyze this project idea and create a structured plan",
        plan: null,
        planMode: true,
        createdAt: "2026-07-31T06:32:09.379Z",
      },
    ];
    testState.billing = {
      data: undefined,
      isLoading: false,
      isError: false,
    };
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    installCapturedTaskEventSource();
  });

  it("keeps the captured live feed open until cancellation is acknowledged", async () => {
    let acknowledge!: () => void;
    testState.cancelTaskMutate.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          acknowledge = resolve;
        }),
    );
    const user = userEvent.setup();
    renderPage();
    const taskStream = await waitFor(() => {
      const stream = testState.eventSources.find((source) =>
        source.url.includes("/tasks/189/events/stream"),
      );
      expect(stream).toBeDefined();
      return stream!;
    });
    taskStream.close.mockClear();
    await user.click(await screen.findByRole("button", { name: "Stop" }));
    expect(taskStream.close).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    await act(async () => {
      acknowledge();
    });
    await waitFor(() => expect(taskStream.close).toHaveBeenCalled());
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument(),
    );
  });

  it.each([404, 503])(
    "keeps Stop and live updates available after an unconfirmed %s response",
    async (status) => {
      testState.cancelTaskMutate.mockRejectedValueOnce({ status });
      const user = userEvent.setup();
      renderPage();
      const taskStream = await waitFor(() => {
        const stream = testState.eventSources.find((source) =>
          source.url.includes("/tasks/189/events/stream"),
        );
        expect(stream).toBeDefined();
        return stream!;
      });
      taskStream.close.mockClear();
      await user.click(await screen.findByRole("button", { name: "Stop" }));
      await waitFor(() =>
        expect(testState.cancelTaskMutate).toHaveBeenCalledWith({ id: 47, taskId: 189 }),
      );
      expect(taskStream.close).not.toHaveBeenCalled();
      expect(screen.getByRole("button", { name: "Stop" })).toBeInTheDocument();
    },
  );

  it.each(["confirmed", "rejected"] as const)(
    "does not apply a delayed %s Stop callback to the next same-project request",
    async (outcome) => {
      const realRequest = confirmedTaskStop.requestConfirmedTaskStop;
      type StopInput = Parameters<typeof realRequest>[0];
      let observed: StopInput | undefined;
      const confirmed = vi.fn();
      const unconfirmed = vi.fn();
      const requestSpy = vi
        .spyOn(confirmedTaskStop, "requestConfirmedTaskStop")
        .mockImplementation((input) => {
          observed = input;
          return realRequest({
            ...input,
            onConfirmed: () => {
              confirmed();
              input.onConfirmed();
            },
            onUnconfirmed: () => {
              unconfirmed();
              input.onUnconfirmed();
            },
          });
        });
      try {
        let settle!: () => void;
        testState.cancelTaskMutate.mockImplementationOnce(
          () =>
            new Promise<void>((resolve, reject) => {
              settle = () =>
                outcome === "confirmed" ? resolve() : reject(new Error("Late Stop failure"));
            }),
        );
        const user = userEvent.setup();
        const page = renderPage();
        await user.click(await screen.findByRole("button", { name: "Stop" }));
        expect(observed).toBeDefined();

        // Polling can observe worker completion before the Stop HTTP response arrives.
        testState.tasks = testState.tasks.map((task) => ({ ...task, status: "canceled" }));
        page.rerender(
          <QueryClientProvider client={testState.queryClient!}>
            <ProjectWorkspacePage />
          </QueryClientProvider>,
        );
        await waitFor(() => expect(screen.getByTestId("real-send-path")).toBeEnabled());
        testState.sendMessageMutate.mockImplementationOnce(() => {
          testState.sendMessagePending = true;
        });
        await user.click(screen.getByTestId("real-send-path"));
        await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
        expect(observed!.currentScope()).toMatchObject({ projectId: 47, taskId: null });
        expect(observed!.currentScope().runGeneration).not.toBe(observed!.runGeneration);

        await act(async () => {
          settle();
        });
        expect(confirmed).not.toHaveBeenCalled();
        expect(unconfirmed).not.toHaveBeenCalled();
        expect(screen.getByTestId("real-send-path")).toBeDisabled();
      } finally {
        requestSpy.mockRestore();
      }
    },
  );

  it("terminalizes locally after cancel and makes the captured user message editable again", async () => {
    const user = userEvent.setup();
    renderPage();

    const taskStream = await waitFor(() => {
      const stream = testState.eventSources.find((source) =>
        source.url.includes("/tasks/189/events/stream"),
      );
      expect(stream).toBeDefined();
      return stream!;
    });

    // Real production task 189 frames 7949-7951, captured before Stop.
    await act(async () => {
      for (const frame of [
        { id: 7949, taskId: 189, eventType: "queued", message: "Plan request received..." },
        {
          id: 7950,
          taskId: 189,
          eventType: "planning",
          message: "Analysing project and requirements...",
        },
        {
          id: 7951,
          taskId: 189,
          eventType: "generating_blueprint",
          message: "Generating structured plan with AI...",
        },
      ]) {
        taskStream.onmessage?.(
          new MessageEvent("message", {
            data: JSON.stringify(frame),
          }),
        );
      }
    });

    await user.click(await screen.findByRole("button", { name: "Stop" }));

    expect(testState.cancelTaskMutate).toHaveBeenCalledWith({ id: 47, taskId: 189 });
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Stop" })).not.toBeInTheDocument(),
    );
    const edit = await screen.findByRole("button", { name: "Edit and resend this message" });
    await user.click(edit);
    expect(screen.getByTestId("composer-value")).toHaveTextContent(
      "Analyze this project idea and create a structured plan",
    );
    expect(screen.getByTestId("real-send-path")).toBeEnabled();
  });
});

describe("automatic backend guidance follows server authority", () => {
  let originalFetch: typeof fetch;
  let streamRequest = vi.fn<typeof fetch>();
  let streamResponse: Response;
  let deliver: (events: Array<Record<string, unknown>>) => void;
  let completeRegular: (intent?: string) => void;

  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.sendMessageMutate.mockImplementation((_variables, callbacks) => {
      completeRegular = (detectedIntent) => callbacks.onSuccess({ detectedIntent });
    });
    testState.clearComposer.mockReset();
    testState.sendMessagePending = false;
    testState.tasks = [];
    testState.builderMode = "static";
    testState.guidanceRequest = { content: "Add database authentication", intent: undefined };
    testState.billing = { data: undefined, isLoading: false, isError: false };
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    installCapturedTaskEventSource();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        deliver = (events) => {
          controller.enqueue(
            new TextEncoder().encode(
              events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
            ),
          );
          controller.close();
        };
      },
    });
    originalFetch = globalThis.fetch;
    streamResponse = new Response(stream, { headers: { "Content-Type": "text/event-stream" } });
    streamRequest = vi.fn<typeof fetch>().mockResolvedValue(streamResponse);
    vi.stubGlobal(
      "fetch",
      vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/messages/stream")) return streamRequest(input, init);
        return originalFetch(input, init);
      }),
    );
  });

  afterEach(() => {
    testState.guidanceRequest = null;
    testState.builderMode = "static";
    vi.stubGlobal("fetch", originalFetch);
  });

  function expectNoGuidance() {
    expect(screen.queryByRole("button", { name: "Upgrade to full-stack" })).not.toBeInTheDocument();
  }

  async function sendAutomaticRequest() {
    await sendPowerBuild();
    await waitFor(() => expect(streamRequest).toHaveBeenCalledTimes(1));
    expectNoGuidance();
    const body = JSON.parse(String(streamRequest.mock.calls[0]?.[1]?.body)) as Record<
      string,
      unknown
    >;
    expect(body).not.toHaveProperty("agentIntent");
    expect(body.planMode).toBe(false);
    return body;
  }

  async function emit(events: Array<Record<string, unknown>>) {
    await act(async () => {
      deliver(events);
    });
  }

  async function finishRegular(intent?: string) {
    await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
    await act(async () => {
      completeRegular(intent);
    });
  }

  it("waits for the regular response's confirmed action and preserves one logical send", async () => {
    renderPage();
    const body = await sendAutomaticRequest();
    await emit([
      { type: "intent", intent: "mutate" },
      { type: "fallback", intent: "mutate" },
    ]);
    expectNoGuidance();
    await finishRegular("mutate");
    expect(
      await screen.findByRole("button", { name: "Upgrade to full-stack" }),
    ).toBeInTheDocument();
    expect(testState.sendMessageMutate.mock.calls[0][0]).toMatchObject({
      id: 47,
      data: {
        content: "Add database authentication",
        agentIntent: "mutate",
        idempotencyKey: body.idempotencyKey,
      },
    });
    expect(streamRequest).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "A to B", routeIds: [48], unmount: false },
    { label: "A to B to A", routeIds: [48, 47], unmount: false },
    { label: "unmount", routeIds: [], unmount: true },
  ])("discards a delayed fallback after $label", async ({ routeIds, unmount }) => {
    const guidance = vi.spyOn(builderFollowup, "shouldShowBuilderUpgradeNudge");
    try {
      testState.sendMessageMutate.mockImplementation((_variables, callbacks) => {
        callbacks.onSuccess({
          detectedIntent: "mutate",
          assistantMessage: { plan: { kind: "queued", taskId: 999 } },
        });
      });
      const view = renderPage();
      await sendAutomaticRequest();
      for (const id of routeIds) {
        testState.projectId = id;
        view.rerender(
          <QueryClientProvider client={testState.queryClient!}>
            <ProjectWorkspacePage />
          </QueryClientProvider>,
        );
      }
      if (unmount) view.unmount();
      guidance.mockClear();
      await emit([{ type: "fallback", intent: "mutate" }]);
      expect(testState.sendMessageMutate).not.toHaveBeenCalled();
      expect(guidance).not.toHaveBeenCalled();
      expectNoGuidance();
      expect(testState.eventSources.some((source) => source.url.includes("/tasks/999/"))).toBe(
        false,
      );
      expect(streamRequest.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    } finally {
      guidance.mockRestore();
    }
  });

  it.each([
    { label: "A to B", routeIds: [48], unmount: false },
    { label: "A to B to A", routeIds: [48, 47], unmount: false },
    { label: "unmount", routeIds: [], unmount: true },
  ])("discards a delayed HTTP response after $label", async ({ routeIds, unmount }) => {
    let releaseResponse!: (response: Response) => void;
    streamRequest.mockImplementationOnce(
      () =>
        new Promise<Response>((resolve) => {
          releaseResponse = resolve;
        }),
    );
    const view = renderPage();
    await sendAutomaticRequest();
    for (const id of routeIds) {
      testState.projectId = id;
      view.rerender(
        <QueryClientProvider client={testState.queryClient!}>
          <ProjectWorkspacePage />
        </QueryClientProvider>,
      );
    }
    if (unmount) view.unmount();
    await act(async () => {
      deliver([{ type: "fallback", intent: "mutate" }]);
      releaseResponse(streamResponse);
    });
    expect(testState.sendMessageMutate).not.toHaveBeenCalled();
    expectNoGuidance();
    expect(streamRequest.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it.each(["plan", "answer", "clarify", "observe", "unknown", undefined])(
    "does not promote fallback intent over a regular %s response",
    async (intent) => {
      renderPage();
      await sendAutomaticRequest();
      await emit([{ type: "fallback", intent: "mutate" }]);
      await finishRegular(intent);
      expectNoGuidance();
    },
  );

  it("stops processing a chunk after its first terminal fallback", async () => {
    renderPage();
    await sendAutomaticRequest();
    await emit([
      { type: "fallback", intent: "mutate" },
      { type: "fallback", intent: "mutate" },
    ]);
    await finishRegular("mutate");
    expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByRole("button", { name: "Upgrade to full-stack" }),
    ).toBeInTheDocument();
  });

  it("covers the production fallback-only mutation sequence", async () => {
    renderPage();
    await sendAutomaticRequest();
    await emit([{ type: "fallback", intent: "mutate" }]);
    expectNoGuidance();
    await finishRegular("mutate");
    expect(
      await screen.findByRole("button", { name: "Upgrade to full-stack" }),
    ).toBeInTheDocument();
  });

  it.each(["plan", "answer", "clarify", "observe", "unknown"])(
    "does not offer guidance for a streamed %s result",
    async (intent) => {
      renderPage();
      await sendAutomaticRequest();
      await emit([{ type: "intent", intent }, { type: "done" }]);
      expectNoGuidance();
      expect(testState.sendMessageMutate).not.toHaveBeenCalled();
    },
  );

  it.each(["agentic", "dismissed"])(
    "does not offer redundant guidance for an %s project",
    async (state) => {
      if (state === "agentic") testState.builderMode = "agentic";
      else localStorage.setItem("mf-upgrade-nudge-47", "1");
      renderPage();
      await sendAutomaticRequest();
      await emit([{ type: "fallback", intent: "mutate" }]);
      await finishRegular("mutate");
      expectNoGuidance();
    },
  );

  it("does not advertise an upgrade against an explicit no-change instruction", async () => {
    testState.guidanceRequest = {
      content: "Do not change this project. Explain database authentication.",
      intent: undefined,
    };
    renderPage();
    await sendAutomaticRequest();
    await emit([{ type: "fallback", intent: "mutate" }]);
    await finishRegular("mutate");
    expectNoGuidance();
  });

  it("does not apply a late regular response to an unmounted workspace", async () => {
    const guidance = vi.spyOn(builderFollowup, "shouldShowBuilderUpgradeNudge");
    try {
      const page = renderPage();
      await sendAutomaticRequest();
      await emit([{ type: "fallback", intent: "mutate" }]);
      await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
      guidance.mockClear();
      page.unmount();
      await act(async () => {
        completeRegular("mutate");
      });
      expect(guidance).not.toHaveBeenCalled();
    } finally {
      guidance.mockRestore();
    }
  });

  it.each([
    { name: "mutation", intent: "mutate", show: true },
    { name: "plan", intent: "plan", show: false },
    { name: "answer", intent: "answer", show: false },
    { name: "clarification", intent: "clarify", show: false },
    { name: "observation", intent: "observe", show: false },
    { name: "missing classification", intent: undefined, show: false },
    { name: "unknown classification", intent: "unknown", show: false },
    {
      name: "explicit no-change",
      intent: "mutate",
      show: false,
      content: "Do not change this project. Explain database authentication.",
    },
    {
      name: "capture-only rejection",
      intent: "mutate",
      show: false,
      content:
        "Save this as a project rejection: never add a database or authentication unless I explicitly reverse it. Do not build or change files.",
    },
  ])("handles a background $name without a client override", async ({ intent, show, content }) => {
    if (content) testState.guidanceRequest = { content, intent: undefined };
    renderPage();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Work in background" }));
    await sendPowerBuild();
    await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
    expect(streamRequest).not.toHaveBeenCalled();
    expectNoGuidance();
    const request = testState.sendMessageMutate.mock.calls[0][0];
    expect(request.data).toMatchObject({ background: true, planMode: false });
    expect(request.data).not.toHaveProperty("agentIntent");
    await finishRegular(intent);
    if (show) {
      expect(
        await screen.findByRole("button", { name: "Upgrade to full-stack" }),
      ).toBeInTheDocument();
    } else {
      expectNoGuidance();
    }
  });
});

describe("composer credit counter", () => {
  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((event: MessageEvent<string>) => void) | null = null;
        onerror: (() => void) | null = null;
        close() {}
      },
    );
  });

  it("shows the composer credit counter in the send-bar area for all users", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: null,
        subscription: null,
        card: null,
        spendCap: null,
        cycle: null,
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    const counter = await screen.findByTestId("composer-credit-counter");
    expect(counter).toBeInTheDocument();
    // Project has agentMode: "power" → 160 credits
    expect(counter).toHaveTextContent(/Power/i);
    expect(counter).toHaveTextContent(/160\s*credits/);
  });

  it("shows remaining included credits when cycle data is available", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 42 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();
    const counter = await screen.findByTestId("composer-credit-counter");
    expect(counter).toHaveTextContent(/42/);
    expect(counter).toHaveTextContent(/remaining/);
  });
});

describe("overage-crossing notice", () => {
  beforeEach(() => {
    testState.sendMessageMutate.mockReset();
    testState.clearComposer.mockReset();
    localStorage.clear();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn().mockReturnValue({
        matches: false,
        media: "",
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }),
    });
    vi.stubGlobal(
      "EventSource",
      class {
        onmessage: ((event: MessageEvent<string>) => void) | null = null;
        onerror: (() => void) | null = null;
        close() {}
      },
    );
  });

  it("shows the overage notice when remainingIncludedCredits < modeCost for a non-exempt account", async () => {
    // Power mode costs 160 credits; remaining = 2 → would cross into overage
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    const notice = await screen.findByTestId("overage-crossing-notice");
    expect(notice).toBeInTheDocument();
    expect(notice).toHaveTextContent(/You've used your included credits/);
    expect(notice).toHaveTextContent(/\$0\.012\/credit/);
  });

  it("does NOT show the overage notice when remainingIncludedCredits >= modeCost", async () => {
    // Power mode costs 160 credits; remaining = 200 → still within included
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 200 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await screen.findByTestId("composer-credit-counter");
    expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument();
  });

  it("does NOT show the overage notice for an exempt account", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: true,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await screen.findByTestId("composer-credit-counter");
    expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument();
  });

  it("dismissing the notice hides it and persists the ack to localStorage", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId("overage-crossing-notice");
    await user.click(screen.getByTestId("overage-notice-continue"));

    await waitFor(() =>
      expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument(),
    );
    // Ack is persisted so it won't re-appear after a refresh
    expect(localStorage.getItem("nabuflow_overage_ack_2026-07-01")).toBe("1");
  });

  it("don't-show-again suppresses the notice for the rest of the cycle", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    const user = userEvent.setup();
    renderPage();

    await screen.findByTestId("overage-crossing-notice");
    await user.click(screen.getByTestId("overage-notice-dont-show"));

    await waitFor(() =>
      expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument(),
    );
    expect(localStorage.getItem("nabuflow_overage_ack_2026-07-01")).toBe("1");
  });

  it("build proceeds immediately even when the overage notice is visible — notice never blocks", async () => {
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-07-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    await screen.findByTestId("overage-crossing-notice");
    // Send without dismissing the notice first
    await sendPowerBuild();

    await waitFor(() => expect(testState.sendMessageMutate).toHaveBeenCalledTimes(1));
    expect(testState.clearComposer).toHaveBeenCalledTimes(1);
  });

  it("notice re-appears after a billing cycle rollover even if it was dismissed in the previous cycle", async () => {
    // Simulate: user dismissed the notice in the July cycle
    localStorage.setItem("nabuflow_overage_ack_2026-07-01", "1");

    // New cycle (August) — no ack for this key
    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-08-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    // The notice must fire again because the new cycle key has no ack
    await screen.findByTestId("overage-crossing-notice");
    // Old cycle's ack is still in storage and was not incorrectly applied
    expect(localStorage.getItem("nabuflow_overage_ack_2026-08-01")).toBeNull();
  });

  it("notice stays hidden when cycle rolls over and the new cycle already has an ack", async () => {
    // Both old and new cycle acks present
    localStorage.setItem("nabuflow_overage_ack_2026-07-01", "1");
    localStorage.setItem("nabuflow_overage_ack_2026-08-01", "1");

    testState.billing = {
      data: {
        enforcementEnabled: true,
        exempt: false,
        canBuild: true,
        blockedReason: null,
        plan: { overageUsdPerCredit: 0.012 },
        subscription: { currentCycleStart: "2026-08-01T00:00:00.000Z" },
        card: null,
        spendCap: null,
        cycle: { remainingIncludedCredits: 2 },
      },
      isLoading: false,
      isError: false,
    };
    renderPage();

    // Already acked for this cycle — should remain hidden
    await waitFor(() =>
      expect(screen.queryByTestId("overage-crossing-notice")).not.toBeInTheDocument(),
    );
  });
});
